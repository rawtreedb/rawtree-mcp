import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

const clusterArgs = {
  organization: 'acme',
  name: 'production',
  replicas: 2,
  minimumSize: { cpuCores: 2, memoryGiB: 8 },
  maximumSize: { cpuCores: 4, memoryGiB: 16 },
};
const storage = {
  data: { bucket: 'customer-data' },
  backups: { bucket: 'customer-backups' },
  roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
};
const wireStorage = {
  data: { bucket: 'customer-data', path: '' },
  backups: { bucket: 'customer-backups', path: '' },
  role_arn: storage.roleArn,
};

describe('storage tool contracts', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((c) => c.close()));
  });

  async function setup(response?: unknown, status = 200) {
    const bodies: unknown[] = [];
    const rawtree = new RawTreeClient({
      apiKey: 'fixture-token',
      fetchFn: async (_url, init) => {
        if (init?.method === 'GET') return Response.json({ clusters: [] });
        const body: unknown = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(JSON.stringify(response ?? body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'storage-contracts', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, bodies };
  }

  it('omits unspecified identities and returns the saved API identity', async () => {
    const saved = {
      id: 'cluster-id',
      s3_storage_access: {
        external_id: 'rawtree-5b71c457-7d83-474b-9db9-6dc48a1ec042',
        resource_tag: 'rawtree-dc1fb78e-341d-48f8-a183-9ecea12eb41d',
      },
    };
    const { client, bodies } = await setup(saved);
    const result = await client.callTool({
      name: 'create-cluster',
      arguments: clusterArgs,
    });
    expect(result.isError).not.toBe(true);
    expect(bodies[0]).not.toHaveProperty('external_id');
    expect(bodies[0]).not.toHaveProperty('resource_tag');
    expect(bodies[0]).not.toHaveProperty('s3_storage_access');
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Create cluster result:\n${JSON.stringify(saved, null, 2)}`,
      },
    ]);
  });

  it('lets the API report missing identity for custom storage', async () => {
    const { client, bodies } = await setup(
      { message: 'Custom S3 storage requires s3_storage_access.external_id.' },
      400,
    );
    const result = await client.callTool({
      name: 'create-cluster',
      arguments: { ...clusterArgs, s3Storage: storage },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'requires s3_storage_access.external_id',
    );
    expect(bodies[0]).not.toHaveProperty('external_id');
    expect(bodies[0]).not.toHaveProperty('resource_tag');
    expect(bodies[0]).not.toHaveProperty('s3_storage_access');
  });

  it('preserves one external ID across cluster verification and creation', async () => {
    const { client, bodies } = await setup();
    const identity = {
      s3StorageAccess: {
        externalId: 'rawtree-trusted',
        resourceTag: 'rawtree-tagged',
      },
    };
    const verification = await client.callTool({
      name: 'verify-cluster-s3-access',
      arguments: {
        organization: 'acme',
        s3StorageAccess: { externalId: identity.s3StorageAccess.externalId },
        s3Storage: storage,
      },
    });
    const creation = await client.callTool({
      name: 'create-cluster',
      arguments: { ...clusterArgs, ...identity, s3Storage: storage },
    });
    expect(verification.isError).not.toBe(true);
    expect(creation.isError).not.toBe(true);
    expect(bodies[0]).toEqual({
      s3_storage_access: { external_id: identity.s3StorageAccess.externalId },
      s3_storage: wireStorage,
    });
    expect(bodies[1]).toMatchObject({
      s3_storage_access: {
        external_id: identity.s3StorageAccess.externalId,
        resource_tag: identity.s3StorageAccess.resourceTag,
      },
      s3_storage: wireStorage,
    });
  });

  it('database verification and creation send storage without identity', async () => {
    const { client, bodies } = await setup();
    for (const name of ['verify-database-s3-access', 'create-database']) {
      const result = await client.callTool({
        name,
        arguments: {
          name: 'analytics',
          organization: 'acme',
          cluster: 'production',
          s3Storage: storage,
        },
      });
      expect(result.isError).not.toBe(true);
    }
    expect(bodies).toEqual(
      Array(2).fill({ name: 'analytics', s3_storage: wireStorage }),
    );
  });

  it('rejects incomplete or obsolete inputs before HTTP', async () => {
    const { client, bodies } = await setup();
    const cases = [
      {
        name: 'create-cluster',
        arguments: {
          ...clusterArgs,
          databaseS3Access: {
            externalId: 'old-id',
            databaseBucketTag: 'old-tag',
          },
        },
      },
      {
        name: 'create-cluster',
        arguments: { ...clusterArgs, externalId: 'bad?value' },
      },
      {
        name: 'create-cluster',
        arguments: {
          ...clusterArgs,
          s3StorageAccess: { externalId: 'bad?value' },
        },
      },
      {
        name: 'create-cluster',
        arguments: {
          ...clusterArgs,
          s3StorageAccess: { resourceTag: 'Invalid_Tag' },
        },
      },
      {
        name: 'create-cluster',
        arguments: { ...clusterArgs, s3StorageAccess: { extra: 'unknown' } },
      },
      {
        name: 'verify-cluster-s3-access',
        arguments: {
          organization: 'acme',
          s3Storage: storage,
          s3StorageAccess: {},
        },
      },

      {
        name: 'create-cluster',
        arguments: { ...clusterArgs, resourceTag: 'Invalid_Tag' },
      },
      {
        name: 'verify-cluster-s3-access',
        arguments: { organization: 'acme', s3Storage: storage },
      },
      {
        name: 'create-database',
        arguments: {
          name: 'analytics',
          externalId: 'override',
          s3Storage: storage,
        },
      },
      {
        name: 'verify-database-s3-access',
        arguments: {
          name: 'analytics',
          resourceTag: 'override',
          s3Storage: storage,
        },
      },
      {
        name: 'create-database',
        arguments: {
          name: 'analytics',
          s3Storage: { ...storage, externalId: 'old-id' },
        },
      },
      {
        name: 'create-database',
        arguments: {
          name: 'analytics',
          s3Storage: {
            dataBucket: 'old-data',
            backupBucket: 'old-backups',
            roleArn: storage.roleArn,
          },
        },
      },
    ];
    const invalidDestinations = [
      { data: storage.data, roleArn: storage.roleArn },
      { ...storage, backups: null },
      { ...storage, data: { path: 'prefix' } },
      { ...storage, data: { ...storage.data, externalId: 'override' } },
    ].map((s3Storage) => ({
      name: 'create-database',
      arguments: { name: 'analytics', s3Storage },
    }));
    for (const request of [...cases, ...invalidDestinations]) {
      const result = await client.callTool(request);
      expect(result.isError, JSON.stringify(request)).toBe(true);
    }
    expect(bodies).toEqual([]);
  });
});

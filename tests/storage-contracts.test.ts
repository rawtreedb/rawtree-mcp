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
  dataBucket: 'customer-data',
  backupBucket: 'customer-backups',
  roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
};
const wireStorage = {
  data_bucket: 'customer-data',
  data_path: '',
  backup_bucket: 'customer-backups',
  backup_path: '',
  role_arn: storage.roleArn,
};

describe('storage tool contracts', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((c) => c.close()));
  });

  async function setup() {
    const bodies: unknown[] = [];
    const rawtree = new RawTreeClient({
      apiKey: 'fixture-token',
      fetchFn: async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(JSON.stringify(body), {
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

  it('generates distinct UUID identities and returns them for managed clusters', async () => {
    const { client, bodies } = await setup();
    const result = await client.callTool({
      name: 'create-cluster',
      arguments: clusterArgs,
    });
    expect(result.isError).not.toBe(true);
    const uuid =
      /^rawtree-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(bodies[0]).toMatchObject({
      external_id: expect.stringMatching(uuid),
      resource_tag: expect.stringMatching(uuid),
    });
    const body = JSON.stringify(bodies[0]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `Create cluster result:\n${JSON.stringify(bodies[0], null, 2)}`,
      },
    ]);
    await client.callTool({
      name: 'create-cluster',
      arguments: { ...clusterArgs, name: 'another' },
    });
    expect(JSON.stringify(bodies[1])).not.toBe(body);
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized.match(/rawtree-[0-9a-f-]+/g)).toHaveLength(2);
    expect(new Set(serialized.match(/rawtree-[0-9a-f-]+/g)).size).toBe(2);
  });

  it('preserves one external ID across cluster verification and creation', async () => {
    const { client, bodies } = await setup();
    const identity = {
      externalId: 'rawtree-trusted',
      resourceTag: 'rawtree-tagged',
    };
    const verification = await client.callTool({
      name: 'verify-cluster-s3-access',
      arguments: {
        organization: 'acme',
        externalId: identity.externalId,
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
      external_id: identity.externalId,
      s3_storage: wireStorage,
    });
    expect(bodies[1]).toMatchObject({
      external_id: identity.externalId,
      resource_tag: identity.resourceTag,
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
        arguments: { ...clusterArgs, s3Storage: storage },
      },
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
            data: { bucket: 'old-data' },
            backups: { bucket: 'old-backups' },
            roleArn: storage.roleArn,
          },
        },
      },
    ];
    for (const request of cases) {
      const result = await client.callTool(request);
      expect(result.isError, JSON.stringify(request)).toBe(true);
    }
    expect(bodies).toEqual([]);
  });
});

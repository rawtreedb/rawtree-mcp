import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

const regionId = '11111111-1111-4111-8111-111111111111';
const region = {
  id: regionId,
  name: 'Frankfurt',
  cloud_region: 'eu-central-1',
  deployment_id: 'abcd1234',
  organization_id: null,
  enabled: true,
};
const storage = {
  dataBucket: 'data',
  backupBucket: 'backup',
  roleArn: 'role',
};
const creation = {
  organization: 'acme',
  regionId,
  name: 'production',
  replicas: 2,
  minimumSize: { cpuCores: 2, memoryGiB: 8 },
  maximumSize: { cpuCores: 2, memoryGiB: 8 },
};
function fixture(
  overrides: Record<string, unknown> = {},
  apiKey = 'session.fixture',
) {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(
      path === '/v1/organizations'
        ? { organizations: [{ name: 'acme', organization_id: 'org-id' }] }
        : path.endsWith('/regions')
          ? { regions: [{ ...region, ...overrides }] }
          : { ok: true },
    );
  };
  return { rawtree: new RawTreeClient({ apiKey, fetchFn }), calls };
}

describe('region-aware creation', () => {
  it('routes MCP discovery, prerequisites and creation through the selected region', async () => {
    const { rawtree, calls } = fixture();
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'region-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const [name, args] of [
        ['list-regions', { organization: 'acme' }],
        ['list-cluster-sizes', { organization: 'acme', regionId }],
        [
          'verify-cluster-s3-access',
          {
            organization: 'acme',
            regionId,
            s3StorageAccess: { externalId: 'external' },
            s3Storage: storage,
          },
        ],
        ['create-cluster', creation],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
      }
      const operations = calls.filter(({ path }) =>
        path.startsWith('/v1/clusters'),
      );
      expect(operations.map(({ path }) => path)).toEqual([
        '/v1/clusters/sizes',
        '/v1/clusters/verify-s3-access',
        '/v1/clusters',
      ]);
      for (const { headers } of operations) {
        expect(headers.get('X-RawTree-Deployment-Id')).toBe('abcd1234');
        expect(headers.get('X-RawTree-Region')).toBe('eu-central-1');
        expect(headers.get('Authorization')).toBe('Bearer session.fixture');
      }
      expect(operations[2]?.body).toMatchObject({ region_id: regionId });
      expect(operations[2]?.body).not.toHaveProperty('deployment_id');
      expect(
        calls
          .filter(({ path }) => !path.startsWith('/v1/clusters'))
          .every(({ headers }) => !headers.has('X-RawTree-Region')),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    { enabled: false },
    { deployment_id: null },
    { deployment_id: 'bad' },
    { deployment_id: '0123456789abcdef0123456789abcdef' },
    { cloud_region: 'bad' },
    { id: 'other' },
  ])('rejects unusable regions before mutation: %j', async (overrides) => {
    const { rawtree, calls } = fixture(overrides);
    await expect(rawtree.createCluster(creation)).rejects.toThrow();
    expect(calls.every(({ path }) => !path.startsWith('/v1/clusters'))).toBe(
      true,
    );
  });

  it('keeps omitted selection and the legacy public region on the default backend', async () => {
    const legacyId = '0c0f0a56-7f03-4d39-8e5d-000000000001';
    const { rawtree, calls } = fixture({
      id: legacyId,
      deployment_id: null,
      cloud_region: 'us-east-1',
    });
    await rawtree.createCluster({ ...creation, regionId: undefined });
    expect(calls).toHaveLength(1);
    await rawtree.createCluster({ ...creation, regionId: legacyId });
    expect(calls.every(({ headers }) => !headers.has('X-RawTree-Region'))).toBe(
      true,
    );
    expect(calls[0]?.body).not.toHaveProperty('region_id');
  });

  it('requires organization for a selected size catalog and user credentials for placement', async () => {
    const { rawtree, calls } = fixture();
    await expect(rawtree.listClusterSizes({ regionId })).rejects.toThrow(
      'organization',
    );
    expect(calls).toHaveLength(0);
    const apiKey = fixture({}, 'rt_fixture');
    await expect(apiKey.rawtree.createCluster(creation)).rejects.toThrow(
      'user credential',
    );
    expect(apiKey.calls).toHaveLength(0);
  });
});

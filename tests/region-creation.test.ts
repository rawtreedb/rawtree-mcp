import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { RawTreeClient, type RawTreeClientOptions } from '../src/client.js';
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
const byoc = {
  ...region,
  id: '00000000-0000-4000-8000-000000000002',
  organization_id: 'org-id',
  deployment_id: 'feed1234',
};
const storage = {
  data: { bucket: 'data' },
  backups: { bucket: 'backup' },
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
  credentialScope?: RawTreeClientOptions['credentialScope'],
) {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push({
      path,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (path === '/v1/organizations')
      return Response.json({
        organizations: [{ name: 'acme', organization_id: 'org-id' }],
      });
    if (
      path === '/v1/regions' &&
      url.searchParams.get('organization_id') === 'org-id'
    )
      return Response.json({ regions: [{ ...region, ...overrides }, byoc] });
    return Response.json({ ok: true });
  };
  return {
    rawtree: new RawTreeClient({ apiKey, credentialScope, fetchFn }),
    calls,
  };
}

const regionalOperations = [
  {
    name: 'listClusterSizes',
    path: '/v1/clusters/sizes',
    invoke: (client: RawTreeClient, selectedRegion?: string) =>
      client.listClusterSizes({
        organization: 'acme',
        regionId: selectedRegion,
      }),
  },
  {
    name: 'verifyClusterS3Access',
    path: '/v1/clusters/verify-s3-access',
    invoke: (client: RawTreeClient, selectedRegion?: string) =>
      client.verifyClusterS3Access({
        organization: 'acme',
        regionId: selectedRegion,
        s3Storage: storage,
        s3StorageAccess: { externalId: 'external' },
      }),
  },
];

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
      const catalog = await client.callTool({
        name: 'list-cluster-regions',
        arguments: { organization: 'acme' },
      });
      const content = catalog.content[0];
      if (content?.type !== 'text') throw new Error('Expected a region list');
      expect(JSON.parse(content.text)).toEqual({ regions: [region, byoc] });
      for (const [name, args] of [
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
      for (const { headers } of operations.slice(0, 2)) {
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

  it('sends only the required region ID and lets the API resolve deployment', async () => {
    const { rawtree, calls } = fixture();
    await rawtree.createCluster(creation);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/clusters');
    expect(calls[0]?.body).toMatchObject({ region_id: regionId });
    expect(calls[0]?.headers.has('X-RawTree-Deployment-Id')).toBe(false);
    expect(calls[0]?.headers.has('X-RawTree-Region')).toBe(false);
  });

  it.each([
    undefined,
    null,
    '',
    'not-a-uuid',
  ])('rejects an invalid region ID: %s', async (invalid) => {
    const { rawtree, calls } = fixture();
    // Exercise JavaScript callers that bypass TypeScript's required property.
    // @ts-expect-error invalid region is deliberately supplied
    await expect(
      rawtree.createCluster({ ...creation, regionId: invalid }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
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

describe.each([
  { apiKey: 'rt_fixture', credentialScope: undefined },
  { apiKey: 'rt_fixture', credentialScope: 'cluster' },
  { apiKey: 'workload.jwt.fixture', credentialScope: 'cluster' },
] as const)('cluster credentials: $apiKey / $credentialScope', ({
  apiKey,
  credentialScope,
}) => {
  it('rejects region discovery before sending any request', async () => {
    const { rawtree, calls } = fixture({}, apiKey, credentialScope);
    await expect(rawtree.listRegions('acme')).rejects.toThrow(
      'user credential',
    );
    expect(calls).toEqual([]);
  });

  it.each(
    regionalOperations,
  )('rejects region selection for $name before sending any request', async ({
    invoke,
  }) => {
    const { rawtree, calls } = fixture({}, apiKey, credentialScope);
    await expect(invoke(rawtree, regionId)).rejects.toThrow('user credential');
    expect(calls).toEqual([]);
  });

  it.each(
    regionalOperations,
  )('keeps $name without region selection on the default gateway', async ({
    invoke,
    path,
  }) => {
    const { rawtree, calls } = fixture({}, apiKey, credentialScope);
    await invoke(rawtree);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(path);
    expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(calls[0]?.headers.has('X-RawTree-Deployment-Id')).toBe(false);
    expect(calls[0]?.headers.has('X-RawTree-Region')).toBe(false);
  });
});

describe.each([
  { apiKey: 'session.fixture', credentialScope: undefined },
  { apiKey: 'oauth.fixture', credentialScope: 'user' },
  { apiKey: 'rt_fixture', credentialScope: 'user' },
] as const)('user routing: $apiKey / $credentialScope', ({
  apiKey,
  credentialScope,
}) => {
  it('allows region discovery', async () => {
    const { rawtree, calls } = fixture({}, apiKey, credentialScope);
    await expect(rawtree.listRegions('acme')).resolves.toEqual({
      regions: [region, byoc],
    });
    expect(calls.map(({ path }) => path)).toEqual([
      '/v1/organizations',
      '/v1/regions',
    ]);
  });

  it.each(
    regionalOperations,
  )('routes $name through the selected region', async ({ invoke, path }) => {
    const { rawtree, calls } = fixture({}, apiKey, credentialScope);
    await invoke(rawtree, regionId);
    expect(calls.map(({ path }) => path)).toEqual([
      '/v1/organizations',
      '/v1/regions',
      path,
    ]);
    expect(calls.at(-1)?.headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(calls.at(-1)?.headers.get('X-RawTree-Deployment-Id')).toBe(
      'abcd1234',
    );
    expect(calls.at(-1)?.headers.get('X-RawTree-Region')).toBe('eu-central-1');
  });
});

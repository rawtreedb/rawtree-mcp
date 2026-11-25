import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const collection = '/v1/clusters';
const routing = { deployment_id: '12abcdef', cloud_region: 'eu-west-1' };
const clusterId = '00000000-0000-4000-8000-0000000000b1';
const scope = { organization: organizationId, cluster: clusterId };

function server(
  metadata: Record<string, unknown> = routing,
  failDiscovery = false,
) {
  const calls: { url: URL; headers: Headers; method: string; body: unknown }[] =
    [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      url,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      body: init?.body,
    });
    if (url.pathname.endsWith('/regions'))
      return Response.json({
        regions: [
          {
            id: '0c0f0a56-7f03-4d39-8e5d-000000000001',
            name: 'N. Virginia',
            enabled: true,
            deployment_id: null,
            cloud_region: 'us-east-1',
            organization_id: null,
          },
        ],
      });
    const body =
      url.pathname.endsWith('/clusters') && init?.method === 'GET'
        ? {
            clusters: [
              {
                id: clusterId,
                name: 'production',
                ...metadata,
                ...(new Headers(init.headers).get(
                  'X-RawTree-Organization-Id',
                ) === otherId
                  ? { deployment_id: 'abcdef12', cloud_region: 'ap-south-1' }
                  : {}),
              },
            ],
          }
        : { data: [{ result: 1 }] };
    return new Response(JSON.stringify(body), {
      status: failDiscovery && url.pathname.endsWith('/clusters') ? 503 : 200,
    });
  };
  return { calls, fetchFn };
}

function expectRouting(
  headers: Headers,
  deployment = '12abcdef',
  region = 'eu-west-1',
) {
  expect(headers.get('X-RawTree-Deployment-Id')).toBe(deployment);
  expect(headers.get('X-RawTree-Region')).toBe(region);
}

describe('automatic cluster routing', () => {
  it('keeps existing cluster URLs and adds serving headers to cluster actions', async () => {
    const { calls, fetchFn } = server();
    const client = new RawTreeClient({ apiKey: 'session.fixture', fetchFn });
    await client.listClusters(organizationId);
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/v1/regions',
      collection,
    ]);
    await client.pauseCluster({ organization: organizationId, clusterId });
    const action = calls.at(-1);
    expect(action?.url.pathname).toBe(`${collection}/${clusterId}/stop`);
    expect(action?.headers.get('X-RawTree-Organization-Id')).toBe(
      organizationId,
    );
    expectRouting(action?.headers ?? new Headers());
    expect(
      calls
        .slice(0, -1)
        .every(({ headers }) => !headers.has('X-RawTree-Deployment-Id')),
    ).toBe(true);
  });

  it('keeps independent organization and per-call cluster scope', async () => {
    const { calls, fetchFn } = server();
    const client = new RawTreeClient({
      apiKey: 'oauth.fixture',
      fetchFn,
      ...scope,
    });
    await Promise.all([
      client.listDatabases(scope),
      client.listDatabases({ organization: otherId, cluster: clusterId }),
    ]);
    const requests = calls.filter(
      ({ url }) => url.pathname === '/v1/databases',
    );
    expect(requests).toHaveLength(2);
    for (const { headers } of requests) {
      if (headers.get('X-RawTree-Organization-Id') === otherId)
        expectRouting(headers, 'abcdef12', 'ap-south-1');
      else expectRouting(headers);
    }
  });

  it.each([
    {},
    { deployment_id: null, cloud_region: null },
    { deployment_id: '12abcdef' },
    { ...routing, deployment_id: '12abcdef00' },
    { ...routing, cloud_region: 'https://bad.invalid' },
  ])('keeps fallback for absent or invalid serving metadata: %j', async (metadata) => {
    const { calls, fetchFn } = server(metadata);
    await new RawTreeClient({ apiKey: 'oauth.fixture', fetchFn }).listDatabases(
      scope,
    );
    const headers = calls.at(-1)?.headers;
    expect(headers?.has('X-RawTree-Deployment-Id')).toBe(false);
    expect(headers?.has('X-RawTree-Region')).toBe(false);
  });

  it('leaves API key routing to the key without metadata requests', async () => {
    const { calls, fetchFn } = server();
    await new RawTreeClient({ apiKey: 'rt_fixture', fetchFn }).listDatabases(
      scope,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('Authorization')).toBe('Bearer rt_fixture');
    expect(calls[0]?.headers.has('X-RawTree-Region')).toBe(false);
  });

  it('propagates discovery errors before executing a cluster operation', async () => {
    const { calls, fetchFn } = server(routing, true);
    await expect(
      new RawTreeClient({ apiKey: 'oauth.fixture', fetchFn }).listDatabases(
        scope,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls.some(({ url }) => url.pathname === '/v1/databases')).toBe(
      false,
    );
  });

  it('sends both headers through an actual OAuth-authenticated MCP tool call', async () => {
    const { calls, fetchFn } = server();
    const rawtree = new RawTreeClient({ apiKey: 'oauth.fixture', fetchFn });
    const mcp = createMcpServer(rawtree);
    const client = new Client({ name: 'routing-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'list-databases',
        arguments: scope,
      });
      expect(result.isError).not.toBe(true);
      const operation = calls.find(
        ({ url }) => url.pathname === '/v1/databases',
      );
      expectRouting(operation?.headers ?? new Headers());
      expect(operation?.headers.get('Authorization')).toBe(
        'Bearer oauth.fixture',
      );
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});

describe('cluster-bound workload credentials', () => {
  it.each([
    { apiKey: 'rt_fixture', credentialScope: undefined },
    { apiKey: 'rt_fixture', credentialScope: 'cluster' },
    { apiKey: 'workload.jwt.credential', credentialScope: 'cluster' },
  ] as const)('lists only the bound cluster and sends queries without regional discovery: $apiKey / $credentialScope', async ({
    apiKey,
    credentialScope,
  }) => {
    const { calls, fetchFn } = server();
    const client = new RawTreeClient({
      apiKey,
      credentialScope,
      fetchFn,
    });
    await client.listClusters(organizationId);
    await client.query('SELECT 1', scope);
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/v1/clusters',
      '/v1/query',
    ]);
    for (const { headers } of calls) {
      expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
      expect(headers.has('X-RawTree-Deployment-Id')).toBe(false);
      expect(headers.has('X-RawTree-Region')).toBe(false);
    }
    expect(calls[1]?.headers.get('X-RawTree-Organization-Id')).toBe(
      organizationId,
    );
    expect(calls[1]?.headers.get('X-RawTree-Cluster-Id')).toBe(clusterId);
  });

  it('honors explicit user routing even when the credential has an API-key prefix', async () => {
    const { calls, fetchFn } = server();
    const client = new RawTreeClient({
      apiKey: 'rt_fixture',
      credentialScope: 'user',
      fetchFn,
    });
    await client.listClusters(organizationId);
    await client.query('SELECT 1', scope);
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/v1/regions',
      '/v1/clusters',
      '/v1/query',
    ]);
    expectRouting(calls.at(-1)?.headers ?? new Headers());
    expect(calls.at(-1)?.headers.get('Authorization')).toBe(
      'Bearer rt_fixture',
    );
  });
});

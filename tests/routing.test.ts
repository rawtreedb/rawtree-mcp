import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const collection = '/v1/clusters';
const routing = { deployment_id: '12abcdef', cloud_region: 'eu-west-1' };
const scope = { organization: 'acme', cluster: 'production' };

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
    const body =
      url.pathname === '/v1/organizations'
        ? {
            organizations: [
              { organization_id: organizationId, name: 'acme' },
              { organization_id: otherId, name: 'other' },
            ],
          }
        : url.pathname.endsWith('/clusters') && init?.method === 'GET'
          ? {
              clusters: [
                {
                  id: 'cluster-id',
                  name: 'production',
                  ...metadata,
                  ...(url.searchParams.get('organization') === 'other'
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
    await client.listClusters('acme');
    expect(calls.map(({ url }) => url.pathname)).toEqual([collection]);
    await client.pauseCluster({
      organization: 'acme',
      clusterId: 'cluster-id',
    });
    const action = calls.at(-1);
    expect(action?.url.pathname).toBe(`${collection}/cluster-id/stop`);
    expect(action?.url.searchParams.get('organization')).toBe('acme');
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
      client.listDatabases({ organization: 'other', cluster: 'production' }),
    ]);
    const requests = calls.filter(
      ({ url }) => url.pathname === '/v1/databases',
    );
    expect(requests).toHaveLength(2);
    for (const { url, headers } of requests) {
      if (url.searchParams.get('organization') === 'other')
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

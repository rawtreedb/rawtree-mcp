import { afterEach, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../src/client.js';

const organizationId = '00000000-0000-4000-8000-0000000000a1';
const clusterIds: Record<string, string> = {
  us: '00000000-0000-4000-8000-0000000000f1',
  eu: '00000000-0000-4000-8000-0000000000e1',
};

type Failure = number | Response | 'network' | 'timeout';

function fixture() {
  const failures = new Map<string, Failure>();
  const calls: { url: URL; signal?: AbortSignal | null }[] = [];
  let empty = false;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, signal: init?.signal });
    if (url.pathname.endsWith('/regions'))
      return Response.json({
        regions: [
          {
            id: 'us',
            name: 'Virginia',
            cloud_region: 'us-east-1',
            deployment_id: null,
            enabled: true,
            organization_id: null,
          },
          {
            id: 'eu',
            name: 'Ireland',
            cloud_region: 'eu-west-1',
            deployment_id: '1234abcd',
            enabled: true,
            organization_id: null,
          },
        ],
      });
    if (url.pathname === '/v1/clusters') {
      const region = url.hostname.includes('1234abcd') ? 'eu' : 'us';
      const failure = failures.get(region);
      if (failure instanceof Response) return failure.clone();
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'timeout') {
        const signal = init?.signal;
        if (!signal) throw new Error('Missing regional timeout signal');
        signal.throwIfAborted();
        return new Promise<Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }
      if (typeof failure === 'number')
        return Response.json(
          {
            error: 'forbidden',
            message: 'Region unavailable',
            hint: 'Check access.',
          },
          { status: failure },
        );
      return Response.json({
        organization: { name: 'acme' },
        clusters: empty
          ? []
          : [{ id: clusterIds[region], name: region, region_id: region }],
      });
    }
    return Response.json({ data: [] });
  };
  return {
    client: new RawTreeClient({ apiKey: 'session.fixture', fetchFn }),
    calls,
    failures,
    empty: () => {
      empty = true;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it.each([
  503,
  'network',
] as const)('routes a healthy cluster before listing during regional failure: %s', async (failure) => {
  const { client, calls, failures } = fixture();
  failures.set('eu', failure);
  await client.listDatabases({
    organization: organizationId,
    cluster: clusterIds.us,
  });
  expect(calls.at(-1)?.url.hostname).toBe('api.rawtree.com');
  expect(calls.at(-1)?.url.pathname).toBe('/v1/databases');
});

it.each([
  '<html>Forbidden</html>',
  '',
  '{}',
  '{"message":"Forbidden"}',
  '{"error":"Forbidden"}',
])('keeps healthy clusters on an unstructured regional 403 (%j)', async (body) => {
  const { client, failures } = fixture();
  failures.set('eu', new Response(body, { status: 403 }));
  expect(await client.listClusters(organizationId)).toMatchObject({
    clusters: [{ id: clusterIds.us }],
    unavailable_regions: [{ id: 'eu', name: 'Ireland' }],
  });
});

it.each([
  [401, false],
  [403, true],
] as const)('rejects an unstructured %s when all fail or credentials expire', async (status, allFail) => {
  const { client, failures } = fixture();
  const failure = new Response(null, { status });
  failures.set('eu', failure);
  if (allFail) failures.set('us', failure);
  await expect(client.listClusters(organizationId)).rejects.toMatchObject({
    status,
  });
});

it('preserves a regional 401 when its response body cannot be read', async () => {
  const { client, failures } = fixture();
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error('Disconnected'));
    },
  });
  failures.set('eu', new Response(body, { status: 401 }));
  await expect(client.listClusters(organizationId)).rejects.toMatchObject({
    status: 401,
  });
});

it('bounds a stalled region at five seconds and returns healthy clusters', async () => {
  const { client, failures } = fixture();
  failures.set('eu', 'timeout');
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  const pending = client.listClusters(organizationId);
  await vi.waitFor(() => expect(timeout).toHaveBeenCalledTimes(2));
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  expect(await pending).toMatchObject({
    clusters: [{ id: clusterIds.us }],
    unavailable_regions: [{ id: 'eu', name: 'Ireland' }],
  });
  expect(timeout).toHaveBeenCalledWith(5_000);
});

it('preserves response metadata when the first deployment fails', async () => {
  const { client, failures } = fixture();
  failures.set('us', 503);
  expect(await client.listClusters(organizationId)).toMatchObject({
    organization: { name: 'acme' },
    clusters: [{ id: clusterIds.eu }],
    unavailable_regions: [{ id: 'us', name: 'Virginia' }],
  });
});

it('marks an empty healthy catalog as partial during an outage', async () => {
  const { client, failures, empty } = fixture();
  empty();
  failures.set('eu', 503);
  expect(await client.listClusters(organizationId)).toMatchObject({
    clusters: [],
    unavailable_regions: [{ id: 'eu', name: 'Ireland' }],
  });
});

it.each([
  401, 403,
])('preserves authorization errors even when another deployment succeeds: %s', async (status) => {
  const { client, failures } = fixture();
  failures.set('eu', status);
  await expect(client.listClusters(organizationId)).rejects.toMatchObject({
    status,
  });
});

it.each([
  401, 403, 503,
])('never returns an empty list for a total outage: %s', async (status) => {
  const { client, failures } = fixture();
  failures.set('us', status);
  failures.set('eu', status);
  await expect(client.listClusters(organizationId)).rejects.toMatchObject({
    status,
  });
});

it.each([
  false,
  true,
])('routes a recovered cluster immediately with a cached partial catalog (explicit refresh: %s)', async (refresh) => {
  const { client, calls, failures } = fixture();
  failures.set('eu', 503);
  await client.listClusters(organizationId);
  failures.clear();
  if (refresh)
    expect(await client.listClusters(organizationId)).not.toHaveProperty(
      'unavailable_regions',
    );
  await client.listDatabases({
    organization: organizationId,
    cluster: clusterIds.eu,
  });
  expect(calls.at(-1)?.url.hostname).toBe(
    'api.1234abcd.eu-west-1.aws.rawtree.com',
  );
});

it('blocks cluster-ID mutations missing from a partial catalog, then retries after recovery', async () => {
  const { client, calls, failures } = fixture();
  failures.set('eu', 503);
  await expect(
    client.pauseCluster({
      organization: organizationId,
      clusterId: clusterIds.eu,
    }),
  ).rejects.toThrow('Some regions are unavailable');
  expect(calls.some(({ url }) => url.pathname.endsWith('/stop'))).toBe(false);
  failures.clear();
  await client.pauseCluster({
    organization: organizationId,
    clusterId: clusterIds.eu,
  });
  expect(calls.at(-1)?.url.hostname).toBe(
    'api.1234abcd.eu-west-1.aws.rawtree.com',
  );
  expect(calls.at(-1)?.url.pathname).toBe(`/v1/clusters/${clusterIds.eu}/stop`);
});

it('asks to retry when a cluster name is missing from a partial catalog', async () => {
  const { client, failures } = fixture();
  failures.set('eu', 503);
  await expect(
    client.listDatabases({ organization: organizationId, cluster: 'eu' }),
  ).rejects.toThrow('Some regions are unavailable');
  failures.clear();
  await expect(
    client.listDatabases({ organization: organizationId, cluster: 'eu' }),
  ).resolves.toBeDefined();
});

it('reports a missing cluster name when the catalog is complete', async () => {
  const { client } = fixture();
  await expect(
    client.listDatabases({ organization: organizationId, cluster: 'nope' }),
  ).rejects.toThrow("Cluster 'nope' was not found");
});

import { describe, expect, it, vi } from 'vitest';
import { ClusterRouting } from '../src/client/routing.js';

const id = '00000000-0000-4000-8000-000000000001';
const clusterId = '00000000-0000-4000-8000-0000000000b1';
const tenant = { organization: id, cluster: clusterId };
const metadata = {
  clusters: [
    {
      id: clusterId,
      name: 'production',
      deployment_id: '12abcdef',
      cloud_region: 'eu-west-1',
    },
  ],
};
const url = new URL('https://api.rawtree.test/v1/query');

describe('routing discovery lifetime', () => {
  it('aborts one discovery waiter promptly without cancelling another caller', async () => {
    const pending = Promise.withResolvers<unknown>();
    const load = vi.fn(() => pending.promise);
    const routing = new ClusterRouting(load);
    const controller = new AbortController();
    const cancelled = routing.headers(url, tenant, controller.signal);
    const active = routing.headers(url, tenant);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(metadata);
    expect(await active).toEqual({
      'X-RawTree-Deployment-Id': '12abcdef',
      'X-RawTree-Region': 'eu-west-1',
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not start discovery for an already cancelled request', () => {
    const load = vi.fn(async () => metadata);
    const routing = new ClusterRouting(load);
    expect(() => routing.headers(url, tenant, AbortSignal.abort())).toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects old list responses after a mutation invalidates the cache', async () => {
    const load = vi.fn(async () => metadata);
    const routing = new ClusterRouting(load);
    const oldVersion = routing.version;
    routing.clear();
    routing.remember(id, { clusters: [] }, oldVersion);
    const result = await routing.headers(
      new URL(`https://api.rawtree.test/v1/clusters/${clusterId}`),
      tenant,
    );
    expect(result['X-RawTree-Deployment-Id']).toBe('12abcdef');
    expect(load).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('does not retain failed discovery and can recover on the next request', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(metadata);
    const routing = new ClusterRouting(load);
    const target = new URL(`https://api.rawtree.test/v1/clusters/${clusterId}`);
    await expect(routing.headers(target, tenant)).rejects.toThrow(
      'Unavailable',
    );
    expect((await routing.headers(target, tenant))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
  });
});

it('matches clusters by ID only, never by name', async () => {
  const routing = new ClusterRouting(async () => ({
    clusters: [
      {
        id: 'other-id',
        name: 'target-id',
        deployment_id: 'aaaaaaaa',
        cloud_region: 'us-east-1',
      },
      {
        id: 'target-id',
        name: 'production',
        deployment_id: 'bbbbbbbb',
        cloud_region: 'eu-west-1',
      },
    ],
  }));
  const query = new URL('https://api.rawtree.test/v1/query');
  expect(
    (await routing.headers(query, { organization: id, cluster: 'target-id' }))[
      'X-RawTree-Deployment-Id'
    ],
  ).toBe('bbbbbbbb');
  expect(
    await routing.headers(query, { organization: id, cluster: 'production' }),
  ).toEqual({});
});

it('needs both an organization and a cluster to route', async () => {
  const load = vi.fn(async () => metadata);
  const routing = new ClusterRouting(load);
  const query = new URL('https://api.rawtree.test/v1/query');
  expect(await routing.headers(query, { organization: id })).toEqual({});
  expect(await routing.headers(query, { cluster: clusterId })).toEqual({});
  expect(load).not.toHaveBeenCalled();
});

it('loads the cluster catalog by organization ID without an organization lookup', async () => {
  const load = vi.fn(async () => metadata);
  const routing = new ClusterRouting(load);
  expect(
    (
      await routing.headers(new URL('https://api.rawtree.test/v1/metrics'), {
        organization: id,
        cluster: clusterId,
      })
    )['X-RawTree-Region'],
  ).toBe('eu-west-1');
  expect(load).toHaveBeenCalledExactlyOnceWith(id);
});

it('keeps newer discovery metadata when an expired in-flight lookup completes late', async () => {
  let completeOld: (value: unknown) => void = () => {
    throw new Error('Lookup was not initialized');
  };
  const old = new Promise<unknown>((resolve) => {
    completeOld = resolve;
  });
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  let calls = 0;
  const routing = new ClusterRouting(async () => {
    const version = routing.version;
    const response = ++calls === 1 ? await old : metadata;
    routing.remember(id, response, version);
    return response;
  });
  const target = new URL(`https://api.rawtree.test/v1/clusters/${clusterId}`);
  try {
    const first = routing.headers(target, tenant);
    await vi.waitFor(() => expect(calls).toBe(1));
    now.mockReturnValue(32000);
    expect((await routing.headers(target, tenant))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
    completeOld({
      clusters: [
        {
          id: clusterId,
          name: 'production',
          deployment_id: 'aaaaaaaa',
          cloud_region: 'us-east-1',
        },
      ],
    });
    await first;
    expect((await routing.headers(target, tenant))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
    expect(calls).toBe(2);
  } finally {
    now.mockRestore();
  }
});

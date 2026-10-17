import { describe, expect, it, vi } from 'vitest';
import { ClusterRouting } from '../src/client/routing.js';

const id = '00000000-0000-4000-8000-000000000001';
const path = '/v1/clusters?organization=acme';
const organizations = {
  organizations: [{ organization_id: id, name: 'acme' }],
};
const metadata = {
  clusters: [
    {
      id: 'cluster-id',
      name: 'production',
      deployment_id: '12abcdef',
      cloud_region: 'eu-west-1',
    },
  ],
};
const url = new URL(
  'https://api.rawtree.test/v1/query?organization=acme&cluster=production',
);

describe('routing discovery lifetime', () => {
  it('aborts one discovery waiter promptly without cancelling another caller', async () => {
    const pending = Promise.withResolvers<unknown>();
    const load = vi.fn(() => pending.promise);
    const routing = new ClusterRouting(load);
    const controller = new AbortController();
    const cancelled = routing.headers(url, controller.signal);
    const active = routing.headers(url);
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
    expect(() => routing.headers(url, AbortSignal.abort())).toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it('rejects old list responses after a mutation invalidates the cache', async () => {
    const load = vi.fn(async () => metadata);
    const routing = new ClusterRouting(load);
    const oldVersion = routing.version;
    routing.clear();
    routing.remember(
      new URL(`https://api.rawtree.test${path}`),
      { clusters: [] },
      oldVersion,
    );
    const result = await routing.headers(
      new URL(
        'https://api.rawtree.test/v1/clusters/cluster-id?organization=acme',
      ),
    );
    expect(result['X-RawTree-Deployment-Id']).toBe('12abcdef');
    expect(load).toHaveBeenCalledExactlyOnceWith(path);
  });

  it('does not retain failed discovery and can recover on the next request', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce(metadata);
    const routing = new ClusterRouting(load);
    const target = new URL(
      'https://api.rawtree.test/v1/clusters/cluster-id?organization=acme',
    );
    await expect(routing.headers(target)).rejects.toThrow('Unavailable');
    expect((await routing.headers(target))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
  });
});

it('distinguishes explicit IDs from names when selectors collide', async () => {
  const routing = new ClusterRouting(async (resource) =>
    resource === '/v1/organizations'
      ? organizations
      : {
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
        },
  );
  for (const resource of [
    '/v1/clusters/target-id?organization=acme',
    `/v1/query?organization_id=${id}&cluster_id=target-id`,
  ]) {
    expect(
      (await routing.headers(new URL(`https://api.rawtree.test${resource}`)))[
        'X-RawTree-Deployment-Id'
      ],
    ).toBe('bbbbbbbb');
  }
  expect(
    (
      await routing.headers(
        new URL(
          `https://api.rawtree.test/v1/query?organization_id=${id}&cluster=target-id`,
        ),
      )
    )['X-RawTree-Deployment-Id'],
  ).toBe('aaaaaaaa');
});

it('refreshes stale organization metadata when an explicit ID is missing', async () => {
  const load = vi.fn(async (resource: string) =>
    resource === '/v1/organizations' ? organizations : metadata,
  );
  const routing = new ClusterRouting(load);
  routing.remember(
    new URL('https://api.rawtree.test/v1/organizations'),
    { organizations: [] },
    routing.version,
  );
  expect(
    (
      await routing.headers(
        new URL(
          `https://api.rawtree.test/v1/metrics?organization_id=${id}&cluster_id=cluster-id`,
        ),
      )
    )['X-RawTree-Region'],
  ).toBe('eu-west-1');
  expect(load.mock.calls.map(([resource]) => resource)).toEqual([
    '/v1/organizations',
    path,
  ]);
});

it('does not repeat a fresh lookup for an unknown organization', async () => {
  const load = vi.fn(async (resource: string) =>
    resource === '/v1/organizations' ? organizations : metadata,
  );
  const routing = new ClusterRouting(load);
  await expect(
    routing.headers(
      new URL(
        'https://api.rawtree.test/v1/metrics?organization_id=missing&cluster_id=cluster-id',
      ),
    ),
  ).rejects.toThrow("Organization 'missing' was not found.");
  expect(load).toHaveBeenCalledOnce();
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
    routing.remember(
      new URL(`https://api.rawtree.test${path}`),
      response,
      version,
    );
    return response;
  });
  const target = new URL(
    'https://api.rawtree.test/v1/clusters/cluster-id?organization=acme',
  );
  try {
    const first = routing.headers(target);
    await vi.waitFor(() => expect(calls).toBe(1));
    now.mockReturnValue(32000);
    expect((await routing.headers(target))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
    completeOld({
      clusters: [
        {
          id: 'cluster-id',
          name: 'production',
          deployment_id: 'aaaaaaaa',
          cloud_region: 'us-east-1',
        },
      ],
    });
    await first;
    expect((await routing.headers(target))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
    expect(calls).toBe(2);
  } finally {
    now.mockRestore();
  }
});

import { describe, expect, it, vi } from 'vitest';
import { ClusterRouting } from '../src/client/routing.js';

const id = '00000000-0000-4000-8000-000000000001';
const path = `/v1/organizations/${id}/clusters`;
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
    const load = vi.fn((resource: string) =>
      resource === '/v1/organizations'
        ? pending.promise
        : Promise.resolve(metadata),
    );
    const routing = new ClusterRouting(load);
    const controller = new AbortController();
    const cancelled = routing.headers(url, controller.signal);
    const active = routing.headers(url);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(organizations);
    expect(await active).toEqual({
      'X-RawTree-Deployment-Id': '12abcdef',
      'X-RawTree-Region': 'eu-west-1',
    });
    expect(load).toHaveBeenCalledTimes(2);
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
    routing.remember(path, { clusters: [] }, oldVersion);
    const result = await routing.headers(
      new URL(`https://api.rawtree.test${path}/cluster-id`),
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
    const target = new URL(`https://api.rawtree.test${path}/cluster-id`);
    await expect(routing.headers(target)).rejects.toThrow('Unavailable');
    expect((await routing.headers(target))['X-RawTree-Region']).toBe(
      'eu-west-1',
    );
  });
});

it('distinguishes explicit IDs from names when selectors collide', async () => {
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
  for (const resource of [
    `${path}/target-id`,
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

it('refreshes stale organization metadata once when a new name is missing', async () => {
  const load = vi.fn(async () => organizations);
  const routing = new ClusterRouting(load);
  routing.remember('/v1/organizations', { organizations: [] }, routing.version);
  expect(await routing.clustersPath('acme')).toBe(path);
  expect(load).toHaveBeenCalledExactlyOnceWith('/v1/organizations');
});

it('does not repeat a fresh lookup for an unknown organization', async () => {
  const load = vi.fn(async () => organizations);
  const routing = new ClusterRouting(load);
  await expect(routing.clustersPath('missing')).rejects.toThrow(
    "Organization 'missing' was not found.",
  );
  expect(load).toHaveBeenCalledOnce();
});

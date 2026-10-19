import { expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';

function fixture(apiUrl = 'https://api.rawtree.com', deployment = '1234abcd') {
  const calls: { url: URL; headers: Headers }[] = [];
  let failEurope = false;
  let unknownRegion = false;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    if (url.pathname === '/v1/organizations')
      return Response.json({
        organizations: [{ name: 'acme', organization_id: 'org-id' }],
      });
    if (url.pathname.endsWith('/regions'))
      return Response.json({
        regions: [
          {
            id: 'legacy',
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
            deployment_id: deployment,
            enabled: true,
            organization_id: null,
          },
          {
            id: 'duplicate',
            name: 'Duplicate',
            cloud_region: 'eu-west-1',
            deployment_id: deployment,
            enabled: true,
            organization_id: null,
          },
          {
            id: 'bad',
            name: 'Pending',
            cloud_region: 'invalid.region',
            deployment_id: 'bad',
            enabled: true,
            organization_id: null,
          },
          {
            id: 'disabled',
            name: 'Disabled',
            cloud_region: 'ap-south-1',
            deployment_id: '87654321',
            enabled: false,
            organization_id: null,
          },
        ],
      });
    if (url.pathname === '/v1/clusters') {
      const europe = headers.has('X-RawTree-Deployment-Id');
      if (europe && failEurope)
        return Response.json(
          { message: 'Europe unavailable' },
          { status: 503 },
        );
      const cluster = europe
        ? {
            id: 'eu-cluster',
            name: 'europe',
            region_id: unknownRegion ? 'missing' : 'eu',
            deployment_id: 'wrong',
            cloud_region: 'us-east-1',
          }
        : {
            id: 'us-cluster',
            name: 'america',
            region_id: 'legacy',
            s3_storage: { data: { bucket: 'data' } },
          };
      return Response.json({
        organization: { name: 'acme' },
        clusters: [cluster, cluster],
      });
    }
    return Response.json({ data: [] });
  };
  return {
    client: new RawTreeClient({ apiKey: 'session.fixture', apiUrl, fetchFn }),
    calls,
    failEurope: (value: boolean) => {
      failEurope = value;
    },
    unknownRegion: () => {
      unknownRegion = true;
    },
  };
}

it.each([
  '1234abcd',
  '0123456789abcdef0123456789abcdef',
])('merges enabled deployments and resolves authoritative region metadata for %s', async (deployment) => {
  const { client, calls } = fixture('https://api.rawtree.dev', deployment);
  expect(await client.listClusters('acme')).toMatchObject({
    organization: { name: 'acme' },
    clusters: [
      { id: 'us-cluster', s3_storage: { data: { bucket: 'data' } } },
      {
        id: 'eu-cluster',
        deployment_id: deployment,
        cloud_region: 'eu-west-1',
      },
    ],
  });
  const discovery = calls.filter(({ url }) => url.pathname === '/v1/clusters');
  expect(discovery.map(({ url }) => url.hostname)).toEqual([
    'api.rawtree.dev',
    `api.${deployment}.eu-west-1.aws.rawtree.dev`,
  ]);
  await client.listDatabases({ organization: 'acme', cluster: 'europe' });
  expect(calls.at(-1)?.url.hostname).toBe(
    `api.${deployment}.eu-west-1.aws.rawtree.dev`,
  );
  expect(calls.at(-1)?.headers.get('X-RawTree-Region')).toBe('eu-west-1');
  expect(calls.at(-1)?.headers.get('Authorization')).toBe(
    'Bearer session.fixture',
  );
  expect(
    calls.filter(({ url }) => url.pathname === '/v1/clusters'),
  ).toHaveLength(2);
});

it('discovers Europe before the caller lists clusters', async () => {
  const { client, calls } = fixture();
  await client.listDatabases({ organization: 'acme', cluster: 'europe' });
  expect(calls.at(-1)?.url.hostname).toBe(
    'api.1234abcd.eu-west-1.aws.rawtree.com',
  );
});

it.each([
  'http://localhost:8080',
  'https://custom.example.com',
  'https://api.rawtree.com:8443',
])('preserves custom API URL %s while sending routing headers', async (apiUrl) => {
  const { client, calls } = fixture(apiUrl);
  await client.listDatabases({ organization: 'acme', cluster: 'europe' });
  expect(calls.every(({ url }) => url.origin === apiUrl)).toBe(true);
  expect(calls.at(-1)?.headers.get('X-RawTree-Deployment-Id')).toBe('1234abcd');
});

it('does not cache a partial list after regional failure and recovers on retry', async () => {
  const { client, calls, failEurope } = fixture();
  failEurope(true);
  await expect(client.listClusters('acme')).rejects.toThrow(
    'Europe unavailable',
  );
  await expect(
    client.listDatabases({ organization: 'acme', cluster: 'europe' }),
  ).rejects.toThrow('Europe unavailable');
  expect(calls.some(({ url }) => url.pathname === '/v1/databases')).toBe(false);
  failEurope(false);
  await client.listDatabases({ organization: 'acme', cluster: 'europe' });
  expect(calls.at(-1)?.url.hostname).toBe(
    'api.1234abcd.eu-west-1.aws.rawtree.com',
  );
});

it('rejects an unknown region reference before executing a cluster operation', async () => {
  const { client, calls, unknownRegion } = fixture();
  unknownRegion();
  await expect(
    client.listDatabases({ organization: 'acme', cluster: 'europe' }),
  ).rejects.toThrow("Region 'missing'");
  expect(calls.some(({ url }) => url.pathname === '/v1/databases')).toBe(false);
});

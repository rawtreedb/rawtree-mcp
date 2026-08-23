import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RawTreeApiError, RawTreeClient } from '../src/client.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function recordingFetch(
  response: Response,
  calls: RecordedCall[],
): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: input.toString(),
      init: init ?? {},
    });
    return response;
  };
}

describe('RawTreeClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the runtime receiver when using the default fetch', async () => {
    const calls: RecordedCall[] = [];
    const runtimeFetch = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      calls.push({
        url: input.toString(),
        init: init ?? {},
      });
      return Promise.resolve(jsonResponse({ status: 'ok' }));
    });
    vi.stubGlobal('fetch', runtimeFetch);

    const client = new RawTreeClient({ apiKey: 'rt_test' });

    await expect(client.query('SELECT 1')).resolves.toEqual({ status: 'ok' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.rawtree.com/v1/query');
  });

  it('sends authenticated query requests to public API routes', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await expect(client.query('SELECT 1')).resolves.toEqual({ rows: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.rawtree.com/v1/query');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ sql: 'SELECT 1' }));
    expect(calls[0].init.headers).toMatchObject({
      Authorization: 'Bearer rt_test',
      'Content-Type': 'application/json',
      'User-Agent': 'rawtree-mcp/0.3.0',
    });
  });

  it('supports overriding the user agent', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse({ status: 'ok' }), calls),
      userAgent: 'rawtree-mcp-test/1.0.0',
    });

    await client.query('SELECT 1');

    expect(calls[0].init.headers).toMatchObject({
      'User-Agent': 'rawtree-mcp-test/1.0.0',
    });
  });

  it('can use a private API URL override', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      apiUrl: 'https://api.rawtree.test/v1/',
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await client.query('SELECT 1');

    expect(calls[0].url).toBe('https://api.rawtree.test/v1/query');
  });

  it('uses database-scoped query routes when configured', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics db',
      organization: 'acme team',
      fetchFn: recordingFetch(jsonResponse({ tables: [] }), calls),
    });

    await client.listTables();

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables?database=analytics+db&organization=acme+team',
    );
  });

  it('uses per-request organization, cluster, and database scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      organization: 'configured_org',
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await client.query('SELECT 1', {
      organization: 'acme team',
      cluster: 'production',
      database: 'analytics db',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/query?database=analytics+db&organization=acme+team&cluster=production',
    );
  });

  it('omits the database selector so the API can use its default', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await client.query('SELECT 1', {
      organization: 'acme',
      cluster: 'production',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/query?organization=acme&cluster=production',
    );
  });

  it('lists organizations without resource scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      organization: 'acme',
      fetchFn: recordingFetch(jsonResponse({ organizations: [] }), calls),
    });

    await client.listOrganizations();

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/organizations');
  });

  it('lists accepted members of an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse({ members: [] }), calls),
    });

    await expect(client.listOrganizationMembers('acme/team')).resolves.toEqual({
      members: [],
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/organizations/acme%2Fteam/members',
    );
    expect(calls[0].init.method).toBe('GET');
  });

  it('starts adding an organization member by email invitation', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          invited: true,
          invite_link: 'https://rawtree.com/invite/token',
          expires_at_unix: 123,
        }),
        calls,
      ),
    });

    await client.addOrganizationMember({
      organization: 'acme team',
      email: 'member@example.com',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/organizations/acme%20team/members',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({ email: 'member@example.com' }),
    );
  });

  it('updates an organization member role by user ID', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse({ role: 'admin' }), calls),
    });

    await client.updateOrganizationMember({
      organization: 'acme/team',
      userId: 'user/id',
      role: 'admin',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/organizations/acme%2Fteam/members/user%2Fid',
    );
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.body).toBe(JSON.stringify({ role: 'admin' }));
  });

  it('removes an organization member by user ID', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse({ removed: true }), calls),
    });

    await client.removeOrganizationMember({
      organization: 'acme team',
      userId: 'user/id',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/organizations/acme%20team/members/user%2Fid',
    );
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('lists databases in an explicit organization and cluster', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      fetchFn: recordingFetch(jsonResponse({ databases: [] }), calls),
    });

    await client.listDatabases({
      organization: 'acme',
      cluster: 'production',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/databases?organization=acme&cluster=production',
    );
  });

  it('deletes a database by name in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      organization: 'configured_org',
      fetchFn: recordingFetch(jsonResponse({ deleted: true }), calls),
    });

    await expect(
      client.deleteDatabase('analytics db', { organization: 'acme team' }),
    ).resolves.toEqual({ deleted: true });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/databases/analytics%20db?organization=acme+team',
    );
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('appends database scope to existing query params', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      organization: 'acme',
      fetchFn: recordingFetch(new Response('{"event":"started"}\n'), calls),
    });

    await client.insertFromUrl({
      table: 'events',
      url: 'https://example.com/events.jsonl',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables/events?url=https%3A%2F%2Fexample.com%2Fevents.jsonl&database=analytics&organization=acme',
    );
  });

  it('inserts JSON without transform query parameters', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse({ inserted: 1 }), calls),
    });

    await client.insertJson({
      table: 'events',
      data: [{ event: 'signup' }],
    });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/tables/events');
    expect(calls[0].init.body).toBe(JSON.stringify([{ event: 'signup' }]));
  });

  it('returns URL insert streams as text', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(new Response('{"event":"started"}\n'), calls),
    });

    await expect(
      client.insertFromUrl({
        table: 'events',
        url: 'https://example.com/events.jsonl',
      }),
    ).resolves.toBe('{"event":"started"}\n');

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables/events?url=https%3A%2F%2Fexample.com%2Fevents.jsonl',
    );
  });

  it('lists clusters for an organization without database scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      fetchFn: recordingFetch(jsonResponse({ clusters: [] }), calls),
    });

    await expect(client.listClusters('acme team')).resolves.toEqual({
      clusters: [],
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters?organization=acme+team',
    );
    expect(calls[0].init.method).toBe('GET');
  });

  it('lists current cluster creation sizes and replica limits', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      min_number_of_replicas: 1,
      max_number_of_replicas: 2,
      sizes: [{ size: 'large', cpu_cores: 2, memory_gib: 8 }],
      default_min_size: { size: 'large', cpu_cores: 2, memory_gib: 8 },
      default_max_size: { size: 'xlarge', cpu_cores: 4, memory_gib: 16 },
    };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      organization: 'configured-org',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(client.listClusterSizes()).resolves.toEqual(response);

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/clusters/sizes');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('creates a cluster with frontend-aligned autoscaling configuration', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster-id', name: 'production' }),
        calls,
      ),
    });

    await expect(
      client.createCluster({
        organization: 'acme',
        name: 'production',
        replicas: 2,
        minimumSize: { cpuCores: 4, memoryGiB: 16 },
        maximumSize: { cpuCores: 8, memoryGiB: 32 },
      }),
    ).resolves.toEqual({ id: 'cluster-id', name: 'production' });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters?organization=acme',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        name: 'production',
        replicas: 2,
        size: {
          cpu_cores: 4,
          memory_gib: 16,
        },
        autoscaling: {
          min_size: {
            cpu_cores: 4,
            memory_gib: 16,
          },
          max_size: {
            cpu_cores: 8,
            memory_gib: 32,
          },
        },
      }),
    );
  });

  it('gets one cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster/id', name: 'production' }),
        calls,
      ),
    });

    await expect(
      client.getCluster({
        organization: 'acme team',
        clusterId: 'cluster/id',
      }),
    ).resolves.toEqual({ id: 'cluster/id', name: 'production' });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters/cluster%2Fid?organization=acme+team',
    );
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('pauses a cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster/id', status: { phase: 'pausing' } }),
        calls,
      ),
    });

    await expect(
      client.pauseCluster({
        organization: 'acme team',
        clusterId: 'cluster/id',
      }),
    ).resolves.toEqual({
      id: 'cluster/id',
      status: { phase: 'pausing' },
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters/cluster%2Fid/stop?organization=acme+team',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('resumes a cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster-id', status: { phase: 'resuming' } }),
        calls,
      ),
    });

    await expect(
      client.resumeCluster({
        organization: 'acme',
        clusterId: 'cluster-id',
      }),
    ).resolves.toEqual({
      id: 'cluster-id',
      status: { phase: 'resuming' },
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters/cluster-id/resume?organization=acme',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('lists apps and installation state for a cluster', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          cluster: { id: 'cluster/id', name: 'production' },
          apps: [{ id: 'prometheus', name: 'Prometheus', installed: true }],
        }),
        calls,
      ),
    });

    await expect(
      client.listApps({
        organization: 'acme team',
        cluster: 'production cluster',
      }),
    ).resolves.toMatchObject({
      apps: [{ id: 'prometheus', installed: true }],
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/apps?organization=acme+team&cluster=production+cluster',
    );
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('installs an app on a cluster', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          id: 'opentelemetry/app',
          name: 'OpenTelemetry',
          installed: true,
        }),
        calls,
      ),
    });

    await expect(
      client.installApp({
        organization: 'acme team',
        cluster: 'production cluster',
        appId: 'opentelemetry/app',
      }),
    ).resolves.toMatchObject({ installed: true });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/apps/opentelemetry%2Fapp?organization=acme+team&cluster=production+cluster',
    );
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('uninstalls an app from a cluster', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          id: 'prometheus/app',
          name: 'Prometheus',
          installed: false,
        }),
        calls,
      ),
    });

    await expect(
      client.uninstallApp({
        organization: 'acme team',
        cluster: 'production cluster',
        appId: 'prometheus/app',
      }),
    ).resolves.toMatchObject({ installed: false });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/apps/prometheus%2Fapp?organization=acme+team&cluster=production+cluster',
    );
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('throws RawTreeApiError with API message and hint', async () => {
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(
        jsonResponse(
          {
            error: 'bad_request',
            message: 'Invalid table name.',
            hint: 'Use a valid identifier.',
          },
          400,
        ),
        [],
      ),
    });

    await expect(client.describeTable('bad-table')).rejects.toMatchObject({
      name: 'RawTreeApiError',
      status: 400,
      message: 'Invalid table name. Use a valid identifier.',
    } satisfies Partial<RawTreeApiError>);
  });
});

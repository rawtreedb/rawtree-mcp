import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { type RawTreeApiError, RawTreeClient } from '../src/client.js';
import { clusterId, expectTenantHeaders, organizationId } from './fixtures.js';

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
      'User-Agent': `rawtree-mcp/${packageJson.version}`,
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
      organization: organizationId,
      fetchFn: recordingFetch(jsonResponse({ tables: [] }), calls),
    });

    await client.listTables();

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables?database=analytics+db',
    );
    expectTenantHeaders(calls[0].init, { organization: organizationId });
  });

  it('creates a table with cluster default storage', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      database: 'analytics',
      table: 'events',
      storage: { type: 'default' },
    };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.createTable(
        { name: 'events' },
        {
          organization: organizationId,
          cluster: clusterId,
          database: 'analytics',
        },
      ),
    ).resolves.toEqual(response);

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables?database=analytics',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ name: 'events' }));
  });

  it('creates a table with an explicit sorting key', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      database: 'analytics',
      table: 'events',
      storage: { type: 'default' },
      sorting_key: 'region, ifNull(cityHash64(host, instanceId), 0)',
    };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.createTable(
        {
          name: 'events',
          sortingKey: 'region, ifNull(cityHash64(host, instanceId), 0)',
        },
        {
          organization: organizationId,
          cluster: clusterId,
          database: 'analytics',
        },
      ),
    ).resolves.toEqual(response);

    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        name: 'events',
        sorting_key: 'region, ifNull(cityHash64(host, instanceId), 0)',
      }),
    );
  });

  it('updates a table sorting key by name', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      database: 'analytics',
      table: 'events',
      sorting_key: 'toStartOfHour(timestamp), region',
    };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.updateTable(
        'events',
        { sortingKey: 'toStartOfHour(timestamp), region' },
        { organization: organizationId, cluster: clusterId },
      ),
    ).resolves.toEqual(response);

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/tables/events');
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.body).toBe(
      JSON.stringify({ sorting_key: 'toStartOfHour(timestamp), region' }),
    );
  });

  it('uses per-request organization, cluster, and database scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      organization: organizationId,
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await client.query('SELECT 1', {
      organization: organizationId,
      cluster: clusterId,
      database: 'analytics db',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/query?database=analytics+db',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
  });

  it('omits the database selector so the API can use its default', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse({ rows: 1 }), calls),
    });

    await client.query('SELECT 1', {
      organization: organizationId,
      cluster: clusterId,
    });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/query');
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
  });

  describe('name resolution', () => {
    function resolvingClient(credentialScope: 'cluster' | 'user' = 'user') {
      const calls: RecordedCall[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url: String(input), init: init ?? {} });
        if (url.pathname === '/v1/organizations')
          return jsonResponse({
            organizations: [
              { name: 'acme', organization_id: organizationId },
              {
                name: 'other',
                organization_id: '00000000-0000-4000-8000-0000000000c1',
              },
            ],
          });
        if (url.pathname === '/v1/regions')
          return jsonResponse({
            regions: [
              {
                id: 'legacy',
                name: 'Virginia',
                cloud_region: 'us-east-1',
                deployment_id: null,
                enabled: true,
                organization_id: null,
              },
            ],
          });
        if (url.pathname === '/v1/clusters')
          return jsonResponse({
            clusters: [{ id: clusterId, name: 'production' }],
          });
        return jsonResponse({ tables: [] });
      };
      return {
        calls,
        client: new RawTreeClient({
          apiKey: credentialScope === 'cluster' ? 'rt_test' : 'jwt_test',
          credentialScope,
          fetchFn,
        }),
      };
    }

    it('resolves organization and cluster names to IDs on the wire, once per client', async () => {
      const { client, calls } = resolvingClient();
      const named = { organization: 'acme', cluster: 'production' };

      await client.listTables(named);
      await client.listTables(named);

      const tables = calls.filter(({ url }) => url.includes('/v1/tables'));
      expect(tables).toHaveLength(2);
      for (const call of tables) expectTenantHeaders(call.init);
      expect(
        calls.filter(({ url }) => url.endsWith('/v1/organizations')),
      ).toHaveLength(1);
      expect(
        calls.filter(({ url }) => url.endsWith('/v1/clusters')),
      ).toHaveLength(1);
      for (const { url, init } of calls) {
        expect(url).not.toMatch(/acme|production/);
        expect(JSON.stringify(init.headers)).not.toMatch(/acme|production/);
      }
    });

    it('passes UUIDs through without any lookup', async () => {
      const { client, calls } = resolvingClient();

      await client.listTables({
        organization: organizationId,
        cluster: clusterId,
      });

      expect(calls).toHaveLength(1);
      expectTenantHeaders(calls[0].init);
    });

    it('puts a resolved organization ID in organization paths', async () => {
      const { client, calls } = resolvingClient();

      await client.listOrganizationMembers('acme');

      expect(calls.at(-1)?.url).toBe(
        `https://api.rawtree.com/v1/organizations/${organizationId}/members`,
      );
    });

    it('sends resolved IDs as metrics query parameters', async () => {
      const { client, calls } = resolvingClient();

      await client.getConnectorMetrics('c1', {
        organization: 'acme',
        cluster: 'production',
      });

      const url = new URL(calls.at(-1)?.url ?? '');
      expect(url.searchParams.get('organization_id')).toBe(organizationId);
      expect(url.searchParams.get('cluster_id')).toBe(clusterId);
    });

    it.each([
      [{ organization: 'missing' }, "Organization 'missing' was not found"],
      [
        { organization: 'acme', cluster: 'missing' },
        "Cluster 'missing' was not found",
      ],
    ])('fails clearly for an unknown name %j without calling the target route', async (scope, message) => {
      const { client, calls } = resolvingClient();

      await expect(client.listTables(scope)).rejects.toThrow(message);
      expect(calls.some(({ url }) => url.includes('/v1/tables'))).toBe(false);
    });

    describe('with an API key', () => {
      it('resolves cluster and organization names through the key, once per client', async () => {
        const { client, calls } = resolvingClient('cluster');
        const named = { organization: 'acme', cluster: 'production' };

        await client.listTables(named);
        await client.listTables(named);

        expect(
          calls.filter(({ url }) => url.endsWith('/v1/organizations')),
        ).toHaveLength(1);
        expect(
          calls.filter(({ url }) => url.endsWith('/v1/clusters')),
        ).toHaveLength(1);
        const tables = calls.filter(({ url }) => url.includes('/v1/tables'));
        expect(tables).toHaveLength(2);
        for (const call of tables) expectTenantHeaders(call.init);
      });

      it('puts the resolved organization ID in organization paths', async () => {
        const { client, calls } = resolvingClient('cluster');

        await client.listOrganizationMembers('acme');

        expect(calls.at(-1)?.url).toBe(
          `https://api.rawtree.com/v1/organizations/${organizationId}/members`,
        );
      });

      it("rejects an organization name that is not the key's organization", async () => {
        const { client, calls } = resolvingClient('cluster');

        await expect(
          client.listTables({ organization: 'missing' }),
        ).rejects.toThrow(
          "Organization 'missing' does not match the API key's organization.",
        );
        expect(calls.some(({ url }) => url.includes('/v1/tables'))).toBe(false);
      });

      it('rejects a cluster name that is not the bound cluster', async () => {
        const { client, calls } = resolvingClient('cluster');

        await expect(client.listTables({ cluster: 'staging' })).rejects.toThrow(
          "The API key is not bound to cluster 'staging'.",
        );
        expect(calls.some(({ url }) => url.includes('/v1/tables'))).toBe(false);
      });

      it('passes UUIDs straight into headers without any lookup', async () => {
        const { client, calls } = resolvingClient('cluster');

        await client.listTables({
          organization: organizationId,
          cluster: clusterId,
        });

        expect(calls).toHaveLength(1);
        expectTenantHeaders(calls[0].init);
      });
    });

    it('needs an organization to resolve a cluster name', async () => {
      const { client } = resolvingClient();

      await expect(
        client.listTables({ cluster: 'production' }),
      ).rejects.toThrow('Provide organization');
    });
  });

  it('never sends organization or cluster names as query parameters', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      organization: organizationId,
      cluster: clusterId,
      fetchFn: recordingFetch(jsonResponse({ tables: [] }), calls),
    });

    await client.listTables();

    const url = new URL(calls[0].url);
    expect(url.searchParams.has('organization')).toBe(false);
    expect(url.searchParams.has('cluster')).toBe(false);
    expectTenantHeaders(calls[0].init);
  });

  it('lists organizations without resource scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      organization: organizationId,
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

    await expect(
      client.listOrganizationMembers(organizationId),
    ).resolves.toEqual({
      members: [],
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/members`,
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
      organization: organizationId,
      email: 'member@example.com',
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/members`,
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
      organization: organizationId,
      userId: 'user/id',
      role: 'admin',
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/members/user%2Fid`,
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
      organization: organizationId,
      userId: 'user/id',
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/members/user%2Fid`,
    );
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('lists databases in an explicit organization and cluster', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      fetchFn: recordingFetch(
        jsonResponse({
          organization: { name: 'acme' },
          databases: [
            {
              name: 'analytics',
              s3_storage: {
                data: { bucket: 'acme-data', path: 'rawtree/data' },
                backups: { bucket: 'acme-backups', path: 'rawtree/backups' },
              },
            },
          ],
        }),
        calls,
      ),
    });

    await expect(
      client.listDatabases({
        organization: organizationId,
        cluster: clusterId,
      }),
    ).resolves.toMatchObject({
      databases: [
        expect.objectContaining({
          s3_storage: expect.objectContaining({
            data: { bucket: 'acme-data', path: 'rawtree/data' },
          }),
        }),
      ],
    });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/databases');
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
  });

  it('creates a database with optional customer-owned S3 storage', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      organization: { name: 'acme' },
      database: { name: 'analytics' },
    };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.createDatabase(
        {
          name: 'analytics',
          s3Storage: {
            data: { bucket: 'acme-data', path: 'rawtree/data' },
            backups: { bucket: 'acme-backups', path: '' },
            roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
          },
        },
        { organization: organizationId, cluster: clusterId },
      ),
    ).resolves.toEqual(response);

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/databases');
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        name: 'analytics',
        s3_storage: {
          data: { bucket: 'acme-data', path: 'rawtree/data' },
          backups: { bucket: 'acme-backups', path: '' },
          role_arn: 'arn:aws:iam::123456789012:role/RawTreeS3',
        },
      }),
    );
  });

  it('verifies customer-owned S3 storage for a database', async () => {
    const calls: RecordedCall[] = [];
    const response = { verified: true, message: 'S3 access verified.' };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.verifyDatabaseS3Access(
        {
          name: 'analytics',
          s3Storage: {
            data: { bucket: 'acme-data', path: 'rawtree/data' },
            backups: { bucket: 'acme-backups', path: 'rawtree/backups' },
            roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
          },
        },
        { organization: organizationId, cluster: clusterId },
      ),
    ).resolves.toEqual(response);

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/databases/verify-s3-access',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        name: 'analytics',
        s3_storage: {
          data: { bucket: 'acme-data', path: 'rawtree/data' },
          backups: { bucket: 'acme-backups', path: 'rawtree/backups' },
          role_arn: 'arn:aws:iam::123456789012:role/RawTreeS3',
        },
      }),
    );
  });

  it('deletes a database by name in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'configured_database',
      organization: organizationId,
      fetchFn: recordingFetch(jsonResponse({ deleted: true }), calls),
    });

    await expect(
      client.deleteDatabase('analytics db', {
        organization: organizationId,
        cluster: clusterId,
      }),
    ).resolves.toEqual({ deleted: true });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/databases/analytics%20db',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('appends database scope to existing query params', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      database: 'analytics',
      organization: organizationId,
      fetchFn: recordingFetch(jsonResponse({ inserted: 1 }), calls),
    });

    await client.insertFromUrl({
      table: 'events',
      url: 'https://example.com/events.jsonl',
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables/events?url=https%3A%2F%2Fexample.com%2Fevents.jsonl&database=analytics',
    );
    expectTenantHeaders(calls[0].init, { organization: organizationId });
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

  it.each([
    1,
    null,
  ])('returns the completed URL insert result with count %s', async (inserted) => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse({ inserted }), calls),
    });

    await expect(
      client.insertFromUrl({
        table: 'events',
        url: 'https://example.com/events.jsonl',
      }),
    ).resolves.toEqual({ inserted });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables/events?url=https%3A%2F%2Fexample.com%2Fevents.jsonl',
    );
  });

  it('lists clusters for an organization without database scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      database: 'analytics',
      fetchFn: recordingFetch(jsonResponse({ clusters: [] }), calls),
    });

    await expect(client.listClusters(organizationId)).resolves.toEqual({
      clusters: [],
    });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/clusters');
    expectTenantHeaders(calls[0].init, { organization: organizationId });
    expect(calls[0].init.method).toBe('GET');
  });

  it('preserves the platform cluster s3_storage metadata response', async () => {
    const calls: RecordedCall[] = [];
    const response = {
      organization: { name: 'acme' },
      clusters: [
        {
          id: 'cluster-id',
          name: 'production',
          s3_storage: {
            data: { bucket: 'acme-rawtree-data', path: 'rawtree/data' },
            backups: {
              bucket: 'acme-rawtree-backups',
              path: 'rawtree/backups',
            },
          },
          s3_storage_access: {
            external_id: 'rawtree-acme-production',
            resource_tag: 'rawtree-acme-database',
          },
        },
      ],
    };
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(client.listClusters(organizationId)).resolves.toEqual(
      response,
    );
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
      organization: organizationId,
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
        regionId: '11111111-1111-4111-8111-111111111111',
        organization: organizationId,
        name: 'production',
        s3StorageAccess: {
          externalId: 'rawtree-acme-production',
          resourceTag: 'rawtree-acme-database',
        },
        replicas: 2,
        minimumSize: { cpuCores: 4, memoryGiB: 16 },
        maximumSize: { cpuCores: 8, memoryGiB: 32 },
        idleTimeoutMinutes: 30,
      }),
    ).resolves.toEqual({ id: 'cluster-id', name: 'production' });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/clusters');
    expectTenantHeaders(calls[0].init, { organization: organizationId });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        region_id: '11111111-1111-4111-8111-111111111111',
        name: 'production',
        s3_storage_access: {
          external_id: 'rawtree-acme-production',
          resource_tag: 'rawtree-acme-database',
        },
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
        idle_timeout_minutes: 30,
      }),
    );
  });

  it('creates a cluster with optional customer-owned S3 configuration', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster-id', name: 'production' }),
        calls,
      ),
    });

    await client.createCluster({
      regionId: '11111111-1111-4111-8111-111111111111',
      organization: organizationId,
      name: 'production',
      s3StorageAccess: {
        externalId: 'rawtree-acme-production',
        resourceTag: 'rawtree-acme-database',
      },
      replicas: 2,
      minimumSize: { cpuCores: 4, memoryGiB: 16 },
      maximumSize: { cpuCores: 8, memoryGiB: 32 },
      s3Storage: {
        data: { bucket: 'acme-rawtree-data', path: 'cluster-data' },
        backups: { bucket: 'acme-rawtree-backups', path: '' },
        roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
      },
    });

    expect(calls[0].init.body).toBe(
      JSON.stringify({
        region_id: '11111111-1111-4111-8111-111111111111',
        name: 'production',
        s3_storage_access: {
          external_id: 'rawtree-acme-production',
          resource_tag: 'rawtree-acme-database',
        },
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
        s3_storage: {
          data: { bucket: 'acme-rawtree-data', path: 'cluster-data' },
          backups: { bucket: 'acme-rawtree-backups', path: '' },
          role_arn: 'arn:aws:iam::123456789012:role/RawTreeS3',
        },
      }),
    );
  });

  it('creates a managed-storage cluster with explicit identity', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: 'cluster-id', name: 'production' }),
        calls,
      ),
    });

    await client.createCluster({
      regionId: '11111111-1111-4111-8111-111111111111',
      organization: organizationId,
      name: 'production',
      s3StorageAccess: {
        externalId: 'rawtree-acme-production',
        resourceTag: 'rawtree-acme-database',
      },
      replicas: 1,
      minimumSize: { cpuCores: 2, memoryGiB: 8 },
      maximumSize: { cpuCores: 4, memoryGiB: 16 },
    });

    expect(calls[0].init.body).toBe(
      JSON.stringify({
        region_id: '11111111-1111-4111-8111-111111111111',
        name: 'production',
        s3_storage_access: {
          external_id: 'rawtree-acme-production',
          resource_tag: 'rawtree-acme-database',
        },
        replicas: 1,
        size: {
          cpu_cores: 2,
          memory_gib: 8,
        },
        autoscaling: {
          min_size: {
            cpu_cores: 2,
            memory_gib: 8,
          },
          max_size: {
            cpu_cores: 4,
            memory_gib: 16,
          },
        },
      }),
    );
  });

  it('verifies customer-owned S3 access before cluster creation', async () => {
    const calls: RecordedCall[] = [];
    const response = { verified: true, message: 'S3 access verified.' };
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(jsonResponse(response), calls),
    });

    await expect(
      client.verifyClusterS3Access({
        organization: organizationId,
        s3StorageAccess: { externalId: 'rawtree-acme-production' },
        s3Storage: {
          data: { bucket: 'acme-rawtree-data', path: 'cluster-data' },
          backups: { bucket: 'acme-rawtree-backups', path: 'backups' },
          roleArn: 'arn:aws:iam::123456789012:role/RawTreeS3',
        },
      }),
    ).resolves.toEqual(response);

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/clusters/verify-s3-access',
    );
    expectTenantHeaders(calls[0].init, { organization: organizationId });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(
      JSON.stringify({
        s3_storage_access: { external_id: 'rawtree-acme-production' },
        s3_storage: {
          data: { bucket: 'acme-rawtree-data', path: 'cluster-data' },
          backups: { bucket: 'acme-rawtree-backups', path: 'backups' },
          role_arn: 'arn:aws:iam::123456789012:role/RawTreeS3',
        },
      }),
    );
  });

  it('gets one cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: clusterId, name: 'production' }),
        calls,
      ),
    });

    await expect(
      client.getCluster({
        organization: organizationId,
        clusterId: clusterId,
      }),
    ).resolves.toEqual({ id: clusterId, name: 'production' });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/clusters/${clusterId}`,
    );
    expectTenantHeaders(calls[0].init);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('updates a cluster idle timeout by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          id: clusterId,
          name: 'production',
          idle_timeout_minutes: 0,
        }),
        calls,
      ),
    });

    await expect(
      client.updateCluster({
        organization: organizationId,
        clusterId: clusterId,
        idleTimeoutMinutes: 0,
      }),
    ).resolves.toMatchObject({
      id: clusterId,
      idle_timeout_minutes: 0,
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/clusters/${clusterId}`,
    );
    expectTenantHeaders(calls[0].init);
    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.body).toBe(
      JSON.stringify({ idle_timeout_minutes: 0 }),
    );
  });

  it('pauses a cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: clusterId, status: { phase: 'pausing' } }),
        calls,
      ),
    });

    await expect(
      client.pauseCluster({
        organization: organizationId,
        clusterId: clusterId,
      }),
    ).resolves.toEqual({
      id: clusterId,
      status: { phase: 'pausing' },
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/clusters/${clusterId}/stop`,
    );
    expectTenantHeaders(calls[0].init);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('resumes a cluster by ID in an organization', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'jwt_test',
      fetchFn: recordingFetch(
        jsonResponse({ id: clusterId, status: { phase: 'resuming' } }),
        calls,
      ),
    });

    await expect(
      client.resumeCluster({
        organization: organizationId,
        clusterId: clusterId,
      }),
    ).resolves.toEqual({
      id: clusterId,
      status: { phase: 'resuming' },
    });

    expect(calls[0].url).toBe(
      `https://api.rawtree.com/v1/clusters/${clusterId}/resume`,
    );
    expectTenantHeaders(calls[0].init);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeUndefined();
  });

  describe('cluster tools by name or ID', () => {
    function clusterClient(credentialScope: 'cluster' | 'user' = 'user') {
      const calls: RecordedCall[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url: String(input), init: init ?? {} });
        if (url.pathname === '/v1/organizations')
          return jsonResponse({
            organizations: [{ name: 'acme', organization_id: organizationId }],
          });
        if (url.pathname === '/v1/regions')
          return jsonResponse({
            regions: [
              {
                id: 'legacy',
                name: 'Virginia',
                cloud_region: 'us-east-1',
                deployment_id: null,
                enabled: true,
                organization_id: null,
              },
            ],
          });
        if (url.pathname === '/v1/clusters')
          return jsonResponse({
            clusters: [{ id: clusterId, name: 'production' }],
          });
        return jsonResponse({ id: clusterId });
      };
      return {
        calls,
        client: new RawTreeClient({
          apiKey: credentialScope === 'cluster' ? 'rt_test' : 'jwt_test',
          credentialScope,
          fetchFn,
        }),
      };
    }

    it.each([
      ['getCluster', 'GET', ''],
      ['pauseCluster', 'POST', '/stop'],
      ['resumeCluster', 'POST', '/resume'],
    ] as const)('%s resolves a cluster name to its ID in the path', async (method, verb, suffix) => {
      for (const credentialScope of ['user', 'cluster'] as const) {
        const { client, calls } = clusterClient(credentialScope);

        await client[method]({ organization: 'acme', clusterId: 'production' });

        const last = calls.at(-1);
        expect(last?.url).toBe(
          `https://api.rawtree.com/v1/clusters/${clusterId}${suffix}`,
        );
        expect(last?.init.method).toBe(verb);
        expectTenantHeaders(last?.init ?? {});
      }
    });

    it('updateCluster resolves a cluster name to its ID in the path', async () => {
      const { client, calls } = clusterClient();

      await client.updateCluster({
        organization: 'acme',
        clusterId: 'production',
        idleTimeoutMinutes: 30,
      });

      expect(calls.at(-1)?.url).toBe(
        `https://api.rawtree.com/v1/clusters/${clusterId}`,
      );
    });

    it('passes a UUID through without looking up clusters', async () => {
      const { client, calls } = clusterClient();

      await client.getCluster({
        organization: organizationId,
        clusterId,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(
        `https://api.rawtree.com/v1/clusters/${clusterId}`,
      );
    });

    it.each([
      'user',
      'cluster',
    ] as const)('fails for an unknown cluster name with %s credentials without calling the cluster route', async (credentialScope) => {
      const { client, calls } = clusterClient(credentialScope);

      await expect(
        client.pauseCluster({ organization: 'acme', clusterId: 'staging' }),
      ).rejects.toThrow(/staging/);
      expect(calls.some(({ url }) => url.endsWith('/stop'))).toBe(false);
    });
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
        organization: organizationId,
        cluster: clusterId,
      }),
    ).resolves.toMatchObject({
      apps: [{ id: 'prometheus', installed: true }],
    });

    expect(calls[0].url).toBe('https://api.rawtree.com/v1/apps');
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
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
        organization: organizationId,
        cluster: clusterId,
        appId: 'opentelemetry/app',
      }),
    ).resolves.toMatchObject({ installed: true });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/apps/opentelemetry%2Fapp',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
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
        organization: organizationId,
        cluster: clusterId,
        appId: 'prometheus/app',
      }),
    ).resolves.toMatchObject({ installed: false });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/apps/prometheus%2Fapp',
    );
    expectTenantHeaders(calls[0].init, {
      organization: organizationId,
      cluster: clusterId,
    });
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

vi.mock('../src/client/routing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client/routing.js')>()),
  ClusterRouting: class {
    async headers() {
      return {};
    }
    clear() {}
    remember() {}
  },
}));

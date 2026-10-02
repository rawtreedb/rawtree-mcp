import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient, type RawTreeClientOptions } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const scope = { organization: 'acme team', cluster: 'production/eu' };
const savedQuery = {
  id: '00000000-0000-4000-8000-000000000001',
  organization_id: '00000000-0000-4000-8000-000000000002',
  cluster_id: '00000000-0000-4000-8000-000000000003',
  user_id: '00000000-0000-4000-8000-000000000004',
  name: 'Recent events',
  sql: ' SELECT * FROM events LIMIT 10;\n',
  database: 'analytics',
  visibility: 'private',
  created_at: '2026-10-02T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
};
const createInput = {
  name: savedQuery.name,
  sql: savedQuery.sql,
  database: savedQuery.database,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonContent(value: unknown) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

describe('saved-query MCP tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(
    responses: Response[] = [],
    requireExplicitScope = true,
    defaults: Partial<RawTreeClientOptions> = {},
  ) {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected API request.');
      return response;
    });
    const rawtree = new RawTreeClient({
      apiKey: 'oauth_test',
      ...defaults,
      fetchFn,
    });
    const server = createMcpServer(rawtree, { requireExplicitScope });
    const client = new Client({ name: 'saved-query-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, fetchFn };
  }

  it.each([
    true,
    false,
  ])('advertises the agreed schemas (explicit scope: %s)', async (explicit) => {
    const { client } = await connect([], explicit);
    const { tools } = await client.listTools();
    for (const name of [
      'list-saved-queries',
      'save-query',
      'delete-saved-query',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const required = [
        ...(explicit ? ['organization', 'cluster'] : []),
        ...(name === 'delete-saved-query' ? ['id'] : []),
      ];
      expect(tool?.inputSchema.required ?? []).toEqual(required);
      expect(tool?.inputSchema.properties).not.toHaveProperty('user_id');
      expect(tool?.inputSchema.properties).not.toHaveProperty('nextCursor');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: name === 'list-saved-queries',
        destructiveHint: name !== 'list-saved-queries',
        idempotentHint: name !== 'save-query',
      });
    }
    expect(
      tools.find((tool) => tool.name === 'list-saved-queries')?.inputSchema
        .properties,
    ).not.toHaveProperty('database');
  });

  it('lists all definitions with cluster scope and no default database or pagination', async () => {
    const body = {
      queries: [
        savedQuery,
        {
          ...savedQuery,
          id: '00000000-0000-4000-8000-000000000005',
          database: 'other',
          visibility: 'cluster',
        },
      ],
    };
    const { client, fetchFn } = await connect([jsonResponse(body)], true, {
      database: 'configured_db',
    });
    const result = await client.callTool({
      name: 'list-saved-queries',
      arguments: scope,
    });
    expect(result).toMatchObject({ content: jsonContent(body) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      'https://api.rawtree.com/v1/saved-queries?organization=acme+team&cluster=production%2Feu',
    );
    expect(fetchFn.mock.calls[0][1]?.method).toBe('GET');
  });

  it('returns an empty query list unchanged', async () => {
    const { client } = await connect([jsonResponse({ queries: [] })]);
    expect(
      await client.callTool({ name: 'list-saved-queries', arguments: scope }),
    ).toMatchObject({ content: jsonContent({ queries: [] }) });
  });

  it('creates with the stored database in the body and leaves ownership and default visibility to the API', async () => {
    const { client, fetchFn } = await connect(
      [jsonResponse(savedQuery, 201)],
      false,
      { ...scope, database: 'configured_db' },
    );
    const result = await client.callTool({
      name: 'save-query',
      arguments: createInput,
    });
    expect(result).toMatchObject({ content: jsonContent(savedQuery) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      'https://api.rawtree.com/v1/saved-queries?organization=acme+team&cluster=production%2Feu',
    );
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(createInput),
      headers: { Authorization: 'Bearer oauth_test' },
    });
  });

  it.each([
    { name: 'Renamed' },
    { sql: 'SELECT 2' },
    { database: 'other' },
    { visibility: 'cluster' },
  ])('patches only supplied fields: %j', async (patch) => {
    const updated = { ...savedQuery, ...patch };
    const { client, fetchFn } = await connect([jsonResponse(updated)], true, {
      database: 'must_not_override',
    });
    expect(
      await client.callTool({
        name: 'save-query',
        arguments: { ...scope, id: savedQuery.id, ...patch },
      }),
    ).toMatchObject({ content: jsonContent(updated) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      `https://api.rawtree.com/v1/saved-queries/${savedQuery.id}?organization=acme+team&cluster=production%2Feu`,
    );
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  });

  it('creates a cluster-shared query when requested', async () => {
    const { client, fetchFn } = await connect([
      jsonResponse({ ...savedQuery, visibility: 'cluster' }, 201),
    ]);
    await client.callTool({
      name: 'save-query',
      arguments: { ...scope, ...createInput, visibility: 'cluster' },
    });
    expect(fetchFn.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ ...createInput, visibility: 'cluster' }),
    );
  });

  it.each([
    {},
    { name: 'Missing SQL and database' },
    { ...createInput, database: undefined },
    { ...createInput, name: undefined },
    { id: savedQuery.id },
    { ...createInput, visibility: 'public' },
    { ...createInput, id: 'invalid' },
    ...['name', 'sql', 'database', 'visibility', 'id'].map((field) => ({
      ...createInput,
      [field]: null,
    })),
  ])('rejects invalid saves before making an API request: %j', async (input) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'save-query',
      arguments: { ...scope, ...input },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    'list-saved-queries',
    'save-query',
    'delete-saved-query',
  ])('requires explicit scope for %s in hosted deployments', async (name) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name,
      arguments: { ...createInput, id: savedQuery.id },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('confirms deletion only after a successful empty 204 response', async () => {
    const { client, fetchFn } = await connect([
      new Response(null, { status: 204 }),
    ]);
    expect(
      await client.callTool({
        name: 'delete-saved-query',
        arguments: { ...scope, id: savedQuery.id },
      }),
    ).toMatchObject({
      content: jsonContent({ id: savedQuery.id, deleted: true }),
    });
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      `https://api.rawtree.com/v1/saved-queries/${savedQuery.id}?organization=acme+team&cluster=production%2Feu`,
    );
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      body: undefined,
    });
  });

  it.each([
    [
      'save-query',
      401,
      'This action requires a user session. API keys aren’t supported.',
    ],
    [
      'delete-saved-query',
      404,
      'Check the query ID, organization, cluster, and your access.',
    ],
    [
      'list-saved-queries',
      403,
      'Reading saved queries requires read permission.',
    ],
  ] as const)('surfaces API errors from %s without claiming success', async (name, status, hint) => {
    const { client, fetchFn } = await connect(
      [
        jsonResponse(
          { error: 'test_error', message: 'Request rejected.', hint },
          status,
        ),
      ],
      true,
      { apiKey: 'rt_test' },
    );
    const result = await client.callTool({
      name,
      arguments: { ...scope, ...createInput, id: savedQuery.id },
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining(hint) }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('runs saved SQL only through a separate run-query call', async () => {
    const rows = {
      meta: [{ name: 'count', type: 'UInt64' }],
      data: [{ count: '2' }],
      rows: 1,
      statistics: {},
    };
    const { client, fetchFn } = await connect([
      jsonResponse({ queries: [savedQuery] }),
      jsonResponse(rows),
    ]);
    await client.callTool({ name: 'list-saved-queries', arguments: scope });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(
      await client.callTool({
        name: 'run-query',
        arguments: {
          ...scope,
          sql: savedQuery.sql,
          database: savedQuery.database,
        },
      }),
    ).toMatchObject({ content: jsonContent(rows) });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const url = new URL(fetchFn.mock.calls[1][0].toString());
    expect(url.pathname).toBe('/v1/query');
    expect(url.searchParams.get('database')).toBe(savedQuery.database);
    expect(fetchFn.mock.calls[1][1]?.body).toBe(
      JSON.stringify({ sql: savedQuery.sql }),
    );
  });
});

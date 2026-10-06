import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const scope = { organization: 'acme team', cluster: 'production/eu' };
const id = '00000000-0000-4000-8000-000000000001';
const sinkId = '00000000-0000-4000-8000-000000000002';
const input = {
  name: 'recent-events',
  database: 'analytics',
  sql: ' SELECT 1 AS value;\n',
};
const workflow = {
  ...input,
  id,
  enabled: false,
  interval_seconds: 60,
  revision: 1,
  sinks: [
    {
      type: 'http',
      id: sinkId,
      url_configured: true,
      header_names: ['Authorization'],
    },
  ],
  created_at: '2026-10-05T10:00:00Z',
  updated_at: '2026-10-05T10:00:00Z',
};
const names = [
  'list-workflows',
  'get-workflow',
  'create-workflow',
  'update-workflow',
  'delete-workflow',
];
const apiUrl = 'https://api.rawtree.com/v1/workflows';
const query = '?organization=acme+team&cluster=production%2Feu';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const content = (body: unknown) => [
  { type: 'text', text: JSON.stringify(body, null, 2) },
];

describe('workflow MCP tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((c) => c.close()));
  });

  async function connect(
    responses: Response[] = [],
    requireExplicitScope = true,
    apiKey = 'rt_admin_test',
  ) {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected API request.');
      return response;
    });
    const rawtree = new RawTreeClient({
      apiKey,
      database: 'must_not_leak',
      organization: 'configured_org',
      cluster: 'configured_cluster',
      fetchFn,
    });
    const server = createMcpServer(rawtree, { requireExplicitScope });
    const client = new Client({ name: 'workflow-test', version: '0.0.0' });
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
  ])('advertises all five tools with explicit scope, seconds, and effect annotations (%s)', async (explicit) => {
    const { client } = await connect([], explicit);
    const { tools } = await client.listTools();
    for (const name of names) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(
        expect.arrayContaining(['organization', 'cluster']),
      );
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.inputSchema.properties).not.toHaveProperty('interval_ms');
      const read = name === 'list-workflows' || name === 'get-workflow';
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: read,
        destructiveHint: !read,
        idempotentHint: read || name === 'delete-workflow',
      });
    }
    expect(
      tools.filter((t) => t.name.includes('workflow')).map((t) => t.name),
    ).toEqual(names);
    expect(tools.some((t) => t.name.includes('trigger'))).toBe(false);
    const create = tools.find((t) => t.name === 'create-workflow');
    expect(create?.inputSchema.required).toEqual([
      'organization',
      'cluster',
      'name',
      'database',
      'sql',
    ]);
    expect(create?.inputSchema.properties.interval_seconds).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 86400,
    });
    expect(
      tools.find((t) => t.name === 'update-workflow')?.inputSchema.required,
    ).toEqual(['organization', 'cluster', 'id']);
  });

  it('lists and gets complete objects without inheriting the default database', async () => {
    const { client, fetchFn } = await connect([
      json({ workflows: [workflow] }),
      json(workflow),
    ]);
    expect(
      await client.callTool({ name: 'list-workflows', arguments: scope }),
    ).toMatchObject({ content: content({ workflows: [workflow] }) });
    expect(
      await client.callTool({
        name: 'get-workflow',
        arguments: { ...scope, id },
      }),
    ).toMatchObject({ content: content(workflow) });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      `${apiUrl}${query}`,
      `${apiUrl}/${id}${query}`,
    ]);
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(
      true,
    );
  });

  it.each([
    'rt_admin_test',
    'oauth_test',
  ])('creates using the supplied credential and leaves omitted defaults to the backend (%s)', async (credential) => {
    const { client, fetchFn } = await connect(
      [json(workflow, 201)],
      true,
      credential,
    );
    expect(
      await client.callTool({
        name: 'create-workflow',
        arguments: { ...scope, ...input },
      }),
    ).toMatchObject({ content: content(workflow) });
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${apiUrl}${query}`);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify(input),
      headers: { Authorization: `Bearer ${credential}` },
    });
  });

  it('sends new sink credentials only in the request and returns sanitized metadata', async () => {
    const sinks = [
      {
        type: 'http',
        url: 'https://example.com/events',
        headers: { Authorization: 'Bearer synthetic-secret' },
      },
      { type: 'table', database: 'default', table: 'alerts' },
    ];
    const { client, fetchFn } = await connect([json(workflow, 201)]);
    const result = await client.callTool({
      name: 'create-workflow',
      arguments: {
        ...scope,
        ...input,
        enabled: false,
        interval_seconds: 86400,
        sinks,
      },
    });
    expect(result).toMatchObject({ content: content(workflow) });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({
      ...input,
      enabled: false,
      interval_seconds: 86400,
      sinks,
    });
  });

  it.each([
    { enabled: false },
    { enabled: true },
    { interval_seconds: 1 },
    { interval_seconds: 86400 },
    { sql: 'INSERT INTO alerts SELECT 1 AS value' },
    { name: 'renamed' },
    { database: 'other' },
    { sinks: [] },
    { sinks: [{ type: 'http', id: sinkId }] },
    {
      sinks: [
        {
          type: 'http',
          id: sinkId,
          headers: { Authorization: null, 'X-New': 'value' },
        },
      ],
    },
    {
      sinks: [
        {
          type: 'table',
          id: sinkId,
          database: 'other',
          table: 'alerts',
        },
      ],
    },
    { sinks: [{ type: 'http', url: 'https://example.com/new' }] },
  ])('PATCH preserves omitted fields and forwards exactly the requested change: %j', async (patch) => {
    const saved = { ...workflow, revision: 2 };
    const { client, fetchFn } = await connect([json(saved)]);
    expect(
      await client.callTool({
        name: 'update-workflow',
        arguments: { ...scope, id, ...patch },
      }),
    ).toMatchObject({ content: content(saved) });
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${apiUrl}/${id}${query}`);
    expect(fetchFn.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual(patch);
  });

  it('returns deleted=true only after a confirmed empty 204 response', async () => {
    const { client, fetchFn } = await connect([
      new Response(null, { status: 204 }),
    ]);
    expect(
      await client.callTool({
        name: 'delete-workflow',
        arguments: { ...scope, id },
      }),
    ).toMatchObject({ content: content({ id, deleted: true }) });
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${apiUrl}/${id}${query}`);
    expect(fetchFn.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it.each([
    ...[0, -1, 86401, 1.5, '1', null].map((interval_seconds) => ({
      name: 'create-workflow',
      args: { ...input, interval_seconds },
    })),
    { name: 'create-workflow', args: { ...input, database: undefined } },
    { name: 'create-workflow', args: { ...input, id } },
    { name: 'create-workflow', args: { ...input, sql: '  ' } },
    {
      name: 'create-workflow',
      args: { ...input, sinks: [{ type: 'http' }] },
    },
    {
      name: 'create-workflow',
      args: {
        ...input,
        sinks: [{ type: 'http', id: sinkId, url: 'https://example.com' }],
      },
    },
    {
      name: 'create-workflow',
      args: {
        ...input,
        sinks: [
          {
            type: 'http',
            url: 'https://example.com',
            headers: { Authorization: null },
          },
        ],
      },
    },
    {
      name: 'create-workflow',
      args: {
        ...input,
        sinks: Array.from({ length: 6 }, () => ({
          type: 'table',
          database: 'default',
          table: 'alerts',
        })),
      },
    },
    { name: 'create-workflow', args: { ...input, interval_ms: 1000 } },
    { name: 'create-workflow', args: { ...input, destinations: [] } },
    { name: 'update-workflow', args: { id, destinations: [] } },
    { name: 'update-workflow', args: { id } },
    { name: 'update-workflow', args: { id, interval_ms: 1000 } },
    {
      name: 'update-workflow',
      args: { id, enabled: false, interval_ms: 1000 },
    },
    { name: 'update-workflow', args: { id, interval_seconds: 0 } },
    { name: 'update-workflow', args: { id, interval_seconds: null } },
    {
      name: 'update-workflow',
      args: { id, sinks: [{ type: 'http', headers: {} }] },
    },
    { name: 'update-workflow', args: { id: 'invalid', enabled: false } },
    { name: 'update-workflow', args: { id, revision: 99 } },
    { name: 'get-workflow', args: {} },
    { name: 'list-workflows', args: { database: 'default' } },
  ])('rejects invalid inputs without calling the API: %j', async ({
    name,
    args,
  }) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name,
      arguments: { ...scope, ...args },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(
    names,
  )('requires explicit scope even with configured defaults: %s', async (name) => {
    const { client, fetchFn } = await connect([], false);
    const result = await client.callTool({
      name,
      arguments: {
        ...(name === 'create-workflow' ? input : {}),
        ...(name === 'list-workflows' || name === 'create-workflow'
          ? {}
          : { id }),
        ...(name === 'update-workflow' ? { enabled: false } : {}),
      },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    403, 404, 409, 503,
  ])('preserves backend failure %s without reporting successful deletion', async (status) => {
    const { client, fetchFn } = await connect([
      json(
        {
          message: 'Workflow operation failed.',
          hint: 'Check scope and service availability.',
        },
        status,
      ),
    ]);
    const result = await client.callTool({
      name: 'delete-workflow',
      arguments: { ...scope, id },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'Workflow operation failed. Check scope and service availability.',
    );
    expect(JSON.stringify(result)).not.toContain('"deleted": true');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

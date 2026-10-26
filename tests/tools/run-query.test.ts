import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

describe('run-query contract', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(fetchFn: typeof fetch, requireExplicitScope = false) {
    const rawtree = new RawTreeClient({ apiKey: 'rt_test', fetchFn });
    const server = createMcpServer(rawtree, { requireExplicitScope });
    const client = new Client({ name: 'run-query-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it.each([
    true,
    false,
  ])('advertises a potentially destructive, non-idempotent SQL tool (explicit scope: %s)', async (explicit) => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = await connect(fetchFn, explicit);
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'run-query');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tool?.inputSchema.required).toEqual([
      ...(explicit ? ['organization', 'cluster'] : []),
      'sql',
    ]);
    expect(tool?.inputSchema.properties?.sql).toMatchObject({
      description: expect.stringContaining(
        'Writes can change persistent state',
      ),
    });
    // All classifier families must remain discoverable to agents, including
    // management statements that are not table-local.
    for (const family of [
      'SELECT, WITH, EXPLAIN, DESCRIBE',
      'INSERT INTO',
      'CREATE TABLE',
      'ALTER TABLE',
      'KILL MUTATION',
      'CREATE ROLE',
      'GRANT SELECT/INSERT',
      'WORKLOAD/RESOURCE',
      'CREATE SETTINGS PROFILE',
      'CREATE ROW POLICY',
      'CREATE NAMED COLLECTION',
    ]) {
      expect(tool?.description).toContain(family);
    }
    expect(tool?.description).toContain(
      'write_only keys cannot use this endpoint',
    );
    expect(tool?.description).toContain(
      'supported writes do not require a browser login',
    );
    expect(tool?.description).not.toContain('validates queries as read-only');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    'SELECT count() FROM events',
    'INSERT INTO daily SELECT count() AS n FROM events',
    'ALTER TABLE events MATERIALIZE INDEX idx_text',
    'CREATE ROLE analytics_reader',
  ])('forwards SQL unchanged with API-key authentication: %s', async (sql) => {
    const response = {
      meta: [],
      data: [],
      rows: 0,
      statistics: { elapsed: 0.01, rows_read: 0, bytes_read: 0 },
    };
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(response));
    const client = await connect(fetchFn, true);
    const result = await client.callTool({
      name: 'run-query',
      arguments: {
        sql,
        organization: 'acme',
        cluster: 'prod',
        database: 'analytics',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(response, null, 2) },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.rawtree.com/v1/query?database=analytics&organization=acme&cluster=prod',
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sql }),
      headers: { Authorization: 'Bearer rt_test' },
    });
  });

  it('returns backend permission errors without retrying or suggesting login', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json(
        { message: 'Updating table configuration requires admin permission.' },
        { status: 403 },
      ),
    );
    const client = await connect(fetchFn);
    const result = await client.callTool({
      name: 'run-query',
      arguments: { sql: 'ALTER TABLE events MATERIALIZE PROJECTION by_region' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Updating table configuration requires admin permission.',
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

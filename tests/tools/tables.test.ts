import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const ttl = 'toDateTime(__raw_data.ts) + INTERVAL 7 DAY DELETE';
const settings = {
  storage_policy: 'cold',
  max_parts_in_total: 1000,
  replacing_enable: false,
};
const configuration = {
  sorting_key: 'region',
  ttl,
  settings: [{ name: 'disk', value: "'[HIDDEN]'" }],
};
const tableResult = {
  database: 'analytics',
  table: 'events',
  ...configuration,
};

describe('table configuration tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(response: unknown = tableResult, status = 200) {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json(response, { status }),
    );
    const rawtree = new RawTreeClient({ apiKey: 'rt_test', fetchFn });
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'table-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, rawtree, fetchFn };
  }

  it('creates with sorting key, TTL, and scalar settings and preserves masked results', async () => {
    const response = { ...tableResult, storage: { type: 'default' } };
    const { client, fetchFn } = await connect(response);
    const result = await client.callTool({
      name: 'create-table',
      arguments: {
        name: 'events',
        sortingKey: 'region',
        ttl,
        settings,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(fetchFn.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        name: 'events',
        sorting_key: 'region',
        ttl,
        settings,
      }),
    );
    expect(JSON.stringify(result.content)).toContain('[HIDDEN]');
    expect(JSON.stringify(result.content)).toContain('ttl');
  });

  it.each([
    { sortingKey: 'region' },
    { ttl },
    { settings },
    { ttl, settings: {} },
  ])('updates only supplied configuration: %j', async (input) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'update-table',
      arguments: {
        table: 'events',
        organization: 'acme',
        cluster: 'prod',
        database: 'analytics',
        ...input,
      },
    });
    expect(result.isError).not.toBe(true);
    const { sortingKey, ...rest } = input;
    expect(fetchFn.mock.calls[0][1]?.body).toBe(
      JSON.stringify({
        ...(sortingKey === undefined ? {} : { sorting_key: sortingKey }),
        ...rest,
      }),
    );
    expect(fetchFn.mock.calls[0][1]?.method).toBe('PATCH');
    expect(String(fetchFn.mock.calls[0][0])).toContain(
      'database=analytics&organization=acme&cluster=prod',
    );
    expect(JSON.stringify(result.content)).toContain('[HIDDEN]');
  });

  it.each([
    {},
    { settings: {} },
    { sortingKey: 'region', ttl },
    { ttl, settings },
    { sortingKey: '' },
    { ttl: '' },
    { ttl: '  ' },
    { ttl: null },
    { settings: null },
    { settings: { x: null } },
    { settings: { x: [] } },
    { settings: { x: {} } },
    { settings: { 'bad.name': 1 } },
  ])('rejects invalid updates without a request: %j', async (input) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'update-table',
      arguments: { table: 'events', ...input },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { ttl: null },
    { ttl: '' },
    { settings: { x: null } },
    { settings: { x: [] } },
  ])('rejects invalid create inputs: %j', async (input) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'create-table',
      arguments: { name: 'events', ...input },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('prechecks empty and multiple updates for direct client callers too', async () => {
    const { rawtree, fetchFn } = await connect();
    await expect(rawtree.updateTable('events', {})).rejects.toThrow(
      'Provide sorting_key, ttl, or nonempty settings.',
    );
    await expect(
      rawtree.updateTable('events', { settings: {} }),
    ).rejects.toThrow('Provide sorting_key, ttl, or nonempty settings.');
    await expect(
      rawtree.updateTable('events', { ttl, settings }),
    ).rejects.toThrow(
      'Update sorting_key, ttl, and settings in separate requests.',
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ttl,
    null,
  ])('describes stored TTL %s and masked explicit settings', async (storedTtl) => {
    const response = {
      table: {
        ...configuration,
        ttl: storedTtl,
        name: 'events',
        created_at: '2026-01-01',
        total_rows: 0,
        total_bytes: 0,
        columns: [],
      },
    };
    const { rawtree } = await connect(response);
    await expect(rawtree.describeTable('events')).resolves.toEqual(response);
  });

  it('documents response values and update limitations on all table tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ['create-table', 'update-table', 'describe-table']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.description).toContain('ttl');
      expect(tool?.description).toContain('settings');
      expect(tool?.description).toContain('secrets masked by the engine');
    }
    const update = tools.find((candidate) => candidate.name === 'update-table');
    expect(update?.description).toContain('exactly one');
    expect(update?.description).toContain('cannot reset settings');
    expect(update?.description).not.toContain(
      'Only the sorting key can be updated',
    );
  });

  it('returns backend configuration errors without retrying', async () => {
    const { client, fetchFn } = await connect(
      { message: 'Invalid table TTL.' },
      400,
    );
    const result = await client.callTool({
      name: 'update-table',
      arguments: { table: 'events', ttl: 'bad sql' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Invalid table TTL.');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { table: 'events' },
    {
      ...tableResult,
      storage: { type: 'future', extra: { enabled: true } },
      settings: [{ name: 'x', value: '1', extra: true }],
    },
  ])('preserves API responses unchanged for all table methods: %j', async (response) => {
    const { rawtree } = await connect(response);
    await expect(rawtree.createTable({ name: 'events' })).resolves.toEqual(
      response,
    );
    await expect(rawtree.describeTable('events')).resolves.toEqual(response);
    await expect(rawtree.updateTable('events', { ttl })).resolves.toEqual(
      response,
    );
  });
});

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type RawTreeApiError,
  RawTreeClient,
  type RawTreeClientOptions,
} from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('query-format', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(
    fetchFn: typeof fetch,
    requireExplicitScope = false,
    defaults: Partial<RawTreeClientOptions> = {},
  ) {
    const rawtree = new RawTreeClient({
      apiKey: 'rt_test',
      ...defaults,
      fetchFn,
    });
    const server = createMcpServer(rawtree, { requireExplicitScope });
    const client = new Client({ name: 'query-format-test', version: '0.0.0' });
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
  ])('advertises non-mutating formatting with scope conventions (explicit: %s)', async (explicit) => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = await connect(fetchFn, explicit);
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'query-format');
    expect(tool?.inputSchema.required).toEqual([
      ...(explicit ? ['organization', 'cluster'] : []),
      'sql',
    ]);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends only complete SQL with authentication and explicit scope and returns all output', async () => {
    const sql = "  -- café\nselect 'a\\b'; INSERT INTO t VALUES (1), (  \n";
    const formatted =
      "-- café\nSELECT 'a\\b';\n\nINSERT INTO t VALUES (1), (  \n";
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ formatted }),
    );
    const client = await connect(fetchFn, true, {
      organization: 'old',
      cluster: 'old',
      database: 'old',
    });
    const result = await client.callTool({
      name: 'query-format',
      arguments: {
        sql,
        organization: 'acme team',
        cluster: 'prod/eu',
        database: 'analytics db',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ formatted }, null, 2) },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.rawtree.com/v1/query-format?database=analytics+db&organization=acme+team&cluster=prod%2Feu',
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ sql }),
      headers: {
        Authorization: 'Bearer rt_test',
        'Content-Type': 'application/json',
        'User-Agent': 'rawtree-mcp/0.4.1',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves large SQL and formatted output without truncation', async () => {
    const sql = `  INSERT INTO t VALUES ('${'café\\"'.repeat(200_000)}'), (  \n`;
    const formatted = sql.slice(2);
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ formatted }),
    );
    const client = await connect(fetchFn);
    const result = await client.callTool({
      name: 'query-format',
      arguments: { sql },
    });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ formatted }, null, 2) },
    ]);
    expect(fetchFn.mock.calls[0][1]?.body).toBe(JSON.stringify({ sql }));
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'https://api.rawtree.com/v1/query-format',
    );
  });

  it('uses configured organization, cluster, and database defaults', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ formatted: 'SELECT 1' }),
    );
    const client = await connect(fetchFn, false, {
      organization: 'team',
      cluster: 'prod',
      database: 'default',
    });
    await client.callTool({
      name: 'query-format',
      arguments: { sql: 'select 1' },
    });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      'https://api.rawtree.com/v1/query-format?database=default&organization=team&cluster=prod',
    );
  });

  it.each([
    400, 401, 403, 408, 413, 503,
  ])('preserves structured HTTP %s errors without partial results or fallback', async (status) => {
    const payload = {
      message: 'Formatting failed',
      hint: 'Try a smaller selection',
    };
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse(payload, status),
    );
    const rawtree = new RawTreeClient({ apiKey: 'rt_test', fetchFn });
    await expect(rawtree.formatQuery('select 1')).rejects.toMatchObject({
      name: 'RawTreeApiError',
      status,
      path: '/v1/query-format',
      payload,
      message: 'Formatting failed Try a smaller selection',
    } satisfies Partial<RawTreeApiError>);
    const client = await connect(fetchFn);
    const result = await client.callTool({
      name: 'query-format',
      arguments: { sql: 'select 1' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Formatting failed Try a smaller selection' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      fetchFn.mock.calls.every(([url]) =>
        String(url).endsWith('/v1/query-format'),
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { formatted: null },
    { formatted: 42 },
    'invalid JSON',
  ])('rejects malformed success response %j', async (response) => {
    const client = await connect(async () => jsonResponse(response));
    const result = await client.callTool({
      name: 'query-format',
      arguments: { sql: 'select 1' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'RawTree returned an invalid query-format response.',
      },
    ]);
  });

  it('cancels the active HTTP request when the MCP caller cancels', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const aborted = Promise.withResolvers<void>();
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Missing cancellation signal');
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
          started.resolve(signal);
        }),
    );
    const client = await connect(fetchFn);
    const controller = new AbortController();
    const result = client.callTool(
      { name: 'query-format', arguments: { sql: 'select 1' } },
      { signal: controller.signal },
    );
    const rejected = expect(result).rejects.toThrow();
    const signal = await started.promise;
    controller.abort();
    await rejected;
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

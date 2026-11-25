import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import { expectTenantHeaders, scope } from './fixtures.js';

const destination = {
  nats_stream: 'EVENTS',
  nats_consumer: 'rawtree',
  database: 'default',
  table: 'events',
};
const input = {
  ...scope,
  name: 'events',
  type: 'nats',
  destinations: [destination],
  settings: { servers: 'tls://nats.example.com:4222' },
};
const connector = {
  id: 'nats/id',
  type: 'nats',
  destinations: [{ id: 'destination-1', ...destination }],
};
const kafkaDestination = {
  topics: ['events'],
  database: 'default',
  table: 'events',
};

// The real routing/discovery contract is covered by routing.test.ts.
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

describe('connector tools over MCP', () => {
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let calls: { url: URL; init: RequestInit }[];
  let responses: Response[];

  beforeEach(async () => {
    calls = [];
    responses = [];
    const rawtree = new RawTreeClient({
      apiKey: 'test-user-token',
      fetchFn: async (url, init) => {
        calls.push({ url: new URL(url.toString()), init: init ?? {} });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected HTTP request');
        return response;
      },
    });
    server = createMcpServer(rawtree, { requireExplicitScope: true });
    client = new Client({ name: 'connector-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  function respond(body: unknown, status = 200) {
    responses.push(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it.each([
    undefined,
    { strategy: 'user_password', user: 'reader', password: 'secret-password' },
    { strategy: 'token', token: 'secret-token' },
    { strategy: 'nkey', nkey: 'U_PUBLIC_KEY', seed: 'SU_SECRET_SEED' },
  ])('creates NATS with auth %j and unchanged API fields', async (auth) => {
    const settings = {
      ...input.settings,
      tls: { enabled: true },
      batch: { max_events: 1000, timeout_secs: 1 },
      ...(auth ? { auth } : {}),
    };
    respond(connector, 201);
    const result = await client.callTool({
      name: 'create-connector',
      arguments: { ...input, settings },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/v1/connectors');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({});
    expectTenantHeaders(calls[0].init);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: input.name,
      type: 'nats',
      destinations: [destination],
      settings,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-password|secret-token|SU_SECRET_SEED/,
    );
  });

  it('still creates Kafka through the same tool', async () => {
    respond({ id: 'kafka-id' }, 201);
    const result = await client.callTool({
      name: 'create-connector',
      arguments: {
        ...input,
        type: 'kafka',
        settings: { bootstrap_servers: 'kafka:9092' },
        destinations: [kafkaDestination],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      type: 'kafka',
      settings: { bootstrap_servers: 'kafka:9092' },
      destinations: [kafkaDestination],
    });
  });

  it.each([
    { type: 'kafka' },
    { type: 'postgres' },
    { settings: { bootstrap_servers: 'kafka:9092' } },
    { destinations: [kafkaDestination] },
    { destinations: [destination, kafkaDestination] },
    { destinations: [] },
    { destinations: Array.from({ length: 33 }, () => destination) },
    { destinations: [{ ...destination, topics: ['events'] }] },
    {
      settings: { servers: 'nats://broker:4222', auth: { strategy: 'token' } },
    },
    {
      settings: {
        servers: 'nats://broker:4222',
        auth: { strategy: 'user_password', user: 'reader' },
      },
    },
    {
      settings: {
        servers: 'nats://broker:4222',
        auth: { strategy: 'nkey', nkey: 'U_PUBLIC_KEY' },
      },
    },
    {
      settings: {
        servers: 'nats://broker:4222',
        auth: { strategy: 'jwt', token: 'secret-token' },
      },
    },
    {
      settings: {
        servers: 'nats://broker:4222',
        auth: {
          strategy: 'token',
          token: 'secret-token',
          password: 'secret-password',
        },
      },
    },
    {
      settings: {
        servers: 'tls://broker:4222',
        tls: { enabled: true, verify_certificate: false },
      },
    },
    { settings: { servers: 'nats://broker:4222', batch: { timeout_secs: 0 } } },
  ])('rejects incompatible or incomplete inputs before HTTP: %j', async (override) => {
    const result = await client.callTool({
      name: 'create-connector',
      arguments: { ...input, ...override },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-password/);
  });

  it.each([
    '',
    'events.*',
    'events>all',
    'events/jobs',
    'events\\jobs',
    'events jobs',
    'é'.repeat(128),
  ])('rejects invalid JetStream name %s', async (name) => {
    const result = await client.callTool({
      name: 'create-connector',
      arguments: {
        ...input,
        destinations: [{ ...destination, nats_stream: name }],
      },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('appends a NATS destination and preserves existing IDs and source fields', async () => {
    respond(connector);
    respond({ id: connector.id });
    const added = {
      ...destination,
      nats_consumer: 'refund-reader',
      table: 'refunds',
    };
    const result = await client.callTool({
      name: 'add-connector-destination',
      arguments: { ...scope, connectorId: connector.id, destination: added },
    });
    expect(result.isError).not.toBe(true);
    expect(calls.map(({ init }) => init.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1].url.pathname).toBe('/v1/connectors/nats%2Fid');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      destinations: [...connector.destinations, added],
    });
  });

  it.each([
    { label: 'same destination', requested: destination, error: false },
    {
      label: 'different stream',
      requested: { ...destination, nats_stream: 'OTHER' },
      error: true,
    },
    {
      label: 'different consumer',
      requested: { ...destination, nats_consumer: 'other' },
      error: true,
    },
    {
      label: 'Kafka fields',
      requested: { ...kafkaDestination, table: 'new_table' },
      error: true,
    },
  ])('handles $label without PATCH', async ({ requested, error }) => {
    respond(connector);
    const result = await client.callTool({
      name: 'add-connector-destination',
      arguments: {
        ...scope,
        connectorId: connector.id,
        destination: requested,
      },
    });
    expect(Boolean(result.isError)).toBe(error);
    expect(calls).toHaveLength(1);
  });

  it.each([
    {
      type: 'kafka',
      destinations: [
        { id: 'kafka-dest', ...kafkaDestination, group_id: 'reader' },
      ],
    },
    { type: 'postgres', destinations: [] },
    { type: 'nats', destinations: [{ ...destination }] },
    {
      type: 'nats',
      destinations: [{ id: 'broken', database: 'default', table: 'events' }],
    },
  ])('rejects mismatched or malformed stored connector %j without PATCH', async (stored) => {
    respond(stored);
    const result = await client.callTool({
      name: 'add-connector-destination',
      arguments: { ...scope, connectorId: connector.id, destination },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([
    'paused',
    'active',
  ])('sets NATS status %s without replacing settings or destinations', async (status) => {
    respond({ ...connector, status });
    const result = await client.callTool({
      name: 'set-connector-status',
      arguments: { ...scope, connectorId: connector.id, status },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status });
  });

  it.each([
    undefined,
    60,
  ])('reads stored metrics with window %s and preserves large integers', async (window_seconds) => {
    const raw =
      '[{"timeUnixNano":1794904212683000001,"asInt":18446744073709551615}]';
    responses.push(new Response(raw));
    const result = await client.callTool({
      name: 'get-connector-metrics',
      arguments: {
        ...scope,
        connectorId: connector.id,
        ...(window_seconds ? { window_seconds } : {}),
      },
    });
    expect(result.content).toEqual([{ type: 'text', text: raw }]);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/v1/metrics');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      organization_id: scope.organization,
      cluster_id: scope.cluster,
      filters: JSON.stringify({ 'rawtree.connector.id': connector.id }),
      window_seconds: String(window_seconds ?? 300),
    });
  });

  it('keeps absent observations empty', async () => {
    respond([]);
    const result = await client.callTool({
      name: 'get-connector-metrics',
      arguments: { ...scope, connectorId: connector.id },
    });
    expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
  });

  it.each([
    0, -1, 1.5, 3601,
  ])('rejects invalid metric window %s before HTTP', async (window_seconds) => {
    const result = await client.callTool({
      name: 'get-connector-metrics',
      arguments: { ...scope, connectorId: connector.id, window_seconds },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('surfaces backend authorization errors and does not retry mutations', async () => {
    respond({ message: 'Organization admin access required.' }, 403);
    const result = await client.callTool({
      name: 'create-connector',
      arguments: input,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'Organization admin access required.',
    );
    expect(calls).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';

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

function sequenceFetch(
  responses: Response[],
  calls: RecordedCall[],
): typeof fetch {
  return async (input, init) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call.');
    return response;
  };
}

const scope = { organization: 'acme team', cluster: 'production/eu' };

const connector = {
  id: 'connector/id',
  name: 'orders',
  type: 'kafka',
  destinations: [
    {
      id: 'destination-1',
      topics: ['orders'],
      group_id: 'orders-rawtree',
      database: 'default',
      table: 'orders',
    },
  ],
  settings: { bootstrap_servers: 'kafka:9092' },
  status: 'active',
};

describe('RawTreeClient connector routes', () => {
  it('lists, gets, and reads metrics with cluster scope', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch(
        [
          jsonResponse({ connectors: [] }),
          jsonResponse(connector),
          jsonResponse({ status: 'running', destinations: [] }),
        ],
        calls,
      ),
    });

    await client.listConnectors(scope);
    await client.getConnector('connector/id', scope);
    await client.getConnectorMetrics('connector/id', scope);

    expect(calls.map((call) => call.url)).toEqual([
      'https://api.rawtree.com/v1/connectors?organization=acme+team&cluster=production%2Feu',
      'https://api.rawtree.com/v1/connectors/connector%2Fid?organization=acme+team&cluster=production%2Feu',
      'https://api.rawtree.com/v1/connectors/connector%2Fid/metrics?organization=acme+team&cluster=production%2Feu',
    ]);
    expect(calls.every((call) => call.init.method === 'GET')).toBe(true);
  });

  it('creates a Kafka connector with the API field names unchanged', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch([jsonResponse(connector, 201)], calls),
    });
    const input = {
      name: 'orders',
      type: 'kafka' as const,
      destinations: [
        {
          topics: ['orders'],
          group_id: 'orders-rawtree',
          database: 'default',
          table: 'orders',
        },
      ],
      settings: {
        bootstrap_servers: 'kafka:9092',
        auto_offset_reset: 'smallest' as const,
        tls: { enabled: true as const },
        sasl: {
          enabled: true as const,
          mechanism: 'PLAIN' as const,
          username: 'user',
          password: 'password',
        },
        batch: { max_events: 1000, timeout_secs: 1 },
      },
    };

    await client.createConnector(input, scope);

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/connectors?organization=acme+team&cluster=production%2Feu',
    );
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify(input));
  });

  it('preserves current destinations when adding a destination', async () => {
    const calls: RecordedCall[] = [];
    const updated = {
      ...connector,
      destinations: [
        ...connector.destinations,
        {
          id: 'destination-2',
          topics: ['refunds'],
          group_id: 'refunds-rawtree',
          database: 'default',
          table: 'refunds',
        },
      ],
    };
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch(
        [jsonResponse(connector), jsonResponse(updated)],
        calls,
      ),
    });

    await expect(
      client.addConnectorDestination(
        'connector/id',
        {
          topics: ['refunds'],
          group_id: 'refunds-rawtree',
          database: 'default',
          table: 'refunds',
        },
        scope,
      ),
    ).resolves.toEqual(updated);

    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      destinations: [
        connector.destinations[0],
        {
          topics: ['refunds'],
          group_id: 'refunds-rawtree',
          database: 'default',
          table: 'refunds',
        },
      ],
    });
  });

  it('treats an existing matching destination as an idempotent success', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch([jsonResponse(connector)], calls),
    });

    await expect(
      client.addConnectorDestination(
        'connector/id',
        {
          topics: ['orders'],
          database: 'default',
          table: 'orders',
        },
        scope,
      ),
    ).resolves.toEqual(connector);
    expect(calls).toHaveLength(1);
  });

  it('rejects conflicting settings for an existing destination', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch([jsonResponse(connector)], calls),
    });

    await expect(
      client.addConnectorDestination(
        'connector/id',
        {
          topics: ['different-topic'],
          database: 'default',
          table: 'orders',
        },
        scope,
      ),
    ).rejects.toThrow('with different topics or group_id');
    expect(calls).toHaveLength(1);
  });

  it('sets connector status without replacing other fields', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'oauth_token',
      fetchFn: sequenceFetch(
        [jsonResponse({ ...connector, status: 'paused' })],
        calls,
      ),
    });

    await client.setConnectorStatus('connector/id', 'paused', scope);

    expect(calls[0].init.method).toBe('PATCH');
    expect(calls[0].init.body).toBe(JSON.stringify({ status: 'paused' }));
  });
});

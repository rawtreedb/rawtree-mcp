import { describe, expect, it } from 'vitest';
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

  it('parses project identity from the keys response', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(
        jsonResponse({
          keys: [],
          project: { name: 'analytics' },
          organization: { name: 'acme' },
        }),
        calls,
      ),
    });

    await expect(client.getProject()).resolves.toEqual({
      name: 'analytics',
      organization: { name: 'acme' },
    });
    expect(calls[0].url).toBe('https://api.rawtree.com/v1/keys');
  });

  it('falls back to tables for project identity when keys require admin permission', async () => {
    const calls: RecordedCall[] = [];
    const responses = [
      jsonResponse(
        {
          error: 'forbidden',
          message: 'Forbidden',
          hint: 'This API key does not have admin permission.',
        },
        403,
      ),
      jsonResponse({
        tables: [],
        project: { name: 'analytics' },
        organization: { name: 'acme' },
      }),
    ];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: async (input, init) => {
        calls.push({
          url: input.toString(),
          init: init ?? {},
        });
        const response = responses.shift();
        if (!response) throw new Error('unexpected request');
        return response;
      },
    });

    await expect(client.getProject()).resolves.toEqual({
      name: 'analytics',
      organization: { name: 'acme' },
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.rawtree.com/v1/keys',
      'https://api.rawtree.com/v1/tables',
    ]);
  });

  it('passes transform and Firehose columns for JSON inserts', async () => {
    const calls: RecordedCall[] = [];
    const client = new RawTreeClient({
      apiKey: 'rt_test',
      fetchFn: recordingFetch(jsonResponse({ inserted: 1 }), calls),
    });

    await client.insertJson({
      table: 'events',
      data: [{ event: 'signup' }],
      transform: 'firehose',
      columns: ['time', 'message'],
    });

    expect(calls[0].url).toBe(
      'https://api.rawtree.com/v1/tables/events?transform=firehose&columns=time%2Cmessage',
    );
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

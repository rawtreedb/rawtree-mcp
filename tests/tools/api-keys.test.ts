import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const scope = { organization: 'acme team', cluster: 'production/eu' };
const key = {
  id: 'key-1',
  token: 'rt_test',
  name: 'ci',
  permission: 'read_only',
};

describe('API-key expiration', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(response: unknown, status = 200) {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(response), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const server = createMcpServer(
      new RawTreeClient({ apiKey: 'rt_test', fetchFn }),
      { requireExplicitScope: true },
    );
    const client = new Client({ name: 'expiration-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, fetchFn };
  }

  it('advertises an optional nullable expiration without an update tool', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    const create = tools.find((tool) => tool.name === 'create-api-key');
    expect(create?.inputSchema.properties).toHaveProperty('expires_at');
    expect(create?.inputSchema.required).not.toContain('expires_at');
    expect(tools.some((tool) => tool.name === 'update-api-key')).toBe(false);
  });

  it.each([
    undefined,
    null,
    '2027-01-01T02:00:00+02:00',
  ])('creates and displays expiration %s', async (expires_at) => {
    const response = {
      ...key,
      expires_at: expires_at ? '2027-01-01T00:00:00Z' : null,
    };
    const { client, fetchFn } = await connect(response);
    const result = await client.callTool({
      name: 'create-api-key',
      arguments: {
        ...scope,
        name: key.name,
        permission: key.permission,
        database: 'analytics',
        ...(expires_at === undefined ? {} : { expires_at }),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      'https://api.rawtree.com/v1/keys?database=analytics&organization=acme+team&cluster=production%2Feu',
    );
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        name: key.name,
        permission: key.permission,
        expires_at,
      }),
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining(JSON.stringify(response, null, 2)),
        }),
      ]),
    );
  });

  it.each([
    undefined,
    null,
    '2027-01-01T00:00:00Z',
  ])('preserves list expiration %s, including older servers', async (expires_at) => {
    const response = {
      keys: [{ ...key, ...(expires_at === undefined ? {} : { expires_at }) }],
    };
    const { client, fetchFn } = await connect(response);
    expect(
      await client.callTool({ name: 'list-api-keys', arguments: scope }),
    ).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
    });
    expect(fetchFn.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces server expiration validation errors', async () => {
    const { client, fetchFn } = await connect(
      {
        error: 'bad_request',
        message: 'Invalid expiration date.',
        hint: 'expires_at must be in the future.',
      },
      400,
    );
    const result = await client.callTool({
      name: 'create-api-key',
      arguments: {
        ...scope,
        name: key.name,
        expires_at: '2000-01-01T00:00:00Z',
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Invalid expiration date');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

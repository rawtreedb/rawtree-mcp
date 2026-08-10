import type { AddressInfo } from 'node:net';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHttp } from '../../src/transports/http.js';

vi.mock('../../src/server.js', () => ({
  createMcpServer: vi.fn(() => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    server.registerTool('ping', { description: 'test tool' }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  }),
}));

async function closeServer(
  server: ReturnType<typeof runHttp> extends Promise<infer T> ? T : never,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function connectClient(
  port: number,
  era: 'legacy' | 'modern',
): Promise<Client> {
  const client = new Client(
    { name: `test-client-${era}`, version: '0.0.0' },
    era === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      : {},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer rt_test' } } },
  );
  await client.connect(transport);
  return client;
}

describe('dual-era HTTP protocol support', () => {
  let servers: Array<Awaited<ReturnType<typeof runHttp>>>;

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) {
      if (server.listening) await closeServer(server);
    }
  });

  it('legacy clients can list and call tools through the sessionful path', async () => {
    const server = await runHttp(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const client = await connectClient(port, 'legacy');

    expect(client.getProtocolEra()).toBe('legacy');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');
    await expect(
      client.callTool({ name: 'ping', arguments: {} }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    await client.close();
  });

  it('modern clients can discover, list, and call tools statelessly', async () => {
    const server = await runHttp(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const client = await connectClient(port, 'modern');

    expect(client.getProtocolEra()).toBe('modern');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');
    await expect(
      client.callTool({ name: 'ping', arguments: {} }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    await client.close();
  });

  it('modern requests do not mint an MCP session ID', async () => {
    const server = await runHttp(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer rt_test',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  it('modern requests without a Bearer token return 401', async () => {
    const server = await runHttp(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });

    expect(response.status).toBe(401);
  });
});

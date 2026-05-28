import { describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

describe('createMcpServer', () => {
  it('returns an MCP server with connect method', () => {
    const client = new RawTreeClient({ token: 'rt_test' });
    const server = createMcpServer(client, {
      baseUrl: 'https://api.rawtree.com',
    });

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });
});

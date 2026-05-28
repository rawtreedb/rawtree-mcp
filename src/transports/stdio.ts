import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';
import type { ServerOptions } from '../types.js';

export async function runStdio(
  token: string,
  options: ServerOptions,
): Promise<void> {
  const rawtree = new RawTreeClient({ ...options, token });
  const server = createMcpServer(rawtree, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('RawTree MCP Server running on stdio');
}

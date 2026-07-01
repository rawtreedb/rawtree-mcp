import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';
import type { StdioConfig } from '../types.js';

type StdioClientConfig = Omit<StdioConfig, 'port' | 'transport'>;

export async function runStdio(config: StdioClientConfig): Promise<void> {
  const rawtree = new RawTreeClient(config);
  const server = createMcpServer(rawtree);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('RawTree MCP Server running on stdio');
}

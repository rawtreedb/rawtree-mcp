import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';

export async function runStdio(apiKey: string, apiUrl?: string): Promise<void> {
  const rawtree = new RawTreeClient({ apiKey, apiUrl });
  const server = createMcpServer(rawtree);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('RawTree MCP Server running on stdio');
}

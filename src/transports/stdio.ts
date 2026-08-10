import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';
import type { StdioConfig } from '../types.js';

type StdioClientConfig = Omit<StdioConfig, 'port' | 'transport'>;

export async function runStdio(config: StdioClientConfig): Promise<void> {
  const rawtree = new RawTreeClient(config);
  serveStdio(() => createMcpServer(rawtree), {
    legacy: 'serve',
    onerror: (error) => console.error('stdio connection error:', error),
  });
  console.error('RawTree MCP Server running on stdio');
}

import {
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';
import type { StdioConfig } from '../types.js';
import { MAX_MCP_REQUEST_BYTES } from './limits.js';

type StdioClientConfig = Omit<StdioConfig, 'port' | 'transport'>;

export async function runStdio(config: StdioClientConfig): Promise<void> {
  const rawtree = new RawTreeClient(config);
  serveStdio(() => createMcpServer(rawtree), {
    legacy: 'serve',
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: MAX_MCP_REQUEST_BYTES,
    }),
    onerror: (error) => console.error('stdio connection error:', error),
  });
  console.error('RawTree MCP Server running on stdio');
}

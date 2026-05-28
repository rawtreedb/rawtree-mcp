import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import packageJson from '../package.json' with { type: 'json' };
import type { RawTreeClient } from './client.js';
import {
  addApiKeyTools,
  addDataTools,
  addLogTools,
  addProjectTools,
  addTableTools,
} from './tools/index.js';
import type { ServerOptions } from './types.js';

export type { ServerOptions } from './types.js';

export function createMcpServer(
  rawtree: RawTreeClient,
  _options: ServerOptions,
): McpServer {
  const server = new McpServer({
    name: 'rawtree',
    version: packageJson.version,
  });

  addDataTools(server, rawtree);
  addTableTools(server, rawtree);
  addLogTools(server, rawtree);
  addApiKeyTools(server, rawtree);
  addProjectTools(server, rawtree);

  return server;
}

import { McpServer } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import type { RawTreeClient } from './client.js';
import {
  addApiKeyTools,
  addDatabaseTools,
  addDataTools,
  addLogTools,
  addTableTools,
} from './tools/index.js';

export type { RawTreeClientOptions } from './client.js';
export { RawTreeClient } from './client.js';

export function createMcpServer(rawtree: RawTreeClient): McpServer {
  const server = new McpServer({
    name: 'rawtree',
    version: packageJson.version,
  });

  addDataTools(server, rawtree);
  addTableTools(server, rawtree);
  addLogTools(server, rawtree);
  addApiKeyTools(server, rawtree);
  addDatabaseTools(server, rawtree);

  return server;
}

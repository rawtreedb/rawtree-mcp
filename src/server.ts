import { McpServer } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import type { RawTreeClient } from './client.js';
import {
  addApiKeyTools,
  addClusterTools,
  addDatabaseTools,
  addDataTools,
  addLogTools,
  addOrganizationTools,
  addTableTools,
} from './tools/index.js';

export type { RawTreeClientOptions, RawTreeScope } from './client.js';
export { RawTreeClient } from './client.js';

export interface McpServerOptions {
  requireExplicitScope?: boolean;
}

export function createMcpServer(
  rawtree: RawTreeClient,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: 'rawtree',
    version: packageJson.version,
  });

  addOrganizationTools(server, rawtree);
  addDataTools(server, rawtree, options);
  addTableTools(server, rawtree, options);
  addLogTools(server, rawtree, options);
  addApiKeyTools(server, rawtree, options);
  addDatabaseTools(server, rawtree, options);
  addClusterTools(server, rawtree);

  return server;
}

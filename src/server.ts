import { McpServer } from '@modelcontextprotocol/server';
import packageJson from '../package.json' with { type: 'json' };
import type { RawTreeClient } from './client.js';
import {
  addApiKeyTools,
  addAppTools,
  addClusterTools,
  addConnectorTools,
  addDatabaseTools,
  addDataTools,
  addLogTools,
  addOrganizationTools,
  addSavedQueryTools,
  addServiceAccountTools,
  addTableTools,
  addWorkflowTools,
} from './tools/index.js';

export type {
  ConnectorDestinationInput,
  ConnectorStatus,
  CreateConnectorInput,
  CreateServiceAccountInput,
  KafkaConnectorSettingsInput,
  NewConnectorDestinationInput,
  RawTreeClientOptions,
  RawTreeScope,
  S3StorageAccessInput,
  S3StorageInput,
} from './client.js';
export { RawTreeClient } from './client.js';
export type {
  CreateSavedQueryInput,
  CreateWorkflowInput,
  NewWorkflowSink,
  UpdateSavedQueryInput,
  UpdateWorkflowInput,
  WorkflowScope,
  WorkflowSinkInput,
} from './types.js';

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
  addServiceAccountTools(server, rawtree);
  addDataTools(server, rawtree, options);
  addSavedQueryTools(server, rawtree, options);
  addTableTools(server, rawtree, options);
  addLogTools(server, rawtree, options);
  addApiKeyTools(server, rawtree, options);
  addDatabaseTools(server, rawtree, options);
  addClusterTools(server, rawtree);
  addConnectorTools(server, rawtree, options);
  addAppTools(server, rawtree);
  addWorkflowTools(server, rawtree);

  return server;
}

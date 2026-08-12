import type { McpServer } from '@modelcontextprotocol/server';
import type { RawTreeClient } from '../client.js';
import {
  clusterScopeInput,
  databaseScopeInput,
  jsonResult,
  requestScope,
  type ToolScopeOptions,
} from './common.js';

export function addDatabaseTools(
  server: McpServer,
  rawtree: RawTreeClient,
  scopeOptions: ToolScopeOptions = {},
) {
  server.registerTool(
    'list-databases',
    {
      title: 'List Databases',
      description: `**Purpose:** List databases in a RawTree organization and cluster.

**Returns:** Database names and their organization context.

**When to use:**
- You need a database name before using query, table, ingest, or log tools
- The user wants to switch databases without configuring another MCP server`,
      inputSchema: clusterScopeInput(scopeOptions),
    },
    async ({ organization, cluster }) =>
      jsonResult(
        await rawtree.listDatabases(requestScope({ organization, cluster })),
      ),
  );

  server.registerTool(
    'get_database',
    {
      title: 'Get Database',
      description: `**Purpose:** Verify and return a selected RawTree database identity using the current credential.

**NOT for:** Listing tables inside a database. Use list-tables for database data.

**Returns:** A compact database shape: { "name": "...", "organization": { "name": "..." } }.

**Auth:** Uses GET /v1/keys and parses the database and organization from that response. If the current database API key cannot list keys, it falls back to GET /v1/tables, which exposes the same database identity for read-capable keys.

**When to use:**
- You want to verify that the current credential can access a specific database
- You need the normalized database and organization identity returned by RawTree`,
      inputSchema: databaseScopeInput(scopeOptions),
    },
    async ({ organization, cluster, database }) =>
      jsonResult(
        await rawtree.getDatabase(
          requestScope({ organization, cluster, database }),
        ),
      ),
  );
}

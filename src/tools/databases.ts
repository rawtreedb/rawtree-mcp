import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  clusterScopeInput,
  jsonResult,
  namedJsonResult,
  organizationScopeInput,
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
    'delete-database',
    {
      title: 'Delete Database',
      description: `**Purpose:** Permanently delete a RawTree database and all data it contains.

**Returns:** RawTree's deletion result, usually { "deleted": true }.

**Safety:** You MUST list databases first and ask the user to confirm the exact organization and database name before calling this tool. This action cannot be undone.

**Auth:** Authorization is enforced by the RawTree API.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        ...organizationScopeInput(scopeOptions),
        database: z.string().min(1).describe('Database name to delete.'),
      },
    },
    async ({ organization, database }) =>
      namedJsonResult(
        'Delete database result',
        await rawtree.deleteDatabase(database, { organization }),
      ),
  );
}

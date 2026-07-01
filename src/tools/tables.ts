import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult, requireConfirmation } from './common.js';

export function addTableTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-tables',
    {
      title: 'List Tables',
      description: `**Purpose:** List all tables in the configured RawTree database with row and byte counts.

**NOT for:** Reading table rows. Use run-query for data and describe-table for columns.

**Returns:** Tables plus database and organization context.

**When to use:**
- User asks what data exists
- You need a table name before querying
- You want to verify that an insert auto-created a table`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.listTables()),
  );

  server.registerTool(
    'describe-table',
    {
      title: 'Describe Table',
      description: `**Purpose:** Inspect a RawTree table's columns, row count, byte count, database, and organization.

**NOT for:** Sampling actual row values. Use run-query for SELECT queries.

**Returns:** Table metadata and columns.

**When to use:**
- You need to know available fields before writing SQL
- A query fails because a column may not exist
- You just inserted data and want to inspect the dynamic schema`,
      inputSchema: {
        table: z.string().min(1).describe('Table name to describe.'),
      },
    },
    async ({ table }) => jsonResult(await rawtree.describeTable(table)),
  );

  server.registerTool(
    'delete-table',
    {
      title: 'Delete Table',
      description: `**Purpose:** Permanently delete a RawTree table and its data.

**NOT for:** Clearing a query result or undoing a single insert. This deletes the whole table.

**Returns:** Deletion confirmation.

**Safety:** You MUST ask the user to confirm the exact table name before calling this tool. This action requires an admin key and cannot be undone.`,
      inputSchema: {
        table: z.string().min(1).describe('Table name to delete.'),
        confirm: z
          .boolean()
          .describe(
            'Set to true only after the user explicitly confirms deletion of this exact table.',
          ),
      },
    },
    async ({ table, confirm }) => {
      requireConfirmation(
        confirm,
        'Refusing to delete table without explicit confirmation.',
      );
      return namedJsonResult(
        'Delete table result',
        await rawtree.deleteTable(table),
      );
    },
  );
}

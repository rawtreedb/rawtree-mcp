import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  databaseScopeInput,
  jsonResult,
  namedJsonResult,
  requestScope,
  type ToolScopeOptions,
} from './common.js';

const sortingKeyInput = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Comma-separated SQL sorting expressions in key order, for example "region, ifNull(cityHash64(host, instanceId), 0)". A bare name such as "user.id" is read as a path into the ingested JSON.',
  );

export function addTableTools(
  server: McpServer,
  rawtree: RawTreeClient,
  scopeOptions: ToolScopeOptions = {},
) {
  server.registerTool(
    'list-tables',
    {
      title: 'List Tables',
      description: `**Purpose:** List all tables in a RawTree database with row and byte counts.

**NOT for:** Reading table rows. Use run-query for data and describe-table for columns.

**Returns:** Tables plus database and organization context.

**When to use:**
- User asks what data exists
- You need a table name before querying
- You want to verify that an insert auto-created a table`,
      inputSchema: databaseScopeInput(scopeOptions),
    },
    async ({ organization, cluster, database }) =>
      jsonResult(
        await rawtree.listTables(
          requestScope({ organization, cluster, database }),
        ),
      ),
  );

  server.registerTool(
    'create-table',
    {
      title: 'Create Table',
      description: `**Purpose:** Create an empty RawTree table in a database.

**Returns:** The database and table names, the resolved storage destination, and the table's sorting key.

**Behavior:** The table uses the database's storage when the database configures one, and the cluster's default storage otherwise. Storage is configured on the cluster or the database, never per table.

**Sorting key:** sortingKey is an optional string of comma-separated SQL expressions. Omit it and the table picks a sorting key per part from the ingested data, which suits exploratory tables. Set it when the query pattern is known, listing expressions in key order, lowest cardinality first. Use update-table to change it later.

**Auth:** Requires organization admin access. Authorization is enforced by the RawTree API.

**Reliability:** If the response is ambiguous, call list-tables to reconcile by database and table name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        name: z.string().min(1).describe('Name of the table to create.'),
        sortingKey: sortingKeyInput
          .optional()
          .describe(
            'Optional comma-separated SQL sorting expressions in key order. Omit it to let the table pick a key per part from the ingested data.',
          ),
      },
    },
    async ({ organization, cluster, database, name, sortingKey }) =>
      namedJsonResult(
        'Create table result',
        await rawtree.createTable(
          { name, sortingKey },
          requestScope({ organization, cluster, database }),
        ),
      ),
  );

  server.registerTool(
    'describe-table',
    {
      title: 'Describe Table',
      description: `**Purpose:** Inspect a RawTree table's columns, row count, byte count, sorting key, database, and organization.

**NOT for:** Sampling actual row values. Use run-query for SELECT queries.

**Returns:** Table metadata and columns. sorting_key is a comma-separated SQL expression string, empty when the table picks a key per part from the ingested data.

**When to use:**
- You need to know available fields before writing SQL
- A query fails because a column may not exist
- You just inserted data and want to inspect the dynamic schema
- You want the current sorting key before changing it with update-table`,
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        table: z.string().min(1).describe('Table name to describe.'),
      },
    },
    async ({ organization, cluster, database, table }) =>
      jsonResult(
        await rawtree.describeTable(
          table,
          requestScope({ organization, cluster, database }),
        ),
      ),
  );

  server.registerTool(
    'update-table',
    {
      title: 'Update Table',
      description: `**Purpose:** Change the sorting key of an existing RawTree table.

**NOT for:** Renaming a table, adding columns, or changing storage. Only the sorting key can be updated.

**Returns:** The database and table names plus the new sorting key.

**Behavior:** Provide a comma-separated SQL expression string in key order, lowest cardinality first. A bare name such as user.id is read as a path into the ingested JSON. The new key applies to newly inserted parts and wins later merges, so existing parts are re-sorted in the background instead of being rewritten by this call. Call describe-table first to see the current key.

**Limits:** The key must contain at least one expression; a table's sorting key cannot be removed once set. RawTree validates the SQL expressions and the engine may reject an unusable key.

**Auth:** Requires organization admin access. Authorization is enforced by the RawTree API.

**Safety:** You MUST confirm the exact table name and sorting expression order with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        table: z.string().min(1).describe('Table name to update.'),
        sortingKey: sortingKeyInput,
      },
    },
    async ({ organization, cluster, database, table, sortingKey }) =>
      namedJsonResult(
        'Update table result',
        await rawtree.updateTable(
          table,
          { sortingKey },
          requestScope({ organization, cluster, database }),
        ),
      ),
  );

  server.registerTool(
    'delete-table',
    {
      title: 'Delete Table',
      description: `**Purpose:** Permanently delete a RawTree table and its data.

**NOT for:** Clearing a query result or undoing a single insert. This deletes the whole table.

**Returns:** Deletion confirmation.

**Safety:** You MUST ask the user to confirm the exact table name before calling this tool. This action requires an admin key and cannot be undone.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        table: z.string().min(1).describe('Table name to delete.'),
      },
    },
    async ({ organization, cluster, database, table }) => {
      return namedJsonResult(
        'Delete table result',
        await rawtree.deleteTable(
          table,
          requestScope({ organization, cluster, database }),
        ),
      );
    },
  );
}

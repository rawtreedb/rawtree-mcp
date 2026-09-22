import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  databaseScopeInput,
  jsonResult,
  namedJsonResult,
  requestScope,
  s3StorageInput,
  type ToolScopeOptions,
} from './common.js';

const sortingKeyInput = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    'Sorting key columns in key order. A bare name such as "user.id" is read as a path into the ingested JSON.',
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
      description: `**Purpose:** Create an empty RawTree table in a database, optionally using a customer-owned S3 bucket configured for the cluster.

**Returns:** The database and table names, the resolved storage destination, and the table's sorting key. S3 responses include the full bucket, object path, and endpoint.

**Behavior:** Omit s3Storage to inherit database-level storage when configured, then the cluster's default storage. To use an explicit per-table customer-owned S3 configuration, provide the complete s3Storage object with data and backup buckets, optional paths, roleArn, and externalId. Paths default to the bucket root when omitted.

**Sorting key:** sortingKey is optional. Omit it and the table picks a sorting key per part from the ingested data, which suits exploratory tables. Set it when the query pattern is known, listing the columns in key order, lowest cardinality first. Use update-table to change it later.

**Credentials:** The API does not return S3 credentials in cluster metadata. Confirm the exact buckets, paths, role ARN, and External ID before using an explicit s3Storage override.

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
            'Optional sorting key columns, in key order. Omit it to let the table pick a key per part from the ingested data.',
          ),
        s3Storage: s3StorageInput
          .optional()
          .describe(
            "Optional per-table S3 override. Omit to inherit the database or cluster's default storage.",
          ),
      },
    },
    async ({ organization, cluster, database, name, sortingKey, s3Storage }) =>
      namedJsonResult(
        'Create table result',
        await rawtree.createTable(
          { name, sortingKey, s3Storage },
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

**Returns:** Table metadata and columns. sorting_key lists the key columns in key order, and is empty when the table picks a key per part from the ingested data.

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

**Behavior:** Columns are listed in key order, lowest cardinality first, and a bare name such as user.id is read as a path into the ingested JSON. The new key applies to newly inserted parts and wins later merges, so existing parts are re-sorted in the background instead of being rewritten by this call. Call describe-table first to see the current key.

**Limits:** The key must name at least one column; a table's sorting key cannot be removed once set. RawTree passes the key to the engine as given, so an unusable key, such as one that repeats a column, comes back as the engine's own error.

**Auth:** Requires organization admin access. Authorization is enforced by the RawTree API.

**Safety:** You MUST confirm the exact table name and column order with the user before calling this tool.`,
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

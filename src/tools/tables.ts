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

**Returns:** The database and table names plus the resolved storage destination. S3 responses include the full bucket, object path, and endpoint.

**Behavior:** Omit storage to use the cluster's default storage. To use a per-table customer-owned bucket, first call get-cluster and confirm its table_bucket_prefix is present. Set storage.type to s3 and provide only the bucket suffix appended to that immutable prefix. The resulting bucket must already exist. path is optional and defaults server-side to rawtree/{database}/{table}.

**Server-owned configuration:** Do not ask for or send the AWS region, IAM role ARN, external ID, or table bucket prefix. RawTree reads those values from the cluster configuration.

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
        storage: z
          .object({
            type: z
              .literal('s3')
              .describe('Use a customer-owned S3 bucket for this table.'),
            bucketSuffix: z
              .string()
              .min(1)
              .max(63)
              .describe(
                'Suffix appended to table_bucket_prefix. The complete bucket must already exist.',
              ),
            path: z
              .string()
              .optional()
              .describe(
                'Optional object path inside the bucket. Omit to use the server default rawtree/{database}/{table}.',
              ),
          })
          .optional()
          .describe(
            "Optional per-table storage override. Omit to use the cluster's default storage.",
          ),
      },
    },
    async ({ organization, cluster, database, name, storage }) =>
      namedJsonResult(
        'Create table result',
        await rawtree.createTable(
          { name, storage },
          requestScope({ organization, cluster, database }),
        ),
      ),
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

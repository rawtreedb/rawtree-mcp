import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  clusterScopeInput,
  jsonResult,
  namedJsonResult,
  requestScope,
  s3StorageInput,
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

**Returns:** Database names and their organization context. Databases with explicit customer-owned storage include s3_storage metadata; null means the database inherits the cluster's default storage. This metadata contains bucket and path values only; credentials are never returned.

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
    'verify-database-s3-access',
    {
      title: 'Verify Database S3 Access',
      description: `**Purpose:** Verify that RawTree can use a customer IAM role to access customer-owned S3 storage before creating a database.

**Returns:** Whether access was verified and a human-readable result message.

**Behavior:** RawTree assumes roleArn using externalId, checks the data and backup bucket locations, lists each configured path, and writes, reads, then removes a temporary probe object under each path. Paths are optional and default to the bucket root. Both configured buckets must be in the cluster environment's AWS region.

**Safety:** This check temporarily writes to and deletes from both configured destinations. Confirm the exact organization, cluster, database name, buckets, paths, role ARN, and External ID before running it. The IAM trust policy's External ID must match externalId exactly.

**Auth:** Organization-admin access is required. Authorization is enforced by the RawTree API.

**Reliability:** The check is safe to retry. Newly changed IAM policies may require a short propagation delay before verification succeeds.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...clusterScopeInput(scopeOptions),
        name: z
          .string()
          .min(1)
          .describe('Database name to verify customer-owned S3 storage for.'),
        s3Storage: s3StorageInput.describe(
          'Customer-owned S3 configuration to verify for the database.',
        ),
      },
    },
    async ({ organization, cluster, name, s3Storage }) =>
      namedJsonResult(
        'Database S3 access verification result',
        await rawtree.verifyDatabaseS3Access(
          { name, s3Storage },
          { organization, cluster },
        ),
      ),
  );

  server.registerTool(
    'create-database',
    {
      title: 'Create Database',
      description: `**Purpose:** Create a database in a RawTree organization and cluster.

**Returns:** The created database and organization context.

**Behavior:** s3Storage is optional. Omit it to use the cluster's default storage. When provided, it configures customer-owned database storage that tables inherit unless they specify their own storage. Destination paths are optional; the buckets, roleArn, and externalId are required inside s3Storage.

**Safety:** You MUST first call list-databases and confirm the exact organization, cluster, database name, and optional S3 configuration with the user. If s3Storage is provided, first call verify-database-s3-access with the identical configuration. Never reuse a successful verification after changing any s3Storage field.

**Auth:** Organization-admin access is required. Authorization is enforced by the RawTree API.

**Reliability:** This operation is not idempotent. If the response is ambiguous, call list-databases to reconcile by organization, cluster, and database name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        ...clusterScopeInput(scopeOptions),
        name: z.string().min(1).describe('Name of the database to create.'),
        s3Storage: s3StorageInput
          .optional()
          .describe(
            "Optional customer-owned S3 configuration. Omit to use the cluster's default storage.",
          ),
      },
    },
    async ({ organization, cluster, name, s3Storage }) =>
      namedJsonResult(
        'Create database result',
        await rawtree.createDatabase(
          { name, s3Storage },
          { organization, cluster },
        ),
      ),
  );

  server.registerTool(
    'delete-database',
    {
      title: 'Delete Database',
      description: `**Purpose:** Permanently delete a RawTree database and all data it contains.

**Returns:** RawTree's deletion result, usually { "deleted": true }.

**Safety:** You MUST list databases first and ask the user to confirm the exact organization, cluster, and database name before calling this tool. This action cannot be undone.

**Auth:** Authorization is enforced by the RawTree API.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        ...clusterScopeInput(scopeOptions),
        database: z.string().min(1).describe('Database name to delete.'),
      },
    },
    async ({ organization, cluster, database }) =>
      namedJsonResult(
        'Delete database result',
        await rawtree.deleteDatabase(database, { organization, cluster }),
      ),
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  clusterScopeInput,
  jsonResult,
  type ToolScopeOptions,
} from './common.js';

export function addSavedQueryTools(
  server: McpServer,
  rawtree: RawTreeClient,
  scopeOptions: ToolScopeOptions = {},
) {
  server.registerTool(
    'list-saved-queries',
    {
      title: 'List Saved Queries',
      description: `List all saved SQL queries visible to you in a cluster, across databases. Returns { queries: [...] } with each query's id, organization_id, cluster_id, user_id, name, sql, database, visibility, created_at, and updated_at. There is no pagination.

User sessions and OAuth can see their own private queries and cluster-shared queries. Standard API keys with read permission can see only cluster-shared queries; write-only and database-role keys are not supported.

To execute a saved query, pass its sql and database to run-query with the same organization and cluster. Listing does not execute SQL or grant access to the underlying data.`,
      inputSchema: clusterScopeInput(scopeOptions),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ organization, cluster }) =>
      jsonResult(await rawtree.listSavedQueries({ organization, cluster })),
  );

  server.registerTool(
    'save-query',
    {
      title: 'Save Query',
      description: `Save SQL for reuse without executing it. Omit id to create a query; name, sql, and database are required. Visibility defaults to private. Supply id to update an existing query, with at least one of name, sql, database, or visibility. Omitted fields remain unchanged; null is invalid. Use the id returned by list-saved-queries or a previous save-query call.

Requires a user session or OAuth; API keys are not supported. The authenticated user owns new queries and can update only their own queries. Set visibility to cluster to share the definition with cluster members. Returns the saved query: id, organization_id, cluster_id, user_id, name, sql, database, visibility, created_at, and updated_at.`,
      inputSchema: {
        ...clusterScopeInput(scopeOptions),
        id: z
          .uuid()
          .optional()
          .describe('Existing query ID to update. Omit to create.'),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Query name. Required when creating.'),
        sql: z
          .string()
          .min(1)
          .optional()
          .describe('SQL to save without executing. Required when creating.'),
        database: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Database stored with the query. Required when creating; omit on update to keep the saved database.',
          ),
        visibility: z
          .enum(['private', 'cluster'])
          .optional()
          .describe(
            'private (default on create) or shared with the cluster. Omit on update to preserve visibility.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization, cluster, id, name, sql, database, visibility }) => {
      const scope = { organization, cluster };
      if (id === undefined) {
        if (name === undefined || sql === undefined || database === undefined) {
          throw new Error(
            'Creating a saved query requires name, sql, and database.',
          );
        }
        return jsonResult(
          await rawtree.createSavedQuery(
            { name, sql, database, visibility },
            scope,
          ),
        );
      }
      if (
        name === undefined &&
        sql === undefined &&
        database === undefined &&
        visibility === undefined
      ) {
        throw new Error(
          'Updating a saved query requires name, sql, database, or visibility.',
        );
      }
      return jsonResult(
        await rawtree.updateSavedQuery(
          id,
          { name, sql, database, visibility },
          scope,
        ),
      );
    },
  );

  server.registerTool(
    'delete-saved-query',
    {
      title: 'Delete Saved Query',
      description: `Delete a saved query you own by its id. Requires a user session or OAuth; API keys are not supported. Deletes only the saved definition and does not execute SQL or delete underlying data. Returns { id, deleted: true } after successful deletion.`,
      inputSchema: {
        ...clusterScopeInput(scopeOptions),
        id: z.uuid().describe('ID of the saved query to delete.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ organization, cluster, id }) => {
      await rawtree.deleteSavedQuery(id, { organization, cluster });
      return jsonResult({ id, deleted: true });
    },
  );
}

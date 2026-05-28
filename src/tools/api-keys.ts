import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  jsonResult,
  namedJsonResult,
  requireConfirmation,
  textResult,
} from './common.js';

const permissionSchema = z.enum([
  'admin',
  'read_write',
  'write_only',
  'read_only',
]);

export function addApiKeyTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-api-keys',
    {
      title: 'List API Keys',
      description: `**Purpose:** List API keys for the configured RawTree project.

**NOT for:** Creating or revoking credentials. Use create-api-key or delete-api-key for those workflows.

**Returns:** API key names, IDs, API key hints, permissions, project, organization, and creation dates.

**Auth:** Uses GET /v1/keys and requires an admin project API key.

**When to use:**
- User asks what API keys exist
- You need the key ID before revoking a key
- You need to audit permissions for a project`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.listApiKeys()),
  );

  server.registerTool(
    'create-api-key',
    {
      title: 'Create API Key',
      description: `**Purpose:** Create a new RawTree API key for the configured project.

**NOT for:** User login or creating projects. Use RawTree auth/CLI or the dashboard for those workflows.

**Returns:** The new API key value. The API key is only shown once, so you MUST display it to the user.

**Auth:** Uses POST /v1/keys and requires admin permission for project API key auth.

**When to use:**
- User needs a key for CI, an agent, a connector, or a script
- User wants a read-only, write-only, read-write, or admin credential
- User asks to rotate credentials by creating a replacement before revoking the old key`,
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('Human-readable API key name.'),
        permission: permissionSchema
          .default('read_write')
          .describe(
            'Permission level. Prefer read_only for query-only agents and write_only for ingest-only connectors.',
          ),
      },
    },
    async ({ name, permission }) => {
      const created = await rawtree.createApiKey({ name, permission });
      return textResult(
        'API key created successfully.',
        `Result:\n${JSON.stringify(created, null, 2)}`,
        'IMPORTANT: The API key above is only shown once. You MUST display it to the user so they can save it.',
      );
    },
  );

  server.registerTool(
    'delete-api-key',
    {
      title: 'Delete API Key',
      description: `**Purpose:** Permanently revoke and delete a RawTree API key by UUID or full API key value.

**NOT for:** Deleting a table, project, or user session.

**Returns:** Deletion confirmation.

**Safety:** You MUST list or identify the key first, ask the user to confirm the exact key name or ID, and warn that services using it will lose access. This action cannot be undone.`,
      inputSchema: {
        idOrApiKey: z
          .string()
          .min(1)
          .describe('API key UUID or full rt_ API key value to delete.'),
        confirm: z
          .boolean()
          .describe(
            'Set to true only after the user explicitly confirms revocation of this exact API key.',
          ),
      },
    },
    async ({ idOrApiKey, confirm }) => {
      requireConfirmation(
        confirm,
        'Refusing to delete API key without explicit confirmation.',
      );
      return namedJsonResult(
        'Delete API key result',
        await rawtree.deleteApiKey(idOrApiKey),
      );
    },
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

const organization = z
  .string()
  .min(1)
  .describe('Organization name from list-organizations.');

export function addServiceAccountTools(
  server: McpServer,
  rawtree: RawTreeClient,
) {
  server.registerTool(
    'list-service-accounts',
    {
      title: 'List Service Accounts',
      description: `List service accounts in an organization, including their IDs, names, descriptions, and stored organization roles. Requires an organization admin using a user session or OAuth; API keys cannot manage service accounts.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: { organization },
    },
    async ({ organization }) =>
      jsonResult(await rawtree.listServiceAccounts(organization)),
  );

  server.registerTool(
    'create-service-account',
    {
      title: 'Create Service Account',
      description: `Create an organization service account with an immutable, unique name. Returns its ID, organization ID, name, description, and stored role. Requires an organization admin using a user session or OAuth; API keys cannot manage service accounts. This creates an identity without credentials. API key permissions are configured separately. An organization can have up to 100 service accounts.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        organization,
        name: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$(?![\s\S])/)
          .describe(
            'Immutable name: lowercase letters and digits separated by single hyphens.',
          ),
        description: z
          .string()
          .refine(
            (value) =>
              new TextEncoder().encode(value).length <= 2000 &&
              !value.includes('\0'),
            'Use at most 2000 UTF-8 bytes without null characters.',
          )
          .optional()
          .describe('Optional description, at most 2000 UTF-8 bytes.'),
        role: z
          .enum(['member', 'admin'])
          .default('member')
          .describe(
            'Stored organization role; API key permissions are configured separately.',
          ),
      },
    },
    async ({ organization, ...input }) =>
      jsonResult(await rawtree.createServiceAccount(organization, input)),
  );
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { federationScope, ruleConfiguration } from '../federation.js';
import { jsonResult } from './common.js';

const scope = federationScope;
const selected = scope.extend({ id: z.uuid() });
const definition = ruleConfiguration.safeExtend(scope.shape);
const replacement = definition.safeExtend({ id: z.uuid() });
const auth =
  'Requires an organization admin using a user session or OAuth with full_access. API keys and workload tokens cannot manage federation configuration.';
const result =
  'Returns a rule object with its full configuration, id, organization_id, cluster_id, created_at and updated_at.';

export function addFederationRuleTools(
  server: McpServer,
  rawtree: RawTreeClient,
) {
  server.registerTool(
    'list-federation-rules',
    {
      title: 'List Federation Rules',
      description: `List all federation rules. Returns an array of complete objects with configuration, IDs and timestamps. ${auth}`,
      inputSchema: scope,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ organization, cluster }) =>
      jsonResult(await rawtree.listFederationRules({ organization, cluster })),
  );
  server.registerTool(
    'get-federation-rule',
    {
      title: 'Get Federation Rule',
      description: `Read the saved configuration. ${result} ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, organization, cluster }) =>
      jsonResult(
        await rawtree.getFederationRule(id, { organization, cluster }),
      ),
  );
  server.registerTool(
    'create-federation-rule',
    {
      title: 'Create Federation Rule',
      description: `Create a cluster rule mapping an external identity to your user or a service account. An enabled rule permits authentication and grants the configured access. ${result} ${auth}`,
      inputSchema: definition,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization, cluster, ...input }) =>
      jsonResult(
        await rawtree.createFederationRule(input, { organization, cluster }),
      ),
  );
  server.registerTool(
    'update-federation-rule',
    {
      title: 'Update Federation Rule',
      description: `Replace the complete configuration (PUT), not a partial update. Omitted optional fields are cleared. Changes invalidate existing workload access tokens. ${result} ${auth}`,
      inputSchema: replacement,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, organization, cluster, ...input }) =>
      jsonResult(
        await rawtree.updateFederationRule(id, input, {
          organization,
          cluster,
        }),
      ),
  );
  server.registerTool(
    'delete-federation-rule',
    {
      title: 'Delete Federation Rule',
      description: `Delete the rule and revoke workload access through it. Returns null on success. ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, organization, cluster }) =>
      jsonResult(
        await rawtree.deleteFederationRule(id, { organization, cluster }),
      ),
  );
}

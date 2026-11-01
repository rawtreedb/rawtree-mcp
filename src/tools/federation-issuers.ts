import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { issuerConfiguration } from '../federation.js';
import { jsonResult } from './common.js';

const scope = z.strictObject({ organization: z.string().min(1) });
const selected = scope.extend({ id: z.uuid() });
const definition = issuerConfiguration.safeExtend(scope.shape);
const replacement = definition.safeExtend({ id: z.uuid() });
const auth =
  'Requires an organization admin using a user session or OAuth with full_access. API keys and workload tokens cannot manage federation configuration.';
const result =
  'Returns an issuer object with its full configuration, id, organization_id, created_at and updated_at.';

export function addFederationIssuerTools(
  server: McpServer,
  rawtree: RawTreeClient,
) {
  server.registerTool(
    'list-federation-issuers',
    {
      title: 'List Federation Issuers',
      description: `List all federation issuers. Returns an array of complete objects with configuration, IDs and timestamps. ${auth}`,
      inputSchema: scope,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ organization }) =>
      jsonResult(await rawtree.listFederationIssuers(organization)),
  );
  server.registerTool(
    'get-federation-issuer',
    {
      title: 'Get Federation Issuer',
      description: `Read the saved configuration. ${result} ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, organization }) =>
      jsonResult(await rawtree.getFederationIssuer(id, organization)),
  );
  server.registerTool(
    'create-federation-issuer',
    {
      title: 'Create Federation Issuer',
      description: `Create an organization issuer with discovery or an explicit JWKS URL. Saving does not fetch keys. ${result} ${auth}`,
      inputSchema: definition,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization, ...input }) =>
      jsonResult(await rawtree.createFederationIssuer(input, organization)),
  );
  server.registerTool(
    'update-federation-issuer',
    {
      title: 'Update Federation Issuer',
      description: `Replace the complete configuration (PUT), not a partial update. Omitted optional fields are cleared. Changes invalidate existing workload access tokens. ${result} ${auth}`,
      inputSchema: replacement,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, organization, ...input }) =>
      jsonResult(await rawtree.updateFederationIssuer(id, input, organization)),
  );
  server.registerTool(
    'delete-federation-issuer',
    {
      title: 'Delete Federation Issuer',
      description: `Delete the issuer. Referencing rules must be deleted first; otherwise the API returns 409. Returns null on success. ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, organization }) =>
      jsonResult(await rawtree.deleteFederationIssuer(id, organization)),
  );
}

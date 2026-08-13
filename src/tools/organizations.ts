import type { McpServer } from '@modelcontextprotocol/server';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

export function addOrganizationTools(
  server: McpServer,
  rawtree: RawTreeClient,
) {
  server.registerTool(
    'list-organizations',
    {
      title: 'List Organizations',
      description: `**Purpose:** List RawTree organizations available to the authenticated user.

**Returns:** Organization names, roles, plans, and avatar URLs.

**Auth:** Requires a user credential such as OAuth. Database API keys are not user credentials and cannot list organizations.

**When to use:**
- You need an organization name before listing clusters
- The user wants to work across multiple organizations through one MCP connection`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.listOrganizations()),
  );
}

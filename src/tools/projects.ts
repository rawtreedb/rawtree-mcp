import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

export function addProjectTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'get_project',
    {
      title: 'Get Project',
      description: `**Purpose:** Return the configured RawTree project identity using the current API key.

**NOT for:** Listing tables inside a project. Use list-tables for project data.

**Returns:** A compact project shape: { "name": "...", "organization": { "name": "..." } }.

**Auth:** Uses GET /v1/keys and parses the project and organization from that response. If the current project API key cannot list keys, it falls back to GET /v1/tables, which exposes the same project identity for read-capable keys.

**When to use:**
- You need to know which RawTree project the current API key belongs to
- You are setting up an MCP client and want to confirm the active project
- You want the organization name without requiring a separate project endpoint`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.getProject()),
  );
}

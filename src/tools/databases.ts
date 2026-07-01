import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

export function addDatabaseTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'get_database',
    {
      title: 'Get Database',
      description: `**Purpose:** Return the configured RawTree database identity using the current API key.

**NOT for:** Listing tables inside a database. Use list-tables for database data.

**Returns:** A compact database shape: { "name": "...", "organization": { "name": "..." } }.

**Auth:** Uses GET /v1/keys and parses the database and organization from that response. If the current database API key cannot list keys, it falls back to GET /v1/tables, which exposes the same database identity for read-capable keys.

**When to use:**
- You need to know which RawTree database the current API key belongs to
- You are setting up an MCP client and want to confirm the active database
- You want the organization name without requiring a separate database endpoint`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.getDatabase()),
  );
}

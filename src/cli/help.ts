export const HELP_TEXT = `
RawTree MCP server

Usage:
  rawtree-mcp [options]
  npx @rawtree/mcp [options]
  RAWTREE_API_KEY=rt_xxx rawtree-mcp [options]

Options:
  --api-key <api-key>      RawTree database API key (stdio mode)
  --api-url <url>          RawTree API base URL (default: https://api.rawtree.com)
  --database <name>        Database name for scoped routes
  --org <name>             Organization name for scoped routes
  --http                   Run HTTP server (Streamable HTTP at /mcp) instead of stdio
  --port <number>          HTTP port when using --http (default: 3000, or MCP_PORT)
  -h, --help               Show this help

Environment:
  RAWTREE_API_KEY          RawTree database API key (rt_...)
  RAWTREE_API_URL          RawTree API base URL (default: https://api.rawtree.com)
  RAWTREE_DATABASE         Database name for scoped routes
  RAWTREE_ORG              Organization name for scoped routes
  MCP_PORT                 HTTP port when using --http

Notes:
  - Data tools work with database API keys.
  - get_database reads database identity from the keys endpoint, with a tables fallback.
`.trim();

export function printHelp(): void {
  console.error(HELP_TEXT);
}

export const HELP_TEXT = `
RawTree MCP server

Usage:
  rawtree-mcp [options]
  npx @rawtree/mcp [options]
  RAWTREE_API_KEY=rt_xxx rawtree-mcp [options]

Options:
  --api-key <api-key>      RawTree project API key (stdio mode)
  --http                   Run HTTP server (Streamable HTTP at /mcp) instead of stdio
  --port <number>          HTTP port when using --http (default: 3000, or MCP_PORT)
  -h, --help               Show this help

Environment:
  RAWTREE_API_KEY          RawTree project API key (rt_...)
  MCP_PORT                 HTTP port when using --http

Notes:
  - Data tools work with project API keys.
  - get_project reads project identity from the keys endpoint, with a tables fallback.
`.trim();

export function printHelp(): void {
  console.error(HELP_TEXT);
}

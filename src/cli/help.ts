export const HELP_TEXT = `
RawTree MCP server

Usage:
  rawtree-mcp [options]
  npx @rawtree/mcp [options]
  RAWTREE_API_KEY=rt_xxx rawtree-mcp [options]

Options:
  --key <token>            RawTree project API key (stdio mode)
  --token <token>          Alias for --key
  --api-url <url>          RawTree API URL (default: https://api.rawtree.com)
  --url <url>              Alias for --api-url
  --org <name>             Organization name for scoped routes
  --organization <name>    Alias for --org
  --project <name>         Project name for scoped routes
  --http                   Run HTTP server (Streamable HTTP at /mcp) instead of stdio
  --port <number>          HTTP port when using --http (default: 3000, or MCP_PORT)
  -h, --help               Show this help

Environment:
  RAWTREE_API_KEY          RawTree project API key (rt_...)
  RAWTREE_TOKEN            Alias for RAWTREE_API_KEY
  RAWTREE_URL              RawTree API URL (default: https://api.rawtree.com)
  RAWTREE_ORG              Organization name for scoped routes
  RAWTREE_PROJECT          Project name for scoped routes
  MCP_PORT                 HTTP port when using --http

Notes:
  - Data tools work with project API keys.
  - get_project reads project identity from the keys endpoint, with a tables fallback.
  - RAWTREE_ORG and RAWTREE_PROJECT must be set together when using scoped routes.
`.trim();

export function printHelp(): void {
  console.error(HELP_TEXT);
}

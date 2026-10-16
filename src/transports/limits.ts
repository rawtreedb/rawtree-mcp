// The API accepts 50 MiB of JSON. Leave 1 MiB for MCP scope and envelope fields.
export const MAX_MCP_REQUEST_BYTES = 51 * 1024 * 1024;

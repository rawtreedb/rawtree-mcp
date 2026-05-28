# Changelog

## 0.2.0

- Remove non-public scoped route support.
- Use `--api-key` and `RAWTREE_API_KEY` as the public API-key configuration surface.
- Keep `--api-url` as a private, undocumented override for internal and development use.
- Rename `delete-api-key` input from `idOrToken` to `idOrApiKey`.

## 0.1.0

- Initial RawTree MCP server with stdio and Streamable HTTP transports.
- Add tools for querying, ingesting, inspecting logs, managing tables, managing API keys, and project workflows.

# Changelog

## Unreleased

- Add tools to create, inspect, monitor, pause, resume, and extend managed Kafka connectors.
- Add `create-table` with optional per-table customer-owned S3 storage and expose the public `tableBucketPrefix` cluster setting.
- Add optional idle timeout configuration to `create-cluster` and a new `update-cluster` tool for changing it later.
- Add `list-cluster-sizes` and align `create-cluster` with the frontend's explicit minimum/maximum vertical autoscaling model.
- Add cluster-scoped tools to list, install, and uninstall apps.
- Add organization-scoped tools to list, invite, update, and remove members.
- Remove the unnecessary `check-health` and `get_database` tools.
- Simplify `insert-json` to accept only raw JSON objects and arrays.
- Add confirmation-instruction-based `delete-database` for removing a database and its data.
- Add `list-clusters` and `create-cluster` tools with explicit client confirmation instructions.
- Add `pause-cluster` and `resume-cluster` tools with explicit client confirmation instructions.
- Add read-only `get-cluster` tool for checking one cluster's lifecycle status.
- Bind the default fetch implementation to the runtime global so API calls work in Cloudflare Workers.
- Add MCP 2026-07-28 stateless protocol support while preserving legacy initialize-handshake clients over stdio and HTTP.
- Add database and organization query scoping with `--database`, `--org`, `RAWTREE_DATABASE`, and `RAWTREE_ORG`.
- Document `--api-url` and `RAWTREE_API_URL`, and update `.env.example` to the canonical `RAWTREE_API_URL`/`RAWTREE_DATABASE` names.

## 0.2.0

- Remove non-public scoped route support.
- Use `--api-key` and `RAWTREE_API_KEY` as the public API-key configuration surface.
- Keep `--api-url` as a private, undocumented override for internal and development use.
- Rename `delete-api-key` input from `idOrToken` to `idOrApiKey`.

## 0.1.0

- Initial RawTree MCP server with stdio and Streamable HTTP transports.
- Add tools for querying, ingesting, inspecting logs, managing tables, managing API keys, and database workflows.

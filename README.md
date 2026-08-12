# RawTree MCP Server

An MCP server for [RawTree](https://rawtree.com/), an analytics database for unstructured data. Query data with SQL, insert JSON, inspect table schemas, review RawTree logs, and manage database credentials from MCP clients like Claude Code, Cursor, and Claude Desktop.

## Features

- **Queries** — Run read-only SQL against a RawTree database and receive JSON rows, metadata, statistics, and hints.
- **Ingest** — Insert a single JSON object, arrays of JSON objects, or public URL data. Supports RawTree built-in transforms for OTLP traces/logs/metrics, CloudWatch Logs, CloudTrail, and Firehose.
- **Tables** — List tables, describe table columns and sizes, and delete tables after explicit confirmation.
- **Logs** — Inspect RawTree query and insert history with structured filters for type, status, origin, table, hints, time window, and pagination.
- **API Keys** — List, create, and revoke RawTree API keys for a database. Creation responses include the one-time API key value.
- **Organizations** — List organizations available to an OAuth-authenticated user.
- **Databases** — List databases in a cluster and verify access to a selected database.
- **Clusters** — List dedicated clusters and provision a cluster after explicit confirmation. RawTree enforces user and organization-admin authorization.
- **Transports** — Supports stdio for local MCP clients and dual-era Streamable HTTP for remote or multi-client deployments, including stateless MCP 2026-07-28 requests and legacy initialize-handshake clients.

## Setup

Create a RawTree API key from the RawTree CLI, dashboard, or API. A database API key starts with `rt_` and is enough for data tools such as `run-query`, `insert-json`, `list-tables`, and `list-logs`.

The `get_database` tool uses the current API key to read database identity from RawTree's keys endpoint, with a tables endpoint fallback for non-admin read-capable database API keys.

## Usage

The server supports two transport modes: **stdio** (default) and **HTTP**.

### Stdio Transport

#### Quick Setup

```bash
npx add-mcp @rawtree/mcp --name rawtree --env "RAWTREE_API_KEY=rt_xxxxxxxxx"
```

#### Claude Code

```bash
claude mcp add rawtree -e RAWTREE_API_KEY=rt_xxxxxxxxx -- npx -y @rawtree/mcp
```

#### Cursor

Open the command palette and choose "Cursor Settings" > "MCP" > "Add new global MCP server".

```json
{
  "mcpServers": {
    "rawtree": {
      "command": "npx",
      "args": ["-y", "@rawtree/mcp"],
      "env": {
        "RAWTREE_API_KEY": "rt_xxxxxxxxx"
      }
    }
  }
}
```

#### Claude Desktop

Open Claude Desktop settings > "Developer" tab > "Edit Config".

```json
{
  "mcpServers": {
    "rawtree": {
      "command": "npx",
      "args": ["-y", "@rawtree/mcp"],
      "env": {
        "RAWTREE_API_KEY": "rt_xxxxxxxxx"
      }
    }
  }
}
```

### HTTP Transport

Run the server over HTTP for remote or web-based integrations. In HTTP mode, each MCP client authenticates by passing its RawTree API key in the `Authorization` header.

Start the server:

```bash
npx -y @rawtree/mcp --http --port 3000
```

The server listens on `http://127.0.0.1:3000` and exposes the MCP endpoint at `/mcp` using Streamable HTTP.

#### Claude Code

```bash
claude mcp add rawtree --transport http http://127.0.0.1:3000/mcp --header "Authorization: Bearer rt_xxxxxxxxx"
```

#### Cursor

```json
{
  "mcpServers": {
    "rawtree": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer rt_xxxxxxxxx"
      }
    }
  }
}
```

You can also set the port via the `MCP_PORT` environment variable:

```bash
MCP_PORT=3000 npx -y @rawtree/mcp --http
```

## Options

- `--api-key`: RawTree database API key for stdio mode
- `--api-url`: RawTree API base URL, default `https://api.rawtree.com`
- `--database`: Database name for scoped routes
- `--org`: Organization name for scoped routes
- `--http`: Use HTTP transport instead of stdio
- `--port`: HTTP port when using `--http`, default `3000` or `MCP_PORT`

Environment variables:

- `RAWTREE_API_KEY`: RawTree database API key
- `RAWTREE_API_URL`: RawTree API base URL, default `https://api.rawtree.com`
- `RAWTREE_DATABASE`: Database name for scoped routes
- `RAWTREE_ORG`: Organization name for scoped routes
- `MCP_PORT`: HTTP port when using `--http`

## Tools

### Data

- `check-health` — Check that the RawTree API endpoint is reachable.
- `run-query` — Run read-only SQL and return RawTree's JSON query response. Accepts organization, cluster, and database overrides.
- `insert-json` — Insert JSON object(s) into a table, optionally with a RawTree transform.
- `insert-from-url` — Ingest data from a public URL and return RawTree's NDJSON progress stream.

### Tables

- `list-tables` — List tables in the configured database.
- `describe-table` — Inspect columns, row count, byte count, database, and organization.
- `delete-table` — Delete a table after explicit confirmation. Requires admin permission.

### Logs

- `list-logs` — Read RawTree query and insert logs. Defaults to the last hour when no time window is provided.

Structured log filters include:

```json
{
  "statuses": ["error"],
  "types": ["insert"],
  "tables": ["events"],
  "origins": ["api"],
  "hints": "any",
  "limit": 50
}
```

### API Keys

- `list-api-keys` — List API keys for the configured database.
- `create-api-key` — Create a key with `admin`, `read_write`, `write_only`, or `read_only` permission.
- `delete-api-key` — Revoke a key after explicit confirmation.

### Databases

- `list-databases` — List databases in an organization and cluster.
- `get_database` — Verify a selected database and return `{ "name": "...", "organization": { "name": "..." } }`.

### Organizations

- `list-organizations` — List organizations available to the authenticated user. Requires a user credential such as OAuth.

### Clusters

- `list-clusters` — List dedicated clusters accessible in an organization.
- `create-cluster` — Provision a dedicated cluster after explicit confirmation of its organization and billable resource configuration.

Cluster tools are advertised to every MCP client. The RawTree API remains the authorization boundary: cluster access requires a user access token, and cluster creation additionally requires organization-admin access.

Programmatic hosted deployments can require explicit resource selection on
every applicable tool. Organization and cluster identify the resource boundary;
database remains an optional override and defaults to `default` when omitted.
This lets one OAuth-backed MCP connection switch between organizations,
clusters, and databases without encoding context in the MCP URL:

```ts
const server = createMcpServer(client, { requireExplicitScope: true });
```

## Examples

### Query

```json
{
  "organization": "acme",
  "cluster": "production",
  "database": "analytics",
  "sql": "SELECT count() AS rows FROM events"
}
```

### Insert JSON

```json
{
  "table": "events",
  "data": [
    {
      "event": "signup",
      "user_id": "user_123",
      "source": "mcp"
    }
  ]
}
```

### Insert OTLP Traces

```json
{
  "table": "traces",
  "transform": "otlp-traces",
  "data": {
    "resource": {
      "attributes": [
        {
          "key": "service.name",
          "value": {
            "stringValue": "api"
          }
        }
      ]
    },
    "scopeSpans": [
      {
        "spans": [
          {
            "name": "GET /health",
            "spanId": "abc"
          }
        ]
      }
    ]
  }
}
```

### Debug Failed Inserts

```json
{
  "statuses": ["error"],
  "types": ["insert"],
  "startTime": "2026-05-28T09:00:00.000Z",
  "endTime": "2026-05-28T10:00:00.000Z",
  "limit": 25
}
```

## Local Development

1. Install and build:

```bash
pnpm install
pnpm build
```

2. Use the local build from an MCP client:

```bash
claude mcp add rawtree -e RAWTREE_API_KEY=rt_xxxxxxxxx -- node /absolute/path/to/rawtree-mcp/dist/index.js
```

### Live Testing with an MCP Client

Run TypeScript in watch mode, then point a separate MCP client at the built server:

```bash
pnpm tsc --watch
```

```json
{
  "mcpServers": {
    "rawtree-dev": {
      "command": "node",
      "args": ["/absolute/path/to/rawtree-mcp/dist/index.js"],
      "env": {
        "RAWTREE_API_KEY": "rt_xxxxxxxxx"
      }
    }
  }
}
```

Restart the MCP client session after each rebuild.

## Programmatic usage

The package root exposes the reusable MCP server layer. The Node HTTP transport
is available separately from `@rawtree/mcp/http`, so hosted adapters can use
the server factory without importing the local process entrypoint.

```ts
import { createMcpServer, RawTreeClient } from '@rawtree/mcp';

const client = new RawTreeClient({ apiKey: process.env.RAWTREE_API_KEY! });
const server = createMcpServer(client);
```

## Publishing

Publishing is handled by the GitHub Actions `Publish` workflow.

Required repository secret:

- `NPM_TOKEN`: npm automation token with permission to publish `@rawtree/mcp`.

Release flow:

1. Update `package.json` to the new version.
2. Push the change to `main`.
3. Create and publish a GitHub release with a tag that matches the package version, such as `v0.2.0`.

The workflow verifies that the release tag matches `package.json`, runs lint, tests, and build, then publishes with npm provenance:

```bash
npm publish --provenance --access public
```

### Testing with MCP Inspector

Build first:

```bash
pnpm build
```

Start the inspector:

```bash
RAWTREE_API_KEY=rt_xxxxxxxxx pnpm inspector
```

In the Inspector UI, choose stdio:

- Command: `node`
- Args: `dist/index.js`
- Environment: `RAWTREE_API_KEY=rt_xxxxxxxxx`

## RawTree References

- [RawTree docs](https://www.rawtree.com/docs)
- [llms.txt](https://rawtree.com/llms.txt)
- [OpenAPI spec](https://api.rawtree.com/v1/openapi.json)

# RawTree MCP Server

An MCP server for [RawTree](https://rawtree.com/), an analytics database for unstructured data. Query data with SQL, insert JSON, inspect table schemas, review RawTree logs, and manage database credentials from MCP clients like Claude Code, Cursor, and Claude Desktop.

## Features

- **Queries** — Run read-only SQL against a RawTree database and receive JSON rows, metadata, statistics, and hints.
- **Workflows** — Create, inspect, update, pause, resume, and delete scheduled SQL workflows with HTTP or table sinks.
- **Saved queries** — List, create, update, and delete saved SQL definitions. Run a saved query by passing its SQL and database to `run-query`.
- **Ingest** — Insert a single JSON object, arrays of JSON objects, or public URL data.
- **Tables** — List tables, describe table columns, sizes, and sorting keys, set and change a table's sorting key, and delete tables after explicit confirmation.
- **Logs** — Inspect RawTree query and insert history with structured filters for type, status, origin, table, hints, time window, and pagination.
- **API Keys** — List, create, and revoke RawTree API keys for a cluster. Creation responses include the one-time API key value and expiration.
- **Organizations** — List organizations and manage their members and roles with an OAuth-authenticated user.
- **Databases** — List, create, verify S3 access for, and delete databases in a cluster.
- **Clusters** — List, inspect, pause, resume, discover current creation options, verify optional customer-owned S3 access, configure independent per-database S3 access, and provision vertically autoscaling dedicated clusters after explicit confirmation where required. RawTree enforces user and organization-admin authorization.
- **Apps** — List the app catalog for a cluster, inspect installation state, and install or uninstall apps after explicit confirmation.
- **Transports** — Supports stdio for local MCP clients and dual-era Streamable HTTP for remote or multi-client deployments, including stateless MCP 2026-07-28 requests and legacy initialize-handshake clients.

## Setup

Create a RawTree API key from the RawTree CLI, dashboard, or API. A database API key starts with `rt_` and is enough for data tools such as `run-query`, `insert-json`, `list-tables`, and `list-logs`.

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

- `run-query` — Run read-only SQL and return RawTree's JSON query response. Accepts organization, cluster, and database overrides.
- `insert-json` — Insert JSON object(s) into a table.
- `insert-from-url` — Ingest data from a public URL and wait for completion, returning the inserted row count (or `null` when unavailable).

### Workflows

These tools target the `/v1/workflows` API with `interval_seconds` (Platform PR [#1306](https://github.com/rawtreedb/rawtree-platform/pull/1306)). The backend must have the `interval_seconds` and workflow `sinks` with nested `settings` contracts deployed. The former workflow `destinations` field is rejected; connector destinations are unchanged. Flattened sink settings are rejected. There are no `trigger` aliases or workflow-specific telemetry tools.

All five tools require explicit `organization` and `cluster` **names**, including standalone/API-key usage. Configured defaults do not replace these required tool arguments. Workflow definitions have their own `database`; the MCP's default database is never added as a workflow query parameter or substituted for that field.

| Tool | Required parameters | Optional parameters | Result |
| --- | --- | --- | --- |
| `list-workflows` | `organization`, `cluster` | None | `{ "workflows": [...] }`; no pagination |
| `get-workflow` | `organization`, `cluster`, `id` | None | Complete workflow object |
| `create-workflow` | `organization`, `cluster`, `name`, `database`, `sql` | `enabled`, `interval_seconds`, `sinks` | Complete saved workflow object |
| `update-workflow` | `organization`, `cluster`, `id`, and at least one changed field | `name`, `database`, `sql`, `enabled`, `interval_seconds`, `sinks` | Complete saved workflow object |
| `delete-workflow` | `organization`, `cluster`, `id` | None | `{ "id": "...", "deleted": true }` after confirmed deletion |

API-key access requires an **admin** key bound to the selected organization and cluster. With OAuth, organization members can read and organization admins can create/update/delete. The backend enforces authorization. Workflows execute with organization credentials; expiration or revocation of the creating key does not stop scheduled execution.

**Create** (`create-workflow`):

```json
{
  "organization": "acme",
  "cluster": "production",
  "name": "recent-events",
  "database": "default",
  "sql": "SELECT 1 AS value",
  "enabled": false,
  "interval_seconds": 60,
  "sinks": [
    {"type": "http", "settings": {"url": "https://example.com/events", "headers": {"Authorization": "Bearer example-only"}}},
    {"type": "table", "settings": {"database": "default", "table": "alerts"}}
  ]
}
```

Defaults on creation are `enabled: true`, `interval_seconds: 1`, and `sinks: []`. Enabled workflows activate recurring SQL execution and sink delivery. SQL supports reads and `INSERT INTO ... SELECT ...`; validation is performed by the API. Intervals must be integers from 1 through 86400; `interval_ms` is rejected. If creation has an uncertain result, inspect `list-workflows` before retrying.

Create, get, and update return the same complete object shape:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "recent-events",
  "database": "default",
  "sql": "SELECT 1 AS value",
  "enabled": false,
  "interval_seconds": 60,
  "revision": 1,
  "created_at": "2026-10-05T10:00:00Z",
  "updated_at": "2026-10-05T10:00:00Z",
  "sinks": [
    {"type": "http", "id": "00000000-0000-4000-8000-000000000002", "settings": {"url_configured": true, "header_names": ["Authorization"]}},
    {"type": "table", "id": "00000000-0000-4000-8000-000000000003", "settings": {"database": "default", "table": "alerts"}}
  ]
}
```

**List** (`list-workflows`):

```json
{ "organization": "acme", "cluster": "production" }
```

Returns `{ "workflows": [<workflow objects as above>] }`, or `{ "workflows": [] }` when empty.

**Get** (`get-workflow`):

```json
{ "organization": "acme", "cluster": "production", "id": "00000000-0000-4000-8000-000000000001" }
```

**Update / resume** (`update-workflow`):

```json
{
  "organization": "acme",
  "cluster": "production",
  "id": "00000000-0000-4000-8000-000000000001",
  "enabled": true,
  "interval_seconds": 30
}
```

The returned object includes `enabled: true`, `interval_seconds: 30`, and the backend's updated revision and timestamp. Set `enabled: false` to pause. Omitted fields stay unchanged; empty updates and null field values are rejected. Already buffered deliveries may continue after pausing.

Supplying `sinks` replaces the whole list (maximum five); omission preserves it and `[]` removes all. New sinks omit `id`; new HTTP sinks require `settings.url`. When editing an existing sink, preserve its `id` and type. HTTP URLs and header values are write-only: returned `settings` contains only `url_configured` and `header_names`. For an existing HTTP sink, omit `settings`, `settings.url`, or `settings.headers` to preserve the stored configuration. Within a supplied `settings.headers` map, `null` preserves the existing value for that name, omitted header names are removed, and `{}` clears all headers.

For example, this update keeps one existing HTTP sink and its Authorization value, replaces its header list, and removes every other sink:

```json
{
  "organization": "acme",
  "cluster": "production",
  "id": "00000000-0000-4000-8000-000000000001",
  "sinks": [
    {"type": "http", "id": "00000000-0000-4000-8000-000000000002", "settings": {"headers": {"Authorization": null, "X-Source": "workflow"}}}
  ]
}
```

**Delete** (`delete-workflow`):

```json
{ "organization": "acme", "cluster": "production", "id": "00000000-0000-4000-8000-000000000001" }
```

Returns `{ "id": "00000000-0000-4000-8000-000000000001", "deleted": true }`. Deletion removes the definition and schedule; it does not undo previous SQL writes or completed deliveries. API failures are returned as MCP tool errors rather than successful deletion results.

As with existing tools, the JSON results above are serialized in the MCP `content` text block.

### Saved queries

- `list-saved-queries` — Return all visible saved queries in a cluster, across databases, as `{ "queries": [...] }`. There is no cursor or pagination.
- `save-query` — Create a saved query when `id` is omitted, or update one when `id` is supplied. Returns the saved query as a flat object.
- `delete-saved-query` — Delete a query you own. Returns `{ "id": "...", "deleted": true }` after the API confirms deletion.
- `run-query` — Execute SQL separately using the saved query's `sql` and `database`, with the same organization and cluster. Saving and listing never execute SQL.

User sessions and OAuth can list their own private queries and cluster-shared queries. Standard API keys with `admin`, `read_write`, or `read_only` permission can list only cluster-shared queries in their bound cluster. Write-only and database-role keys cannot read saved queries. Reading a definition does not grant permission to execute its SQL or access its database.

Creating, updating, and deleting require a user session or OAuth. The API assigns new queries to the authenticated user; callers do not supply a user ID. Only the owner can update or delete a query, including a cluster-shared query. With an API key, these actions return: “This action requires a user session. API keys aren’t supported.”

All examples below show explicit organization and cluster names, as required by hosted deployments configured with `requireExplicitScope`. Standalone clients may omit names already configured on `RawTreeClient`. Saved-query requests never inherit the client's database: it is a field of the saved definition, not a list filter.

**List saved queries**

```json
{
  "organization": "acme",
  "cluster": "production"
}
```

Response:

```json
{
  "queries": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "organization_id": "00000000-0000-4000-8000-000000000002",
      "cluster_id": "00000000-0000-4000-8000-000000000003",
      "user_id": "00000000-0000-4000-8000-000000000004",
      "name": "Recent events",
      "sql": "SELECT * FROM events LIMIT 10",
      "database": "analytics",
      "visibility": "private",
      "created_at": "2026-10-02T10:00:00Z",
      "updated_at": "2026-10-02T10:00:00Z"
    }
  ]
}
```

No visible queries returns `{ "queries": [] }`.

**Save query: create**

```json
{
  "organization": "acme",
  "cluster": "production",
  "name": "Recent events",
  "sql": "SELECT * FROM events LIMIT 10",
  "database": "analytics",
  "visibility": "private"
}
```

`name`, `sql`, and `database` are required when creating. `visibility` is optional and defaults to `private`; use `cluster` to share the definition. The response is the flat query object shown inside the list above, including the generated `id` and authenticated `user_id`.

**Save query: update**

```json
{
  "organization": "acme",
  "cluster": "production",
  "id": "00000000-0000-4000-8000-000000000001",
  "name": "Shared recent events",
  "visibility": "cluster"
}
```

Supply at least one of `name`, `sql`, `database`, or `visibility`. Omitted fields stay unchanged; `null` is rejected. The response is the complete updated query, with the same `id` and an updated `updated_at`.

**Delete saved query**

```json
{
  "organization": "acme",
  "cluster": "production",
  "id": "00000000-0000-4000-8000-000000000001"
}
```

Response:

```json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "deleted": true
}
```

This removes the saved definition only; the underlying data is unchanged. A failed deletion returns an MCP tool error, not a success confirmation.

**Run query**

```json
{
  "organization": "acme",
  "cluster": "production",
  "database": "analytics",
  "sql": "SELECT count() AS events FROM events"
}
```

Example response:

```json
{
  "meta": [{ "name": "events", "type": "UInt64" }],
  "data": [{ "events": "42" }],
  "rows": 1,
  "statistics": { "elapsed": 0.001, "rows_read": 42, "bytes_read": 336 }
}
```

`run-query` also forwards optional query hints from the API. All responses above are JSON encoded in the MCP text content, following the server's existing response format.

### Tables

- `list-tables` — List tables in the configured database.
- `create-table` — Create an empty table with an optional sorting key, using the storage configured on its database or cluster.
- `describe-table` — Inspect columns, row count, byte count, sorting key, database, and organization.
- `update-table` — Change a table's sorting key. Requires admin permission.
- `delete-table` — Delete a table after explicit confirmation. Requires admin permission.

`sortingKey` is an optional string on `create-table`. Omit it and the table picks a sorting key per part from the ingested data; set it to comma-separated SQL expressions in key order, such as `region, ifNull(cityHash64(host, instanceId), 0)`. A bare name such as `user.id` is read as a path into the ingested JSON. `describe-table` reports the current key as a string, and `update-table` changes it: the new key applies to newly inserted parts and wins later merges, so existing parts are re-sorted in the background rather than rewritten by the call. A key must contain at least one expression; a table's sorting key cannot be removed once set.

Tables have no storage configuration of their own: a table uses its database's storage when the database configures one, and the cluster's default storage otherwise. Customer-owned S3 is configured with `create-cluster.s3Storage` or `create-database.s3Storage`.

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

- `list-api-keys` — List API keys for a cluster, including `expires_at` (UTC timestamp or null for never).
- `create-api-key` — Create a key with `admin`, `read_write`, `write_only`, or `read_only` permission. Optional `expires_at` accepts a future RFC 3339 timestamp with a timezone, validated by the API. Omit it or pass null to never expire. Creation returns the expiration and one-time token. Expiration is fixed at creation; no API-key update tool is available.
- `delete-api-key` — Revoke a key after explicit confirmation.

### Databases

- `list-databases` — List databases in an organization and cluster.
- `verify-database-s3-access` — Verify a customer-owned S3 configuration before creating a database.
- `create-database` — Create a database with cluster-default storage or an optional customer-owned S3 configuration.
- `delete-database` — Delete a database and all its data after explicit confirmation.

`create-database.s3Storage` is optional. Omit it to use the cluster's default storage. When provided, tables in that database inherit its storage. Call `verify-database-s3-access` with the identical configuration before creation. Database listings expose `s3_storage` metadata with bucket and path values only; credentials are never returned.

### Organizations

- `list-organizations` — List organizations available to the authenticated user. Requires a user credential such as OAuth.
- `list-organization-members` — List accepted members of an organization with their user IDs and roles.
- `add-organization-member` — Send an organization member invitation after confirming the organization and email address. Membership starts after acceptance.
- `update-organization-member` — Change an accepted member's role to `admin` or `member` after explicit confirmation.
- `remove-organization-member` — Remove an accepted member and revoke organization access after explicit confirmation.

### Clusters

- `list-clusters` — List dedicated clusters accessible in an organization.
- `list-cluster-sizes` — List current replica limits, supported per-replica sizes, and default vertical autoscaling bounds.
- `verify-cluster-s3-access` — Verify an optional customer-owned S3 configuration before cluster creation. The check temporarily writes, reads, and removes a probe object in both configured destinations.
- `create-cluster` — Provision a dedicated cluster after confirming its organization, replica count, minimum size, maximum size, autoscaling behavior, optional idle timeout, optional customer-owned default S3 configuration, and optional independent per-database S3 access.
- `get-cluster` — Get one dedicated cluster and its current lifecycle status by ID.
- `update-cluster` — Change a dedicated cluster's idle timeout after confirming the organization, cluster ID, and new value. Use `0` to disable idling.
- `pause-cluster` — Pause a dedicated cluster after explicit confirmation. Its databases become unavailable until the cluster is resumed.
- `resume-cluster` — Resume a paused dedicated cluster after explicit confirmation.

Cluster tools are advertised to every MCP client. Call `list-cluster-sizes` before `create-cluster`; creation starts at the selected minimum per-replica size and can vertically autoscale to the selected maximum. `idleTimeoutMinutes` accepts `0` to disable idling or a value from 15 through 43200; omit it during creation to use the server default.

`create-cluster.s3Storage` is optional. Omit it to use RawTree-managed storage. When provided, `data` and `backups` each require a bucket and accept an optional object-key path; `roleArn` identifies the customer IAM role RawTree may assume, and `externalId` must exactly match the role trust policy. Call `verify-cluster-s3-access` with the identical configuration before creation, and repeat verification after changing any `s3Storage` field.

`create-cluster.databaseS3Access` is optional and independent from `s3Storage`. Provide it when databases may later use dedicated customer-owned buckets, including when the cluster uses RawTree-managed default storage. It contains `externalId` and `databaseBucketTag`; tag every customer database bucket with `rawtree.com/cluster=<databaseBucketTag>`. If both `s3Storage` and `databaseS3Access` are supplied, their External ID values must match. The role ARN and bucket destinations for a specific database are supplied later through `create-database.s3Storage`. Cluster list and get responses expose `database_s3_access` metadata only; credentials are never returned.

The RawTree API remains the authorization boundary: cluster access requires a user access token, and cluster creation, S3 verification, updates, pausing, and resuming additionally require organization-admin access.

### Apps

- `list-apps` — List the available apps and installation state for one cluster.
- `install-app` — Install an app on a cluster after confirming the organization, cluster name, and app ID.
- `uninstall-app` — Uninstall an app and disable its native endpoints after confirming the organization, cluster name, and app ID. Existing cluster data is not deleted.

App tools require a user credential. Organization members can list apps; installing and uninstalling require organization-admin access. Use the app IDs returned by `list-apps`.

### Connectors

- `list-connectors` — List the managed connectors and destinations in a cluster.
- `get-connector` — Get one connector's status and sanitized configuration.
- `create-connector` — Create an active Kafka connector with one or more destinations.
- `get-connector-metrics` — Read connector and per-destination health, lag, buffers, delivery counters, errors, source lag, and HTTP latency counters.
- `add-connector-destination` — Preserve the existing routes and add another topic-to-table destination.
- `set-connector-status` — Pause or resume all destinations in a connector.

Connector tools use the same nested field names as the RawTree API. A minimal
Kafka connector request looks like:

```json
{
  "organization": "acme",
  "cluster": "production",
  "name": "orders",
  "type": "kafka",
  "destinations": [
    {
      "topics": ["orders"],
      "database": "default",
      "table": "orders"
    }
  ],
  "settings": {
    "bootstrap_servers": "kafka.example.com:9092",
    "auto_offset_reset": "largest",
    "tls": { "enabled": true },
    "sasl": {
      "enabled": true,
      "mechanism": "PLAIN",
      "username": "connector-user",
      "password": "secret"
    },
    "batch": { "max_events": 1000, "timeout_secs": 1 }
  }
}
```

Creating connectors, adding destinations, and changing status require
organization-admin access. Credentials are encrypted by RawTree and omitted
from connector responses. `get-connector-metrics` returns cumulative counters;
take two samples and divide counter differences by elapsed time to calculate
event rates.

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

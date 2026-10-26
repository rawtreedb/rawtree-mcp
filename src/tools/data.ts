import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  asJsonRows,
  databaseScopeInput,
  jsonResult,
  namedJsonResult,
  requestScope,
  type ToolScopeOptions,
} from './common.js';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export function addDataTools(
  server: McpServer,
  rawtree: RawTreeClient,
  scopeOptions: ToolScopeOptions = {},
) {
  server.registerTool(
    'query-format',
    {
      title: 'Format Query',
      description: `Format complete SQL with the native RawTree formatter without executing statements or writing database query logs. Supports multiple statements and preserves literals. Inline INSERT VALUES data is copied verbatim without completeness or schema validation.

Returns JSON { "formatted": "..." } containing the entire formatted SQL. The API allows a 50 MiB JSON request, 100 MiB formatted output, and 30 seconds of formatting. Requires a backend with POST /v1/query-format.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        sql: z.string().min(1).describe('Complete SQL document to format.'),
      },
    },
    async ({ organization, cluster, database, sql }, ctx) =>
      jsonResult(
        await rawtree.formatQuery(
          sql,
          requestScope({ organization, cluster, database }),
          ctx.mcpReq.signal,
        ),
      ),
  );

  server.registerTool(
    'run-query',
    {
      title: 'Run Query',
      // Keep aligned with Platform's classify_query_statement and per-family validators.
      description: `Execute one SQL statement through RawTree's Query API. Supports reads and the writes below; this tool can change data, table configuration, and access controls. Use the existing connection with sufficient permission; supported writes do not require a browser login or a different execution surface.

Supported statements and permissions:
- SELECT, WITH, EXPLAIN, DESCRIBE: read_only, read_write, or admin API key, or a signed-in session. Database-role keys support reads subject to their database grants; they cannot execute the write families below. write_only keys cannot use this endpoint.
- INSERT INTO <table> [(columns)] SELECT ... (including a WITH source): read_write/admin or a signed-in session. The target must already exist in the selected user database. VALUES, FORMAT, and url()/urlCluster() sources are unsupported; use insert-json or insert-from-url for ingestion.
- CREATE TABLE [IF NOT EXISTS] <table> ENGINE = ReplicatedRawMergeTree [ORDER BY <expressions>]: admin API key or a signed-in session. No column definitions, engine arguments, other engines, AS SELECT, or other table clauses except optional ON CLUSTER 'default'.
- ALTER TABLE <table> MODIFY ORDER BY <expressions>; ADD/MATERIALIZE/CLEAR/DROP PROJECTION; ADD/MATERIALIZE/CLEAR/DROP INDEX (including text indexes): admin API key or a signed-in session. One operation per statement, on a table in the selected user database; no ON CLUSTER or IN PARTITION. ADD accepts IF NOT EXISTS; MATERIALIZE/CLEAR/DROP accept IF EXISTS. ADD INDEX requires an expression and TYPE, optionally positive integer GRANULARITY; AFTER is unsupported. Use storage paths such as __raw_data.field in index/projection definitions, with casts as needed.
- KILL MUTATION WHERE table = '<table>' [AND mutation_id = '<id>']: admin API key or a signed-in session. The backend applies the selected user database automatically. Only these equality filters are supported; use doubled quotes, not backslash escapes, in string values.
- CREATE ROLE <name>, DROP ROLE [IF EXISTS] <name>, GRANT SELECT/INSERT [(columns)] ON <database>.<table> TO <role>: admin API key or organization administrator session. Grants can combine SELECT and INSERT and use database.* or *.*; the target must be an existing role, not a user. No role inheritance, delegation options, or REVOKE.
- CREATE [OR REPLACE] WORKLOAD/RESOURCE, CREATE WORKLOAD/RESOURCE IF NOT EXISTS, DROP WORKLOAD/RESOURCE [IF EXISTS]: admin API key or organization administrator session. Workloads support IN <parent> and literal SETTINGS; resources support MASTER/WORKER THREAD and READ/WRITE DISK or ANY DISK operations.
- CREATE SETTINGS PROFILE [OR REPLACE | IF NOT EXISTS], DROP SETTINGS PROFILE [IF EXISTS]: admin API key or organization administrator session. Only workload = '<name>' and use_concurrency_control = 0/1, optionally READONLY/CONST, assigned TO 1–32 distinct existing roles.
- CREATE ROW POLICY [OR REPLACE | IF NOT EXISTS], DROP ROW POLICY [IF EXISTS]: admin API key or organization administrator session. One table in the selected user database; SELECT USING a scalar filter, optional AS PERMISSIVE/RESTRICTIVE, TO 1–32 distinct existing roles. No subqueries, user targets, or wildcard targets.
- CREATE NAMED COLLECTION [IF NOT EXISTS] <name> AS key = literal, ...: admin API key or organization administrator session. Unique keys with string/numeric/boolean values and optional OVERRIDABLE/NOT OVERRIDABLE; no ALTER or DROP.

Role, workload/resource, profile, policy, and named-collection management accept optional ON CLUSTER 'default' and preserve the engine's replication semantics; row policies with ON CLUSTER require an explicit matching database.table. These management operations can affect the cluster beyond the selected database. All write families are unavailable in RawTree's internal organization. Other SQL mutations, including UPDATE, DELETE, DROP TABLE, and arbitrary ALTER, are unsupported; use delete-table for table deletion.

Returns JSON meta, data, rows, statistics, and optional hints. DDL normally returns an empty result; INSERT SELECT reports statistics.written_rows; KILL MUTATION returns matched mutations. MATERIALIZE/CLEAR run in the background: inspect system.mutations for progress and system.projections or system.data_skipping_indices for definitions. Repeating writes may duplicate data or change state; inspect results before retrying. For exploratory reads, use LIMIT and deterministic ORDER BY.

Detailed syntax and replication limits: https://rawtree.com/docs/reference/api and https://rawtree.com/docs/reference/authentication#existing-database-roles.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        sql: z
          .string()
          .min(1)
          .describe(
            'One supported SQL statement to execute: a read query or an authorized INSERT SELECT, CREATE TABLE, ALTER TABLE, KILL MUTATION, or management statement listed in the tool description. Writes can change persistent state. Use LIMIT for exploratory reads.',
          ),
      },
    },
    async ({ organization, cluster, database, sql }) =>
      jsonResult(
        await rawtree.query(
          sql,
          requestScope({ organization, cluster, database }),
        ),
      ),
  );

  server.registerTool(
    'insert-json',
    {
      title: 'Insert JSON',
      description: `**Purpose:** Insert one JSON object or an array of JSON objects into a RawTree table. RawTree auto-creates the table on first insert.

**NOT for:** Loading data from a public URL (use insert-from-url).

**Returns:** Insert confirmation, usually { "inserted": <row_count> }.

**When to use:**
- User wants to send events, logs, traces, metrics, or arbitrary records to RawTree
- You need to create a table by inserting the first row
- You need to validate that RawTree accepts a payload shape

**Workflow:** Choose a table name → send a small representative payload → run describe-table or run-query to verify.

**Key trigger phrases:** "insert this", "send event", "write to RawTree", "create table with data", "ingest JSON"`,
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        table: z
          .string()
          .min(1)
          .describe(
            'Target table name. RawTree accepts identifiers like events, traces, api_logs.',
          ),
        data: z
          .union([jsonObjectSchema, z.array(jsonObjectSchema).min(1)])
          .describe(
            'A JSON object or a non-empty array of JSON objects to insert.',
          ),
      },
    },
    async ({ organization, cluster, database, table, data }) => {
      const inserted = await rawtree.insertJson(
        {
          table,
          data: asJsonRows(data),
        },
        requestScope({ organization, cluster, database }),
      );
      return namedJsonResult('Insert result', inserted);
    },
  );

  server.registerTool(
    'insert-from-url',
    {
      title: 'Insert From URL',
      description: `**Purpose:** Ask RawTree to ingest JSON/JSONL data from a public URL into a table. Waits for the import to complete.

**NOT for:** Private files on your machine or authenticated URLs. Normalize or transform data before making it available at the public URL.

**Returns:** The completed import result as JSON: inserted is the row count, or null when unavailable.

**When to use:**
- User has a public JSON or JSONL file URL
- You need RawTree to fetch and ingest the file directly
- The data is too large or inconvenient to paste into the MCP call

**Workflow:** Confirm the URL is public → call insert-from-url → use list-logs and run-query to verify.

**Key trigger phrases:** "ingest this URL", "load JSONL from", "import from public file"`,
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        table: z.string().min(1).describe('Target table name.'),
        url: z.url().describe('Public URL containing data RawTree can fetch.'),
      },
    },
    async ({ organization, cluster, database, table, url }) => {
      const inserted = await rawtree.insertFromUrl(
        { table, url },
        requestScope({ organization, cluster, database }),
      );
      return namedJsonResult('URL insert result', inserted);
    },
  );
}

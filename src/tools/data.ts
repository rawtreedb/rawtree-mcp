import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { asJsonRows, jsonResult, namedJsonResult } from './common.js';

const transformSchema = z.enum([
  'otlp-traces',
  'otlp-logs',
  'otlp-metrics',
  'cloudwatch-logs',
  'cloudtrail',
  'firehose',
]);

const jsonObjectSchema = z.record(z.string(), z.unknown());

export function addDataTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'check-health',
    {
      title: 'Check RawTree Health',
      description: `**Purpose:** Check that the RawTree API endpoint is reachable.

**NOT for:** Validating project permissions or checking whether a specific table exists. Use list-tables or run-query for authenticated checks.

**Returns:** The RawTree health response.

**When to use:**
- User asks whether RawTree is up
- You are debugging MCP configuration before using authenticated tools`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.health()),
  );

  server.registerTool(
    'run-query',
    {
      title: 'Run Query',
      description: `**Purpose:** Execute a read-only SQL query against the configured RawTree project and return JSON rows, column metadata, statistics, and hints.

**NOT for:** Inserting, updating, deleting, or mutating data. RawTree validates queries as read-only and rejects unsafe statements.

**Returns:** RawTree's query response: meta, data, rows, statistics, and optional hints.

**When to use:**
- User asks questions about data already in RawTree
- You need to verify an insert
- You need a quick aggregate, sample, or schema-oriented SELECT
- You need RawTree query hints after an error

**Workflow:** Start with a bounded SELECT. For exploratory queries, include LIMIT and order by a time column when available.

**Key trigger phrases:** "query RawTree", "run SQL", "count rows", "show sample rows", "check the data"`,
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe(
            'Read-only SQL to execute. Prefer bounded SELECT queries with LIMIT for exploration.',
          ),
      },
    },
    async ({ sql }) => jsonResult(await rawtree.query(sql)),
  );

  server.registerTool(
    'insert-json',
    {
      title: 'Insert JSON',
      description: `**Purpose:** Insert one JSON object or an array of JSON objects into a RawTree table. RawTree auto-creates the table on first insert.

**NOT for:** Loading data from a public URL (use insert-from-url). Not for transformed URL ingest; transforms only apply to JSON request bodies.

**Returns:** Insert confirmation, usually { "inserted": <row_count> }. Firehose transform returns request metadata.

**When to use:**
- User wants to send events, logs, traces, metrics, or arbitrary records to RawTree
- You need to create a table by inserting the first row
- You need to validate that RawTree accepts a payload shape
- You have OTLP, CloudWatch Logs, CloudTrail, or Firehose JSON that should be flattened by RawTree

**Workflow:** Choose a table name → send a small representative payload → run describe-table or run-query to verify.

**Key trigger phrases:** "insert this", "send event", "write to RawTree", "create table with data", "ingest JSON"`,
      inputSchema: {
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
        transform: transformSchema
          .optional()
          .describe(
            'Optional RawTree built-in transform for JSON body inserts: otlp-traces, otlp-logs, otlp-metrics, cloudwatch-logs, cloudtrail, or firehose.',
          ),
        columns: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'For transform=firehose only: TSV column names matching each Firehose record line.',
          ),
      },
    },
    async ({ table, data, transform, columns }) => {
      const inserted = await rawtree.insertJson({
        table,
        data: asJsonRows(data),
        transform,
        columns,
      });
      return namedJsonResult('Insert result', inserted);
    },
  );

  server.registerTool(
    'insert-from-url',
    {
      title: 'Insert From URL',
      description: `**Purpose:** Ask RawTree to ingest JSON/JSONL data from a public URL into a table. RawTree streams progress as NDJSON.

**NOT for:** Private files on your machine, authenticated URLs, or built-in transforms. Host transformed data first or use insert-json with transform.

**Returns:** The RawTree NDJSON progress stream as text.

**When to use:**
- User has a public JSON or JSONL file URL
- You need RawTree to fetch and ingest the file directly
- The data is too large or inconvenient to paste into the MCP call

**Workflow:** Confirm the URL is public → call insert-from-url → use list-logs and run-query to verify.

**Key trigger phrases:** "ingest this URL", "load JSONL from", "import from public file"`,
      inputSchema: {
        table: z.string().min(1).describe('Target table name.'),
        url: z.url().describe('Public URL containing data RawTree can fetch.'),
      },
    },
    async ({ table, url }) => {
      const stream = await rawtree.insertFromUrl({ table, url });
      return namedJsonResult('URL insert event stream', stream);
    },
  );
}

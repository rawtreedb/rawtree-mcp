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
    'run-query',
    {
      title: 'Run Query',
      description: `**Purpose:** Execute a SQL query against a RawTree database. Read queries return JSON rows, column metadata, statistics, and hints. Supported ALTER TABLE mutations return an accepted response and hints.

**Allowed writes:** Only ALTER TABLE <table> MODIFY ORDER BY (...), ALTER TABLE <table> UPDATE ... WHERE ..., and ALTER TABLE <table> DELETE WHERE .... UPDATE and DELETE are asynchronous and require a bounded WHERE condition.

**NOT for:** INSERT, standard UPDATE or DELETE FROM syntax, schema changes other than MODIFY ORDER BY, multiple statements, qualified/cross-database tables, ON CLUSTER, SETTINGS, or subqueries in mutations.

**Returns:** RawTree's query response: meta, data, rows, statistics, and optional hints.

**When to use:**
- User asks questions about data already in RawTree
- You need to verify an insert
- You need a quick aggregate, sample, or schema-oriented SELECT
- You need RawTree query hints after an error
- The user explicitly asks to change a sorting key, update matching rows, or delete matching rows

**Workflow:** Start with a bounded SELECT. For exploratory queries, include LIMIT and order by a time column when available. Before UPDATE or DELETE, preview the same WHERE condition with SELECT and confirm the requested mutation scope.

**Key trigger phrases:** "query RawTree", "run SQL", "count rows", "show sample rows", "check the data", "change sorting key", "update rows", "delete rows"`,
      inputSchema: {
        ...databaseScopeInput(scopeOptions),
        sql: z
          .string()
          .min(1)
          .describe(
            'SQL to execute. Prefer bounded SELECT queries for exploration. Writes are limited to ALTER TABLE MODIFY ORDER BY, UPDATE ... WHERE, and DELETE WHERE.',
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
      description: `**Purpose:** Ask RawTree to ingest JSON/JSONL data from a public URL into a table. RawTree streams progress as NDJSON.

**NOT for:** Private files on your machine or authenticated URLs. Normalize or transform data before making it available at the public URL.

**Returns:** The RawTree NDJSON progress stream as text.

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
      const stream = await rawtree.insertFromUrl(
        { table, url },
        requestScope({ organization, cluster, database }),
      );
      return namedJsonResult('URL insert event stream', stream);
    },
  );
}

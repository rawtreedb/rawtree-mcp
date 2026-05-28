import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

const logTypeSchema = z.enum(['select', 'insert', 'describe', 'explain']);
const logStatusSchema = z.enum(['success', 'error']);
const logOriginSchema = z.enum(['ui', 'cli', 'api']);
const hintsSchema = z.enum(['any', 'none']);

function assertValidDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO-8601 datetime string.`);
  }
  return date;
}

function resolveTimeWindow({
  startTime,
  endTime,
}: {
  startTime?: string;
  endTime?: string;
}): { start_time: string; end_time: string } {
  const end = endTime ? assertValidDate(endTime, 'endTime') : new Date();
  const start = startTime
    ? assertValidDate(startTime, 'startTime')
    : new Date(end.getTime() - 60 * 60 * 1000);

  if (start.getTime() > end.getTime()) {
    throw new Error('startTime must be before endTime.');
  }

  return {
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  };
}

function appendToken(
  tokens: string[],
  field: string,
  values: readonly string[] | undefined,
) {
  if (!values || values.length === 0) return;
  tokens.push(`${field}:${values.join(',')}`);
}

function buildSearch({
  search,
  types,
  statuses,
  origins,
  tables,
  hints,
}: {
  search?: string;
  types?: readonly string[];
  statuses?: readonly string[];
  origins?: readonly string[];
  tables?: readonly string[];
  hints?: string;
}): string | undefined {
  const tokens: string[] = [];
  if (search?.trim()) tokens.push(search.trim());
  appendToken(tokens, 'type', types);
  appendToken(tokens, 'status', statuses);
  appendToken(tokens, 'origin', origins);
  appendToken(tokens, 'table', tables);
  if (hints) tokens.push(`hints:${hints}`);
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

export function addLogTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-logs',
    {
      title: 'List Logs',
      description: `**Purpose:** List recent RawTree insert/query/describe/explain activity for the configured project.

**NOT for:** Reading application log files from disk or infrastructure logs. This tool reads RawTree's product query and insert logs.

**Returns:** Log entries with time, type, status, origin, query, exception, rows, duration, bytes, tables, projections, hints, and pagination.

**When to use:**
- An insert or query failed and you need the RawTree exception or hints
- You need to verify whether an agent, CLI, API, or UI call reached RawTree
- You need recent activity for a table
- You want the exact SQL RawTree saw

**Workflow:** Start with status=error for the last hour. Narrow by table or type if needed. Use next_offset for pagination.

**Key trigger phrases:** "check RawTree logs", "why did the insert fail", "show query history", "recent errors"`,
      inputSchema: {
        startTime: z
          .string()
          .optional()
          .describe(
            'Inclusive lower bound as an ISO datetime. Defaults to one hour before endTime.',
          ),
        endTime: z
          .string()
          .optional()
          .describe(
            'Inclusive upper bound as an ISO datetime. Defaults to now.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Number of logs to return. Default: 50. Max: 200.'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Number of logs to skip for pagination.'),
        search: z
          .string()
          .optional()
          .describe(
            'Optional raw RawTree search string, for example "type:insert status:error table:events". Structured filters are appended to it.',
          ),
        types: z
          .array(logTypeSchema)
          .optional()
          .describe('Filter by log type.'),
        statuses: z
          .array(logStatusSchema)
          .optional()
          .describe('Filter by status.'),
        origins: z
          .array(logOriginSchema)
          .optional()
          .describe('Filter by origin.'),
        tables: z
          .array(z.string().min(1))
          .optional()
          .describe('Filter by one or more table names.'),
        hints: hintsSchema
          .optional()
          .describe('Filter to logs with any hints or no hints.'),
      },
    },
    async ({
      startTime,
      endTime,
      limit,
      offset,
      search,
      types,
      statuses,
      origins,
      tables,
      hints,
    }) => {
      const timeWindow = resolveTimeWindow({ startTime, endTime });
      const response = await rawtree.listLogs({
        ...timeWindow,
        limit,
        offset,
        search: buildSearch({
          search,
          types,
          statuses,
          origins,
          tables,
          hints,
        }),
      });
      return jsonResult(response);
    },
  );
}

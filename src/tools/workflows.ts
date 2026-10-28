import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { clusterScopeInput, jsonResult } from './common.js';

const id = z
  .uuid()
  .describe(
    'Workflow ID returned by list-workflows, get-workflow, or create-workflow.',
  );
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const httpSettings = z.strictObject({
  url: z
    .url()
    .describe('Write-only sink URL. The API validates allowed origins.'),
  headers: z.record(z.string(), z.string()).optional(),
});
const tableFields = {
  type: z.literal('table'),
  settings: z.strictObject({ database: identifier, table: identifier }),
};
const newSink = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('http'), settings: httpSettings }),
  z.strictObject(tableFields),
]);
const sink = z.union([
  newSink,
  z.strictObject({
    type: z.literal('http'),
    id: z.uuid(),
    settings: httpSettings
      .extend({
        url: httpSettings.shape.url.optional(),
        headers: z.record(z.string(), z.string().nullable()).optional(),
      })
      .optional(),
  }),
  z.strictObject({ ...tableFields, id: z.uuid() }),
]);
const workflowQuery = z.strictObject({
  database: identifier.describe(
    'Database where the saved SQL executes; never inherited from the MCP default database.',
  ),
  sql: z
    .string()
    .refine((value) => value.trim().length > 0, 'SQL is required.')
    .describe(
      'Read query or INSERT INTO ... SELECT ... SQL. The API validates supported statements.',
    ),
});
const description = z
  .string()
  .max(1000)
  .describe(
    'Free-form text. The API trims it and stores blank values as null.',
  );
const cron = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .describe(
    'UTC cron: `minute hour day-of-month month day-of-week`, with an optional leading seconds field. Fields accept *, values, a-b ranges, /step, and comma lists; day of week is 0-7 with 0 and 7 as Sunday. Example: "*/30 * * * * *" runs every 30 seconds. The API validates the expression.',
  );
const scheduleEnabled = z
  .boolean()
  .optional()
  .describe('False pauses automatic runs without removing the schedule.');
const definitionFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  query: workflowQuery,
};
const auth =
  'Requires an admin API key bound to the selected organization and cluster, or OAuth. Organization members may read; organization admins may create, update, or delete. Workflows execute with organization credentials and continue after the creating key is revoked or expires.';
const result =
  'Returns the workflow object: id, name, description, query, schedule, revision, created_at, updated_at, and sinks. The query object contains database and sql. schedule is null for manual-only workflows; otherwise it contains cron, enabled, and next_run_at (null while paused). Each sink has id, type, and settings. HTTP settings contain url (null when unreadable), url_configured, and header_names; header values are never returned. Table settings contain database and table.';

export function addWorkflowTools(server: McpServer, rawtree: RawTreeClient) {
  // These API routes require both names even for API-key callers.
  const scope = z
    .strictObject(clusterScopeInput({ requireExplicitScope: true }))
    .required();
  const selected = scope.extend({ id });
  const create = scope.extend({
    ...definitionFields,
    description: description.optional(),
    schedule: z
      .strictObject({ cron, enabled: scheduleEnabled })
      .nullable()
      .optional()
      .describe(
        'Omit for the default schedule, "* * * * * *" (every second), enabled. null creates a manual-only workflow. enabled defaults to true.',
      ),
    sinks: z
      .array(newSink)
      .max(5)
      .optional()
      .describe(
        'Up to five sinks. Omit for none. New HTTP sinks require settings.url; all sink IDs are assigned by the API.',
      ),
  });
  const update = create
    .omit({
      name: true,
      description: true,
      query: true,
      schedule: true,
      sinks: true,
    })
    .extend({
      id,
      name: definitionFields.name.optional(),
      description: description
        .nullable()
        .optional()
        .describe('Omit to preserve the description; null or blank clears it.'),
      query: workflowQuery
        .partial()
        .optional()
        .describe(
          'Omit to preserve the query. Omitted database or sql fields retain their saved values.',
        ),
      schedule: z
        .strictObject({ cron: cron.optional(), enabled: scheduleEnabled })
        .nullable()
        .optional()
        .describe(
          'Omit to preserve the schedule; null makes the workflow manual-only. Omitted cron or enabled keep their saved values. cron is required when scheduling a manual-only workflow.',
        ),
      sinks: z
        .array(sink)
        .max(5)
        .optional()
        .describe(
          'Replaces the entire list. Omit to preserve it; [] removes all. Preserve IDs when editing. Existing HTTP sinks may omit settings, settings.url, or settings.headers to retain them. Within a supplied settings.headers map, null preserves a stored value; omitted header names are removed.',
        ),
    })
    .refine(
      ({ name, description, query, schedule, sinks }) =>
        schedule === null ||
        [
          name,
          description,
          query?.database,
          query?.sql,
          schedule?.cron,
          schedule?.enabled,
          sinks,
        ].some((value) => value !== undefined),
      'Supply at least one workflow field to update.',
    );

  server.registerTool(
    'list-workflows',
    {
      title: 'List Workflows',
      description: `List all workflows in one cluster across databases. Returns { workflows: [...] } with complete workflow objects; no pagination. ${result} ${auth}`,
      inputSchema: scope,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (scope) => jsonResult(await rawtree.listWorkflows(scope)),
  );

  server.registerTool(
    'get-workflow',
    {
      title: 'Get Workflow',
      description: `Read a workflow and its current schedule configuration. ${result} ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ id, ...scope }) =>
      jsonResult(await rawtree.getWorkflow(id, scope)),
  );

  server.registerTool(
    'create-workflow',
    {
      title: 'Create Workflow',
      description: `Create a scheduled SQL workflow. Requires name and query (database and sql). Defaults: schedule={ cron: "* * * * * *", enabled: true }, sinks=[]. An enabled schedule starts recurring SQL execution and sink delivery; use schedule.enabled=false to create it paused, or schedule=null for manual-only. SQL may write rows through INSERT SELECT. Creation is not idempotent: reconcile an uncertain result with list-workflows before retrying. ${result} ${auth}`,
      inputSchema: create,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization, cluster, ...input }) =>
      jsonResult(
        await rawtree.createWorkflow(input, { organization, cluster }),
      ),
  );

  server.registerTool(
    'update-workflow',
    {
      title: 'Update Workflow',
      description: `Update only supplied fields of an existing workflow; at least one changed field is required. Omitted fields remain unchanged. Set schedule.enabled=false to pause or schedule.enabled=true to resume; set schedule.cron to change the cadence. Supplying sinks replaces the whole list and may remove delivery targets. Read get-workflow before editing sinks so you can preserve their IDs. Already buffered deliveries can continue after pausing. ${result} ${auth}`,
      inputSchema: update,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ organization, cluster, id, ...input }) =>
      jsonResult(
        await rawtree.updateWorkflow(id, input, { organization, cluster }),
      ),
  );

  server.registerTool(
    'delete-workflow',
    {
      title: 'Delete Workflow',
      description: `Delete a workflow definition and its schedule, stopping future evaluations. Does not undo previous SQL writes or completed deliveries. Returns { id, deleted: true } only after the API confirms deletion. ${auth}`,
      inputSchema: selected,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ id, ...scope }) => {
      await rawtree.deleteWorkflow(id, scope);
      return jsonResult({ id, deleted: true });
    },
  );
}

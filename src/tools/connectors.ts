import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  clusterScopeInput,
  jsonResult,
  namedJsonResult,
  type ToolScopeOptions,
} from './common.js';

const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .describe('RawTree database or table identifier.');

const connectorId = z
  .string()
  .min(1)
  .describe('Connector ID returned by list-connectors or create-connector.');

const destinationInput = z
  .object({
    topics: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(100)
      .describe('Kafka topics consumed by this destination.'),
    group_id: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe(
        'Kafka consumer group. Omit to let RawTree generate an independent group for this destination.',
      ),
    database: identifier.describe('Destination RawTree database.'),
    table: identifier.describe('Destination RawTree table.'),
  })
  .strict();

const kafkaSettingsInput = z
  .object({
    bootstrap_servers: z
      .string()
      .trim()
      .min(1)
      .describe('Kafka bootstrap server addresses.'),
    auto_offset_reset: z
      .enum(['largest', 'smallest'])
      .optional()
      .describe(
        'Offset policy when the consumer group has no committed offset. Defaults to largest.',
      ),
    tls: z
      .object({
        enabled: z.literal(true),
        verify_certificate: z.boolean().optional(),
        verify_hostname: z.boolean().optional(),
      })
      .strict()
      .optional()
      .describe('TLS settings. Omit tls to disable it.'),
    sasl: z
      .object({
        enabled: z.literal(true),
        mechanism: z.enum(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512']),
        username: z.string().trim().min(1),
        password: z.string().min(1),
      })
      .strict()
      .optional()
      .describe(
        'SASL credentials. Omit sasl for an unauthenticated Kafka connection.',
      ),
    batch: z
      .object({
        max_events: z.number().int().min(1).max(100_000).optional(),
        timeout_secs: z.number().gt(0).max(60).optional(),
      })
      .strict()
      .optional()
      .describe('Optional HTTP delivery batch settings.'),
  })
  .strict();

export function addConnectorTools(
  server: McpServer,
  rawtree: RawTreeClient,
  options: ToolScopeOptions,
) {
  const scopeInput = clusterScopeInput(options);

  server.registerTool(
    'list-connectors',
    {
      title: 'List Connectors',
      description: `**Purpose:** List managed connectors for one RawTree cluster.

**Returns:** Connector IDs, names, types, statuses, destinations, sanitized settings, revisions, and timestamps. Stored credentials are never returned.

**Auth:** Requires a user credential and organization membership. Connector management may be unavailable in some environments.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: scopeInput,
    },
    async ({ organization, cluster }) =>
      jsonResult(await rawtree.listConnectors({ organization, cluster })),
  );

  server.registerTool(
    'get-connector',
    {
      title: 'Get Connector',
      description: `**Purpose:** Get one managed connector and its complete public configuration.

**Returns:** The connector status, sanitized connection settings, destinations with topics and consumer groups, revision, and timestamps. Stored credentials are never returned.

**When to use:** Inspect the latest connector before adding a destination or changing its status.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: { ...scopeInput, connectorId },
    },
    async ({ organization, cluster, connectorId }) =>
      jsonResult(
        await rawtree.getConnector(connectorId, { organization, cluster }),
      ),
  );

  server.registerTool(
    'create-connector',
    {
      title: 'Create Connector',
      description: `**Purpose:** Create an active Kafka connector with one or more independent topic-to-table destinations.

**Behavior:** Consumption starts after the runtime applies the connector. Each destination uses its own consumer group; omit group_id to let RawTree generate one. Destination tables can be created automatically when their first events arrive.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector name, bootstrap servers, offset policy, topics, consumer groups, and destination tables before calling. Treat SASL values as secrets and never repeat them in confirmation text or logs.

**Reliability:** Creation is not idempotent. If the response is ambiguous, call list-connectors and reconcile by name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        ...scopeInput,
        name: z.string().trim().min(1).max(128),
        type: z.literal('kafka'),
        destinations: z.array(destinationInput).min(1).max(32),
        settings: kafkaSettingsInput,
      },
    },
    async ({ organization, cluster, name, type, destinations, settings }) =>
      namedJsonResult(
        'Create connector result',
        await rawtree.createConnector(
          { name, type, destinations, settings },
          { organization, cluster },
        ),
      ),
  );

  server.registerTool(
    'get-connector-metrics',
    {
      title: 'Get Connector Metrics',
      description: `**Purpose:** Read current health and runtime counters for one connector and each destination.

**Returns:** Runtime status, observation time, Kafka consumer lag, buffered events, consumed and delivered event totals, errors, discarded events, source lag, and HTTP latency counters.

**Interpretation:** Event values are cumulative counters. Take two samples and divide their difference by elapsed time to calculate rates. A status of applying or unavailable includes an explanatory message.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: { ...scopeInput, connectorId },
    },
    async ({ organization, cluster, connectorId }) =>
      jsonResult(
        await rawtree.getConnectorMetrics(connectorId, {
          organization,
          cluster,
        }),
      ),
  );

  server.registerTool(
    'add-connector-destination',
    {
      title: 'Add Connector Destination',
      description: `**Purpose:** Add one Kafka topic-to-table destination to an existing connector without changing its current destinations.

**Behavior:** The tool reads the latest connector, preserves every existing destination, and appends the new destination. Omit group_id to let RawTree generate an independent consumer group. An exact existing database/table destination is treated as an idempotent success; conflicting settings are rejected.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector ID, topics, optional consumer group, database, and table before calling.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...scopeInput,
        connectorId,
        destination: destinationInput,
      },
    },
    async ({ organization, cluster, connectorId, destination }) =>
      namedJsonResult(
        'Add connector destination result',
        await rawtree.addConnectorDestination(connectorId, destination, {
          organization,
          cluster,
        }),
      ),
  );

  server.registerTool(
    'set-connector-status',
    {
      title: 'Set Connector Status',
      description: `**Purpose:** Pause or resume every destination in one connector.

**Behavior:** paused removes the connector from the active runtime. active restores it with the same destination consumer groups, so Kafka resumes from their committed offsets subject to Kafka retention and at-least-once delivery.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector ID, and requested status. Pausing interrupts ingestion for all destinations until resumed.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        ...scopeInput,
        connectorId,
        status: z.enum(['active', 'paused']),
      },
    },
    async ({ organization, cluster, connectorId, status }) =>
      namedJsonResult(
        'Set connector status result',
        await rawtree.setConnectorStatus(connectorId, status, {
          organization,
          cluster,
        }),
      ),
  );
}

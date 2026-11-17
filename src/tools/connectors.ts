import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import {
  createConnectorInput,
  destinationInput,
  kafkaSettingsInput,
  natsSettingsInput,
} from '../connectors.js';
import {
  clusterScopeInput,
  jsonResult,
  namedJsonResult,
  type ToolScopeOptions,
  textResult,
} from './common.js';

const connectorId = z
  .string()
  .min(1)
  .describe('Connector ID returned by list-connectors or create-connector.');

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

**Returns:** The connector status, sanitized connection settings, destinations with their source configuration, revision, and timestamps. Stored credentials are never returned.

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
      description: `**Purpose:** Create an active Kafka or NATS JetStream connector with one or more destinations. Settings and all destination fields must match the selected type.

**Behavior:** Consumption starts after the runtime applies the connector. Kafka destinations use independent consumer groups; omit group_id to generate one. NATS destinations require nats_stream and nats_consumer naming an existing durable pull consumer with explicit acknowledgements. RawTree does not create streams or consumers. Destination tables can be created automatically when their first events arrive.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector name, broker addresses, source topics or streams, consumer groups or durable consumers, and destination tables before calling. Treat SASL credentials, NATS passwords, tokens, and NKey seeds as secrets and never repeat them in confirmation text or logs.

**Reliability:** Creation is not idempotent. If the response is ambiguous, call list-connectors and reconcile by name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        ...scopeInput,
        name: z.string().trim().min(1).max(128),
        type: z.enum(['kafka', 'nats']),
        destinations: z.array(destinationInput).min(1).max(32),
        settings: z
          .union([kafkaSettingsInput, natsSettingsInput])
          .describe(
            'Settings must match type: bootstrap_servers for kafka; servers and optional auth for nats.',
          ),
      },
    },
    async ({ organization, cluster, name, type, destinations, settings }) =>
      namedJsonResult(
        'Create connector result',
        await rawtree.createConnector(
          createConnectorInput.parse({ name, type, destinations, settings }),
          { organization, cluster },
        ),
      ),
  );

  server.registerTool(
    'get-connector-metrics',
    {
      title: 'Get Connector Metrics',
      description: `**Purpose:** Read stored metric observations for one connector over the last window_seconds (default 300, maximum 3600).

**Returns:** A raw JSON array from /v1/metrics, filtered by connector ID. Rows retain metric names, timestamps, destination, revision, and collector identities. Metric availability depends on the connector and runtime. An empty array means no observations in this window, not zero activity.

**Interpretation:** Counters are cumulative; compare observations for the same series and revision, accounting for resets. Histograms and gauges are not counters. No runtime status or synthesized zero values are added.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        ...scopeInput,
        connectorId,
        window_seconds: z.number().int().min(1).max(3600).optional(),
      },
    },
    async ({ organization, cluster, connectorId, window_seconds }) =>
      textResult(
        await rawtree.getConnectorMetrics(
          connectorId,
          {
            organization,
            cluster,
          },
          window_seconds,
        ),
      ),
  );

  server.registerTool(
    'add-connector-destination',
    {
      title: 'Add Connector Destination',
      description: `**Purpose:** Add one Kafka topic-to-table or NATS JetStream consumer-to-table destination to an existing connector without changing its current destinations.

**Behavior:** The tool reads the latest connector, preserves every existing destination, and appends the new destination. For Kafka, omit group_id to generate an independent consumer group. For NATS, supply nats_stream and nats_consumer for an existing durable pull consumer with explicit acknowledgements. An exact existing database/table destination is treated as an idempotent success; conflicting settings are rejected.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector ID, source topics or stream, consumer group or durable consumer, database, and table before calling.`,
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

**Behavior:** paused removes the connector from the active runtime. active restores it with the same Kafka consumer groups or NATS durable consumers. Resumption depends on broker retention and saved consumer progress; delivery is at least once.

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

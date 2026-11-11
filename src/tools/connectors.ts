import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CreateConnectorInput, RawTreeClient } from '../client.js';
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

const createDestinationInput = destinationInput.extend({
  topics: destinationInput.shape.topics
    .optional()
    .describe('Kafka topics consumed by this destination. Omit for S3.'),
  group_id: destinationInput.shape.group_id.describe(
    'Kafka consumer group. Omit to let RawTree generate one. Omit for S3.',
  ),
});

const s3SettingsInput = z
  .object({
    ingestion_mode: z
      .enum(['events', 'backfill_and_events', 'backfill'])
      .optional()
      .describe(
        'events (default) imports only objects created after the connector is activated. backfill_and_events also imports existing objects once. backfill imports existing objects once and ignores new ones. Cannot change after creation.',
      ),
    bucket_uri: z
      .string()
      .trim()
      .min(1)
      .describe(
        's3://bucket/key-pattern, such as s3://acme-events/logs/**/*.parquet. * and ? match within one path segment, ** crosses segments, and **/ matches zero or more directories. The bucket cannot change after creation, and an organization can have only one S3 connector per bucket.',
      ),
    format: z
      .enum(['ndjson', 'csv', 'parquet'])
      .optional()
      .describe(
        'File format. Omit when bucket_uri ends in .ndjson, .jsonl, .csv, or .parquet; RawTree infers it from the extension.',
      ),
    region: z
      .string()
      .trim()
      .min(1)
      .describe(
        'AWS region of the bucket, such as us-east-1. Cannot change after creation.',
      ),
    auth: z
      .object({
        type: z.literal('iam_role'),
        role_arn: z
          .string()
          .trim()
          .min(1)
          .describe(
            'IAM role RawTree assumes, such as arn:aws:iam::123456789012:role/rawtree-s3. It must be in the AWS partition of region.',
          ),
      })
      .strict()
      .describe(
        'IAM role auth, the only method. RawTree generates the external ID for the role trust policy and returns it in settings; it cannot be set.',
      ),
    from_time: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Skip objects last modified before this RFC 3339 time.'),
  })
  .strict();

const createConnectorFields = {
  name: z.string().trim().min(1).max(128),
  type: z.enum(['kafka', 's3']),
  destinations: z
    .array(createDestinationInput)
    .min(1)
    .max(32)
    .describe(
      'Kafka: one or more topic-to-table destinations. S3: exactly one destination with only database and table.',
    ),
  settings: z
    .union([kafkaSettingsInput, s3SettingsInput])
    .describe(
      "Kafka settings for type kafka; S3 settings for type s3. Each shape rejects the other type's fields.",
    ),
};

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

**Returns:** The connector status, sanitized connection settings, destinations with topics and consumer groups, revision, and timestamps. S3 connectors that import existing objects also return backfill with its status (pending, running, completed, or failed) and objects_imported. Stored credentials are never returned.

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
      description: `**Purpose:** Create a Kafka or S3 connector that imports data into RawTree tables.

**Kafka:** Created active. One or more independent topic-to-table destinations. Each destination uses its own consumer group; omit group_id to let RawTree generate one.

**S3:** Created paused, because the IAM role cannot trust the connector's generated external ID until the connector exists. Imports objects matching settings.bucket_uri into exactly one table; settings.ingestion_mode chooses new objects (events, the default), existing objects once, or both. Pass one destination with only database and table. An organization can have only one S3 connector per bucket. Then: call get-connector-aws-iam-policies, have the user attach the returned policies to the role in AWS, and call set-connector-status with active. S3 connectors may not be enabled in every environment; the API error says so.

**Behavior:** Destination tables can be created automatically when their first events arrive.

**Auth:** Requires organization-admin access.

**Safety:** Confirm the exact organization, cluster, connector name, type, source settings, and destination tables before calling. Treat SASL passwords as secrets and never repeat them in confirmation text or logs.

**Reliability:** Creation is not idempotent. If the response is ambiguous, call list-connectors and reconcile by name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: z
        .object({ ...scopeInput, ...createConnectorFields })
        .transform(({ organization, cluster, ...fields }, context) => {
          const request = createConnectorRequest(fields);
          if (typeof request === 'string') {
            context.issues.push({
              code: 'custom',
              message: request,
              input: fields,
            });
            return z.NEVER;
          }
          return { organization, cluster, request };
        }),
    },
    async ({ organization, cluster, request }) =>
      namedJsonResult(
        'Create connector result',
        await rawtree.createConnector(request, { organization, cluster }),
      ),
  );

  server.registerTool(
    'get-connector-aws-iam-policies',
    {
      title: 'Get Connector AWS IAM Policies',
      description: `**Purpose:** Get the AWS IAM policies an S3 connector needs to read its bucket.

**Returns:** access_policy, the permissions to attach to the connector's IAM role, and role_trust with RawTree's principal_arn, the connector's generated external_id, and the trust_policy to set on the role.

**When to use:** Right after create-connector for an S3 connector, before activating it, and whenever bucket access fails. Show the user both documents; they attach them in AWS.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: { ...scopeInput, connectorId },
    },
    async ({ organization, cluster, connectorId }) =>
      jsonResult(
        await rawtree.getConnectorAwsIamPolicies(connectorId, {
          organization,
          cluster,
        }),
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
      description: `**Purpose:** Add one Kafka topic-to-table destination to an existing Kafka connector without changing its current destinations. S3 connectors have exactly one destination, set at creation.

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

**S3:** S3 connectors are created paused; set active once the user has attached the policies from get-connector-aws-iam-policies. Activating installs the bucket notification for events modes and, the first time, starts the one-time backfill of existing objects for backfill modes. Pausing also pauses an unfinished backfill.

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

type CreateConnectorFields = z.output<
  z.ZodObject<typeof createConnectorFields>
>;

/** Pairs the connector type with its settings and destination shape. */
function createConnectorRequest({
  name,
  type,
  destinations,
  settings,
}: CreateConnectorFields): CreateConnectorInput | string {
  if (type === 's3') {
    if (!('bucket_uri' in settings)) {
      return 'S3 connectors take S3 settings: bucket_uri, region, and auth.';
    }
    const [destination, ...rest] = destinations;
    if (
      destination === undefined ||
      rest.length > 0 ||
      destination.topics !== undefined ||
      destination.group_id !== undefined
    ) {
      return 'S3 connectors take exactly one destination with only database and table.';
    }
    const { database, table } = destination;
    return { name, type, destinations: [{ database, table }], settings };
  }

  if (!('bootstrap_servers' in settings)) {
    return 'Kafka connectors take Kafka settings, starting with bootstrap_servers.';
  }
  const kafkaDestinations = [];
  for (const { topics, group_id, database, table } of destinations) {
    if (topics === undefined) return 'Kafka destinations require topics.';
    kafkaDestinations.push({ topics, group_id, database, table });
  }
  return { name, type, destinations: kafkaDestinations, settings };
}

import { z } from 'zod';

const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .describe('RawTree database or table identifier.');

export const kafkaDestinationInput = z
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

export const kafkaSettingsInput = z
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

const natsName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s.*>/\\]+$/)
  .refine(
    (name) => Buffer.byteLength(name, 'utf8') <= 255,
    'JetStream names must contain at most 255 UTF-8 bytes.',
  );

export const natsDestinationInput = z.strictObject({
  nats_stream: natsName.describe('Existing JetStream stream name.'),
  nats_consumer: natsName.describe(
    'Existing durable pull consumer with explicit acknowledgements.',
  ),
  database: identifier,
  table: identifier,
});

export const destinationInput = z.union([
  kafkaDestinationInput,
  natsDestinationInput,
]);

export const natsSettingsInput = z.strictObject({
  servers: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Comma-separated nats:// or tls:// server URLs, without embedded credentials.',
    ),
  tls: z
    .strictObject({ enabled: z.literal(true) })
    .optional()
    .describe(
      'Standard TLS with certificate and hostname verification. tls:// URLs also enable TLS.',
    ),
  auth: z
    .discriminatedUnion('strategy', [
      z.strictObject({
        strategy: z.literal('user_password'),
        user: z.string().trim().min(1),
        password: z.string().min(1),
      }),
      z.strictObject({
        strategy: z.literal('token'),
        token: z.string().min(1),
      }),
      z.strictObject({
        strategy: z.literal('nkey'),
        nkey: z.string().min(1),
        seed: z.string().min(1),
      }),
    ])
    .optional()
    .describe(
      'NATS credentials. Passwords, tokens, and NKey seeds are secrets. Omit for an unauthenticated broker.',
    ),
  batch: kafkaSettingsInput.shape.batch,
});

const name = z.string().trim().min(1).max(128);
export const createConnectorInput = z.discriminatedUnion('type', [
  z.strictObject({
    name,
    type: z.literal('kafka'),
    destinations: z.array(kafkaDestinationInput).min(1).max(32),
    settings: kafkaSettingsInput,
  }),
  z.strictObject({
    name,
    type: z.literal('nats'),
    destinations: z.array(natsDestinationInput).min(1).max(32),
    settings: natsSettingsInput,
  }),
]);

export type CreateConnectorInput = z.infer<typeof createConnectorInput>;
export type KafkaConnectorSettingsInput = z.infer<typeof kafkaSettingsInput>;
export type NatsConnectorSettingsInput = z.infer<typeof natsSettingsInput>;
export type NewConnectorDestinationInput = z.infer<typeof destinationInput>;
export type ConnectorDestinationInput = NewConnectorDestinationInput & {
  id?: string;
};

const storedDestination = z.object({
  id: z.string(),
  database: z.string(),
  table: z.string(),
});
const storedConnector = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kafka'),
    destinations: z.array(
      storedDestination.extend({
        topics: z.array(z.string()),
        group_id: z.string(),
      }),
    ),
  }),
  z.object({
    type: z.literal('nats'),
    destinations: z.array(
      storedDestination.extend({
        nats_stream: z.string(),
        nats_consumer: z.string(),
      }),
    ),
  }),
]);

export function connectorDestinations(
  value: unknown,
  requested: NewConnectorDestinationInput,
): ConnectorDestinationInput[] {
  const parsed = storedConnector.safeParse(value);
  if (!parsed.success)
    throw new Error(
      'RawTree returned an invalid or unsupported connector response.',
    );
  const schema =
    parsed.data.type === 'nats' ? natsDestinationInput : kafkaDestinationInput;
  if (!schema.safeParse(requested).success) {
    throw new Error(
      `Destination fields must match connector type ${parsed.data.type}.`,
    );
  }
  return parsed.data.destinations;
}

export function sameDestination(
  existing: ConnectorDestinationInput,
  requested: NewConnectorDestinationInput,
): boolean {
  if ('nats_stream' in existing && 'nats_stream' in requested) {
    return (
      existing.nats_stream === requested.nats_stream &&
      existing.nats_consumer === requested.nats_consumer
    );
  }
  if ('topics' in existing && 'topics' in requested) {
    return (
      existing.topics.length === requested.topics.length &&
      existing.topics.every(
        (topic, index) => topic === requested.topics[index],
      ) &&
      (requested.group_id === undefined ||
        existing.group_id === requested.group_id)
    );
  }
  return false;
}

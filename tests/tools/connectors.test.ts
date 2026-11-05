import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const scope = { organization: 'acme', cluster: 'production' };
const query = '?organization=acme&cluster=production';
const roleArn = 'arn:aws:iam::123456789012:role/rawtree-s3';
const s3Settings = {
  bucket_uri: 's3://acme-events/logs/**/*.parquet',
  region: 'eu-west-1',
  auth: { type: 'iam_role', role_arn: roleArn },
};
const s3Destination = { database: 'default', table: 'events' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('connector MCP tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((c) => c.close()));
  });

  async function connect(responses: Response[] = []) {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected API request.');
      return response;
    });
    const rawtree = new RawTreeClient({ apiKey: 'rt_admin_test', fetchFn });
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'connector-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, fetchFn };
  }

  function sentBody(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
    const init = fetchFn.mock.calls[0]?.[1];
    return JSON.parse(String(init?.body));
  }

  it('creates an S3 connector with one destination and API field names', async () => {
    const { client, fetchFn } = await connect([json({ id: 'c1' }, 201)]);
    const settings = {
      ...s3Settings,
      format: 'ndjson',
      from_time: '2026-01-02T03:04:05Z',
    };

    const result = await client.callTool({
      name: 'create-connector',
      arguments: {
        ...scope,
        name: 'events',
        type: 's3',
        destinations: [s3Destination],
        settings,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(fetchFn.mock.calls[0]?.[0].toString()).toBe(
      `https://api.rawtree.com/v1/connectors${query}`,
    );
    expect(sentBody(fetchFn)).toEqual({
      name: 'events',
      type: 's3',
      destinations: [s3Destination],
      settings,
    });
  });

  it('sends access key credentials only in the create request', async () => {
    const { client, fetchFn } = await connect([json({ id: 'c1' }, 201)]);
    const auth = {
      type: 'access_key',
      access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      secret_access_key: 'secret',
    };

    await client.callTool({
      name: 'create-connector',
      arguments: {
        ...scope,
        name: 'events',
        type: 's3',
        destinations: [s3Destination],
        settings: { ...s3Settings, auth },
      },
    });

    expect(sentBody(fetchFn).settings.auth).toEqual(auth);
  });

  it.each([
    [
      'Kafka fields on an S3 destination',
      { type: 's3', destinations: [{ ...s3Destination, topics: ['orders'] }] },
      'exactly one destination',
    ],
    [
      'two S3 destinations',
      {
        type: 's3',
        destinations: [s3Destination, { ...s3Destination, table: 'other' }],
      },
      'exactly one destination',
    ],
    [
      'Kafka settings for an S3 connector',
      { type: 's3', settings: { bootstrap_servers: 'kafka:9092' } },
      'S3 settings',
    ],
    ['S3 settings for a Kafka connector', { type: 'kafka' }, 'Kafka settings'],
    [
      'a Kafka destination without topics',
      { type: 'kafka', settings: { bootstrap_servers: 'kafka:9092' } },
      'require topics',
    ],
    [
      'a client-chosen external ID',
      {
        type: 's3',
        settings: {
          ...s3Settings,
          auth: { ...s3Settings.auth, external_id: 'chosen' },
        },
      },
      'Invalid arguments',
    ],
  ])('rejects %s before calling the API', async (_case, overrides, message) => {
    const { client, fetchFn } = await connect();

    const result = await client.callTool({
      name: 'create-connector',
      arguments: {
        ...scope,
        name: 'events',
        destinations: [s3Destination],
        settings: s3Settings,
        ...overrides,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(message);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('surfaces the API error when S3 connectors are disabled', async () => {
    const { client } = await connect([
      json(
        {
          error: 'service_unavailable',
          message: 'S3 connectors are not available.',
          hint: 'S3 connectors are not enabled in this environment.',
        },
        503,
      ),
    ]);

    const result = await client.callTool({
      name: 'create-connector',
      arguments: {
        ...scope,
        name: 'events',
        type: 's3',
        destinations: [s3Destination],
        settings: s3Settings,
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'S3 connectors are not available. S3 connectors are not enabled in this environment.',
        },
      ],
    });
  });

  it('returns the AWS IAM policies for an S3 connector', async () => {
    const policies = {
      access_policy: { Version: '2012-10-17', Statement: [] },
      role_trust: {
        principal_arn: 'arn:aws:iam::111111111111:role/rawtree',
        external_id: 'rawtree-external-id',
        trust_policy: { Version: '2012-10-17', Statement: [] },
      },
    };
    const { client, fetchFn } = await connect([json(policies)]);

    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === 'get-connector-aws-iam-policies',
    );
    expect(tool?.inputSchema.required).toEqual(['connectorId']);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const result = await client.callTool({
      name: 'get-connector-aws-iam-policies',
      arguments: { ...scope, connectorId: 'c1' },
    });

    expect(result.isError).not.toBe(true);
    expect(fetchFn.mock.calls[0]?.[0].toString()).toBe(
      `https://api.rawtree.com/v1/connectors/c1/aws-iam-policies${query}`,
    );
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(policies, null, 2) },
    ]);
  });
});

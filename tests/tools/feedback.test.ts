import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json' with { type: 'json' };
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const receipt = {
  id: 'b2b27b86-f2eb-4059-86f9-b99c29f05980',
  created_at: '2026-11-08T12:34:56Z',
};
const input = {
  message: 'The tool error is unclear.',
  category: 'bug',
  actor_type: 'agent',
};
const org = '47ce36ed-fada-442a-b69d-0ecc9bbc5af4';
const cluster = '98e74d8b-d7f3-4ae2-a6ad-b21f10640ad7';

describe('feedback MCP tool', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((item) => item.close()));
  });

  async function connect(status = 201, explicit = true, apiKey = 'rt_test') {
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(
            status === 201 ? receipt : { message: 'Feedback unavailable' },
          ),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const rawtree = new RawTreeClient({
      apiKey,
      fetchFn,
      organization: 'configured-org',
      cluster: 'configured-cluster',
      database: 'configured-db',
    });
    const server = createMcpServer(rawtree, { requireExplicitScope: explicit });
    const client = new Client({ name: 'feedback-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, fetchFn };
  }

  it.each([
    true,
    false,
  ])('advertises authorship and agent feedback on initialization (explicit=%s)', async (explicit) => {
    const { client, fetchFn } = await connect(201, explicit);
    expect(client.getInstructions()).toContain('submit-feedback');
    expect(client.getInstructions()).toContain('actor_type to agent');
    expect(client.getInstructions()).toContain('actor_type to human');
    expect(client.getInstructions()).toContain('When a user asks');
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === 'submit-feedback',
    );
    expect(tool?.inputSchema.required).toEqual([
      'message',
      'category',
      'actor_type',
    ]);
    expect(tool?.description).toContain('inconsistencies');
    expect(tool?.description).toContain('unclear behavior');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tool?.inputSchema.additionalProperties).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  for (const actor_type of ['human', 'agent']) {
    it.each([
      'bug',
      'feature_request',
      'question',
      'other',
    ])(`submits ${actor_type} feedback (%s) without requiring scope discovery`, async (category) => {
      const { client, fetchFn } = await connect(201, true, 'oauth_user');
      const extra = {
        tool: 'run-query',
        nested: { values: [1, true, null, 'café'] },
        actor_type: 'spoofed',
        user_id: 'untrusted',
      };
      const body = { ...input, category, actor_type, extra };
      const result = await client.callTool({
        name: 'submit-feedback',
        arguments: body,
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify(receipt, null, 2) },
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, options] = fetchFn.mock.calls[0];
      expect(url.toString()).toBe('https://api.rawtree.com/v1/feedback');
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual(body);
      expect(options?.headers).toMatchObject({
        Authorization: 'Bearer oauth_user',
        'x-rawtree-client': 'mcp',
        'x-rawtree-client-version': packageJson.version,
      });
    });
  }

  it.each([
    {},
    { organization_id: org },
    { cluster_id: cluster },
    { organization_id: org, cluster_id: cluster },
  ])('preserves optional scope IDs: %j', async (scope) => {
    const { client, fetchFn } = await connect();
    const body = { ...input, ...scope };
    await client.callTool({ name: 'submit-feedback', arguments: body });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, options] = fetchFn.mock.calls[0];
    expect(Object.fromEntries(new URL(url.toString()).searchParams)).toEqual(
      scope,
    );
    expect(JSON.parse(String(options?.body))).toEqual(body);
  });

  it.each([
    { ...input, actor_type: undefined },
    { ...input, actor_type: 'user' },
    { ...input, category: undefined },
    { ...input, category: 'invalid' },
    { ...input, message: '' },
    { ...input, message: ' \n\t' },
    { ...input, message: 'é'.repeat(8193) },
    { ...input, organization_id: 'name' },
    { ...input, cluster_id: 'name' },
    { ...input, extra: [] },
    { ...input, extra: null },
    { ...input, extra: 'text' },
    { ...input, source: 'mcp' },
    { ...input, user_id: org },
    { ...input, service_account_id: org },
    { ...input, extra: { large: 'x'.repeat(32768) } },
  ])('rejects invalid input without a request: %j', async (body) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'submit-feedback',
      arguments: body,
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts the UTF-8 message boundary', async () => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'submit-feedback',
      arguments: { ...input, message: 'é'.repeat(8192), extra: {} },
    });
    expect(result.isError).not.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    400, 401, 403, 413, 429, 503,
  ])('surfaces HTTP %s without retry or a success receipt', async (status) => {
    const { client, fetchFn } = await connect(status);
    const result = await client.callTool({
      name: 'submit-feedback',
      arguments: input,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Feedback unavailable');
    expect(JSON.stringify(result.content)).not.toContain(receipt.id);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

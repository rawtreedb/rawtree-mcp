import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const organizationId = '00000000-0000-4000-8000-000000000001';
const account = {
  id: '00000000-0000-4000-8000-000000000002',
  organization_id: organizationId,
  name: 'build-jobs',
  description: null,
  role: 'member',
};
const organizations = {
  organizations: [
    { name: 'other', organization_id: '00000000-0000-4000-8000-000000000003' },
    { name: 'team alpha', organization_id: organizationId },
  ],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('service account tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(responses: Response[] = [], explicit = true) {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      const next = responses.shift();
      if (!next) throw new Error('Unexpected request');
      return next;
    });
    const server = createMcpServer(
      new RawTreeClient({
        apiKey: 'oauth_test',
        fetchFn,
        organization: 'other',
        cluster: 'ignored',
        database: 'ignored',
      }),
      { requireExplicitScope: explicit },
    );
    const client = new Client({
      name: 'service-account-test',
      version: '0.0.0',
    });
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
  ])('requires an organization and advertises correct annotations (explicit: %s)', async (explicit) => {
    const { client } = await connect([], explicit);
    const { tools } = await client.listTools();
    for (const name of ['list-service-accounts', 'create-service-account']) {
      const tool = tools.find((value) => value.name === name);
      const creating = name === 'create-service-account';
      expect(tool?.inputSchema.required).toEqual(
        creating ? ['organization', 'name'] : ['organization'],
      );
      expect(tool?.inputSchema.properties).not.toHaveProperty('cluster');
      expect(tool?.inputSchema.properties).not.toHaveProperty('database');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: !creating,
        destructiveHint: false,
        idempotentHint: !creating,
      });
    }
  });

  it.each([
    { accounts: [] },
    { accounts: [account] },
  ])('lists accounts using the selected organization UUID', async ({
    accounts,
  }) => {
    const { client, fetchFn } = await connect([
      response(organizations),
      response(accounts),
    ]);
    const result = await client.callTool({
      name: 'list-service-accounts',
      arguments: { organization: 'team alpha' },
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      'https://api.rawtree.com/v1/organizations',
    );
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/service-accounts`,
    );
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('GET');
  });

  it.each([
    {},
    { role: 'admin', description: 'é'.repeat(1000) },
  ])('creates with optional metadata %j', async (metadata) => {
    const created = { ...account, ...metadata };
    const { client, fetchFn } = await connect([
      response(organizations),
      response(created),
    ]);
    const result = await client.callTool({
      name: 'create-service-account',
      arguments: {
        organization: 'team alpha',
        name: 'build-jobs',
        ...metadata,
      },
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: JSON.stringify(created, null, 2) }],
    });
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(
      `https://api.rawtree.com/v1/organizations/${organizationId}/service-accounts`,
    );
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual({
      name: 'build-jobs',
      role: 'member',
      ...metadata,
    });
  });

  it.each([
    { name: '' },
    { name: 'Build' },
    { name: 'a--b' },
    { name: 'a\n' },
    { name: 'a\r' },
    { name: 'a'.repeat(129) },
    { name: 'build', role: 'owner' },
    { name: 'build', description: 'é'.repeat(1001) },
    { name: 'build', description: 'null\0byte' },
  ])('rejects invalid creation input before contacting the API: %j', async (input) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({
      name: 'create-service-account',
      arguments: { organization: 'team alpha', ...input },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    'list-service-accounts',
    'create-service-account',
  ])('rejects missing organization for %s', async (name) => {
    const { client, fetchFn } = await connect([], false);
    const result = await client.callTool({
      name,
      arguments: { name: 'build-jobs' },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never falls back to a different organization', async () => {
    const { client, fetchFn } = await connect([response(organizations)]);
    const result = await client.callTool({
      name: 'create-service-account',
      arguments: { organization: 'missing', name: 'build-jobs' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Organization 'missing' was not found"),
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    401, 403, 409,
  ])('reports API errors without retrying creation: %s', async (status) => {
    const { client, fetchFn } = await connect([
      response(organizations),
      response({ message: 'Request denied' }, status),
    ]);
    const result = await client.callTool({
      name: 'create-service-account',
      arguments: { organization: 'team alpha', name: 'build-jobs' },
    });
    expect(result.isError).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

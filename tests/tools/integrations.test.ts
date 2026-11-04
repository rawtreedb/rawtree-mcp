import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const integrationId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const organizationsUrl = 'https://api.rawtree.com/v1/organizations';
const apiUrl = `${organizationsUrl}/${organizationId}`;
const organizations = {
  organizations: [
    { organization_id: '00000000-0000-4000-8000-000000000003', name: 'acme' },
    { organization_id: organizationId, name: 'acme team' },
  ],
};
const integrations = {
  integrations: [
    {
      id: integrationId,
      organization_id: organizationId,
      type: 'slack',
      settings: {
        team_id: 'T0123456789',
        team_name: 'Acme',
        bot_user_id: 'U0123456789',
        scopes: ['channels:read', 'chat:write'],
      },
      created_at: '2026-10-05T10:00:00Z',
    },
  ],
  slack_available: true,
};
const channels = {
  channels: [{ id: 'C0123456789', name: 'alerts', is_private: false }],
  next_cursor: 'dGVhbTpDMDEyMw==',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const content = (body: unknown) => [
  { type: 'text', text: JSON.stringify(body, null, 2) },
];

describe('integration MCP tools', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((c) => c.close()));
  });

  async function connect(responses: Response[] = [], appUrl?: string) {
    const fetchFn = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === organizationsUrl) return json(organizations);
      const response = responses.shift();
      if (!response) throw new Error('Unexpected API request.');
      return response;
    });
    const rawtree = new RawTreeClient({
      apiKey: 'oauth_test',
      appUrl,
      fetchFn,
    });
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'integration-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const apiCalls = () =>
      fetchFn.mock.calls.filter(([url]) => String(url) !== organizationsUrl);
    return { client, fetchFn, apiCalls };
  }

  it('advertises read-only lookup tools and no install or disconnect tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const name of ['list-integrations', 'list-slack-channels']) {
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(
      tools.find((t) => t.name === 'list-slack-channels')?.inputSchema.required,
    ).toEqual(['organization', 'integration_id']);
    expect(
      tools.filter((t) => t.name.includes('integration')).map((t) => t.name),
    ).toEqual(['list-integrations']);
  });

  it.each([
    [undefined, 'https://rawtree.com/acme%20team/~/integrations'],
    [
      'http://localhost:8081/',
      'http://localhost:8081/acme%20team/~/integrations',
    ],
  ])('lists integrations with the settings link (app URL %s)', async (appUrl, settingsUrl) => {
    const { client, fetchFn } = await connect([json(integrations)], appUrl);
    expect(
      await client.callTool({
        name: 'list-integrations',
        arguments: { organization: 'acme team' },
      }),
    ).toMatchObject({
      content: content({ ...integrations, settings_url: settingsUrl }),
    });
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      organizationsUrl,
      `${apiUrl}/integrations`,
    ]);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer oauth_test' },
    });
  });

  it('lists Slack channels and forwards the cursor', async () => {
    const { client, apiCalls } = await connect([
      json(channels),
      json({ ...channels, next_cursor: null }),
    ]);
    const args = { organization: 'acme team', integration_id: integrationId };
    expect(
      await client.callTool({ name: 'list-slack-channels', arguments: args }),
    ).toMatchObject({ content: content(channels) });
    await client.callTool({
      name: 'list-slack-channels',
      arguments: { ...args, cursor: channels.next_cursor },
    });
    const base = `${apiUrl}/integrations/${integrationId}/channels`;
    expect(apiCalls().map(([url]) => String(url))).toEqual([
      base,
      `${base}?cursor=dGVhbTpDMDEyMw%3D%3D`,
    ]);
  });

  it('searches channels by name and passes through an empty page with a cursor', async () => {
    const pending = { channels: [], next_cursor: 'c2Nhbjoy' };
    const { client, apiCalls } = await connect([
      json(pending),
      json({ ...channels, next_cursor: null }),
    ]);
    const args = {
      organization: 'acme team',
      integration_id: integrationId,
      name: '#Alerts',
    };
    expect(
      await client.callTool({ name: 'list-slack-channels', arguments: args }),
    ).toMatchObject({ content: content(pending) });
    await client.callTool({
      name: 'list-slack-channels',
      arguments: { ...args, cursor: pending.next_cursor },
    });
    const base = `${apiUrl}/integrations/${integrationId}/channels`;
    expect(apiCalls().map(([url]) => String(url))).toEqual([
      `${base}?name=%23Alerts`,
      `${base}?name=%23Alerts&cursor=c2Nhbjoy`,
    ]);
  });

  it.each([
    { name: 'list-integrations', args: {} },
    { name: 'list-slack-channels', args: { organization: 'acme' } },
    {
      name: 'list-slack-channels',
      args: { organization: 'acme', integration_id: 'slack' },
    },
    {
      name: 'list-slack-channels',
      args: { organization: 'acme', integration_id: integrationId, cursor: '' },
    },
    ...['', ' # ', 'a'.repeat(81)].map((name) => ({
      name: 'list-slack-channels',
      args: { organization: 'acme', integration_id: integrationId, name },
    })),
  ])('rejects invalid inputs without calling the API: %j', async ({
    name,
    args,
  }) => {
    const { client, fetchFn } = await connect();
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails when the organization is not visible to the credential', async () => {
    const { client, apiCalls } = await connect();
    const result = await client.callTool({
      name: 'list-integrations',
      arguments: { organization: 'other' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      "Organization 'other' was not found.",
    );
    expect(apiCalls()).toEqual([]);
  });

  it('preserves backend failures', async () => {
    const { client } = await connect([
      json(
        {
          message: 'Organization not found.',
          hint: 'Check the organization name.',
        },
        404,
      ),
    ]);
    const result = await client.callTool({
      name: 'list-integrations',
      arguments: { organization: 'acme team' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'Organization not found. Check the organization name.',
    );
  });
});

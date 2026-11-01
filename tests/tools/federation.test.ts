import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

const id = '00000000-0000-4000-8000-000000000001';
const organization = 'team alpha';
const cluster = 'prod/eu';
const catalog = {
  organizations: [
    { name: 'other', organization_id: '00000000-0000-4000-8000-000000000002' },
    { name: organization, organization_id: id },
  ],
};
const issuer = { name: 'ci', issuer_url: 'https://EXAMPLE.com/tenant/' };
const rule = {
  name: 'ci',
  issuer_id: id,
  allowed_audiences: ['rawtree', 'second'],
  claim_conditions: { sub: 'repo:acme/app:ref:refs/heads/main', label: 'a=b' },
  principal_type: 'service_account',
  principal_id: id,
  permission: 'read_only',
  database: 'warehouse',
  enabled: false,
};
const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
async function connect(responses: Response[] = []) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const result = responses.shift();
    if (!result) throw new Error('Unexpected request');
    return result;
  });
  const server = createMcpServer(
    new RawTreeClient({
      apiKey: 'rt_fixture',
      fetchFn,
      organization: 'wrong',
      cluster: 'wrong',
      database: 'wrong',
    }),
  );
  const client = new Client({ name: 'federation-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await server.connect(right);
  await client.connect(left);
  return { client, fetchFn };
}

describe('federation tools', () => {
  for (const entity of ['issuer', 'rule']) {
    for (const action of ['list', 'get', 'create', 'update', 'delete']) {
      const name = `${action}-federation-${entity}${action === 'list' ? 's' : ''}`;
      it(`${name} uses the exact API method, scope and complete payload`, async () => {
        const input = entity === 'issuer' ? issuer : rule;
        const body =
          action === 'list'
            ? []
            : action === 'delete'
              ? null
              : {
                  ...input,
                  id,
                  organization_id: id,
                  created_at: 'date',
                  updated_at: 'date',
                };
        const replies = [response(body)];
        if (entity === 'issuer') replies.unshift(response(catalog));
        const { client, fetchFn } = await connect(replies);
        const args = {
          organization,
          ...(entity === 'rule' ? { cluster } : {}),
          ...(['get', 'update', 'delete'].includes(action) ? { id } : {}),
          ...(['create', 'update'].includes(action) ? input : {}),
        };
        expect(await client.callTool({ name, arguments: args })).toMatchObject({
          content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
        });
        const request = fetchFn.mock.calls.at(-1);
        const url = new URL(String(request?.[0]));
        const suffix = ['get', 'update', 'delete'].includes(action)
          ? `/${id}`
          : '';
        expect(url.pathname).toBe(
          entity === 'issuer'
            ? `/v1/organizations/${id}/federation-issuers${suffix}`
            : `/v1/federation-rules${suffix}`,
        );
        expect(Object.fromEntries(url.searchParams)).toEqual(
          entity === 'issuer' ? {} : { organization, cluster },
        );
        expect(request?.[1]?.method).toBe(
          action === 'create'
            ? 'POST'
            : action === 'update'
              ? 'PUT'
              : action === 'delete'
                ? 'DELETE'
                : 'GET',
        );
        if (['create', 'update'].includes(action))
          expect(JSON.parse(String(request?.[1]?.body))).toEqual(
            entity === 'issuer'
              ? { ...issuer, jwks_source: 'discovery' }
              : rule,
          );
        const tool = (await client.listTools()).tools.find(
          (t) => t.name === name,
        );
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: ['list', 'get'].includes(action),
          destructiveHint: !['list', 'get'].includes(action),
          idempotentHint: action !== 'create',
        });
        expect(tool?.inputSchema.required).toContain('organization');
        if (entity === 'rule')
          expect(tool?.inputSchema.required).toContain('cluster');
        else expect(tool?.inputSchema.properties).not.toHaveProperty('cluster');
      });
    }
  }
  it('replaces a rule with database roles and preserves null descriptions', async () => {
    const { permission: _permission, ...rolesRule } = rule;
    const input = {
      ...rolesRule,
      database_roles: ['reader', 'writer'],
      description: null,
    };
    const { client, fetchFn } = await connect([response(input)]);
    expect(
      (
        await client.callTool({
          name: 'update-federation-rule',
          arguments: { organization, cluster, id, ...input },
        })
      ).isError,
    ).not.toBe(true);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
  it('supports explicit signing key URLs without normalizing the issuer', async () => {
    const input = {
      ...issuer,
      jwks_source: 'explicit_url',
      jwks_url: 'https://keys.example.com/jwks?version=2',
    };
    const { client, fetchFn } = await connect([
      response(catalog),
      response(input),
    ]);
    expect(
      (
        await client.callTool({
          name: 'create-federation-issuer',
          arguments: { organization, ...input },
        })
      ).isError,
    ).not.toBe(true);
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual(input);
  });
  it.each([
    ['create-federation-issuer', { ...issuer, jwks_source: 'explicit_url' }],
    [
      'create-federation-issuer',
      { ...issuer, jwks_url: 'https://keys.example.com' },
    ],
    [
      'create-federation-issuer',
      { ...issuer, issuer_url: 'http://example.com' },
    ],
    ['create-federation-rule', { ...rule, permission: undefined }],
    ['create-federation-rule', { ...rule, database_roles: ['reader'] }],
    ['create-federation-rule', { ...rule, claim_conditions: {} }],
    [
      'create-federation-rule',
      { ...rule, claim_conditions: { aud: 'rawtree' } },
    ],
    ['create-federation-rule', { ...rule, claim_conditions: { sub: 42 } }],
    ['create-federation-rule', { ...rule, allowed_audiences: ['a', 'a'] }],
    ['update-federation-rule', { id, name: 'partial' }],
    ['update-federation-issuer', { id, name: 'partial' }],
  ])('rejects invalid or partial configuration for %s', async (name, input) => {
    const { client, fetchFn } = await connect();
    const scope = name.endsWith('rule')
      ? { organization, cluster }
      : { organization };
    expect(
      (await client.callTool({ name, arguments: { ...scope, ...input } }))
        .isError,
    ).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    'list-federation-issuers',
    'get-federation-issuer',
    'delete-federation-issuer',
    'list-federation-rules',
    'get-federation-rule',
    'delete-federation-rule',
  ])('requires explicit scope despite connection defaults: %s', async (name) => {
    const { client, fetchFn } = await connect();
    expect((await client.callTool({ name, arguments: { id } })).isError).toBe(
      true,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('does not silently use another organization', async () => {
    const { client, fetchFn } = await connect([response(catalog)]);
    expect(
      (
        await client.callTool({
          name: 'create-federation-issuer',
          arguments: { organization: 'missing', ...issuer },
        })
      ).isError,
    ).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    401, 403, 404, 409,
  ])('surfaces API errors without retries: %s', async (status) => {
    const { client, fetchFn } = await connect([
      response({ message: 'Denied' }, status),
    ]);
    expect(
      (
        await client.callTool({
          name: 'delete-federation-rule',
          arguments: { organization, cluster, id },
        })
      ).isError,
    ).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

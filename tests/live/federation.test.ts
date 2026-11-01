import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { RawTreeClient } from '../../src/client.js';
import { createMcpServer } from '../../src/server.js';

it.skipIf(!process.env.RAWTREE_LIVE_API_URL)(
  'manages issuers and rules through MCP using a real user OAuth grant',
  async () => {
    const env = z
      .object({
        RAWTREE_LIVE_API_URL: z.url(),
        RAWTREE_LIVE_OAUTH_TOKEN: z.string().min(1),
        RAWTREE_LIVE_ORGANIZATION: z.string().min(1),
        RAWTREE_LIVE_CLUSTER: z.string().min(1),
        RAWTREE_LIVE_USER_ID: z.uuid(),
      })
      .parse(process.env);
    const organization = env.RAWTREE_LIVE_ORGANIZATION,
      cluster = env.RAWTREE_LIVE_CLUSTER;
    const server = createMcpServer(
      new RawTreeClient({
        apiKey: env.RAWTREE_LIVE_OAUTH_TOKEN,
        apiUrl: env.RAWTREE_LIVE_API_URL,
      }),
      { requireExplicitScope: true },
    );
    const client = new Client({ name: 'federation-live', version: '1' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    const issued: string[] = [];
    const rules: string[] = [];
    async function call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const content = z
        .object({
          content: z.array(
            z.object({ type: z.literal('text'), text: z.string() }),
          ),
        })
        .parse(result);
      return JSON.parse(content.content[0].text);
    }
    const identify = z.object({ id: z.uuid() });
    try {
      const name = `mcp-${crypto.randomUUID()}`;
      const config = {
        name,
        issuer_url: 'https://issuer.example.invalid',
        description: 'MCP live test',
      };
      const issuer = await call('create-federation-issuer', {
        organization,
        ...config,
      });
      const id = identify.parse(issuer).id;
      issued.push(id);
      expect(await call('get-federation-issuer', { organization, id })).toEqual(
        issuer,
      );
      expect(
        await call('list-federation-issuers', { organization }),
      ).toContainEqual(issuer);
      const ruleConfig = {
        name,
        issuer_id: id,
        allowed_audiences: ['rawtree'],
        claim_conditions: { sub: 'repo:acme/app:ref:refs/heads/main' },
        principal_type: 'user',
        principal_id: env.RAWTREE_LIVE_USER_ID,
        permission: 'read_only',
        database: 'default',
        enabled: false,
      };
      const rule = await call('create-federation-rule', {
        organization,
        cluster,
        ...ruleConfig,
      });
      const ruleId = identify.parse(rule).id;
      rules.push(ruleId);
      expect(
        await call('get-federation-rule', {
          organization,
          cluster,
          id: ruleId,
        }),
      ).toEqual(rule);
      expect(
        await call('list-federation-rules', { organization, cluster }),
      ).toContainEqual(rule);
      expect(
        await call('update-federation-rule', {
          organization,
          cluster,
          id: ruleId,
          ...ruleConfig,
          description: 'updated',
        }),
      ).toMatchObject({ description: 'updated', enabled: false });
      expect(
        (
          await client.callTool({
            name: 'delete-federation-issuer',
            arguments: { organization, id },
          })
        ).isError,
      ).toBe(true);
      expect(
        await call('delete-federation-rule', {
          organization,
          cluster,
          id: ruleId,
        }),
      ).toBe(null);
      rules.pop();
      expect(
        (
          await client.callTool({
            name: 'get-federation-rule',
            arguments: { organization, cluster, id: ruleId },
          })
        ).isError,
      ).toBe(true);
      expect(
        await call('update-federation-issuer', {
          organization,
          id,
          name,
          issuer_url: config.issuer_url,
          jwks_source: 'explicit_url',
          jwks_url: 'https://keys.example.invalid/jwks',
        }),
      ).toMatchObject({ jwks_source: 'explicit_url', description: null });
      expect(await call('delete-federation-issuer', { organization, id })).toBe(
        null,
      );
      issued.pop();
    } finally {
      for (const id of rules)
        await client.callTool({
          name: 'delete-federation-rule',
          arguments: { organization, cluster, id },
        });
      for (const id of issued)
        await client.callTool({
          name: 'delete-federation-issuer',
          arguments: { organization, id },
        });
      await client.close();
      await server.close();
    }
  },
  60_000,
);

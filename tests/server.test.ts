import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';

describe('createMcpServer', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      closeables.splice(0).map((closeable) => closeable.close()),
    );
  });

  it('returns an MCP server with connect method', () => {
    const client = new RawTreeClient({ apiKey: 'rt_test' });
    const server = createMcpServer(client);

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('unconditionally advertises cluster tools', async () => {
    const rawtree = new RawTreeClient({ apiKey: 'rt_database_key' });
    const server = createMcpServer(rawtree);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'list-organizations',
        'list-clusters',
        'create-cluster',
        'get-cluster',
        'pause-cluster',
        'resume-cluster',
        'list-databases',
      ]),
    );

    const getCluster = tools.find(
      (candidate) => candidate.name === 'get-cluster',
    );
    expect(getCluster?.inputSchema.required).toEqual([
      'organization',
      'clusterId',
    ]);
    expect(getCluster?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    for (const name of ['pause-cluster', 'resume-cluster']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual([
        'organization',
        'clusterId',
        'confirm',
      ]);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
  });

  it('requires resource scope in explicitly scoped deployments', async () => {
    const rawtree = new RawTreeClient({ apiKey: 'oauth_access_token' });
    const server = createMcpServer(rawtree, { requireExplicitScope: true });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const runQuery = tools.find((tool) => tool.name === 'run-query');
    const listClusters = tools.find((tool) => tool.name === 'list-clusters');
    const listDatabases = tools.find((tool) => tool.name === 'list-databases');

    expect(runQuery?.inputSchema.required).toEqual([
      'organization',
      'cluster',
      'sql',
    ]);
    expect(listClusters?.inputSchema.required).toEqual(['organization']);
    expect(listDatabases?.inputSchema.required).toEqual([
      'organization',
      'cluster',
    ]);
  });
});

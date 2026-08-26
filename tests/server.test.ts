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

  it('unconditionally advertises management tools', async () => {
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
        'list-organization-members',
        'add-organization-member',
        'update-organization-member',
        'remove-organization-member',
        'list-clusters',
        'list-cluster-sizes',
        'verify-cluster-s3-access',
        'create-cluster',
        'create-table',
        'get-cluster',
        'update-cluster',
        'pause-cluster',
        'resume-cluster',
        'list-apps',
        'install-app',
        'uninstall-app',
        'delete-table',
        'delete-api-key',
        'list-databases',
        'delete-database',
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toContain('check-health');
    expect(tools.map((tool) => tool.name)).not.toContain('get_database');

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

    const listClusterSizes = tools.find(
      (candidate) => candidate.name === 'list-cluster-sizes',
    );
    expect(listClusterSizes?.inputSchema.properties).toEqual({});
    expect(listClusterSizes?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const createCluster = tools.find(
      (candidate) => candidate.name === 'create-cluster',
    );
    expect(createCluster?.inputSchema.required).toEqual([
      'organization',
      'name',
      'replicas',
      'minimumSize',
      'maximumSize',
    ]);
    expect(createCluster?.inputSchema.properties).not.toHaveProperty(
      'cpuCores',
    );
    expect(createCluster?.inputSchema.properties).not.toHaveProperty(
      'memoryGiB',
    );
    expect(createCluster?.inputSchema.required).not.toContain(
      'idleTimeoutMinutes',
    );
    expect(createCluster?.inputSchema.required).not.toContain('byoS3');
    expect(
      createCluster?.inputSchema.properties.idleTimeoutMinutes,
    ).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 43200,
    });
    for (const field of ['minimumSize', 'maximumSize']) {
      expect(createCluster?.inputSchema.properties[field]).toMatchObject({
        type: 'object',
        required: ['cpuCores', 'memoryGiB'],
      });
    }
    expect(createCluster?.inputSchema.properties.byoS3).toMatchObject({
      type: 'object',
      required: ['data', 'backups', 'roleArn', 'externalId'],
    });
    expect(
      createCluster?.inputSchema.properties.byoS3.properties,
    ).toHaveProperty('tableBucketPrefix');
    expect(createCluster?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });

    const verifyClusterS3Access = tools.find(
      (candidate) => candidate.name === 'verify-cluster-s3-access',
    );
    expect(verifyClusterS3Access?.inputSchema.required).toEqual([
      'organization',
      'byoS3',
    ]);
    expect(verifyClusterS3Access?.inputSchema.properties.byoS3).toMatchObject({
      type: 'object',
      required: ['data', 'backups', 'roleArn', 'externalId'],
    });
    expect(verifyClusterS3Access?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    const updateCluster = tools.find(
      (candidate) => candidate.name === 'update-cluster',
    );
    expect(updateCluster?.inputSchema.required).toEqual([
      'organization',
      'clusterId',
      'idleTimeoutMinutes',
    ]);
    expect(
      updateCluster?.inputSchema.properties.idleTimeoutMinutes,
    ).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 43200,
    });
    expect(updateCluster?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    const listOrganizationMembers = tools.find(
      (tool) => tool.name === 'list-organization-members',
    );
    expect(listOrganizationMembers?.inputSchema.required).toEqual([
      'organization',
    ]);
    expect(listOrganizationMembers?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    const organizationMemberMutations = [
      {
        name: 'add-organization-member',
        required: ['organization', 'email'],
        destructiveHint: false,
      },
      {
        name: 'update-organization-member',
        required: ['organization', 'userId', 'role'],
        destructiveHint: true,
      },
      {
        name: 'remove-organization-member',
        required: ['organization', 'userId'],
        destructiveHint: true,
      },
    ];
    for (const expected of organizationMemberMutations) {
      const tool = tools.find((candidate) => candidate.name === expected.name);
      expect(tool?.inputSchema.required).toEqual(expected.required);
      expect(tool?.inputSchema.properties).not.toHaveProperty('confirm');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: expected.destructiveHint,
      });
    }

    const addOrganizationMember = tools.find(
      (tool) => tool.name === 'add-organization-member',
    );
    expect(addOrganizationMember?.inputSchema.properties.email).toMatchObject({
      type: 'string',
      minLength: 1,
    });
    expect(
      addOrganizationMember?.inputSchema.properties.email,
    ).not.toHaveProperty('pattern');

    for (const name of [
      'create-cluster',
      'verify-cluster-s3-access',
      'update-cluster',
      'pause-cluster',
      'resume-cluster',
      'delete-table',
      'delete-api-key',
      'delete-database',
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).not.toHaveProperty('confirm');
    }

    const insertJson = tools.find((tool) => tool.name === 'insert-json');
    expect(insertJson?.inputSchema.properties).not.toHaveProperty('transform');
    expect(insertJson?.inputSchema.properties).not.toHaveProperty('columns');

    const createTable = tools.find((tool) => tool.name === 'create-table');
    expect(createTable?.inputSchema.required).toEqual(['name']);
    expect(createTable?.inputSchema.properties.storage).toMatchObject({
      type: 'object',
      required: ['type', 'bucketSuffix'],
    });
    expect(createTable?.inputSchema.properties.storage.properties).toEqual(
      expect.objectContaining({
        type: expect.objectContaining({ const: 's3' }),
        bucketSuffix: expect.objectContaining({
          type: 'string',
          minLength: 1,
          maxLength: 63,
        }),
        path: expect.objectContaining({ type: 'string' }),
      }),
    );
    expect(createTable?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    const deleteDatabase = tools.find(
      (tool) => tool.name === 'delete-database',
    );
    expect(deleteDatabase?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    for (const name of ['pause-cluster', 'resume-cluster']) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual(['organization', 'clusterId']);
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }

    const listApps = tools.find((candidate) => candidate.name === 'list-apps');
    expect(listApps?.inputSchema.required).toEqual(['organization', 'cluster']);
    expect(listApps?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });

    for (const expected of [
      { name: 'install-app', destructiveHint: false },
      { name: 'uninstall-app', destructiveHint: true },
    ]) {
      const tool = tools.find((candidate) => candidate.name === expected.name);
      expect(tool?.inputSchema.required).toEqual([
        'organization',
        'cluster',
        'appId',
      ]);
      expect(tool?.inputSchema.properties.appId).not.toHaveProperty('enum');
      expect(tool?.inputSchema.properties).not.toHaveProperty('confirm');
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: expected.destructiveHint,
        idempotentHint: true,
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
    const deleteDatabase = tools.find(
      (tool) => tool.name === 'delete-database',
    );

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
    expect(deleteDatabase?.inputSchema.required).toEqual([
      'organization',
      'database',
    ]);
    const createTable = tools.find((tool) => tool.name === 'create-table');
    expect(createTable?.inputSchema.required).toEqual([
      'organization',
      'cluster',
      'name',
    ]);
  });
});

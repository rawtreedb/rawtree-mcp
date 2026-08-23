import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult } from './common.js';

const positiveUint32 = z.number().int().min(1).max(4_294_967_295);

export function addClusterTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-clusters',
    {
      title: 'List Clusters',
      description: `**Purpose:** List RawTree dedicated clusters accessible in an organization.

**Returns:** Cluster IDs, names, creation times, lifecycle status, resources, and whether each cluster can be paused or resumed.

**Auth:** The RawTree API requires a user access token and organization membership. Authorization is enforced by the API.

**When to use:**
- User asks which dedicated clusters exist
- You need a cluster ID or current lifecycle status
- You need to inspect provisioned resources before creating another cluster`,
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization whose dedicated clusters should be listed.'),
      },
    },
    async ({ organization }) =>
      jsonResult(await rawtree.listClusters(organization)),
  );

  server.registerTool(
    'create-cluster',
    {
      title: 'Create Cluster',
      description: `**Purpose:** Provision a new RawTree dedicated cluster in an organization.

**Returns:** The newly created cluster, including its ID, lifecycle status, and resources. Provisioning continues asynchronously after the request is accepted.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**Safety:** Creating a dedicated cluster provisions billable infrastructure. You MUST confirm the exact organization, name, replica count, CPU cores, and memory GiB with the user before calling this tool. The selected replica count and size must be supported by RawTree.`,
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization in which to create the cluster.'),
        name: z
          .string()
          .min(1)
          .describe(
            "URL-friendly cluster name using letters, numbers, '_' or '-'.",
          ),
        replicas: positiveUint32.describe('Number of cluster replicas.'),
        cpuCores: positiveUint32.describe('CPU cores per replica.'),
        memoryGiB: positiveUint32.describe('Memory in GiB per replica.'),
      },
    },
    async ({ organization, name, replicas, cpuCores, memoryGiB }) => {
      return namedJsonResult(
        'Create cluster result',
        await rawtree.createCluster({
          organization,
          name,
          replicas,
          cpuCores,
          memoryGiB,
        }),
      );
    },
  );

  server.registerTool(
    'get-cluster',
    {
      title: 'Get Cluster',
      description: `**Purpose:** Get one RawTree dedicated cluster and its current lifecycle status.

**Returns:** The cluster ID, name, creation time, lifecycle status, resources, and whether it can be paused or resumed.

**Auth:** The RawTree API requires a user access token and organization membership. Authorization is enforced by the API.

**When to use:**
- User asks for the current status of one cluster
- You need to check progress after pausing or resuming a cluster
- You already have a cluster ID and do not need the full organization cluster list`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the cluster.'),
        clusterId: z
          .string()
          .min(1)
          .describe('Dedicated cluster ID returned by list-clusters.'),
      },
    },
    async ({ organization, clusterId }) =>
      jsonResult(await rawtree.getCluster({ organization, clusterId })),
  );

  server.registerTool(
    'pause-cluster',
    {
      title: 'Pause Cluster',
      description: `**Purpose:** Request that a RawTree dedicated cluster pause.

**Returns:** The updated cluster, including its lifecycle status. Pausing continues asynchronously after the request is accepted. Use get-cluster to check one cluster's progress.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**Safety:** Pausing makes the cluster's databases unavailable until it is resumed. You MUST confirm the exact organization and cluster ID before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the cluster to pause.'),
        clusterId: z
          .string()
          .min(1)
          .describe('Dedicated cluster ID returned by list-clusters.'),
      },
    },
    async ({ organization, clusterId }) => {
      return namedJsonResult(
        'Pause cluster result',
        await rawtree.pauseCluster({ organization, clusterId }),
      );
    },
  );

  server.registerTool(
    'resume-cluster',
    {
      title: 'Resume Cluster',
      description: `**Purpose:** Request that a paused RawTree dedicated cluster resume.

**Returns:** The updated cluster, including its lifecycle status. Resuming continues asynchronously after the request is accepted. Use get-cluster to check one cluster's progress.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**Safety:** Resuming a cluster can generate usage charges. You MUST confirm the exact organization and cluster ID and acknowledge the possible charges before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the cluster to resume.'),
        clusterId: z
          .string()
          .min(1)
          .describe('Dedicated cluster ID returned by list-clusters.'),
      },
    },
    async ({ organization, clusterId }) => {
      return namedJsonResult(
        'Resume cluster result',
        await rawtree.resumeCluster({ organization, clusterId }),
      );
    },
  );
}

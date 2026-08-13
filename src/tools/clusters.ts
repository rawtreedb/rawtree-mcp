import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult, requireConfirmation } from './common.js';

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
        confirm: z
          .boolean()
          .describe(
            'Set to true only after the user confirms the exact cluster configuration and understands that it provisions billable infrastructure.',
          ),
      },
    },
    async ({ organization, name, replicas, cpuCores, memoryGiB, confirm }) => {
      requireConfirmation(
        confirm,
        'Refusing to create cluster without explicit confirmation.',
      );
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
}

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult } from './common.js';

const appScopeInput = {
  organization: z
    .string()
    .min(1)
    .describe('Organization containing the target cluster.'),
  cluster: z
    .string()
    .min(1)
    .describe('Cluster name returned by list-clusters.'),
};

const appIdInput = z.string().min(1).describe('App ID returned by list-apps.');

export function addAppTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-apps',
    {
      title: 'List Apps',
      description: `**Purpose:** List the RawTree app catalog and installation state for one cluster.

**Returns:** The cluster ID and name, plus every available app with its ID, display name, and installed state.

**Auth:** Requires a user credential and organization membership. Authorization is enforced by the RawTree API.

**When to use:**
- You need a valid app ID before installing or uninstalling an app
- You want to check which apps are installed on a cluster
- You want to verify installation state after a change`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: appScopeInput,
    },
    async ({ organization, cluster }) =>
      jsonResult(await rawtree.listApps({ organization, cluster })),
  );

  server.registerTool(
    'install-app',
    {
      title: 'Install App',
      description: `**Purpose:** Install a RawTree app on one cluster and enable its native endpoints.

**Returns:** The app ID, display name, and installed state set to true.

**Auth:** Requires a user credential with organization admin access. Authorization is enforced by the RawTree API.

**Safety:** This changes the app functionality enabled for the cluster. You MUST confirm the exact organization, cluster name, and app ID with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        ...appScopeInput,
        appId: appIdInput,
      },
    },
    async ({ organization, cluster, appId }) =>
      namedJsonResult(
        'Install app result',
        await rawtree.installApp({ organization, cluster, appId }),
      ),
  );

  server.registerTool(
    'uninstall-app',
    {
      title: 'Uninstall App',
      description: `**Purpose:** Uninstall a RawTree app from one cluster and disable its native endpoints.

**Returns:** The app ID, display name, and installed state set to false.

**Behavior:** Uninstalling removes the app installation state. It does not delete existing data stored in the cluster.

**Auth:** Requires a user credential with organization admin access. Authorization is enforced by the RawTree API.

**Safety:** This makes the app's native endpoints unavailable for the cluster. You MUST confirm the exact organization, cluster name, and app ID with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        ...appScopeInput,
        appId: appIdInput,
      },
    },
    async ({ organization, cluster, appId }) =>
      namedJsonResult(
        'Uninstall app result',
        await rawtree.uninstallApp({ organization, cluster, appId }),
      ),
  );
}

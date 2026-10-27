import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, slackChannelName } from './common.js';

const auth =
  '**Auth:** Requires a user credential such as OAuth, or an admin API key bound to the organization. Authorization is enforced by the RawTree API.';
const connect =
  'Connecting or disconnecting Slack is not available through MCP: an organization admin must do it on the integrations settings page in the RawTree app.';
const organization = z
  .string()
  .min(1)
  .describe('Organization whose integrations should be used.');

export function addIntegrationTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'list-integrations',
    {
      title: 'List Integrations',
      description: `**Purpose:** List the integrations connected to a RawTree organization, such as Slack workspaces.

**Returns:** { integrations, slack_available, settings_url }. Each integration has id, organization_id, type ("slack"), settings (team_id, team_name, bot_user_id, scopes), and created_at. slack_available is false when Slack is not configured for this RawTree deployment. settings_url links to the organization's integrations settings page in the RawTree app.

**Behavior:** ${connect} Share settings_url with the user when no Slack workspace is connected.

${auth}

**When to use:**
- You need a Slack integration ID for a workflow Slack sink
- The user wants to know which Slack workspaces the organization has connected`,
      inputSchema: { organization },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ organization }) => {
      const result = await rawtree.listIntegrations(organization);
      return jsonResult({
        ...(result as object),
        settings_url: rawtree.integrationsSettingsUrl(organization),
      });
    },
  );

  server.registerTool(
    'list-slack-channels',
    {
      title: 'List Slack Channels',
      description: `**Purpose:** List or search the channels of a Slack workspace connected to a RawTree organization.

**Returns:** { channels, next_cursor }. Each channel has id, name, and is_private. next_cursor is null when there are no more results.

**Behavior:** Results are paginated. Pass next_cursor as cursor, with the same name when searching, to continue. With name, returns channels whose name contains it, ignoring a leading #, surrounding spaces, and case. Each search request scans a bounded part of the workspace, so a page can have no channels while next_cursor is set: the search has not finished, so call again with that cursor and the same name. Workflow Slack sinks accept a channel_name directly; use this tool to find a channel or confirm its exact name. The RawTree app must be a member of a private channel before it can post there.

${auth}

**When to use:**
- You need to find a Slack channel for a workflow Slack sink
- The user describes a channel only partially and you need its exact name or ID`,
      inputSchema: {
        organization,
        integration_id: z
          .uuid()
          .describe('Slack integration ID returned by list-integrations.'),
        name: slackChannelName
          .optional()
          .describe(
            'Text that channel names must contain, such as alerts or #alerts. Omit to list all channels.',
          ),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe(
            'next_cursor from a previous list-slack-channels response. Omit for the first page.',
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ organization, integration_id, name, cursor }) =>
      jsonResult(
        await rawtree.listSlackChannels({
          organization,
          integrationId: integration_id,
          name,
          cursor,
        }),
      ),
  );
}

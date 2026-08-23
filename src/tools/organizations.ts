import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult } from './common.js';

const organizationMemberRoleSchema = z.enum(['admin', 'member']);

export function addOrganizationTools(
  server: McpServer,
  rawtree: RawTreeClient,
) {
  server.registerTool(
    'list-organizations',
    {
      title: 'List Organizations',
      description: `**Purpose:** List RawTree organizations available to the authenticated user.

**Returns:** Organization names, roles, plans, and avatar URLs.

**Auth:** Requires a user credential such as OAuth. Database API keys are not user credentials and cannot list organizations.

**When to use:**
- You need an organization name before listing clusters
- The user wants to work across multiple organizations through one MCP connection`,
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.listOrganizations()),
  );

  server.registerTool(
    'list-organization-members',
    {
      title: 'List Organization Members',
      description: `**Purpose:** List accepted members of a RawTree organization.

**Returns:** Member user IDs, email addresses, roles, and creation times. Pending invitations are not included.

**Auth:** Requires a user credential and membership in the organization. Authorization is enforced by the RawTree API.

**When to use:**
- You need the member user ID before changing a role or removing access
- The user wants to inspect who belongs to an organization`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization whose accepted members should be listed.'),
      },
    },
    async ({ organization }) =>
      jsonResult(await rawtree.listOrganizationMembers(organization)),
  );

  server.registerTool(
    'add-organization-member',
    {
      title: 'Add Organization Member',
      description: `**Purpose:** Start adding a member to a RawTree organization by sending an invitation to their email address.

**Returns:** Whether the invitation was created, its invite link, and its expiration time.

**Behavior:** This creates a pending invitation. The person becomes a member only after accepting it and will not appear in list-organization-members before acceptance. New members join with the member role; use update-organization-member after acceptance to promote them.

**Auth:** Requires a user credential with organization admin access. Authorization is enforced by the RawTree API.

**Safety:** This sends an external email and creates a pending access invitation. You MUST confirm the exact organization and email address with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization to which the person should be invited.'),
        email: z.email().describe('Email address to invite.'),
      },
    },
    async ({ organization, email }) =>
      namedJsonResult(
        'Add organization member result',
        await rawtree.addOrganizationMember({ organization, email }),
      ),
  );

  server.registerTool(
    'update-organization-member',
    {
      title: 'Update Organization Member',
      description: `**Purpose:** Change an accepted organization member's role to admin or member.

**Returns:** The member's updated role.

**NOT for:** Pending invitations. Use list-organization-members to identify an accepted member and obtain their user ID.

**Auth:** Requires a user credential with organization admin access. Authorization is enforced by the RawTree API. RawTree prevents demoting the last organization admin.

**Safety:** Changing a role can grant administrative privileges or revoke them. You MUST confirm the exact organization, member, and new role with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the member.'),
        userId: z
          .string()
          .min(1)
          .describe('Member user ID returned by list-organization-members.'),
        role: organizationMemberRoleSchema.describe(
          'New organization role: admin or member.',
        ),
      },
    },
    async ({ organization, userId, role }) =>
      namedJsonResult(
        'Update organization member result',
        await rawtree.updateOrganizationMember({ organization, userId, role }),
      ),
  );

  server.registerTool(
    'remove-organization-member',
    {
      title: 'Remove Organization Member',
      description: `**Purpose:** Remove an accepted member from a RawTree organization and revoke their organization access.

**Returns:** Whether the member was removed.

**NOT for:** Revoking a pending invitation. Use list-organization-members to identify an accepted member and obtain their user ID.

**Auth:** Requires a user credential with organization admin access. Authorization is enforced by the RawTree API. RawTree prevents removing the last organization admin.

**Safety:** This revokes the member's access to the organization. You MUST confirm the exact organization and member with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the member.'),
        userId: z
          .string()
          .min(1)
          .describe('Member user ID returned by list-organization-members.'),
      },
    },
    async ({ organization, userId }) =>
      namedJsonResult(
        'Remove organization member result',
        await rawtree.removeOrganizationMember({ organization, userId }),
      ),
  );
}

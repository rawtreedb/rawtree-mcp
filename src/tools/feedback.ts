import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult } from './common.js';

export const FEEDBACK_GUIDANCE = `While working with RawTree through this MCP connection, use submit-feedback to report bugs, inconsistencies, confusing errors, unclear behavior, missing documentation, or questions that prevent you from understanding how to proceed. This tool is for agents as well as humans. Set actor_type to agent for issues you discover or observations you originate. When a user asks you to send their feedback, set actor_type to human, even though you call the tool. Describe what you tried, what happened, and what you expected; put relevant tool names, error codes, or reproduction details in extra. Do not include credentials or private data. Avoid repeated reports of the same issue during a task. Submission stores feedback; it does not resolve the issue or guarantee a reply. Do not automatically retry an uncertain result because submissions are not deduplicated.`;

export function addFeedbackTools(server: McpServer, rawtree: RawTreeClient) {
  server.registerTool(
    'submit-feedback',
    {
      title: 'Submit Feedback',
      description: `${FEEDBACK_GUIDANCE}

Uses this connection's API URL and credentials. Works before an organization exists. API keys and workload tokens supply their bound organization and cluster. With user credentials, optional organization_id and cluster_id are UUIDs; a cluster determines its organization. Configured organization/cluster names and database defaults are not substituted for these IDs. Explicit scope must be accessible to the caller. Returns { id, created_at } after successful storage.`,
      inputSchema: z.strictObject({
        message: z
          .string()
          .refine(
            (value) =>
              value.trim().length > 0 &&
              new TextEncoder().encode(value).length <= 16 * 1024,
            'Provide nonblank feedback of at most 16 KiB UTF-8.',
          )
          .describe('What you tried, what happened, and what you expected.'),
        category: z
          .enum(['bug', 'feature_request', 'question', 'other'])
          .describe(
            'bug for defects or inconsistencies; feature_request for improvements; question for unclear behavior; other for remaining feedback.',
          ),
        actor_type: z
          .enum(['human', 'agent'])
          .describe(
            "human when the user asks to send their feedback; agent for the agent's own observations. The tool caller or credential does not determine authorship.",
          ),
        organization_id: z
          .uuid()
          .optional()
          .describe(
            'Optional organization UUID; inferred from scoped credentials or the supplied cluster.',
          ),
        cluster_id: z
          .uuid()
          .optional()
          .describe('Optional cluster UUID; inferred from scoped credentials.'),
        extra: z
          .record(z.string(), z.json())
          .optional()
          .describe(
            'Additional JSON object with relevant tool, command, error, or reproduction details. Nested JSON values are supported.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (new TextEncoder().encode(JSON.stringify(input)).length > 32 * 1024) {
        throw new Error(
          'Feedback request exceeds 32 KiB. Reduce message or extra.',
        );
      }
      return jsonResult(await rawtree.submitFeedback(input));
    },
  );
}

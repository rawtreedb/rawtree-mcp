import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RawTreeClient } from '../client.js';
import { jsonResult, namedJsonResult } from './common.js';

const positiveUint32 = z.number().int().min(1).max(4_294_967_295);
const idleTimeoutMinutesInput = z
  .number()
  .int()
  .min(0)
  .max(43_200)
  .refine((value) => value === 0 || value >= 15, {
    message: 'Idle timeout must be 0 or between 15 and 43200 minutes.',
  })
  .describe(
    'Minutes of inactivity before automatically pausing. Use 0 to disable idling.',
  );

function clusterSizeInput(description: string) {
  return z
    .object({
      cpuCores: positiveUint32.describe('CPU cores per replica.'),
      memoryGiB: positiveUint32.describe('Memory in GiB per replica.'),
    })
    .describe(description);
}

const s3DestinationInput = z.object({
  bucket: z.string().min(3).max(63).describe('Customer-owned S3 bucket name.'),
  path: z
    .string()
    .optional()
    .describe(
      'Optional object key prefix inside the bucket. Omit or use an empty string for the bucket root. RawTree trims leading and trailing slashes.',
    ),
});

const byoS3Input = z.object({
  data: s3DestinationInput.describe(
    'Customer-owned bucket and optional key prefix for cluster data.',
  ),
  backups: s3DestinationInput.describe(
    'Customer-owned bucket and optional key prefix for cluster backups.',
  ),
  roleArn: z
    .string()
    .min(1)
    .describe(
      'ARN of the customer IAM role that RawTree may assume to access the configured buckets.',
    ),
  externalId: z
    .string()
    .min(2)
    .max(1224)
    .describe(
      'External ID required by the IAM role trust policy. It must exactly match the value configured in AWS.',
    ),
  databaseBucketPrefix: z
    .string()
    .min(1)
    .max(62)
    .optional()
    .describe(
      'Optional bucket-name prefix for separate customer-owned per-database buckets. The same IAM role must allow buckets matching this prefix. Omit when databases should use the cluster data destination.',
    ),
});

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
    'list-cluster-sizes',
    {
      title: 'List Cluster Sizes',
      description: `**Purpose:** List the current RawTree cluster creation options.

**Returns:** Supported per-replica sizes, minimum and maximum replica counts, and the default minimum and maximum vertical autoscaling sizes.

**Auth:** Requires a user credential such as OAuth. Authorization is enforced by the RawTree API.

**When to use:** You MUST call this tool before create-cluster so replicas and both sizes come from the current backend-controlled catalog.`,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {},
    },
    async () => jsonResult(await rawtree.listClusterSizes()),
  );

  server.registerTool(
    'verify-cluster-s3-access',
    {
      title: 'Verify Cluster S3 Access',
      description: `**Purpose:** Verify that RawTree can use a customer IAM role to access customer-owned S3 storage before cluster creation.

**Returns:** Whether access was verified and a human-readable result message.

**Behavior:** RawTree assumes roleArn using externalId, checks the data and backup bucket locations, lists each configured path, and writes, reads, then removes a temporary probe object under each path. Paths are optional and default to the bucket root. databaseBucketPrefix is optional; it enables separate customer-owned buckets for future databases, but this preflight does not create or probe those future buckets. Both configured buckets must be in the cluster environment's AWS region.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**When to use:** Use this tool after the IAM trust and permissions policies are configured and immediately before create-cluster whenever its optional byoS3 field will be provided. It is unnecessary when RawTree-managed storage will be used.

**Safety:** This check temporarily writes to and deletes from both configured destinations. Confirm the exact organization, buckets, paths, role ARN, and optional database bucket prefix before running it. The IAM trust policy's External ID must match externalId exactly.

**Reliability:** The check is safe to retry. Newly changed IAM policies may require a short propagation delay before verification succeeds.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization that will own the cluster.'),
        byoS3: byoS3Input.describe(
          'Customer-owned S3 configuration to verify before cluster creation.',
        ),
      },
    },
    async ({ organization, byoS3 }) =>
      namedJsonResult(
        'S3 access verification result',
        await rawtree.verifyClusterS3Access({ organization, byoS3 }),
      ),
  );

  server.registerTool(
    'create-cluster',
    {
      title: 'Create Cluster',
      description: `**Purpose:** Provision a new RawTree dedicated cluster in an organization.

**Returns:** The newly created cluster, including its ID, lifecycle status, and initial resources. Provisioning continues asynchronously after the request is accepted; use get-cluster to check progress.

**Behavior:** The cluster starts at minimumSize and can vertically autoscale per replica up to maximumSize. The replica count remains fixed. byoS3 is optional: omit it to use RawTree-managed storage. When provided, it configures customer-owned data and backup destinations through a customer IAM role. Destination paths and databaseBucketPrefix are individually optional; the buckets, roleArn, and externalId are required inside byoS3.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**Safety:** You MUST first call list-cluster-sizes, then confirm the exact organization, name, replica count, minimum per-replica size, maximum per-replica size, vertical autoscaling behavior, and idle timeout with the user. If idleTimeoutMinutes is omitted, explain that the server default will apply. For one replica, warn that the cluster has no redundancy. If byoS3 is provided, first call verify-cluster-s3-access with the identical configuration and confirm the data and backup buckets, optional paths, role ARN, and optional database bucket prefix. Never reuse a successful verification after changing any byoS3 field.

**Reliability:** This operation is not idempotent. If the response is ambiguous, call list-clusters to reconcile by organization and name before retrying.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
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
        minimumSize: clusterSizeInput(
          'Initial and minimum vertical autoscaling size returned by list-cluster-sizes.',
        ),
        maximumSize: clusterSizeInput(
          'Maximum vertical autoscaling size returned by list-cluster-sizes. Must be at or above minimumSize in the returned catalog.',
        ),
        idleTimeoutMinutes: idleTimeoutMinutesInput
          .optional()
          .describe(
            'Minutes of inactivity before automatically pausing. Use 0 to disable idling. Omit to use the server default.',
          ),
        byoS3: byoS3Input
          .optional()
          .describe(
            'Optional customer-owned S3 configuration. Omit to use RawTree-managed storage. Verify the identical configuration with verify-cluster-s3-access before creation.',
          ),
      },
    },
    async ({
      organization,
      name,
      replicas,
      minimumSize,
      maximumSize,
      idleTimeoutMinutes,
      byoS3,
    }) => {
      return namedJsonResult(
        'Create cluster result',
        await rawtree.createCluster({
          organization,
          name,
          replicas,
          minimumSize,
          maximumSize,
          idleTimeoutMinutes,
          byoS3,
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
    'update-cluster',
    {
      title: 'Update Cluster Settings',
      description: `**Purpose:** Update the idle timeout for a RawTree dedicated cluster.

**Returns:** The updated cluster, including its effective idle timeout and current lifecycle status.

**Behavior:** idleTimeoutMinutes controls how many minutes of inactivity pass before the cluster automatically pauses. Use 0 to disable idling. Values from 15 through 43200 minutes are supported.

**Auth:** The RawTree API requires a user access token with organization admin access. Authorization is enforced by the API.

**Safety:** You MUST confirm the exact organization, cluster ID, and new idle timeout with the user before calling this tool.`,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        organization: z
          .string()
          .min(1)
          .describe('Organization containing the cluster to update.'),
        clusterId: z
          .string()
          .min(1)
          .describe('Dedicated cluster ID returned by list-clusters.'),
        idleTimeoutMinutes: idleTimeoutMinutesInput,
      },
    },
    async ({ organization, clusterId, idleTimeoutMinutes }) => {
      return namedJsonResult(
        'Update cluster result',
        await rawtree.updateCluster({
          organization,
          clusterId,
          idleTimeoutMinutes,
        }),
      );
    },
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

**Safety:** You MUST confirm the exact organization and cluster ID before calling this tool.`,
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

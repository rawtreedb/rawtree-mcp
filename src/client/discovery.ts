import { z } from 'zod';
import { RawTreeApiError } from './http.js';
import type { RegionCatalog } from './regions.js';
import { deploymentHeaders } from './routing.js';

const collection = z
  .object({
    clusters: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          region_id: z.string().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Keep healthy deployments usable while explicitly reporting incomplete discovery. */
export async function discoverClusters(
  organization: string,
  catalog: RegionCatalog,
  load: (
    path: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const { regions } = await catalog.list(organization);
  const deployments = new Map<
    string,
    { headers: Record<string, string>; regions: typeof regions }
  >();
  for (const region of regions.filter((item) => item.enabled)) {
    const headers =
      deploymentHeaders(region.deployment_id, region.cloud_region) ?? {};
    const key = JSON.stringify(headers);
    const deployment = deployments.get(key);
    if (deployment) deployment.regions.push(region);
    else deployments.set(key, { headers, regions: [region] });
  }
  const path = `/v1/clusters?${new URLSearchParams({ organization })}`;
  const targets = [...deployments.values()];
  const responses = await Promise.allSettled(
    targets.map(async ({ headers }) =>
      collection.parse(await load(path, headers, AbortSignal.timeout(5_000))),
    ),
  );
  const failures = responses.filter(
    (response) => response.status === 'rejected',
  );
  for (const failure of failures) {
    const error: unknown = failure.reason;
    if (error instanceof RawTreeApiError && [401, 403].includes(error.status))
      throw error;
  }
  // A total outage must not look like an empty catalog.
  if (failures.length > 0 && failures.length === responses.length)
    throw failures[0].reason;
  const unavailableRegions = targets.flatMap((target, index) =>
    responses[index].status === 'rejected'
      ? target.regions.map(({ id, name }) => ({ id, name }))
      : [],
  );
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const clusters = new Map<
    string,
    z.infer<typeof collection>['clusters'][number]
  >();
  for (const response of responses) {
    if (response.status === 'rejected') continue;
    for (const cluster of response.value.clusters) {
      if (!cluster.region_id) {
        if (!clusters.has(cluster.id)) clusters.set(cluster.id, cluster);
        continue;
      }
      const region = regionsById.get(cluster.region_id);
      if (!region)
        throw new Error(
          `Region '${cluster.region_id}' for cluster '${cluster.name}' was not found.`,
        );
      clusters.set(cluster.id, {
        ...cluster,
        deployment_id: region.deployment_id,
        cloud_region: region.cloud_region,
      });
    }
  }
  const firstSuccess = responses.find(
    (response) => response.status === 'fulfilled',
  );
  return {
    ...firstSuccess?.value,
    clusters: [...clusters.values()],
    ...(unavailableRegions.length > 0
      ? { unavailable_regions: unavailableRegions }
      : {}),
  };
}

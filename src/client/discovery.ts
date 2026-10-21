import { z } from 'zod';
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

/** Publish a complete catalog only after every enabled deployment responds. */
export async function discoverClusters(
  organization: string,
  catalog: RegionCatalog,
  load: (path: string, headers: Record<string, string>) => Promise<unknown>,
) {
  const { regions } = await catalog.list(organization);
  const deployments = new Map<string, Record<string, string>>();
  for (const region of regions.filter((item) => item.enabled)) {
    const headers =
      deploymentHeaders(region.deployment_id, region.cloud_region) ?? {};
    deployments.set(JSON.stringify(headers), headers);
  }
  const path = `/v1/clusters?${new URLSearchParams({ organization })}`;
  const responses = await Promise.all(
    [...deployments.values()].map(async (headers) =>
      collection.parse(await load(path, headers)),
    ),
  );
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const clusters = new Map<
    string,
    z.infer<typeof collection>['clusters'][number]
  >();
  for (const response of responses) {
    for (const cluster of response.clusters) {
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
  return { ...responses[0], clusters: [...clusters.values()] };
}

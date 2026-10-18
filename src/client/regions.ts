import { z } from 'zod';
import { deploymentHeaders, type LoadMetadata } from './routing.js';

const organizations = z.object({
  organizations: z.array(
    z.object({ organization_id: z.string().min(1), name: z.string() }),
  ),
});
const regions = z.object({
  regions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      cloud_region: z.string(),
      organization_id: z.string().nullable(),
      deployment_id: z.string().nullable(),
      enabled: z.boolean(),
    }),
  ),
});

export class RegionCatalog {
  constructor(private readonly load: LoadMetadata) {}

  async list(organization: string) {
    const response = organizations.parse(await this.load('/v1/organizations'));
    const owner = response.organizations.find(
      (item) => item.name === organization,
    );
    if (!owner)
      throw new Error(`Organization '${organization}' was not found.`);
    return regions.parse(
      await this.load(
        `/v1/organizations/${encodeURIComponent(owner.organization_id)}/regions`,
      ),
    );
  }

  async headers(
    organization: string | undefined,
    regionId: string | undefined,
    credential: string,
  ): Promise<Record<string, string>> {
    if (regionId === undefined) return {};
    if (credential.startsWith('rt_'))
      throw new Error(
        'Region selection requires a user credential such as OAuth.',
      );
    if (!organization)
      throw new Error('Provide organization when selecting a region.');
    const response = await this.list(organization);
    const region = response.regions.find((item) => item.id === regionId);
    if (!region) throw new Error('Region not found in this organization.');
    if (!region.enabled) throw new Error('The selected region is disabled.');
    if (
      region.id === '0c0f0a56-7f03-4d39-8e5d-000000000001' &&
      region.organization_id === null &&
      region.deployment_id === null &&
      region.cloud_region === 'us-east-1'
    )
      return {};
    const headers = deploymentHeaders(
      region.deployment_id,
      region.cloud_region,
    );
    if (!headers)
      throw new Error(
        'The selected region is not ready for cluster creation. Choose another region.',
      );
    return headers;
  }
}

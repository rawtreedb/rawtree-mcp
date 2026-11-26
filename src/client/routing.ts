import type { TenantIds } from './http.js';

export type LoadMetadata = (path: string) => Promise<unknown>;
export type LoadClusters = (organizationId: string) => Promise<unknown>;

export const ORGANIZATION_ID_HEADER = 'X-RawTree-Organization-Id';
export const CLUSTER_ID_HEADER = 'X-RawTree-Cluster-Id';

type MetadataRecord = Record<string, unknown>;

function records(value: unknown, field: string): MetadataRecord[] {
  if (!value || typeof value !== 'object' || !(field in value)) return [];
  const items: unknown = Reflect.get(value, field);
  return Array.isArray(items)
    ? items.filter(
        (item): item is MetadataRecord => !!item && typeof item === 'object',
      )
    : [];
}

const DEPLOYMENT = /^(?:[0-9a-f]{8}|[0-9a-f]{32})$/;
const REGION = /^[a-z]+(?:-[a-z]+)+-[1-9][0-9]*$/;
const CACHE_MS = 30_000;

export function deploymentHeaders(
  deployment: unknown,
  region: unknown,
): Record<string, string> | null {
  if (
    typeof deployment !== 'string' ||
    !DEPLOYMENT.test(deployment) ||
    typeof region !== 'string' ||
    region.length > 63 ||
    !REGION.test(region)
  )
    return null;
  return { 'X-RawTree-Deployment-Id': deployment, 'X-RawTree-Region': region };
}

/** Rewrite only public RawTree API origins; preserve custom gateways and paths. */
export function deploymentApiUrl(
  url: URL,
  headers: Record<string, string>,
): URL {
  const deployment = headers['X-RawTree-Deployment-Id'];
  const region = headers['X-RawTree-Region'];
  if (
    !deploymentHeaders(deployment, region) ||
    !['https://api.rawtree.com', 'https://api.rawtree.dev'].includes(url.origin)
  )
    return url;
  const target = new URL(url);
  target.hostname = target.hostname.replace(
    'api.',
    `api.${deployment}.${region}.aws.`,
  );
  return target;
}

/** The loader supplies the merged regional cluster catalog for scoped requests. */
export class ClusterRouting {
  private readonly cache = new Map<
    string,
    { expires: number; value: Promise<unknown> }
  >();

  constructor(private readonly load: LoadClusters) {}

  private generation = 0;

  get version() {
    return this.generation;
  }

  remember(organizationId: string, value: unknown, version: number) {
    // Ordinary GETs cannot overwrite a newer discovery or a mutation's invalidation.
    if (version !== this.generation || this.cache.has(organizationId)) return;
    this.cache.set(organizationId, {
      expires: Date.now() + CACHE_MS,
      value: Promise.resolve(value),
    });
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
  }

  private metadata(organizationId: string): Promise<unknown> {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.load(organizationId);
    this.cache.set(organizationId, { expires: Date.now() + CACHE_MS, value });
    void value.catch(() => {
      if (this.cache.get(organizationId)?.value === value)
        this.cache.delete(organizationId);
    });
    return value;
  }

  headers(
    url: URL,
    tenant: TenantIds,
    signal?: AbortSignal | null,
  ): Promise<Record<string, string>> {
    signal?.throwIfAborted();
    const pending = this.resolveHeaders(url, tenant, signal);
    if (!signal) return pending;
    // Discovery can be shared by concurrent callers. Abort only this caller's wait.
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      const cleanup = () => signal.removeEventListener('abort', aborted);
      pending.then(
        (headers) => {
          cleanup();
          resolve(headers);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private async resolveHeaders(
    url: URL,
    tenant: TenantIds,
    signal?: AbortSignal | null,
  ): Promise<Record<string, string>> {
    const pathCluster = /^\/v1\/clusters\/([^/]+)(?:\/|$)/.exec(
      url.pathname,
    )?.[1];
    const clusterId =
      pathCluster &&
      !['sizes', 'metrics', 'verify-s3-access'].includes(pathCluster)
        ? decodeURIComponent(pathCluster)
        : tenant.cluster;
    const organizationId = tenant.organization;
    if (!organizationId || !clusterId) return {};
    signal?.throwIfAborted();
    const cached = this.cache.get(organizationId);
    const wasCached = cached !== undefined && cached.expires > Date.now();
    let response = await this.metadata(organizationId);
    const findTarget = (value: unknown) => {
      const target = records(value, 'clusters').find(
        (item) => item.id === clusterId,
      );
      // A gateway stub cannot prove default placement while regional discovery
      // is incomplete. Treat it as undiscovered so retry can resolve its region.
      if (
        records(value, 'unavailable_regions').length > 0 &&
        !target?.region_id &&
        !deploymentHeaders(target?.deployment_id, target?.cloud_region)
      )
        return undefined;
      return target;
    };
    let target = findTarget(response);
    if (
      !target &&
      wasCached &&
      records(response, 'unavailable_regions').length > 0
    ) {
      this.cache.delete(organizationId);
      response = await this.metadata(organizationId);
      signal?.throwIfAborted();
      target = findTarget(response);
    }
    if (!target && records(response, 'unavailable_regions').length > 0) {
      // Absence from a partial catalog cannot establish a gateway placement.
      // Retry discovery next time so a recovered region is immediately usable.
      this.cache.delete(organizationId);
      throw new Error(
        'Some regions are unavailable. Retry loading the cluster before continuing.',
      );
    }
    return deploymentHeaders(target?.deployment_id, target?.cloud_region) ?? {};
  }
}

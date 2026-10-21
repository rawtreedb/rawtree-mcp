export type LoadMetadata = (path: string) => Promise<unknown>;
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

function clustersPath(organization: string): string {
  return `/v1/clusters?${new URLSearchParams({ organization })}`;
}

/** The loader supplies the merged regional cluster catalog for scoped requests. */
export class ClusterRouting {
  private readonly cache = new Map<
    string,
    { expires: number; value: Promise<unknown> }
  >();

  constructor(private readonly load: LoadMetadata) {}

  private generation = 0;

  get version() {
    return this.generation;
  }

  remember(url: URL, value: unknown, version: number) {
    const organization = url.searchParams.get('organization');
    const path =
      url.pathname === '/v1/organizations'
        ? url.pathname
        : url.pathname === '/v1/clusters' && organization
          ? clustersPath(organization)
          : undefined;
    // Ordinary GETs cannot overwrite a newer discovery or a mutation's invalidation.
    if (!path || version !== this.generation || this.cache.has(path)) return;
    this.cache.set(path, {
      expires: Date.now() + CACHE_MS,
      value: Promise.resolve(value),
    });
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
  }

  private metadata(path: string): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.load(path);
    this.cache.set(path, { expires: Date.now() + CACHE_MS, value });
    void value.catch(() => {
      if (this.cache.get(path)?.value === value) this.cache.delete(path);
    });
    return value;
  }

  private async organizationName(
    id: string,
    signal?: AbortSignal | null,
  ): Promise<string> {
    const path = '/v1/organizations';
    const cached = this.cache.get(path);
    const wasCached = cached !== undefined && cached.expires > Date.now();
    let response = await this.metadata(path);
    signal?.throwIfAborted();
    let match = records(response, 'organizations').find(
      (item) => item.organization_id === id,
    );
    if (!match && wasCached) {
      this.cache.delete(path);
      response = await this.metadata(path);
      signal?.throwIfAborted();
      match = records(response, 'organizations').find(
        (item) => item.organization_id === id,
      );
    }
    if (typeof match?.name !== 'string' || !match.name) {
      throw new Error(`Organization '${id}' was not found.`);
    }
    return match.name;
  }

  headers(
    url: URL,
    signal?: AbortSignal | null,
  ): Promise<Record<string, string>> {
    signal?.throwIfAborted();
    const pending = this.resolveHeaders(url, signal);
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
    signal?: AbortSignal | null,
  ): Promise<Record<string, string>> {
    const pathCluster = /^\/v1\/clusters\/([^/]+)(?:\/|$)/.exec(
      url.pathname,
    )?.[1];
    const clusterId =
      pathCluster &&
      !['sizes', 'metrics', 'verify-s3-access'].includes(pathCluster)
        ? decodeURIComponent(pathCluster)
        : url.searchParams.get('cluster_id');
    const clusterName = url.searchParams.get('cluster');
    const organizationId = url.searchParams.get('organization_id');
    let organization = url.searchParams.get('organization');
    if (!(organizationId || organization) || !(clusterId ?? clusterName))
      return {};
    // The metrics API accepts IDs; cluster discovery still uses organization names.
    if (organizationId)
      organization = await this.organizationName(organizationId, signal);
    if (!organization) return {};
    signal?.throwIfAborted();
    const response = await this.metadata(clustersPath(organization));
    const target = records(response, 'clusters').find((item) =>
      clusterId !== null ? item.id === clusterId : item.name === clusterName,
    );
    return deploymentHeaders(target?.deployment_id, target?.cloud_region) ?? {};
  }
}

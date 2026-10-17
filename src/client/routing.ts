type LoadMetadata = (path: string) => Promise<unknown>;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT = /^[0-9a-f]{8}$/;
const REGION = /^[a-z]+(?:-[a-z]+)+-[1-9][0-9]*$/;
const CACHE_MS = 30_000;

/** Discovery uses the default API origin; only cluster-scoped requests carry routing. */
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

  remember(path: string, value: unknown, version: number) {
    // Ordinary GETs may seed an empty cache, but cannot replace a discovery load.
    // Its promise owns the entry even if an older response completes afterward.
    if (version !== this.generation || this.cache.has(path)) return;
    if (
      path === '/v1/organizations' ||
      /^\/v1\/organizations\/[^/]+\/clusters$/.test(path)
    ) {
      this.cache.set(path, {
        expires: Date.now() + CACHE_MS,
        value: Promise.resolve(value),
      });
    }
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

  async clustersPath(
    organization: string,
    signal?: AbortSignal | null,
  ): Promise<string> {
    signal?.throwIfAborted();
    let id = organization;
    if (!UUID.test(id)) {
      const cached = this.cache.get('/v1/organizations');
      const wasCached = cached !== undefined && cached.expires > Date.now();
      let response = await this.metadata('/v1/organizations');
      signal?.throwIfAborted();
      let match = records(response, 'organizations').find(
        (item) => item.name === organization,
      );
      if (!match && wasCached) {
        // A stale list must not block a newly created organization's retry.
        this.cache.delete('/v1/organizations');
        response = await this.metadata('/v1/organizations');
        signal?.throwIfAborted();
        match = records(response, 'organizations').find(
          (item) => item.name === organization,
        );
      }
      if (
        typeof match?.organization_id !== 'string' ||
        !UUID.test(match.organization_id)
      ) {
        throw new Error(`Organization '${organization}' was not found.`);
      }
      id = match.organization_id;
    }
    return `/v1/organizations/${encodeURIComponent(id)}/clusters`;
  }

  async listClusters(
    organization: string,
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    const path = await this.clustersPath(organization, signal);
    signal?.throwIfAborted();
    return this.metadata(path);
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
    const pathScope =
      /^\/v1\/organizations\/([^/]+)\/clusters(?:\/([^/]+))?/.exec(
        url.pathname,
      );
    const organization = pathScope?.[1]
      ? decodeURIComponent(pathScope[1])
      : (url.searchParams.get('organization_id') ??
        url.searchParams.get('organization'));
    const pathCluster = pathScope?.[2];
    const clusterId =
      pathCluster &&
      pathCluster !== 'metrics' &&
      pathCluster !== 'verify-s3-access'
        ? decodeURIComponent(pathCluster)
        : url.searchParams.get('cluster_id');
    const clusterName = url.searchParams.get('cluster');
    if (!organization || !(clusterId ?? clusterName)) return {};
    const response = await this.listClusters(organization, signal);
    const target = records(response, 'clusters').find((item) =>
      clusterId !== null ? item.id === clusterId : item.name === clusterName,
    );
    const deployment = target?.deployment_id;
    const region = target?.cloud_region;
    // A partial/invalid pair cannot identify a deployment. Keep the migration fallback.
    if (
      typeof deployment !== 'string' ||
      !DEPLOYMENT.test(deployment) ||
      typeof region !== 'string' ||
      region.length > 63 ||
      !REGION.test(region)
    )
      return {};
    return {
      'X-RawTree-Deployment-Id': deployment,
      'X-RawTree-Region': region,
    };
  }
}

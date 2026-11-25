import {
  type CreateConnectorInput,
  connectorDestinations,
  type NewConnectorDestinationInput,
  sameDestination,
} from './connectors.js';

export type {
  ConnectorDestinationInput,
  CreateConnectorInput,
  KafkaConnectorSettingsInput,
  NatsConnectorSettingsInput,
  NewConnectorDestinationInput,
} from './connectors.js';

import {
  type S3StorageAccessInput,
  type S3StorageInput,
  s3StorageAccessRequestBody,
  s3StorageRequestBody,
} from './client/storage.js';
import {
  type FederationIssuerInput,
  type FederationRuleInput,
  type FederationScope,
  federationScope,
  issuerConfiguration,
  ruleConfiguration,
} from './federation.js';

export type {
  S3StorageAccessInput,
  S3StorageInput,
} from './client/storage.js';

import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { discoverClusters } from './client/discovery.js';
import {
  appendQuery,
  errorMessage,
  normalizeApiUrl,
  parseJson,
  type QueryParams,
  RawTreeApiError,
  type RequestOptions,
  uiUrlForApi,
} from './client/http.js';
import { RegionCatalog } from './client/regions.js';
import {
  CLUSTER_ID_HEADER,
  ClusterRouting,
  deploymentApiUrl,
  ORGANIZATION_ID_HEADER,
} from './client/routing.js';

import type {
  CreateSavedQueryInput,
  CreateTableInput,
  CreateWorkflowInput,
  JsonValue,
  SubmitFeedbackInput,
  UpdateSavedQueryInput,
  UpdateTableInput,
  UpdateWorkflowInput,
  WorkflowScope,
} from './types.js';

export { RawTreeApiError } from './client/http.js';

const DEFAULT_USER_AGENT = `rawtree-mcp/${packageJson.version}`;

export interface RawTreeClientOptions {
  fetchFn?: typeof fetch;
  apiKey: string;
  /** Cluster-bound credentials use gateway routing, without user discovery. */
  credentialScope?: 'cluster' | 'user';
  apiUrl?: string;
  /** Default cluster name or ID. */
  cluster?: string;
  database?: string;
  /** Default organization name or ID. */
  organization?: string;
  userAgent?: string;
}

/** `organization` and `cluster` accept a name or an ID; the client resolves names and only sends IDs to the API. */
export interface RawTreeScope {
  cluster?: string;
  database?: string;
  organization?: string;
}

export interface CreateServiceAccountInput {
  name: string;
  description?: string;
  role?: 'member' | 'admin';
}

export type ConnectorStatus = 'active' | 'paused';

function encodePathPart(part: string): string {
  return encodeURIComponent(part);
}

function isUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class RawTreeClient {
  private readonly regions: RegionCatalog;
  private readonly routing = new ClusterRouting((organization) =>
    this.listClusters(organization),
  );
  private readonly organizationIds = new Map<string, Promise<string>>();
  private readonly clusterIds = new Map<string, Promise<string>>();
  private boundCluster?: Promise<{ id: string; name: string }>;
  private readonly apiUrl: string;
  private readonly uiUrl: string;
  private readonly cluster?: string;
  private readonly database?: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiKey: string;
  private readonly credentialScope: 'cluster' | 'user';
  private readonly organization?: string;
  private readonly userAgent: string;

  constructor(options: RawTreeClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.uiUrl = uiUrlForApi(this.apiUrl);
    this.cluster = options.cluster;
    this.database = options.database;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.apiKey = options.apiKey;
    this.credentialScope =
      options.credentialScope ??
      (options.apiKey.startsWith('rt_') ? 'cluster' : 'user');
    this.regions = new RegionCatalog(
      (path) => this.requestJson('GET', path),
      this.credentialScope,
    );
    this.organization = options.organization;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  apiPath(path: `/${string}`): string {
    return `/v1${path}`;
  }

  async submitFeedback(input: SubmitFeedbackInput): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/feedback'), {
      body: { ...input },
      routeTo: {
        organization: input.organization_id,
        cluster: input.cluster_id,
      },
    });
  }

  async listOrganizations(): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/organizations'));
  }

  /** The app addresses organizations by name, so the ID is resolved through the organization list. */
  async integrationsSettingsUrl(organization: string): Promise<string> {
    const name = isUuid(organization)
      ? await this.organizationName(organization)
      : organization;
    return `${this.uiUrl}/${encodePathPart(name)}/~/integrations`;
  }

  private async organizationName(organizationId: string): Promise<string> {
    const response = z
      .object({
        organizations: z.array(
          z.object({ name: z.string(), organization_id: z.string() }),
        ),
      })
      .parse(await this.listOrganizations());
    const selected = response.organizations.find(
      (item) => item.organization_id === organizationId,
    );
    if (!selected)
      throw new Error(
        `Organization '${organizationId}' was not found. Use list-organizations to select an organization.`,
      );
    return selected.name;
  }

  async listIntegrations(organization: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/integrations`,
    );
  }

  async listSlackChannels({
    organization,
    integrationId,
    name,
    cursor,
  }: {
    organization: string;
    integrationId: string;
    name?: string;
    cursor?: string;
  }): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/integrations/${encodePathPart(integrationId)}/channels`,
      { query: { name, cursor } },
    );
  }

  async listOrganizationMembers(organization: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/members`,
    );
  }

  /** Resolves an organization name to its ID; UUIDs pass through. Lookups are cached per client. */
  private resolveOrganization(organization: string): Promise<string> {
    if (isUuid(organization)) return Promise.resolve(organization);
    const cached = this.organizationIds.get(organization);
    if (cached) return cached;
    const lookup = (async () => {
      const response = z
        .object({
          organizations: z.array(
            z.object({ name: z.string(), organization_id: z.string() }),
          ),
        })
        .parse(await this.listOrganizations());
      const selected = response.organizations.find(
        (item) => item.name === organization,
      );
      if (!selected)
        throw new Error(
          this.credentialScope === 'cluster'
            ? `Organization '${organization}' does not match the API key's organization.`
            : `Organization '${organization}' was not found. Use list-organizations to select an organization.`,
        );
      return selected.organization_id;
    })();
    this.organizationIds.set(organization, lookup);
    lookup.catch(() => this.organizationIds.delete(organization));
    return lookup;
  }

  /** Resolves a cluster name within an organization to its ID; UUIDs pass through. */
  private resolveCluster(
    organizationId: string | undefined,
    cluster: string,
  ): Promise<string> {
    if (isUuid(cluster)) return Promise.resolve(cluster);
    if (!organizationId)
      return Promise.reject(
        new Error('Provide organization when selecting a cluster by name.'),
      );
    const key = `${organizationId}/${cluster}`;
    const cached = this.clusterIds.get(key);
    if (cached) return cached;
    const lookup = (async () => {
      const response = z
        .object({
          clusters: z.array(z.object({ id: z.string(), name: z.string() })),
        })
        .parse(await this.listClusters(organizationId));
      const selected = response.clusters.find((item) => item.name === cluster);
      if (!selected)
        throw new Error(
          `Cluster '${cluster}' was not found. Use list-clusters to select a cluster.`,
        );
      return selected.id;
    })();
    this.clusterIds.set(key, lookup);
    lookup.catch(() => this.clusterIds.delete(key));
    return lookup;
  }

  /** An API key is pinned to one cluster, so a cluster name is matched against that cluster. */
  private bound(): Promise<{ id: string; name: string }> {
    if (this.boundCluster) return this.boundCluster;
    const lookup = (async () => {
      const response = z
        .object({
          clusters: z.array(z.object({ id: z.string(), name: z.string() })),
        })
        .parse(await this.requestJson('GET', '/v1/clusters'));
      const [cluster] = response.clusters;
      if (!cluster) throw new Error('The API key is not bound to a cluster.');
      return cluster;
    })();
    this.boundCluster = lookup;
    lookup.catch(() => {
      if (this.boundCluster === lookup) this.boundCluster = undefined;
    });
    return lookup;
  }

  private async tenantIds({
    organization,
    cluster,
  }: {
    organization?: string | undefined;
    cluster?: string | undefined;
  }): Promise<{ organization?: string; cluster?: string }> {
    if (this.credentialScope === 'cluster') {
      let clusterId: string | undefined;
      if (cluster) {
        if (isUuid(cluster)) clusterId = cluster;
        else {
          const bound = await this.bound();
          if (bound.name !== cluster)
            throw new Error(
              `The API key is not bound to cluster '${cluster}'.`,
            );
          clusterId = bound.id;
        }
      }
      return {
        ...(organization
          ? { organization: await this.resolveOrganization(organization) }
          : {}),
        ...(clusterId ? { cluster: clusterId } : {}),
      };
    }
    const organizationId = organization
      ? await this.resolveOrganization(organization)
      : undefined;
    const clusterId = cluster
      ? await this.resolveCluster(organizationId, cluster)
      : undefined;
    return {
      ...(organizationId ? { organization: organizationId } : {}),
      ...(clusterId ? { cluster: clusterId } : {}),
    };
  }

  private async organizationPath(organization: string): Promise<string> {
    return `${this.apiPath('/organizations')}/${encodePathPart(await this.resolveOrganization(organization))}`;
  }

  async listServiceAccounts(organization: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/service-accounts`,
    );
  }

  async createServiceAccount(
    organization: string,
    input: CreateServiceAccountInput,
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${await this.organizationPath(organization)}/service-accounts`,
      {
        body: { ...input },
      },
    );
  }

  async listFederationIssuers(organization: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/federation-issuers`,
    );
  }

  async getFederationIssuer(
    id: string,
    organization: string,
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${await this.organizationPath(organization)}/federation-issuers/${encodePathPart(id)}`,
    );
  }

  async createFederationIssuer(
    input: FederationIssuerInput,
    organization: string,
  ): Promise<unknown> {
    const body = issuerConfiguration.parse(input);
    return this.requestJson(
      'POST',
      `${await this.organizationPath(organization)}/federation-issuers`,
      { body },
    );
  }

  async updateFederationIssuer(
    id: string,
    input: FederationIssuerInput,
    organization: string,
  ): Promise<unknown> {
    const body = issuerConfiguration.parse(input);
    return this.requestJson(
      'PUT',
      `${await this.organizationPath(organization)}/federation-issuers/${encodePathPart(id)}`,
      { body },
    );
  }

  async deleteFederationIssuer(
    id: string,
    organization: string,
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${await this.organizationPath(organization)}/federation-issuers/${encodePathPart(id)}`,
    );
  }

  async listFederationRules(scope: FederationScope): Promise<unknown> {
    return this.requestJson('GET', `${this.apiPath('/federation-rules')}`, {
      tenant: await this.tenantIds(federationScope.parse(scope)),
    });
  }

  async getFederationRule(
    id: string,
    scope: FederationScope,
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/federation-rules')}/${encodePathPart(id)}`,
      { tenant: await this.tenantIds(federationScope.parse(scope)) },
    );
  }

  async createFederationRule(
    input: FederationRuleInput,
    scope: FederationScope,
  ): Promise<unknown> {
    const body = ruleConfiguration.parse(input);
    return this.requestJson('POST', `${this.apiPath('/federation-rules')}`, {
      body,
      tenant: await this.tenantIds(federationScope.parse(scope)),
    });
  }

  async updateFederationRule(
    id: string,
    input: FederationRuleInput,
    scope: FederationScope,
  ): Promise<unknown> {
    const body = ruleConfiguration.parse(input);
    return this.requestJson(
      'PUT',
      `${this.apiPath('/federation-rules')}/${encodePathPart(id)}`,
      { body, tenant: await this.tenantIds(federationScope.parse(scope)) },
    );
  }

  async deleteFederationRule(
    id: string,
    scope: FederationScope,
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/federation-rules')}/${encodePathPart(id)}`,
      { tenant: await this.tenantIds(federationScope.parse(scope)) },
    );
  }

  async addOrganizationMember({
    organization,
    email,
  }: {
    organization: string;
    email: string;
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${await this.organizationPath(organization)}/members`,
      { body: { email } },
    );
  }

  async updateOrganizationMember({
    organization,
    userId,
    role,
  }: {
    organization: string;
    userId: string;
    role: 'admin' | 'member';
  }): Promise<unknown> {
    return this.requestJson(
      'PATCH',
      `${await this.organizationPath(organization)}/members/${encodePathPart(userId)}`,
      { body: { role } },
    );
  }

  async removeOrganizationMember({
    organization,
    userId,
  }: {
    organization: string;
    userId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${await this.organizationPath(organization)}/members/${encodePathPart(userId)}`,
    );
  }

  async listTables(scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/tables'),
      await this.scoped({}, scope),
    );
  }

  async createTable(
    { name, sortingKey, ttl, settings }: CreateTableInput,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/tables'),
      await this.scoped(
        {
          body: {
            name,
            ...(sortingKey === undefined ? {} : { sorting_key: sortingKey }),
            ...(ttl === undefined ? {} : { ttl }),
            ...(settings === undefined ? {} : { settings }),
          },
        },
        scope,
      ),
    );
  }

  async describeTable(
    table: string,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      await this.scoped({}, scope),
    );
  }

  async updateTable(
    table: string,
    { sortingKey, ttl, settings }: UpdateTableInput,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    const fields =
      Number(sortingKey !== undefined) +
      Number(ttl !== undefined) +
      Number(settings !== undefined && Object.keys(settings).length > 0);
    if (fields === 0) {
      throw new Error('Provide sorting_key, ttl, or nonempty settings.');
    }
    if (fields > 1) {
      throw new Error(
        'Update sorting_key, ttl, and settings in separate requests.',
      );
    }
    return this.requestJson(
      'PATCH',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      await this.scoped(
        {
          body: {
            ...(sortingKey === undefined ? {} : { sorting_key: sortingKey }),
            ...(ttl === undefined ? {} : { ttl }),
            ...(settings === undefined ? {} : { settings }),
          },
        },
        scope,
      ),
    );
  }

  async deleteTable(table: string, scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      await this.scoped({}, scope),
    );
  }

  async insertJson(
    {
      table,
      data,
    }: {
      table: string;
      data: JsonValue;
    },
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      await this.scoped({ body: data }, scope),
    );
  }

  async insertFromUrl(
    {
      table,
      url,
    }: {
      table: string;
      url: string;
    },
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      await this.scoped(
        {
          query: { url },
        },
        scope,
      ),
    );
  }

  async query(sql: string, scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/query'),
      await this.scoped(
        {
          body: { sql },
        },
        scope,
      ),
    );
  }

  async formatQuery(
    sql: string,
    scope: RawTreeScope = {},
    signal?: AbortSignal,
  ): Promise<{ formatted: string }> {
    const response = await this.requestJson(
      'POST',
      this.apiPath('/query-format'),
      await this.scoped({ body: { sql }, signal }, scope),
    );
    if (!isRecord(response) || typeof response.formatted !== 'string') {
      throw new Error('RawTree returned an invalid query-format response.');
    }
    return { formatted: response.formatted };
  }

  async listSavedQueries(
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/saved-queries'),
      await this.clusterScoped({}, scope),
    );
  }

  async createSavedQuery(
    input: CreateSavedQueryInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/saved-queries'),
      await this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async updateSavedQuery(
    id: string,
    input: UpdateSavedQueryInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'PATCH',
      `${this.apiPath('/saved-queries')}/${encodePathPart(id)}`,
      await this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async deleteSavedQuery(
    id: string,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/saved-queries')}/${encodePathPart(id)}`,
      await this.clusterScoped({}, scope),
    );
  }

  async listWorkflows(scope: WorkflowScope): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/workflows'),
      await this.clusterScoped({}, scope),
    );
  }

  async getWorkflow(id: string, scope: WorkflowScope): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/workflows')}/${encodePathPart(id)}`,
      await this.clusterScoped({}, scope),
    );
  }

  async createWorkflow(
    input: CreateWorkflowInput,
    scope: WorkflowScope,
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/workflows'),
      await this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async updateWorkflow(
    id: string,
    input: UpdateWorkflowInput,
    scope: WorkflowScope,
  ): Promise<unknown> {
    return this.requestJson(
      'PATCH',
      `${this.apiPath('/workflows')}/${encodePathPart(id)}`,
      await this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async deleteWorkflow(id: string, scope: WorkflowScope): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/workflows')}/${encodePathPart(id)}`,
      await this.clusterScoped({}, scope),
    );
  }

  async listLogs(
    query: QueryParams,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/logs'),
      await this.scoped({ query }, scope),
    );
  }

  async listClusters(organization: string): Promise<unknown> {
    const organizationId = await this.resolveOrganization(organization);
    const version = this.routing.version;
    const result =
      this.credentialScope === 'cluster'
        ? await this.requestJson('GET', '/v1/clusters', {
            tenant: { organization: organizationId },
          })
        : await discoverClusters(
            organizationId,
            this.regions,
            (path, options) => this.requestJson('GET', path, options),
          );
    this.routing.remember(organizationId, result, version);
    return result;
  }

  async listRegions(organization: string): Promise<unknown> {
    return this.regions.list(await this.resolveOrganization(organization));
  }

  async listClusterSizes(
    placement: { organization?: string; regionId?: string } = {},
  ): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/clusters/sizes'), {
      headers: await this.regions.headers(
        placement.organization
          ? await this.resolveOrganization(placement.organization)
          : undefined,
        placement.regionId,
      ),
    });
  }

  async createCluster({
    organization,
    regionId,
    name,
    replicas,
    minimumSize,
    maximumSize,
    idleTimeoutMinutes,
    s3Storage,
    s3StorageAccess,
  }: {
    organization: string;
    regionId: string;
    name: string;
    replicas: number;
    minimumSize: { cpuCores: number; memoryGiB: number };
    maximumSize: { cpuCores: number; memoryGiB: number };
    idleTimeoutMinutes?: number;
    s3Storage?: S3StorageInput;
    s3StorageAccess?: S3StorageAccessInput;
  }): Promise<unknown> {
    if (this.credentialScope === 'cluster') {
      throw new Error(
        'Cluster creation requires a user credential such as OAuth.',
      );
    }
    z.string().uuid().parse(regionId);
    return this.requestJson('POST', this.apiPath('/clusters'), {
      tenant: await this.tenantIds({ organization }),
      body: {
        region_id: regionId,
        name,
        ...(s3StorageAccess === undefined
          ? {}
          : { s3_storage_access: s3StorageAccessRequestBody(s3StorageAccess) }),
        replicas,
        size: {
          cpu_cores: minimumSize.cpuCores,
          memory_gib: minimumSize.memoryGiB,
        },
        autoscaling: {
          min_size: {
            cpu_cores: minimumSize.cpuCores,
            memory_gib: minimumSize.memoryGiB,
          },
          max_size: {
            cpu_cores: maximumSize.cpuCores,
            memory_gib: maximumSize.memoryGiB,
          },
        },
        ...(idleTimeoutMinutes === undefined
          ? {}
          : { idle_timeout_minutes: idleTimeoutMinutes }),
        ...(s3Storage === undefined
          ? {}
          : { s3_storage: s3StorageRequestBody(s3Storage) }),
      },
    });
  }

  async verifyClusterS3Access({
    organization,
    regionId,
    s3Storage,
    s3StorageAccess,
  }: {
    organization: string;
    regionId?: string;
    s3Storage: S3StorageInput;
    s3StorageAccess: S3StorageAccessInput & { externalId: string };
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/clusters/verify-s3-access'),
      {
        tenant: await this.tenantIds({ organization }),
        headers: await this.regions.headers(
          await this.resolveOrganization(organization),
          regionId,
        ),
        body: {
          s3_storage_access: s3StorageAccessRequestBody(s3StorageAccess),
          s3_storage: s3StorageRequestBody(s3Storage),
        },
      },
    );
  }

  /** Resolves a cluster name or ID for a route that carries the cluster ID in its path. */
  private async clusterTarget(organization: string, cluster: string) {
    const tenant = await this.tenantIds({ organization, cluster });
    return {
      tenant,
      path: `${this.apiPath('/clusters')}/${encodePathPart(tenant.cluster ?? cluster)}`,
    };
  }

  async getCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    const { tenant, path } = await this.clusterTarget(organization, clusterId);
    return this.requestJson('GET', path, { tenant });
  }

  async updateCluster({
    organization,
    clusterId,
    idleTimeoutMinutes,
  }: {
    organization: string;
    clusterId: string;
    idleTimeoutMinutes: number;
  }): Promise<unknown> {
    const { tenant, path } = await this.clusterTarget(organization, clusterId);
    return this.requestJson('PATCH', path, {
      tenant,
      body: { idle_timeout_minutes: idleTimeoutMinutes },
    });
  }

  async pauseCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    const { tenant, path } = await this.clusterTarget(organization, clusterId);
    return this.requestJson('POST', `${path}/stop`, { tenant });
  }

  async resumeCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    const { tenant, path } = await this.clusterTarget(organization, clusterId);
    return this.requestJson('POST', `${path}/resume`, { tenant });
  }

  async listApps({
    organization,
    cluster,
  }: {
    organization: string;
    cluster: string;
  }): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/apps'), {
      tenant: await this.tenantIds({ organization, cluster }),
    });
  }

  async installApp({
    organization,
    cluster,
    appId,
  }: {
    organization: string;
    cluster: string;
    appId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'PUT',
      `${this.apiPath('/apps')}/${encodePathPart(appId)}`,
      { tenant: await this.tenantIds({ organization, cluster }) },
    );
  }

  async uninstallApp({
    organization,
    cluster,
    appId,
  }: {
    organization: string;
    cluster: string;
    appId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/apps')}/${encodePathPart(appId)}`,
      { tenant: await this.tenantIds({ organization, cluster }) },
    );
  }

  async listConnectors(
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/connectors'),
      await this.clusterScoped({}, scope),
    );
  }

  async createConnector(
    input: CreateConnectorInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/connectors'),
      await this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async getConnector(
    connectorId: string,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}`,
      await this.clusterScoped({}, scope),
    );
  }

  async getConnectorMetrics(
    connectorId: string,
    scope: Omit<RawTreeScope, 'database'> = {},
    windowSeconds = 300,
  ): Promise<string> {
    // Keep the raw JSON: OTLP timestamps and counters can exceed JS integer precision.
    const tenant = await this.scopeTenant(scope);
    return this.requestText('GET', this.apiPath('/metrics'), {
      // The metrics API takes IDs as query parameters, not selector headers.
      routeTo: tenant,
      query: {
        organization_id: tenant.organization,
        cluster_id: tenant.cluster,
        filters: JSON.stringify({ 'rawtree.connector.id': connectorId }),
        window_seconds: windowSeconds,
      },
    });
  }

  async addConnectorDestination(
    connectorId: string,
    destination: NewConnectorDestinationInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    const connector = await this.getConnector(connectorId, scope);
    const destinations = connectorDestinations(connector, destination);
    const existing = destinations.find(
      (candidate) =>
        candidate.database === destination.database &&
        candidate.table === destination.table,
    );
    if (existing) {
      if (sameDestination(existing, destination)) return connector;
      throw new Error(
        `Connector already has a destination for ${destination.database}.${destination.table} with different source settings.`,
      );
    }

    return this.requestJson(
      'PATCH',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}`,
      await this.clusterScoped(
        { body: { destinations: [...destinations, destination] } },
        scope,
      ),
    );
  }

  async setConnectorStatus(
    connectorId: string,
    status: ConnectorStatus,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'PATCH',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}`,
      await this.clusterScoped({ body: { status } }, scope),
    );
  }

  async listDatabases(
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/databases'), {
      tenant: await this.scopeTenant(scope),
    });
  }

  async createDatabase(
    {
      name,
      s3Storage,
    }: {
      name: string;
      s3Storage?: S3StorageInput;
    },
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/databases'), {
      tenant: await this.scopeTenant(scope),
      body: {
        name,
        ...(s3Storage === undefined
          ? {}
          : { s3_storage: s3StorageRequestBody(s3Storage) }),
      },
    });
  }

  async verifyDatabaseS3Access(
    {
      name,
      s3Storage,
    }: {
      name: string;
      s3Storage: S3StorageInput;
    },
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/databases/verify-s3-access'),
      {
        tenant: await this.scopeTenant(scope),
        body: { name, s3_storage: s3StorageRequestBody(s3Storage) },
      },
    );
  }

  async deleteDatabase(
    database: string,
    scope: Pick<RawTreeScope, 'organization' | 'cluster'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/databases')}/${encodePathPart(database)}`,
      {
        tenant: await this.scopeTenant(scope),
      },
    );
  }

  async listApiKeys(scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/api-keys'),
      await this.scoped({}, scope),
    );
  }

  async createApiKey(
    {
      name,
      permission,
      expires_at,
    }: {
      name: string;
      permission: string;
      expires_at?: string | null;
    },
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/api-keys'),
      await this.scoped(
        {
          body: { name, permission, expires_at },
        },
        scope,
      ),
    );
  }

  async deleteApiKey(id: string, scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/api-keys')}/${encodePathPart(id)}`,
      await this.scoped({}, scope),
    );
  }

  /** Resolved IDs for a scope that falls back to the configured organization and cluster. */
  private scopeTenant(
    scope: Pick<RawTreeScope, 'organization' | 'cluster'>,
  ): Promise<{ organization?: string; cluster?: string }> {
    return this.tenantIds({
      organization: scope.organization ?? this.organization,
      cluster: scope.cluster ?? this.cluster,
    });
  }

  private async scoped(
    options: RequestOptions = {},
    scope: RawTreeScope = {},
  ): Promise<RequestOptions> {
    const database = scope.database ?? this.database;
    return {
      ...(await this.clusterScoped(options, scope)),
      ...(database ? { query: { ...options.query, database } } : {}),
    };
  }

  private async clusterScoped(
    options: RequestOptions = {},
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<RequestOptions> {
    return { ...options, tenant: await this.scopeTenant(scope) };
  }

  private endpoint(path: string, query?: QueryParams): URL {
    const url = new URL(`${this.apiUrl}${path}`);
    appendQuery(url, query);
    return url;
  }

  private async requestJson(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const text = await this.requestText(method, path, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...options.headers,
      },
    });

    const result = text ? parseJson(text) : null;
    return result;
  }

  private async requestText(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const hasBody = options.body !== undefined;
    const url = this.endpoint(path, options.query);
    const routingHeaders =
      this.credentialScope === 'cluster'
        ? {}
        : await this.routing.headers(
            url,
            options.tenant ?? options.routeTo ?? {},
            options.signal,
          );
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': this.userAgent,
      'x-rawtree-client': 'mcp',
      'x-rawtree-client-version': packageJson.version,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.tenant?.organization
        ? { [ORGANIZATION_ID_HEADER]: options.tenant.organization }
        : {}),
      ...(options.tenant?.cluster
        ? { [CLUSTER_ID_HEADER]: options.tenant.cluster }
        : {}),
      ...options.headers,
      ...routingHeaders,
    };
    const response = await this.fetchFn(deploymentApiUrl(url, headers), {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });

    const text = await response.text();
    const payload = text ? parseJson(text) : null;
    if (!response.ok) {
      throw new RawTreeApiError({
        status: response.status,
        method,
        path,
        payload,
        message: errorMessage(payload, response.status, method, path),
      });
    }
    if (
      method !== 'GET' &&
      (path.startsWith('/v1/organizations') || path.startsWith('/v1/clusters'))
    ) {
      this.routing.clear();
      this.organizationIds.clear();
      this.clusterIds.clear();
      this.boundCluster = undefined;
    }
    return text;
  }
}

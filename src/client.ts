import packageJson from '../package.json' with { type: 'json' };
import type { JsonValue } from './types.js';

const DEFAULT_API_URL = 'https://api.rawtree.com';
const DEFAULT_USER_AGENT = `rawtree-mcp/${packageJson.version}`;

type QueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | null
  | undefined;

type QueryParams = Record<string, QueryValue>;

interface RequestOptions {
  body?: JsonValue | Record<string, unknown>;
  query?: QueryParams;
  headers?: Record<string, string>;
}

export interface RawTreeClientOptions {
  fetchFn?: typeof fetch;
  apiKey: string;
  apiUrl?: string;
  cluster?: string;
  database?: string;
  organization?: string;
  userAgent?: string;
}

export interface RawTreeScope {
  cluster?: string;
  database?: string;
  organization?: string;
}

export interface S3DestinationInput {
  bucket: string;
  path?: string;
}

export interface ByoS3Input {
  data: S3DestinationInput;
  backups: S3DestinationInput;
  roleArn: string;
  externalId: string;
  tableBucketPrefix?: string;
}

export interface CreateTableStorageInput {
  type: 's3';
  bucketSuffix: string;
  path?: string;
}

export interface ConnectorDestinationInput {
  id?: string;
  topics: string[];
  group_id?: string;
  database: string;
  table: string;
}

export type NewConnectorDestinationInput = Omit<
  ConnectorDestinationInput,
  'id'
>;

export interface KafkaConnectorSettingsInput {
  bootstrap_servers: string;
  auto_offset_reset?: 'largest' | 'smallest';
  tls?: {
    enabled: true;
    verify_certificate?: boolean;
    verify_hostname?: boolean;
  };
  sasl?: {
    enabled: true;
    mechanism: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
    username: string;
    password: string;
  };
  batch?: {
    max_events?: number;
    timeout_secs?: number;
  };
}

export interface CreateConnectorInput {
  name: string;
  type: 'kafka';
  destinations: NewConnectorDestinationInput[];
  settings: KafkaConnectorSettingsInput;
}

export type ConnectorStatus = 'active' | 'paused';

export class RawTreeApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly payload: unknown;

  constructor({
    status,
    method,
    path,
    payload,
    message,
  }: {
    status: number;
    method: string;
    path: string;
    payload: unknown;
    message: string;
  }) {
    super(message);
    this.name = 'RawTreeApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.payload = payload;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeApiUrl(apiUrl: string | undefined): string {
  const trimmed = (apiUrl ?? DEFAULT_API_URL).trim();
  if (!trimmed) return DEFAULT_API_URL;
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function errorMessage(
  payload: unknown,
  status: number,
  method: string,
  path: string,
): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : null;
    const hint = typeof record.hint === 'string' ? record.hint : null;
    if (message && hint) return `${message} ${hint}`;
    if (message) return message;
    const error = typeof record.error === 'string' ? record.error : null;
    if (error) return error;
  }
  return `RawTree API request failed: ${method} ${path} returned ${status}`;
}

function appendQuery(url: URL, query: QueryParams | undefined): void {
  if (!query) return;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) url.searchParams.set(key, value.join(','));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

function encodePathPart(part: string): string {
  return encodeURIComponent(part);
}

function byoS3RequestBody(byoS3: ByoS3Input) {
  return {
    data: {
      bucket: byoS3.data.bucket,
      ...(byoS3.data.path === undefined ? {} : { path: byoS3.data.path }),
    },
    backups: {
      bucket: byoS3.backups.bucket,
      ...(byoS3.backups.path === undefined ? {} : { path: byoS3.backups.path }),
    },
    role_arn: byoS3.roleArn,
    external_id: byoS3.externalId,
    ...(byoS3.tableBucketPrefix === undefined
      ? {}
      : { table_bucket_prefix: byoS3.tableBucketPrefix }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectorDestinations(value: unknown): ConnectorDestinationInput[] {
  if (!isRecord(value) || !Array.isArray(value.destinations)) {
    throw new Error('RawTree returned an invalid connector response.');
  }

  return value.destinations.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      !Array.isArray(candidate.topics) ||
      !candidate.topics.every((topic) => typeof topic === 'string') ||
      typeof candidate.group_id !== 'string' ||
      typeof candidate.database !== 'string' ||
      typeof candidate.table !== 'string'
    ) {
      throw new Error('RawTree returned an invalid connector destination.');
    }
    return {
      id: candidate.id,
      topics: candidate.topics,
      group_id: candidate.group_id,
      database: candidate.database,
      table: candidate.table,
    };
  });
}

function sameDestination(
  existing: ConnectorDestinationInput,
  requested: NewConnectorDestinationInput,
): boolean {
  return (
    existing.topics.length === requested.topics.length &&
    existing.topics.every(
      (topic, index) => topic === requested.topics[index],
    ) &&
    (requested.group_id === undefined ||
      existing.group_id === requested.group_id)
  );
}

export class RawTreeClient {
  private readonly apiUrl: string;
  private readonly cluster?: string;
  private readonly database?: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiKey: string;
  private readonly organization?: string;
  private readonly userAgent: string;

  constructor(options: RawTreeClientOptions) {
    this.apiUrl = normalizeApiUrl(options.apiUrl);
    this.cluster = options.cluster;
    this.database = options.database;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.apiKey = options.apiKey;
    this.organization = options.organization;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  apiPath(path: `/${string}`): string {
    return `/v1${path}`;
  }

  async listOrganizations(): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/organizations'));
  }

  async listOrganizationMembers(organization: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/organizations')}/${encodePathPart(organization)}/members`,
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
      `${this.apiPath('/organizations')}/${encodePathPart(organization)}/members`,
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
      `${this.apiPath('/organizations')}/${encodePathPart(organization)}/members/${encodePathPart(userId)}`,
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
      `${this.apiPath('/organizations')}/${encodePathPart(organization)}/members/${encodePathPart(userId)}`,
    );
  }

  async listTables(scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/tables'),
      this.scoped({}, scope),
    );
  }

  async createTable(
    {
      name,
      storage,
    }: {
      name: string;
      storage?: CreateTableStorageInput;
    },
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/tables'),
      this.scoped(
        {
          body: {
            name,
            ...(storage === undefined
              ? {}
              : {
                  storage: {
                    type: storage.type,
                    bucket_suffix: storage.bucketSuffix,
                    ...(storage.path === undefined
                      ? {}
                      : { path: storage.path }),
                  },
                }),
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
      this.scoped({}, scope),
    );
  }

  async deleteTable(table: string, scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      this.scoped({}, scope),
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
      this.scoped({ body: data }, scope),
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
  ): Promise<string> {
    return this.requestText(
      'POST',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      this.scoped(
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
      this.scoped(
        {
          body: { sql },
        },
        scope,
      ),
    );
  }

  async listLogs(
    query: QueryParams,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/logs'),
      this.scoped({ query }, scope),
    );
  }

  async listClusters(organization: string): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/clusters'), {
      query: { organization },
    });
  }

  async listClusterSizes(): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/clusters/sizes'));
  }

  async createCluster({
    organization,
    name,
    replicas,
    minimumSize,
    maximumSize,
    idleTimeoutMinutes,
    byoS3,
  }: {
    organization: string;
    name: string;
    replicas: number;
    minimumSize: { cpuCores: number; memoryGiB: number };
    maximumSize: { cpuCores: number; memoryGiB: number };
    idleTimeoutMinutes?: number;
    byoS3?: ByoS3Input;
  }): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/clusters'), {
      query: { organization },
      body: {
        name,
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
        ...(byoS3 === undefined ? {} : { byo_s3: byoS3RequestBody(byoS3) }),
      },
    });
  }

  async verifyClusterS3Access({
    organization,
    byoS3,
  }: {
    organization: string;
    byoS3: ByoS3Input;
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/clusters/verify-s3-access'),
      {
        query: { organization },
        body: { byo_s3: byoS3RequestBody(byoS3) },
      },
    );
  }

  async getCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/clusters')}/${encodePathPart(clusterId)}`,
      { query: { organization } },
    );
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
    return this.requestJson(
      'PATCH',
      `${this.apiPath('/clusters')}/${encodePathPart(clusterId)}`,
      {
        query: { organization },
        body: { idle_timeout_minutes: idleTimeoutMinutes },
      },
    );
  }

  async pauseCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${this.apiPath('/clusters')}/${encodePathPart(clusterId)}/stop`,
      { query: { organization } },
    );
  }

  async resumeCluster({
    organization,
    clusterId,
  }: {
    organization: string;
    clusterId: string;
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${this.apiPath('/clusters')}/${encodePathPart(clusterId)}/resume`,
      { query: { organization } },
    );
  }

  async listApps({
    organization,
    cluster,
  }: {
    organization: string;
    cluster: string;
  }): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/apps'), {
      query: { organization, cluster },
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
      { query: { organization, cluster } },
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
      { query: { organization, cluster } },
    );
  }

  async listConnectors(
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/connectors'),
      this.clusterScoped({}, scope),
    );
  }

  async createConnector(
    input: CreateConnectorInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/connectors'),
      this.clusterScoped({ body: { ...input } }, scope),
    );
  }

  async getConnector(
    connectorId: string,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}`,
      this.clusterScoped({}, scope),
    );
  }

  async getConnectorMetrics(
    connectorId: string,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}/metrics`,
      this.clusterScoped({}, scope),
    );
  }

  async addConnectorDestination(
    connectorId: string,
    destination: NewConnectorDestinationInput,
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    const connector = await this.getConnector(connectorId, scope);
    const destinations = connectorDestinations(connector);
    const existing = destinations.find(
      (candidate) =>
        candidate.database === destination.database &&
        candidate.table === destination.table,
    );
    if (existing) {
      if (sameDestination(existing, destination)) return connector;
      throw new Error(
        `Connector already has a destination for ${destination.database}.${destination.table} with different topics or group_id.`,
      );
    }

    return this.requestJson(
      'PATCH',
      `${this.apiPath('/connectors')}/${encodePathPart(connectorId)}`,
      this.clusterScoped(
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
      this.clusterScoped({ body: { status } }, scope),
    );
  }

  async listDatabases(
    scope: Omit<RawTreeScope, 'database'> = {},
  ): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/databases'), {
      query: {
        organization: scope.organization ?? this.organization,
        cluster: scope.cluster ?? this.cluster,
      },
    });
  }

  async deleteDatabase(
    database: string,
    scope: Pick<RawTreeScope, 'organization'> = {},
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/databases')}/${encodePathPart(database)}`,
      {
        query: {
          organization: scope.organization ?? this.organization,
        },
      },
    );
  }

  async listApiKeys(scope: RawTreeScope = {}): Promise<unknown> {
    return this.requestJson(
      'GET',
      this.apiPath('/keys'),
      this.scoped({}, scope),
    );
  }

  async createApiKey(
    {
      name,
      permission,
    }: {
      name: string;
      permission: string;
    },
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'POST',
      this.apiPath('/keys'),
      this.scoped(
        {
          body: { name, permission },
        },
        scope,
      ),
    );
  }

  async deleteApiKey(
    idOrApiKey: string,
    scope: RawTreeScope = {},
  ): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/keys')}/${encodePathPart(idOrApiKey)}`,
      this.scoped({}, scope),
    );
  }

  private scoped(
    options: RequestOptions = {},
    scope: RawTreeScope = {},
  ): RequestOptions {
    const cluster = scope.cluster ?? this.cluster;
    const database = scope.database ?? this.database;
    const organization = scope.organization ?? this.organization;
    if (!cluster && !database && !organization) return options;
    // RawTree database-scoped data routes stay at /v1/<resource>; auth reads scope from query params.
    return {
      ...options,
      query: {
        ...options.query,
        database,
        organization,
        cluster,
      },
    };
  }

  private clusterScoped(
    options: RequestOptions = {},
    scope: Omit<RawTreeScope, 'database'> = {},
  ): RequestOptions {
    const cluster = scope.cluster ?? this.cluster;
    const organization = scope.organization ?? this.organization;
    if (!cluster && !organization) return options;
    return {
      ...options,
      query: {
        ...options.query,
        organization,
        cluster,
      },
    };
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

    return text ? parseJson(text) : null;
  }

  private async requestText(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<string> {
    const hasBody = options.body !== undefined;
    const response = await this.fetchFn(this.endpoint(path, options.query), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': this.userAgent,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
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
    return text;
  }
}

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

  async createCluster({
    organization,
    name,
    replicas,
    cpuCores,
    memoryGiB,
  }: {
    organization: string;
    name: string;
    replicas: number;
    cpuCores: number;
    memoryGiB: number;
  }): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/clusters'), {
      query: { organization },
      body: {
        name,
        replicas,
        size: {
          cpu_cores: cpuCores,
          memory_gib: memoryGiB,
        },
      },
    });
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

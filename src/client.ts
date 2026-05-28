import type { JsonValue, ServerOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.rawtree.com';
const DEFAULT_USER_AGENT = '@rawtree/mcp/0.1.0';

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

interface RawTreeClientOptions extends ServerOptions {
  fetchFn?: typeof fetch;
  token: string;
  userAgent?: string;
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

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = (baseUrl ?? DEFAULT_BASE_URL).trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function namedRef(value: unknown): { name: string } | null {
  const record = objectRecord(value);
  if (!record || typeof record.name !== 'string' || !record.name) return null;
  return { name: record.name };
}

function projectIdentityFromResponse(response: unknown): {
  name: string;
  organization: { name: string };
} {
  const record = objectRecord(response);
  const project = namedRef(record?.project);
  const organization = namedRef(record?.organization);

  if (!project || !organization) {
    throw new Error(
      'RawTree response did not include project and organization names.',
    );
  }

  return {
    name: project.name,
    organization,
  };
}

export class RawTreeClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly token: string;
  private readonly userAgent: string;

  constructor(options: RawTreeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
    this.token = options.token;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  apiPath(path: `/${string}`): string {
    return `/v1${path}`;
  }

  async health(): Promise<unknown> {
    return this.requestJson('GET', '/health');
  }

  async listTables(): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/tables'));
  }

  async describeTable(table: string): Promise<unknown> {
    return this.requestJson(
      'GET',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
    );
  }

  async deleteTable(table: string): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
    );
  }

  async insertJson({
    table,
    data,
    transform,
    columns,
  }: {
    table: string;
    data: JsonValue;
    transform?: string;
    columns?: readonly string[];
  }): Promise<unknown> {
    return this.requestJson(
      'POST',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      {
        body: data,
        query: {
          transform,
          columns:
            columns && columns.length > 0 ? columns.join(',') : undefined,
        },
      },
    );
  }

  async insertFromUrl({
    table,
    url,
  }: {
    table: string;
    url: string;
  }): Promise<string> {
    return this.requestText(
      'POST',
      `${this.apiPath('/tables')}/${encodePathPart(table)}`,
      {
        query: { url },
      },
    );
  }

  async query(sql: string): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/query'), {
      body: { sql },
    });
  }

  async listLogs(query: QueryParams): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/logs'), { query });
  }

  async getProject(): Promise<{
    name: string;
    organization: { name: string };
  }> {
    try {
      return projectIdentityFromResponse(
        await this.requestJson('GET', this.apiPath('/keys')),
      );
    } catch (error) {
      if (!(error instanceof RawTreeApiError) || error.status !== 403) {
        throw error;
      }
    }

    return projectIdentityFromResponse(
      await this.requestJson('GET', this.apiPath('/tables')),
    );
  }

  async listApiKeys(): Promise<unknown> {
    return this.requestJson('GET', this.apiPath('/keys'));
  }

  async createApiKey({
    name,
    permission,
  }: {
    name: string;
    permission: string;
  }): Promise<unknown> {
    return this.requestJson('POST', this.apiPath('/keys'), {
      body: { name, permission },
    });
  }

  async deleteApiKey(idOrToken: string): Promise<unknown> {
    return this.requestJson(
      'DELETE',
      `${this.apiPath('/keys')}/${encodePathPart(idOrToken)}`,
    );
  }

  private endpoint(path: string, query?: QueryParams): URL {
    const url = new URL(`${this.baseUrl}${path}`);
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
        Authorization: `Bearer ${this.token}`,
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

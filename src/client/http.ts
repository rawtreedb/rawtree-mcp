import type { JsonValue } from '../types.js';

const DEFAULT_API_URL = 'https://api.rawtree.com';

type QueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | null
  | undefined;

export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  body?: JsonValue | Record<string, unknown>;
  query?: QueryParams;
  headers?: Record<string, string>;
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

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function normalizeApiUrl(apiUrl: string | undefined): string {
  const trimmed = (apiUrl ?? DEFAULT_API_URL).trim();
  if (!trimmed) return DEFAULT_API_URL;
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function errorMessage(
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

export function appendQuery(url: URL, query: QueryParams | undefined): void {
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

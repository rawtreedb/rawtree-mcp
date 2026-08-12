import { z } from 'zod';
import type { RawTreeScope } from '../client.js';
import type { JsonObject, JsonValue } from '../types.js';

export interface ToolScopeOptions {
  requireExplicitScope?: boolean;
}

function scopeName(options: ToolScopeOptions, description: string) {
  const schema = z.string().min(1).describe(description);
  return options.requireExplicitScope ? schema : schema.optional();
}

export function clusterScopeInput(options: ToolScopeOptions) {
  return {
    organization: scopeName(
      options,
      'RawTree organization containing the target cluster.',
    ),
    cluster: scopeName(options, 'RawTree cluster to use for this operation.'),
  };
}

export function databaseScopeInput(options: ToolScopeOptions) {
  return {
    ...clusterScopeInput(options),
    database: scopeName(options, 'RawTree database to use for this operation.'),
  };
}

export function requestScope({
  organization,
  cluster,
  database,
}: RawTreeScope): RawTreeScope {
  return { organization, cluster, database };
}

export function textResult(...texts: string[]) {
  return {
    content: texts.map((text) => ({ type: 'text' as const, text })),
  };
}

export function jsonResult(value: unknown, label?: string) {
  const body = JSON.stringify(value, null, 2);
  return textResult(label ? `${label}\n${body}` : body);
}

export function namedJsonResult(name: string, value: unknown) {
  return textResult(`${name}:\n${JSON.stringify(value, null, 2)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) return value.every(isJsonValue);

  if (!isPlainObject(value)) return false;

  return Object.values(value).every(isJsonValue);
}

export function asJsonRows(value: unknown): JsonObject | JsonObject[] {
  if (isPlainObject(value) && isJsonValue(value)) return value;

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isPlainObject(item) && isJsonValue(item))
  ) {
    return value;
  }

  throw new Error(
    'data must be a JSON object or a non-empty array of JSON objects.',
  );
}

export function requireConfirmation(
  confirmed: boolean | undefined,
  message: string,
): void {
  if (confirmed !== true) throw new Error(message);
}

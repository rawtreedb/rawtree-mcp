export type TransportMode = 'stdio' | 'http';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

interface RawTreeScopeConfig {
  apiUrl?: string;
  database?: string;
  organization?: string;
}

export interface StdioConfig extends RawTreeScopeConfig {
  apiKey: string;
  transport: 'stdio';
  port: number;
}

export interface HttpConfig extends RawTreeScopeConfig {
  transport: 'http';
  port: number;
}

export type CliConfig = StdioConfig | HttpConfig;

export type ResolveResult =
  | { ok: true; config: CliConfig }
  | { ok: false; error: string };

export type PermissionLevel =
  | 'admin'
  | 'read_write'
  | 'write_only'
  | 'read_only';

export type BuiltinTransform =
  | 'otlp-traces'
  | 'otlp-logs'
  | 'otlp-metrics'
  | 'cloudwatch-logs'
  | 'cloudtrail'
  | 'firehose';

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

export interface CreateSavedQueryInput {
  name: string;
  sql: string;
  database: string;
  visibility?: 'private' | 'cluster';
}

export type UpdateSavedQueryInput = Partial<CreateSavedQueryInput>;

export interface WorkflowScope {
  organization: string;
  cluster: string;
}

export type NewWorkflowSink =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'table'; database: string; table: string };

export type WorkflowSinkInput =
  | NewWorkflowSink
  | {
      type: 'http';
      id: string;
      url?: string;
      headers?: Record<string, string | null>;
    }
  | { type: 'table'; id: string; database: string; table: string };

export interface CreateWorkflowInput {
  name: string;
  database: string;
  sql: string;
  enabled?: boolean;
  interval_seconds?: number;
  sinks?: NewWorkflowSink[];
}

export type UpdateWorkflowInput = Partial<
  Omit<CreateWorkflowInput, 'sinks'>
> & {
  sinks?: WorkflowSinkInput[];
};

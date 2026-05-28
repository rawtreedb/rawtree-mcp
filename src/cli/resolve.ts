import type { ParsedArgs } from 'minimist';
import { DEFAULT_HTTP_PORT } from './constants.js';
import type { ResolveResult } from './types.js';

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function parsePort(parsed: ParsedArgs, env: NodeJS.ProcessEnv): number {
  const fromArg = readString(parsed.port);
  const argPort = fromArg ? Number.parseInt(fromArg, 10) : NaN;
  if (Number.isInteger(argPort) && argPort > 0 && argPort < 65536)
    return argPort;

  const fromEnv = readString(env.MCP_PORT);
  const envPort = fromEnv ? Number.parseInt(fromEnv, 10) : NaN;
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536)
    return envPort;

  return DEFAULT_HTTP_PORT;
}

export function resolveConfig(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv = process.env,
): ResolveResult {
  const apiKey = firstString(parsed['api-key'], env.RAWTREE_API_KEY);
  const transport = parsed.http === true ? 'http' : 'stdio';

  if (transport === 'stdio' && !apiKey) {
    return {
      ok: false,
      error:
        'No RawTree API key. Set RAWTREE_API_KEY or use --api-key=<api-key>',
    };
  }

  const common = {
    port: parsePort(parsed, env),
  };

  if (transport === 'http') {
    return {
      ok: true,
      config: {
        ...common,
        transport,
      },
    };
  }

  return {
    ok: true,
    config: {
      ...common,
      transport,
      apiKey: apiKey!,
    },
  };
}

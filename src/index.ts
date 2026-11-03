#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs, resolveConfigOrExit } from './cli/index.js';
import { startTelemetry } from './telemetry-node.js';

const parsed = parseArgs(process.argv.slice(2));
const config = resolveConfigOrExit(parsed, process.env);
const shutdownTelemetry = await startTelemetry();
process.once('beforeExit', shutdownTelemetry);

async function onFatal(err: unknown): Promise<void> {
  console.error(
    'Fatal error:',
    err instanceof Error ? err.message : 'unexpected error',
  );
  await shutdownTelemetry();
  process.exit(1);
}

if (config.transport === 'http') {
  const { runHttp } = await import('./transports/http.js');
  const { apiUrl, database, organization } = config;
  runHttp(
    config.port,
    { apiUrl, database, organization },
    shutdownTelemetry,
  ).catch(onFatal);
} else {
  const { runStdio } = await import('./transports/stdio.js');
  const shutdown = async () => {
    await shutdownTelemetry();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const { apiKey, apiUrl, database, organization } = config;
  runStdio({ apiKey, apiUrl, database, organization }).catch(onFatal);
}

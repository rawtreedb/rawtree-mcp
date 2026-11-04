#!/usr/bin/env node
import 'dotenv/config';
import { parseArgs, resolveConfigOrExit } from './cli/index.js';
import { runHttp } from './transports/http.js';
import { runStdio } from './transports/stdio.js';

const parsed = parseArgs(process.argv.slice(2));
const config = resolveConfigOrExit(parsed, process.env);

function onFatal(err: unknown): void {
  console.error(
    'Fatal error:',
    err instanceof Error ? err.message : 'unexpected error',
  );
  process.exit(1);
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (config.transport === 'http') {
  const { apiUrl, database, organization } = config;
  runHttp(config.port, { apiUrl, database, organization }).catch(onFatal);
} else {
  const { apiKey, apiUrl, database, organization } = config;
  runStdio({ apiKey, apiUrl, database, organization }).catch(onFatal);
}

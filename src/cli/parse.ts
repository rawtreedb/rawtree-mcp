import type { ParsedArgs } from 'minimist';
import minimist from 'minimist';
import { CLI_STRING_OPTIONS } from './constants.js';

export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  return minimist(argv, {
    string: [...CLI_STRING_OPTIONS],
    boolean: ['help', 'http'],
    alias: { h: 'help' },
  });
}

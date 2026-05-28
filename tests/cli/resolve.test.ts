import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/cli/resolve.js';

describe('resolveConfig', () => {
  it('requires a token for stdio mode', () => {
    expect(resolveConfig({}, {})).toEqual({
      ok: false,
      error:
        'No RawTree token. Set RAWTREE_API_KEY, RAWTREE_TOKEN, or use --key=<token>',
    });
  });

  it('resolves stdio config from env', () => {
    expect(
      resolveConfig(
        {},
        {
          RAWTREE_API_KEY: 'rt_test',
          RAWTREE_URL: 'https://api.rawtree.test/',
        },
      ),
    ).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://api.rawtree.test',
        port: 3000,
        token: 'rt_test',
        transport: 'stdio',
      },
    });
  });

  it('allows HTTP mode without a startup token', () => {
    expect(resolveConfig({ http: true }, {})).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://api.rawtree.com',
        port: 3000,
        token: undefined,
        transport: 'http',
      },
    });
  });

  it('resolves the configured port from args', () => {
    expect(
      resolveConfig(
        { port: '4545' },
        {
          RAWTREE_TOKEN: 'jwt_test',
        },
      ),
    ).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://api.rawtree.com',
        port: 4545,
        token: 'jwt_test',
        transport: 'stdio',
      },
    });
  });
});

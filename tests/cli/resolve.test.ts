import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/cli/resolve.js';

describe('resolveConfig', () => {
  it('requires an API key for stdio mode', () => {
    expect(resolveConfig({}, {})).toEqual({
      ok: false,
      error:
        'No RawTree API key. Set RAWTREE_API_KEY or use --api-key=<api-key>',
    });
  });

  it('resolves stdio config from the api-key arg', () => {
    expect(resolveConfig({ 'api-key': 'rt_arg' }, {})).toEqual({
      ok: true,
      config: {
        apiKey: 'rt_arg',
        port: 3000,
        transport: 'stdio',
      },
    });
  });

  it('accepts the api-url arg', () => {
    expect(
      resolveConfig(
        {
          'api-key': 'rt_arg',
          'api-url': 'https://api.rawtree.test',
        },
        {},
      ),
    ).toEqual({
      ok: true,
      config: {
        apiKey: 'rt_arg',
        apiUrl: 'https://api.rawtree.test',
        port: 3000,
        transport: 'stdio',
      },
    });
  });

  it('resolves database scope from args', () => {
    expect(
      resolveConfig(
        {
          'api-key': 'rt_arg',
          database: 'analytics',
          org: 'team',
        },
        {},
      ),
    ).toEqual({
      ok: true,
      config: {
        apiKey: 'rt_arg',
        database: 'analytics',
        organization: 'team',
        port: 3000,
        transport: 'stdio',
      },
    });
  });

  it('resolves stdio config from env', () => {
    expect(
      resolveConfig(
        {},
        {
          RAWTREE_API_KEY: 'rt_test',
          RAWTREE_DATABASE: 'analytics',
          RAWTREE_ORG: 'team',
        },
      ),
    ).toEqual({
      ok: true,
      config: {
        apiKey: 'rt_test',
        database: 'analytics',
        organization: 'team',
        port: 3000,
        transport: 'stdio',
      },
    });
  });

  it('allows HTTP mode without a startup API key', () => {
    expect(resolveConfig({ http: true }, {})).toEqual({
      ok: true,
      config: {
        port: 3000,
        transport: 'http',
      },
    });
  });

  it('resolves the configured port from args', () => {
    expect(
      resolveConfig(
        { port: '4545' },
        {
          RAWTREE_API_KEY: 'rt_test',
        },
      ),
    ).toEqual({
      ok: true,
      config: {
        apiKey: 'rt_test',
        port: 4545,
        transport: 'stdio',
      },
    });
  });
});

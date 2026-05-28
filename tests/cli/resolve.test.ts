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
        organization: undefined,
        project: undefined,
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
        organization: undefined,
        project: undefined,
        port: 3000,
        token: undefined,
        transport: 'http',
      },
    });
  });

  it('requires organization and project together', () => {
    expect(
      resolveConfig(
        {},
        {
          RAWTREE_API_KEY: 'rt_test',
          RAWTREE_ORG: 'team',
        },
      ),
    ).toEqual({
      ok: false,
      error:
        'Scoped routes require both organization and project. Set RAWTREE_ORG and RAWTREE_PROJECT together.',
    });
  });

  it('uses scoped route settings when both values are present', () => {
    expect(
      resolveConfig(
        { port: '4545' },
        {
          RAWTREE_TOKEN: 'jwt_test',
          RAWTREE_ORG: 'team',
          RAWTREE_PROJECT: 'analytics',
        },
      ),
    ).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://api.rawtree.com',
        organization: 'team',
        project: 'analytics',
        port: 4545,
        token: 'jwt_test',
        transport: 'stdio',
      },
    });
  });
});

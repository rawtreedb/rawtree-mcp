import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import * as serverModule from '../src/server.js';

describe('package exports', () => {
  it('exposes the reusable server layer at the package root', () => {
    expect(packageJson.main).toBe('dist/server.js');
    expect(packageJson.types).toBe('dist/server.d.ts');
    expect(packageJson.exports['.']).toEqual({
      types: './dist/server.d.ts',
      default: './dist/server.js',
    });
    expect(typeof serverModule.createMcpServer).toBe('function');
    expect(typeof serverModule.RawTreeClient).toBe('function');
  });

  it('keeps the Node HTTP transport under its own subpath', () => {
    expect(packageJson.exports['./http']).toEqual({
      types: './dist/transports/http.d.ts',
      default: './dist/transports/http.js',
    });
  });
});

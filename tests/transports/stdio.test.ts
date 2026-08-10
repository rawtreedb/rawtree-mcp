import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStdio } from '../../src/transports/stdio.js';

const { mockServeStdio } = vi.hoisted(() => ({
  mockServeStdio: vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/server.js', () => ({
  createMcpServer: vi.fn(() => ({ mock: 'server' })),
}));

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: mockServeStdio,
}));

describe('runStdio', () => {
  beforeEach(() => {
    mockServeStdio.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves modern clients while preserving legacy stdio clients', async () => {
    await runStdio({ apiKey: 'rt_test' });

    expect(mockServeStdio).toHaveBeenCalledTimes(1);
    expect(mockServeStdio.mock.calls[0]?.[1]).toMatchObject({
      legacy: 'serve',
    });
  });

  it('creates the RawTree MCP server through the stdio factory', async () => {
    await runStdio({ apiKey: 'rt_test' });

    const factory = mockServeStdio.mock.calls[0]?.[0] as
      | (() => unknown)
      | undefined;
    expect(factory).toBeDefined();
    expect(factory?.()).toEqual({ mock: 'server' });
  });

  it('routes stdio connection errors to stderr without throwing', async () => {
    await runStdio({ apiKey: 'rt_test' });

    const options = mockServeStdio.mock.calls[0]?.[1] as {
      onerror?: (error: Error) => void;
    };
    expect(() =>
      options.onerror?.(new Error('connection failed')),
    ).not.toThrow();
  });
});

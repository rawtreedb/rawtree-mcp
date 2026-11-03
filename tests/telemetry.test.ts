import { createServer, type Server } from 'node:http';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RawTreeClient } from '../src/client.js';
import { traceContextHeaders } from '../src/telemetry.js';
import { startTelemetry } from '../src/telemetry-node.js';

let shutdown: (() => Promise<void>) | undefined;
let collector: Server | undefined;

afterEach(async () => {
  await shutdown?.();
  if (collector) {
    await new Promise<void>((resolve) => collector?.close(() => resolve()));
  }
  shutdown = undefined;
  collector = undefined;
  context.disable();
  trace.disable();
  propagation.disable();
  metrics.disable();
  vi.unstubAllEnvs();
});

describe('optional Node tracing', () => {
  it.each([
    undefined,
    '',
    '   ',
  ])('stays inactive without an endpoint: %s', async (endpoint) => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', endpoint);
    shutdown = await startTelemetry();
    expect(trace.getTracer('test').startSpan('test').isRecording()).toBe(false);
    expect(traceContextHeaders()).toEqual({});
  });

  it('honors OTEL_SDK_DISABLED even with an endpoint', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:1');
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    shutdown = await startTelemetry();
    expect(trace.getTracer('test').startSpan('test').isRecording()).toBe(false);
  });

  it('flushes OTLP traces and forwards only trace context to the RawTree API', async () => {
    const exports: { path: string | undefined; body: string }[] = [];
    collector = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      exports.push({ path: request.url, body });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) =>
      collector?.listen(0, '127.0.0.1', resolve),
    );
    const address = collector.address();
    if (!address || typeof address === 'string')
      throw new Error('No collector port');
    vi.stubEnv(
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      `http://127.0.0.1:${address.port}`,
    );
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', undefined);
    vi.stubEnv('OTEL_SDK_DISABLED', 'false');
    vi.stubEnv('OTEL_SERVICE_NAME', 'rawtree-mcp-test');
    // These settings must not enable baggage or process-argument collection.
    vi.stubEnv('OTEL_PROPAGATORS', 'tracecontext,baggage');
    vi.stubEnv('OTEL_NODE_RESOURCE_DETECTORS', 'all');
    shutdown = await startTelemetry();

    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [] }),
    );
    const client = new RawTreeClient({ apiKey: 'rt_secret', fetchFn });
    const baggageContext = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ secret: { value: 'private-baggage' } }),
    );
    await context.with(baggageContext, () =>
      trace
        .getTracer('test')
        .startActiveSpan('test operation', async (span) => {
          try {
            await client.query('SELECT private_data');
            const headers = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
            expect(headers.get('traceparent')).toBe(
              `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
            );
            expect(headers.get('baggage')).toBeNull();
            expect(headers.get('authorization')).toBe('Bearer rt_secret');
            const propagated: Record<string, string> = {};
            propagation.inject(context.active(), propagated);
            expect(propagated.baggage).toBeUndefined();
          } finally {
            span.end();
          }
        }),
    );
    await Promise.all([shutdown(), shutdown()]);
    expect(exports).toHaveLength(1);
    expect(exports[0]?.path).toBe('/v1/traces');
    expect(exports[0]?.body).toContain('test operation');
    expect(exports[0]?.body).toContain('rawtree-mcp-test');
    for (const privateValue of [
      'process.command_args',
      'rt_secret',
      'private_data',
      'private-baggage',
    ]) {
      expect(exports[0]?.body).not.toContain(privateValue);
    }
  });
});

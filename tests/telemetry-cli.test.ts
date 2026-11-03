import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
let child: ChildProcess | undefined;
let collector: Server | undefined;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No listening port');
  return address.port;
}

beforeAll(() => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
    cwd: root,
  });
});

afterEach(async () => {
  if (child?.exitCode === null) child.kill('SIGKILL');
  if (collector) {
    await new Promise<void>((resolve) => collector?.close(() => resolve()));
  }
});

describe('CLI trace flushing', () => {
  it.each([
    ['stdio', 'SIGTERM'],
    ['stdio', 'SIGINT'],
    ['stdio', 'EOF'],
    ['http', 'SIGTERM'],
  ] as const)(
    'flushes before %s exits on %s',
    async (transport, termination) => {
      const bodies: string[] = [];
      collector = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        bodies.push(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
      const collectorPort = await listen(collector);
      const reservation = createServer();
      const httpPort = await listen(reservation);
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      // SDK 2.4 does not emit MCP spans. Supply one independently to verify the
      // real CLI's exporter and exit handlers without pretending it does.
      const preload = `
      import { trace } from ${JSON.stringify(import.meta.resolve('@opentelemetry/api'))};
      const timer = setInterval(() => {
        const span = trace.getTracer('shutdown-test').startSpan('pending-cli-span');
        if (span.isRecording()) {
          span.end();
          clearInterval(timer);
          process.stderr.write('test-span-ready\\n');
        }
      }, 10);
    `;
      child = spawn(
        process.execPath,
        [
          `--import=data:text/javascript,${encodeURIComponent(preload)}`,
          'dist/index.js',
          ...(transport === 'http'
            ? ['--http', '--port', String(httpPort)]
            : []),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            RAWTREE_API_KEY: 'rt_shutdown_secret',
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: undefined,
            OTEL_SDK_DISABLED: 'false',
            OTEL_TRACES_SAMPLER: 'always_on',
            OTEL_BSP_SCHEDULE_DELAY: '60000',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const exited = new Promise<number | null>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('exit', resolve);
      });
      let stderr = '';
      let stdout = '';
      let terminated = false;
      child.stdout?.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr?.on('data', (data) => {
        stderr += String(data);
        const listening =
          transport === 'http'
            ? stderr.includes('server listening')
            : stderr.includes('running on stdio');
        if (!terminated && listening && stderr.includes('test-span-ready')) {
          terminated = true;
          if (termination === 'EOF') child?.stdin?.end();
          else child?.kill(termination);
        }
      });
      expect(await exited, stderr).toBe(0);
      expect(stdout).toBe('');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('pending-cli-span');
      expect(bodies[0]).not.toContain('rt_shutdown_secret');
    },
    10000,
  );
});

import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHttp } from '../../src/transports/http.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('large query-format documents over real transports', () => {
  const servers: Server[] = [];
  const clients: Client[] = [];

  beforeAll(() => {
    // Exercise the packaged stdio entrypoint, rebuilt from this checkout.
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
      cwd: root,
    });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  });

  it.each([
    ['http', 'legacy'],
    ['http', 'modern'],
    ['stdio', 'legacy'],
    ['stdio', 'modern'],
  ] as const)(
    'preserves a document above the old buffer limit over %s (%s)',
    async (transport, era) => {
      const sql = `  INSERT INTO t VALUES ('${'x'.repeat(11 * 1024 * 1024)}'), (  \n`;
      const formatted = sql.slice(2);
      const requests: Array<{
        path?: string;
        authorization?: string;
        body: unknown;
      }> = [];
      const api = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push({
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ formatted }));
      });
      servers.push(api);
      await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
      const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
      const client = new Client(
        { name: 'query-format-transport-test', version: '0.0.0' },
        era === 'modern'
          ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          : {},
      );
      clients.push(client);
      if (transport === 'http') {
        const server = await runHttp(0, { apiUrl });
        servers.push(server);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(
              `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
            ),
            { requestInit: { headers: { Authorization: 'Bearer rt_test' } } },
          ),
        );
      } else {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
              '--api-key',
              'rt_test',
              '--api-url',
              apiUrl,
            ],
            // Client-side buffers must also allow complete formatted responses.
            maxBufferSize: 32 * 1024 * 1024,
            stderr: 'pipe',
          }),
        );
      }
      const result = await client.callTool({
        name: 'query-format',
        arguments: { sql },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: JSON.stringify({ formatted }, null, 2) },
      ]);
      expect(requests).toEqual([
        {
          path: '/v1/query-format',
          authorization: 'Bearer rt_test',
          body: { sql },
        },
      ]);
    },
    15_000,
  );
});

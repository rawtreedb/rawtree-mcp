import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import { RawTreeClient } from '../client.js';
import { createMcpServer } from '../server.js';
import type { HttpConfig } from '../types.js';

const sessions: Record<string, NodeStreamableHTTPServerTransport> = {};
export type HttpTransportOptions = Omit<HttpConfig, 'port' | 'transport'>;

function sendJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }),
  );
}

function extractBearerApiKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const apiKey = header.slice('Bearer '.length).trim();
  return apiKey || null;
}

function extractBearerApiKeyFromWebRequest(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const apiKey = header.slice('Bearer '.length).trim();
  return apiKey || null;
}

export async function runHttp(
  port: number,
  config: HttpTransportOptions = {},
): Promise<Server> {
  const app = createMcpExpressApp();

  const modernHandler = createMcpHandler(
    (ctx) => {
      const apiKey = ctx.requestInfo
        ? extractBearerApiKeyFromWebRequest(ctx.requestInfo)
        : null;
      if (!apiKey) {
        throw new Error(
          'Unauthorized: provide a RawTree API key via Authorization: Bearer <api-key>',
        );
      }
      return createMcpServer(new RawTreeClient({ ...config, apiKey }));
    },
    { legacy: 'reject' },
  );
  const modernNodeHandler = toNodeHandler(modernHandler);

  app.get('/health', (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  app.all(
    '/mcp',
    async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
      const webRequest = await toWebRequest(req, req.body);
      if (!(await isLegacyRequest(webRequest, req.body))) {
        const apiKey = extractBearerApiKeyFromWebRequest(webRequest);
        if (!apiKey) {
          sendJsonRpcError(
            res,
            401,
            'Unauthorized: provide a RawTree API key via Authorization: Bearer <api-key>',
          );
          return;
        }
        await modernNodeHandler(req, res, req.body);
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: NodeStreamableHTTPServerTransport | undefined;

      if (sessionId && sessions[sessionId]) {
        transport = sessions[sessionId];
      } else if (
        !sessionId &&
        req.method === 'POST' &&
        isInitializeRequest(req.body)
      ) {
        const apiKey = extractBearerApiKey(req);
        if (!apiKey) {
          sendJsonRpcError(
            res,
            401,
            'Unauthorized: provide a RawTree API key via Authorization: Bearer <api-key>',
          );
          return;
        }

        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions[sid] = transport!;
          },
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid && sessions[sid]) delete sessions[sid];
        };

        const rawtree = new RawTreeClient({ ...config, apiKey });
        const server = createMcpServer(rawtree);
        await server.connect(transport);
      } else if (sessionId && !sessions[sessionId]) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          }),
        );
        return;
      } else {
        sendJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
        return;
      }

      await transport.handleRequest(req, res, req.body);
    },
  );

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.error(`RawTree MCP server listening on http://127.0.0.1:${port}`);
      console.error('  Streamable HTTP: POST/GET/DELETE /mcp');
      resolve(server);
    });
    server.once('error', reject);

    const shutdown = async () => {
      for (const sid of Object.keys(sessions)) {
        try {
          await sessions[sid].close();
        } catch {
          // ignore shutdown errors
        }
        delete sessions[sid];
      }
      await modernHandler.close().catch(() => {});
      server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

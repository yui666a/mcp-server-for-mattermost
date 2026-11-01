import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from './log.ts';
import type { MmClient } from './mattermost/client.ts';
import { checkOrigin, requireBearer, type McpAuth } from './mcp/auth.ts';
import { buildServer } from './mcp/server.ts';
import type { Config } from './config.ts';
import type { Deps } from './deps.ts';
import { authorizeRouter } from './oauth/authorize.ts';
import { metadataRouter } from './oauth/metadata.ts';
import { registerRouter } from './oauth/register.ts';
import { tokenRouter } from './oauth/token.ts';
import type { Store } from './store.ts';

export type AppContext = { config: Config; store: Store; deps: Deps; mm: MmClient };

const MAX_MCP_BODY = 1024 * 1024;

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(metadataRouter(ctx.config));
  app.use(registerRouter(ctx));
  app.use(authorizeRouter(ctx));
  app.use(tokenRouter(ctx));
  app.get('/mcp/healthz', (_req, res) => { res.set('Cache-Control', 'no-store').json({ ok: true }); });
  const guard = [checkOrigin(['https://claude.ai', 'https://claude.com', ...ctx.config.extraOrigins]), requireBearer(ctx.config, ctx.store)];
  app.post('/mcp', ...guard, async (req, res, next) => {
    const auth = res.locals.auth as McpAuth;
    const server = buildServer({ mm: ctx.mm, mmUserId: auth.mmUserId, cfg: ctx.config, store: ctx.store });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_MCP_BODY });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      // The transport reads the body itself; express.json is not mounted so the SDK keeps its 413/415/406 handling.
      await transport.handleRequest(req, res);
    } catch (e) {
      next(e);
    }
  });
  // Stateless with no notifications: there is no SSE stream to open (GET) and no session to end (DELETE).
  app.all('/mcp', ...guard, (_req, res) => { res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' }); });
  // Only the error's name and code are logged: messages from parsers and the DB can embed request data.
  app.use(((err, _req, res, _next) => {
    // Not handing off to express's default handler: it prints the stack, and a partly sent response cannot take a JSON error.
    if (res.headersSent) {
      log('unhandled_error', { name: err?.name });
      return res.end();
    }
    const status = err?.status ?? err?.statusCode;
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      log('request_rejected', { name: err?.name, type: err?.type, status });
      return res.status(status).set('Cache-Control', 'no-store').json({ error: 'invalid_request' });
    }
    log('unhandled_error', { name: err?.name, code: err?.code });
    res.status(500).set('Cache-Control', 'no-store').json({ error: 'server_error' });
  }) satisfies express.ErrorRequestHandler);
  return app;
}

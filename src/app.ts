import express from 'express';
import { log } from './log.ts';
import type { Config } from './config.ts';
import type { Deps } from './deps.ts';
import { authorizeRouter } from './oauth/authorize.ts';
import { metadataRouter } from './oauth/metadata.ts';
import { registerRouter } from './oauth/register.ts';
import type { Store } from './store.ts';

export type AppContext = { config: Config; store: Store; deps: Deps };

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(metadataRouter(ctx.config));
  app.use(registerRouter(ctx));
  app.use(authorizeRouter(ctx));
  // Only the error's name and code are logged: messages from parsers and the DB can embed request data.
  app.use(((err, _req, res, next) => {
    if (res.headersSent) return next(err);
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

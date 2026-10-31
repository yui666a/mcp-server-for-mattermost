import express from 'express';
import type { Config } from './config.ts';
import type { Deps } from './deps.ts';
import { metadataRouter } from './oauth/metadata.ts';
import { registerRouter } from './oauth/register.ts';
import type { Store } from './store.ts';

export type AppContext = { config: Config; store: Store; deps: Deps };

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(metadataRouter(ctx.config));
  app.use(registerRouter(ctx));
  return app;
}

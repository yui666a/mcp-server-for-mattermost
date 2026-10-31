import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { Store } from '../../src/store.ts';

export function makeApp(env: Record<string, string> = {}, fetchImpl: typeof fetch = fetch) {
  const config = loadConfig({
    PUBLIC_URL: 'https://mm.example', TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
    MM_OAUTH_CLIENT_ID: 'id', MM_OAUTH_CLIENT_SECRET: 's', ...env,
  });
  const store = new Store(openDb(':memory:'), config.encKey, Date.now, config.accessTokenTtlSec);
  const app = createApp({ config, store, deps: { fetch: fetchImpl, now: Date.now } });
  return { app, store, config, req: request(app) };
}

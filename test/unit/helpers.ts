import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { MmClient } from '../../src/mattermost/client.ts';
import { Limiter } from '../../src/mattermost/limiter.ts';
import { Store } from '../../src/store.ts';

export function makeApp(env: Record<string, string> = {}, fetchImpl: typeof fetch = fetch) {
  const config = loadConfig({
    PUBLIC_URL: 'https://mm.example', TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
    MM_OAUTH_CLIENT_ID: 'id', MM_OAUTH_CLIENT_SECRET: 's', ...env,
  });
  const store = new Store(openDb(':memory:'), config.encKey, Date.now, config.accessTokenTtlSec);
  const deps = { fetch: fetchImpl, now: Date.now };
  const mm = new MmClient(config, store, new Limiter({ perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 120, globalPerMin: 600 }, Date.now), deps);
  const app = createApp({ config, store, deps, mm });
  return { app, store, config, mm, req: request(app) };
}

// Not vitest's defaults (1 s for vi.waitFor, 5 s for a test): on a busy machine the awaited event can take seconds.
export const SLOW = { timeout: 10_000 };
export const SLOW_TEST = 30_000;

// Not bound inside a function: vitest returns the same spy when spyOn is called on a spy, and binding that spy would make it call itself.
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
export const freezeCleanupDeadline = (signal?: AbortSignal) =>
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 5000 ? signal ?? new AbortController().signal : realTimeout(ms)));
// Not left to the real clock: under load the cleanup's 5-second deadline and its 1-second margin before DELETE would run out while a test holds the lock or waits.
export const freezeCleanupClock = () => {
  freezeCleanupDeadline();
  vi.spyOn(performance, 'now').mockReturnValue(0);
};

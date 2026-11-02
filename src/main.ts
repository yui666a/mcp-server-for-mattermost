import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { log } from './log.ts';
import { MmClient } from './mattermost/client.ts';
import { Limiter } from './mattermost/limiter.ts';
import { every, tick } from './scheduler.ts';
import { Store } from './store.ts';

const config = loadConfig(process.env);
const store = new Store(openDb(config.dbPath), config.encKey, Date.now, config.accessTokenTtlSec);
const deps = { fetch, now: Date.now };
const limiter = new Limiter({ perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 300, globalPerMin: 600 }, Date.now);
const mm = new MmClient(config, store, limiter, deps);
const app = createApp({ config, store, deps, mm });

const server = app.listen(config.port, () => log('listening', { port: config.port }));
setInterval(() => {
  try {
    store.sweep();
  } catch (e) {
    log('sweep_failed', { name: (e as Error)?.name });
  }
}, 60_000).unref();
const stopScheduler = every(30_000, () => tick(store, mm, Date.now()));
// Not waiting for a running tick: a row left sending is retried with a lookup after the restart.
process.on('SIGTERM', () => {
  log('shutting_down');
  stopScheduler();
  server.close(() => process.exit(0));
});

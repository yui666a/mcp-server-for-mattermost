import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runAdmin } from '../../src/admin.ts';
import { openDb } from '../../src/db.ts';
import { Store } from '../../src/store.ts';

const codeInput = (clientId: string) => ({ mmUserId: 'u1', clientId, redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: 'r', scope: 'mattermost' });
const sessionInput = (clientId: string) => ({ clientId, redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', state: 's', resource: 'r', scope: 'mattermost' });

function seed(db: ReturnType<typeof openDb>, store: Store, name: string) {
  const c = store.createClient({ clientName: name, redirectUris: ['http://localhost:1/cb'] });
  store.markClientAuthorized(c.clientId);
  const rec = store.consumeCode(store.createCode(codeInput(c.clientId)));
  if (typeof rec !== 'object') throw new Error('code');
  store.createGrant({ mmUserId: 'u1', clientId: c.clientId, scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
  store.createCode(codeInput(c.clientId));
  store.createAuthSession(sessionInput(c.clientId));
  store.putMmCred('u1', 'a', 'r');
  store.claimPost({ mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' });
  return c;
}

const count = (db: ReturnType<typeof openDb>, t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
const TABLES = ['grants', 'access_tokens', 'refresh_tokens', 'codes', 'auth_sessions', 'mm_creds', 'post_claims'];

function run(db: ReturnType<typeof openDb>, argv: string[]) {
  let out = '';
  let err = '';
  const code = runAdmin(argv, db, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

test('purge-credentials clears credentials but keeps clients, and prints the count', () => {
  const db = openDb(':memory:');
  const store = new Store(db, randomBytes(32));
  seed(db, store, 'a');
  const expected = TABLES.reduce((n, t) => n + count(db, t), 0);
  expect(expected).toBeGreaterThan(0);
  const r = run(db, ['purge-credentials']);
  expect(r.code).toBe(0);
  expect(r.out).toBe(`purged ${expected} rows\n`);
  expect(count(db, 'clients')).toBe(1);
  for (const t of TABLES) expect(count(db, t), t).toBe(0);
});

test('invalidate-scheduled fails every pending and sending schedule, telling the user to check Mattermost where a post was attempted, and leaves finished ones', () => {
  const db = openDb(':memory:');
  const store = new Store(db, randomBytes(32));
  const make = () => store.createScheduled({ mmUserId: 'u1', channelId: 'c'.repeat(26), message: 'm', scheduledAt: 5000 }, 1000)!;
  const set = (id: string, sql: string) => db.prepare(`UPDATE scheduled_posts SET ${sql} WHERE id = ?`).run(id);
  const fresh = make();
  const attempted = make();
  set(attempted, 'first_attempt_at = 2000');
  const sending = make();
  set(sending, "status = 'sending', first_attempt_at = 2000");
  const posted = make();
  set(posted, "status = 'posted', post_id = 'p'");
  const failed = make();
  set(failed, "status = 'failed', error = 'earlier'");
  const r = run(db, ['invalidate-scheduled']);
  expect(r.code).toBe(0);
  expect(r.out).toBe('invalidated 3 scheduled posts\n');
  const row = (id: string) => db.prepare('SELECT status, error FROM scheduled_posts WHERE id = ?').get(id);
  expect(row(fresh)).toEqual({ status: 'failed', error: 'サーバーを復元したため無効にしました。予約を入れ直してください。' });
  const unknown = { status: 'failed', error: 'サーバーを復元したため無効にしました。投稿されたか不明なので、Mattermost の画面で確かめてください。' };
  expect(row(attempted)).toEqual(unknown);
  expect(row(sending)).toEqual(unknown);
  expect(row(posted)).toEqual({ status: 'posted', error: null });
  expect(row(failed)).toEqual({ status: 'failed', error: 'earlier' });
});

test('list-clients shows id, name, created and authorized; --unauthorized filters', () => {
  const db = openDb(':memory:');
  const store = new Store(db, randomBytes(32));
  const a = seed(db, store, 'authorized-app');
  const u = store.createClient({ clientName: 'pending-app', redirectUris: ['http://localhost:1/cb'] });
  const all = run(db, ['list-clients']);
  expect(all.out).toContain(a.clientId);
  expect(all.out).toContain('authorized-app');
  expect(all.out).toContain(u.clientId);
  const only = run(db, ['list-clients', '--unauthorized']);
  expect(only.out).toContain(u.clientId);
  expect(only.out).not.toContain(a.clientId);
});

test('delete-client removes the client and everything that belongs to it, leaving other clients intact', () => {
  const db = openDb(':memory:');
  const store = new Store(db, randomBytes(32));
  const a = seed(db, store, 'a');
  const b = seed(db, store, 'b');
  const r = run(db, ['delete-client', a.clientId]);
  expect(r.code).toBe(0);
  expect(store.getClient(a.clientId)).toBeUndefined();
  expect(store.getClient(b.clientId)).toBeDefined();
  for (const t of ['grants', 'codes', 'auth_sessions'])
    expect(Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE client_id = ?`).get(a.clientId) as { n: number }).n), t).toBe(0);
  expect(count(db, 'grants')).toBe(1);
  expect(count(db, 'access_tokens')).toBe(1);
  expect(count(db, 'refresh_tokens')).toBe(1);
});

test('delete-client on an unknown id fails', () => {
  const db = openDb(':memory:');
  const r = run(db, ['delete-client', 'nope']);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('nope');
});

test.each([[[]], [['bogus']], [['delete-client']], [['list-clients', '--wat']], [['invalidate-scheduled', 'x']]])('bad usage %j prints usage to stderr and fails', (argv) => {
  const db = openDb(':memory:');
  const r = run(db, argv);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('Usage');
  expect(r.out).toBe('');
});

test('the CLI runs with DB_PATH as the only environment variable', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'admin-')), 'mcp.sqlite');
  const db = openDb(path);
  seed(db, new Store(db, randomBytes(32)), 'cli-app');
  db.close();
  const env = { DB_PATH: path, PATH: process.env.PATH ?? '' };
  expect(execFileSync(process.execPath, ['src/admin.ts', 'list-clients'], { env }).toString()).toContain('cli-app');
  expect(execFileSync(process.execPath, ['src/admin.ts', 'purge-credentials'], { env }).toString()).toMatch(/\d+/);
  const bad = spawnSync(process.execPath, ['src/admin.ts', 'bogus'], { env });
  expect(bad.status).not.toBe(0);
  expect(bad.stderr.toString()).toContain('Usage');
});

test('a missing DB file is an error and is not created', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'admin-')), 'missing.sqlite');
  const r = spawnSync(process.execPath, ['src/admin.ts', 'purge-credentials'], { env: { DB_PATH: path, PATH: process.env.PATH ?? '' } });
  expect(r.status).toBe(1);
  expect(r.stderr.toString()).toContain(path);
  expect(r.stdout.toString()).toBe('');
  expect(existsSync(path)).toBe(false);
});

test('a DB error prints a one-line error without a stack trace', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'admin-')), 'bad.sqlite');
  writeFileSync(path, 'this is not a sqlite database, '.repeat(10));
  const r = spawnSync(process.execPath, ['src/admin.ts', 'list-clients'], { env: { DB_PATH: path, PATH: process.env.PATH ?? '' } });
  expect(r.status).toBe(1);
  expect(r.stderr.toString()).toMatch(/^error: .+\n$/);
});

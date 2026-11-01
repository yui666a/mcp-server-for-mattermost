import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { MmClient, Reauthorize } from '../../src/mattermost/client.ts';
import { Limiter } from '../../src/mattermost/limiter.ts';
import { Store } from '../../src/store.ts';
import { mmAuthorizeCode, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

async function tokenPair(cookie: string): Promise<{ access: string; refresh: string }> {
  const code = await mmAuthorizeCode(cookie, { response_type: 'code', client_id: e.oauth.clientId, redirect_uri: e.oauth.callback, state: 'st' });
  const res = await fetch(`${e.mmUrl}/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: e.oauth.callback, client_id: e.oauth.clientId, client_secret: e.oauth.clientSecret,
    }),
  });
  expect(res.status).toBe(200);
  const b = await res.json();
  return { access: b.access_token, refresh: b.refresh_token };
}

const adminApi = (method: string, path: string, body?: unknown) =>
  fetch(`${e.mmUrl}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${e.adminToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const psql = (sql: string) =>
  execFileSync('docker', ['exec', 'mcp-dev-postgres-1', 'psql', '-U', 'mmuser', '-d', 'mattermost', '-tAc', sql], { encoding: 'utf8' }).trim();

describe('MmClient against the local Mattermost', () => {
  let store: Store;
  let client: MmClient;

  beforeAll(() => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
  afterAll(() => vi.restoreAllMocks());

  beforeEach(() => {
    const config = loadConfig({
      PUBLIC_URL: new URL(e.oauth.callback).origin, TOKEN_ENC_KEY: randomBytes(32).toString('base64'), MM_URL: e.mmUrl,
      MM_OAUTH_CLIENT_ID: e.oauth.clientId, MM_OAUTH_CLIENT_SECRET: e.oauth.clientSecret,
    });
    store = new Store(openDb(':memory:'), config.encKey, Date.now, config.accessTokenTtlSec);
    const limiter = new Limiter({ perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 120, globalPerMin: 600 }, Date.now);
    client = new MmClient(config, store, limiter, { fetch, now: Date.now });
  });

  function grant(mmUserId: string) {
    const rec = store.consumeCode(store.createCode({
      mmUserId, clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: 'r', scope: 'mattermost',
    }));
    if (typeof rec !== 'object') throw new Error('code not consumed');
    return store.createGrant({ mmUserId, clientId: 'c1', scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
  }

  async function loginAs(user: Cred): Promise<{ cookie: string; pair: ReturnType<typeof grant> }> {
    const cookie = await mmLoginCookie(user);
    await mmDeauthorize(cookie, e.oauth.clientId);
    const t = await tokenPair(cookie);
    store.putMmCred(user.id, t.access, t.refresh);
    return { cookie, pair: grant(user.id) };
  }

  test('deauthorize in Mattermost leads to Reauthorize and revoked grants', async () => {
    const { cookie, pair } = await loginAs(e.users.alice);
    expect(await client.call<{ id: string }>(e.users.alice.id, 'GET', '/users/me')).toMatchObject({ id: e.users.alice.id });
    expect((await mmDeauthorize(cookie, e.oauth.clientId)).status).toBe(200);
    await expect(client.call(e.users.alice.id, 'GET', '/users/me')).rejects.toBeInstanceOf(Reauthorize);
    expect(store.verifyAccess(pair.accessToken)).toBeUndefined();
    expect(store.getMmCred(e.users.alice.id)).toBeUndefined();
  });

  test('deactivated user leads to Reauthorize and revoked grants', async () => {
    const name = `tmp${Date.now().toString(36)}`;
    const created = await adminApi('POST', '/users', { username: name, email: `${name}@example.com`, password: e.users.alice.password });
    expect(created.status).toBe(201);
    const user: Cred = { id: (await created.json()).id, username: name, password: e.users.alice.password };
    const { pair } = await loginAs(user);
    expect((await adminApi('DELETE', `/users/${user.id}`)).status).toBe(200);
    await expect(client.call(user.id, 'GET', '/users/me')).rejects.toBeInstanceOf(Reauthorize);
    expect(store.verifyAccess(pair.accessToken)).toBeUndefined();
    expect(store.getMmCred(user.id)).toBeUndefined();
  });

  test('expired Mattermost access token is refreshed transparently', async () => {
    // Revoking the session would also delete OAuthAccessData (the refresh token), so the session is expired in the DB instead.
    const { pair } = await loginAs(e.users.alice);
    const before = store.getMmCred(e.users.alice.id)!;
    expect(psql(`UPDATE sessions SET expiresat = 1 WHERE token = '${before.access}'`)).toBe('UPDATE 1');
    expect((await adminApi('POST', '/caches/invalidate')).status).toBe(200);
    expect(await client.call<{ id: string }>(e.users.alice.id, 'GET', '/users/me')).toMatchObject({ id: e.users.alice.id });
    const after = store.getMmCred(e.users.alice.id)!;
    expect(after.access).not.toBe(before.access);
    expect(after.refresh).not.toBe(before.refresh);
    expect(store.verifyAccess(pair.accessToken)?.mmUserId).toBe(e.users.alice.id);
  });
});

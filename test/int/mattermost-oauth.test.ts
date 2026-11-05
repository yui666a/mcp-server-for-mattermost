import { beforeEach, describe, expect, test } from 'vitest';
import { mmAuthorizeCode, requireMm, mmDeauthorize, mmLoginCookie, withUsers, type Cred } from './helpers.ts';

const e = await requireMm();

const form = (o: Record<string, string>) => new URLSearchParams(o);
const tokenReq = (o: Record<string, string>) =>
  fetch(`${e.mmUrl}/oauth/access_token`, { method: 'POST', body: form({ client_id: e.oauth.clientId, client_secret: e.oauth.clientSecret, ...o }) });
const authParams = { response_type: 'code', client_id: '', redirect_uri: '', state: 'st' };

type Pair = { access_token: string; refresh_token: string };
async function exchange(cookie: string): Promise<Pair> {
  const code = await mmAuthorizeCode(cookie, { ...authParams, client_id: e.oauth.clientId, redirect_uri: e.oauth.callback });
  const res = await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: e.oauth.callback });
  expect(res.status).toBe(200);
  return res.json();
}
const refreshRaw = (refresh_token: string) => tokenReq({ grant_type: 'refresh_token', refresh_token });
const me = (token: string) => fetch(`${e.mmUrl}/api/v4/users/me`, { headers: { authorization: `Bearer ${token}` } });

async function createPost(token: string, body: Record<string, string>) {
  const res = await fetch(`${e.mmUrl}/api/v4/posts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string }>;
}

async function adminApi(method: string, path: string, body?: unknown) {
  return fetch(`${e.mmUrl}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${e.adminToken}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Mattermost OAuth behavior the MCP server relies on', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(cookie, e.oauth.clientId);
  });

  test('re-authorizing the same user and app returns the same token pair', async () => {
    const t1 = await exchange(cookie);
    const t2 = await exchange(cookie);
    expect(t2.access_token).toBe(t1.access_token);
    expect(t2.refresh_token).toBe(t1.refresh_token);
  });

  test('refresh issues a new access token and rotates the refresh token', async () => {
    const t1 = await exchange(cookie);
    expect((await me(t1.access_token)).status).toBe(200);
    const res = await refreshRaw(t1.refresh_token);
    expect(res.status).toBe(200);
    const r: Pair = await res.json();
    expect(r.refresh_token).not.toBe(t1.refresh_token);
    expect(r.access_token).not.toBe(t1.access_token);
    expect((await me(r.access_token)).status).toBe(200);
  });

  test('refresh with a used refresh token fails with a 4xx', async () => {
    const t1 = await exchange(cookie);
    expect((await refreshRaw(t1.refresh_token)).status).toBe(200);
    expect((await refreshRaw(t1.refresh_token)).status).toBeGreaterThanOrEqual(400);
  });

  test('refresh after the user deauthorizes the app fails', async () => {
    const t1 = await exchange(cookie);
    expect((await mmDeauthorize(cookie, e.oauth.clientId)).status).toBe(200);
    const res = await refreshRaw(t1.refresh_token);
    const body = await res.json();
    expect({ status: res.status, id: body.id }).toEqual({ status: 404, id: 'api.oauth.get_access_token.refresh_token.app_error' });
    expect((await me(t1.access_token)).status).toBe(401);
  });

  // In withUsers though the test deactivates the user itself: a failure before that would leave an active user on the shared Mattermost.
  test('refresh after the user is deactivated fails', () => withUsers(async (made) => {
    const name = `tmp${Date.now().toString(36)}`;
    const cred: Cred = { id: '', username: name, password: e.users.alice.password };
    const created = await adminApi('POST', '/users', { username: name, email: `${name}@example.com`, password: cred.password });
    expect(created.status).toBe(201);
    cred.id = (await created.json()).id;
    made.push(cred.id);
    const t = await exchange(await mmLoginCookie(cred));
    expect((await adminApi('DELETE', `/users/${cred.id}`)).status).toBe(200);
    const res = await refreshRaw(t.refresh_token);
    const body = await res.json();
    expect({ status: res.status, id: body.id }).toEqual({ status: 404, id: 'api.oauth.get_access_token.refresh_token.app_error' });
  }));

  test('same pending_post_id within 30s yields one post', async () => {
    const t = await exchange(cookie);
    const pending_post_id = `${e.users.alice.id}:${Date.now()}`;
    const body = { channel_id: e.teams.a.dupChannelId, message: 'dedup probe', pending_post_id };
    const a = await createPost(t.access_token, body);
    const b = await createPost(t.access_token, body);
    expect(b.id).toBe(a.id);
  });
});

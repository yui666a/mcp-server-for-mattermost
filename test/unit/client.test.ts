import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { MmClient, MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../../src/mattermost/client.ts';
import { Limiter } from '../../src/mattermost/limiter.ts';
import { Store } from '../../src/store.ts';

const cfg = loadConfig({
  PUBLIC_URL: 'https://mm.example', TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
  MM_OAUTH_CLIENT_ID: 'mm-client', MM_OAUTH_CLIENT_SECRET: 'SECRET-XYZ', MM_URL: 'http://mm.internal',
});
const limits = { perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 120, globalPerMin: 600 } as const;
const mmError = (status: number, id: string) => Response.json({ id, message: `msg ${id}`, status_code: status }, { status });
const RELOGIN = () => mmError(404, 'api.oauth.get_access_token.refresh_token.app_error');
const logged = () => vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');

type Api = (access: string, req: Request) => Response | Promise<Response>;
type Refresh = (refresh: string) => Response | Promise<Response>;

let store: Store;
let limiter: Limiter;
let api: Api;
let refresh: Refresh;
let apiCalls: { access: string; req: Request }[];
let refreshCalls: string[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let client: MmClient;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  store = new Store(openDb(':memory:'), cfg.encKey, Date.now, 3600);
  limiter = new Limiter(limits, Date.now);
  apiCalls = [];
  refreshCalls = [];
  api = () => Response.json({ ok: true });
  refresh = () => Response.json({ access_token: 'a2', refresh_token: 'r2' });
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === 'http://mm.internal/oauth/access_token') {
      const r = new URLSearchParams(await req.text()).get('refresh_token')!;
      refreshCalls.push(r);
      await new Promise((ok) => setTimeout(ok, 5));
      return refresh(r);
    }
    const access = req.headers.get('authorization')!.replace(/^Bearer /, '');
    apiCalls.push({ access, req });
    return api(access, req);
  });
  client = new MmClient(cfg, store, limiter, { fetch: fetchMock, now: Date.now });
});
afterEach(() => vi.restoreAllMocks());

function grant(mmUserId = 'u1') {
  const code = store.createCode({ mmUserId, clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: 'r', scope: 'mattermost' });
  const rec = store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  return store.createGrant({ mmUserId, clientId: 'c1', scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
}
const only = (valid: string[]): Api => (access) => (valid.includes(access) ? Response.json({ ok: access }) : mmError(401, 'api.context.session_expired.app_error'));
const cred = () => store.getMmCred('u1');
const failure = (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected a rejection'); }, (x) => x);

test('sends a JSON request with the bearer token to MM_URL/api/v4 without following redirects', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  expect(await client.call('u1', 'POST', '/posts?x=SECRET-Q', { message: 'BODY-TEXT' })).toEqual({ ok: true });
  const { access, req } = apiCalls[0];
  expect(access).toBe('a1');
  expect(req.url).toBe('http://mm.internal/api/v4/posts?x=SECRET-Q');
  expect(req.method).toBe('POST');
  expect(req.headers.get('content-type')).toBe('application/json');
  expect(await req.json()).toEqual({ message: 'BODY-TEXT' });
  const init = fetchMock.mock.calls[0][1]!;
  expect(init.redirect).toBe('manual');
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(logged()).toContain('"mm_user_id":"u1"');
  expect(logged()).not.toMatch(/SECRET|BODY-TEXT|a1"/);
});

test('shared credential survives refresh by another grant', async () => {
  grant();
  grant();
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['a2']);
  const results = await Promise.all([client.call('u1', 'GET', '/users/me'), client.call('u1', 'GET', '/users/me')]);
  expect(results).toEqual([{ ok: 'a2' }, { ok: 'a2' }]);
  expect(refreshCalls).toEqual(['r1']);
  expect(cred()).toMatchObject({ access: 'a2', refresh: 'r2' });
});

test('reloads newer credential before refreshing', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = (access) => {
    if (access === 'a1') {
      store.putMmCred('u1', 'a3', 'r3');
      return mmError(401, 'x');
    }
    return Response.json({ ok: access });
  };
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'a3' });
  expect(refreshCalls).toEqual([]);
  expect(apiCalls.map((c) => c.access)).toEqual(['a1', 'a3']);
});

test('after a refresh loses the save race, the refreshed token is tried and kept if it works', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['a2']);
  refresh = () => {
    store.putMmCred('u1', 'aC', 'rC');
    return Response.json({ access_token: 'a2', refresh_token: 'r2' });
  };
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'a2' });
  expect(cred()).toMatchObject({ access: 'a2', refresh: 'r2' });
});

test('after a refresh loses the save race and the refreshed token fails, the stored token is used', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['aC']);
  refresh = () => {
    store.putMmCred('u1', 'aC', 'rC');
    return Response.json({ access_token: 'a2', refresh_token: 'r2' });
  };
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'aC' });
  expect(apiCalls.map((c) => c.access)).toEqual(['a1', 'a2', 'aC']);
  expect(cred()).toMatchObject({ access: 'aC', refresh: 'rC' });
});

test('transient upstream failure keeps grants', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  const before = cred();
  const failures: [Api, boolean][] = [
    [() => mmError(503, 'x'), true],
    [() => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); }, false],
    [() => { throw new DOMException('timed out', 'TimeoutError'); }, true],
    [() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), true],
  ];
  for (const [f, sent] of failures) {
    api = f;
    const e = await failure(client.call('u1', 'GET', '/users/me'));
    expect(e).toBeInstanceOf(UpstreamUnavailable);
    expect(e.sent).toBe(sent);
  }
  api = only([]);
  refresh = () => mmError(503, 'x');
  await expect(client.call('u1', 'GET', '/users/me')).rejects.toBeInstanceOf(UpstreamUnavailable);
  expect(cred()).toEqual(before);
  expect(store.verifyAccess(pair.accessToken)?.mmUserId).toBe('u1');
});

test('revoked app forces relogin', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  api = only([]);
  refresh = RELOGIN;
  const e = await failure(client.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(Reauthorize);
  expect(e.sent).toBe(true);
  expect(store.verifyAccess(pair.accessToken)).toBeUndefined();
  expect(cred()).toBeUndefined();
});

test('401 after a successful refresh also forces relogin', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  api = only([]);
  await expect(client.call('u1', 'GET', '/users/me')).rejects.toBeInstanceOf(Reauthorize);
  expect(store.verifyAccess(pair.accessToken)).toBeUndefined();
  expect(cred()).toBeUndefined();
});

test('a user without stored Mattermost credentials must log in again before anything is sent', async () => {
  const e = await failure(client.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(Reauthorize);
  expect(e.sent).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('other 4xx on refresh (bad client secret) keeps grants and credentials', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  const before = cred();
  api = only([]);
  refresh = () => mmError(401, 'model.oauth.validate_grant.credentials.app_error');
  await expect(client.call('u1', 'GET', '/users/me')).rejects.toBeInstanceOf(UpstreamUnavailable);
  expect(cred()).toEqual(before);
  expect(store.verifyAccess(pair.accessToken)?.mmUserId).toBe('u1');
});

test('429 is not retried', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => new Response('{}', { status: 429, headers: { 'X-RateLimit-Reset': '7' } });
  const e = await failure(client.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(RateLimited);
  expect(e.retryAfterSec).toBe(7);
  expect(e.sent).toBe(true);
  expect(apiCalls).toHaveLength(1);
  api = () => new Response('{}', { status: 429, headers: { 'Retry-After': '3' } });
  expect((await failure(client.call('u1', 'GET', '/users/me'))).retryAfterSec).toBe(3);
});

test('other 4xx is an MmError carrying the Mattermost id and message', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => mmError(403, 'api.context.permissions.app_error');
  const e = await failure(client.call('u1', 'GET', '/channels/c1'));
  expect(e).toBeInstanceOf(MmError);
  expect(e).toMatchObject({ status: 403, id: 'api.context.permissions.app_error', message: 'msg api.context.permissions.app_error', sent: true });
});

test('each call takes one limiter slot for its whole duration and is rejected unsent beyond the limit', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  const acquire = vi.spyOn(limiter, 'acquire');
  let open!: () => void;
  const gate = new Promise<void>((ok) => { open = ok; });
  api = async () => { await gate; return Response.json({ ok: true }); };
  const running = [1, 2, 3, 4].map(() => client.call('u1', 'GET', '/users/me'));
  const e = await failure(client.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(RateLimited);
  expect(e.sent).toBe(false);
  open();
  await Promise.all(running);
  expect(acquire).toHaveBeenCalledTimes(5);
  api = only(['a2']);
  await client.call('u1', 'GET', '/users/me');
  expect(acquire).toHaveBeenCalledTimes(6);
});

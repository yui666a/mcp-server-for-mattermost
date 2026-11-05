import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { CALL_DEADLINE_MS, MmClient, MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../../src/mattermost/client.ts';
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

test('logged paths keep IDs but not channel, team or user names', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  await client.call('u1', 'GET', '/teams/name/secret-team/channels/name/secret-channel');
  await client.call('u1', 'GET', '/users/username/secret-user');
  await client.call('u1', 'GET', '/teams/abcdefghijklmnopqrstuvwxyz/channels/name/secret-dm');
  await client.call('u1', 'GET', '/channels/abcdefghijklmnopqrstuvwxyz/posts?since=1');
  expect(logged()).not.toContain('secret');
  expect(logged()).toContain('"path":"/teams/name/:name/channels/name/:name"');
  expect(logged()).toContain('"path":"/users/username/:name"');
  expect(logged()).toContain('"path":"/teams/abcdefghijklmnopqrstuvwxyz/channels/name/:name"');
  expect(logged()).toContain('"path":"/channels/abcdefghijklmnopqrstuvwxyz/posts"');
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
  const afterRefresh = await failure(client.call('u1', 'GET', '/users/me'));
  expect(afterRefresh).toBeInstanceOf(UpstreamUnavailable);
  expect(afterRefresh.sent).toBe(false);
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
  expect(e.sent).toBe(false);
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

test('credentials sealed under another TOKEN_ENC_KEY force relogin before anything is sent', async () => {
  const db = openDb(':memory:');
  new Store(db, randomBytes(32), Date.now, 3600).putMmCred('u1', 'a1', 'r1');
  store = new Store(db, cfg.encKey, Date.now, 3600);
  client = new MmClient(cfg, store, limiter, { fetch: fetchMock, now: Date.now });
  const pair = grant();
  const e = await failure(client.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(Reauthorize);
  expect(e.sent).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(store.verifyAccess(pair.accessToken)).toBeUndefined();
  expect(db.prepare('SELECT count(*) AS n FROM mm_creds').get()).toEqual({ n: 0 });
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

test('501 is an MmError carrying the Mattermost id, since a disabled feature does not pass on retry', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => mmError(501, 'api.drafts.disabled.app_error');
  const e = await failure(client.call('u1', 'POST', '/drafts', {}));
  expect(e).toBeInstanceOf(MmError);
  expect(e).toMatchObject({ status: 501, id: 'api.drafts.disabled.app_error', sent: true });
});

test.each([500, 502, 503, 504])('%i stays UpstreamUnavailable', async (status) => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => mmError(status, 'x');
  expect(await failure(client.call('u1', 'GET', '/users/me'))).toBeInstanceOf(UpstreamUnavailable);
});

test('a 5xx UpstreamUnavailable carries its status, and the Mattermost id only for a 500 with a JSON error', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => mmError(500, 'app.file_info.get.app_error');
  expect(await failure(client.callBytes('u1', '/files/f'))).toMatchObject({ status: 500, id: 'app.file_info.get.app_error', sent: true });
  api = () => new Response("seeker can't seek\n", { status: 500, headers: { 'content-type': 'text/plain' } });
  const plain = await failure(client.callBytes('u1', '/files/f', undefined, { maxBytes: 10 }));
  expect(plain).toBeInstanceOf(UpstreamUnavailable);
  expect(plain).toMatchObject({ status: 500, id: undefined, sent: true });
  for (const status of [502, 503, 504]) {
    api = () => mmError(status, 'x');
    expect(await failure(client.call('u1', 'GET', '/users/me'))).toMatchObject({ status, id: undefined, sent: true });
  }
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

test('a 401 → refresh → retry call counts three Mattermost requests in the rate window', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['a2']);
  const tight = new Limiter({ ...limits, perUserPerMin: 3 }, Date.now);
  const c = new MmClient(cfg, store, tight, { fetch: fetchMock, now: Date.now });
  await c.call('u1', 'GET', '/users/me');
  const e = await failure(c.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(RateLimited);
  expect(e.sent).toBe(false);
});

test('a call that has used up its deadline does not start the refresh', async () => {
  let t = 1_000;
  const c = new MmClient(cfg, store, limiter, { fetch: fetchMock, now: () => t });
  store.putMmCred('u1', 'a1', 'r1');
  api = () => { t += CALL_DEADLINE_MS; return mmError(401, 'x'); };
  const e = await failure(c.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(UpstreamUnavailable);
  expect(e.sent).toBe(false);
  expect(refreshCalls).toEqual([]);
  expect(CALL_DEADLINE_MS).toBe(25_000);
});

test('requests after the first only get the remaining part of the call deadline', async () => {
  let t = 1_000;
  const c = new MmClient(cfg, store, limiter, { fetch: fetchMock, now: () => t });
  store.putMmCred('u1', 'a1', 'r1');
  api = (access, req) => {
    if (access === 'a1') { t += CALL_DEADLINE_MS - 100; return mmError(401, 'x'); }
    return new Promise((_, fail) => req.signal.addEventListener('abort', () => fail(req.signal.reason)));
  };
  const started = Date.now();
  const e = await failure(c.call('u1', 'GET', '/users/me'));
  expect(e).toBeInstanceOf(UpstreamUnavailable);
  expect(e.sent).toBe(true);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(cred()).toMatchObject({ access: 'a2' });
});

test('invalid_grant does not revoke when a concurrent login stored new credentials', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['aN']);
  refresh = () => { store.putMmCred('u1', 'aN', 'rN'); return RELOGIN(); };
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'aN' });
  expect(cred()).toMatchObject({ access: 'aN', refresh: 'rN' });
  expect(store.verifyAccess(pair.accessToken)?.mmUserId).toBe('u1');
});

test('401 after the retry does not revoke when a concurrent login stored new credentials', async () => {
  const pair = grant();
  store.putMmCred('u1', 'a1', 'r1');
  api = (access) => {
    if (access === 'a2') store.putMmCred('u1', 'aN', 'rN');
    return access === 'aN' ? Response.json({ ok: access }) : mmError(401, 'x');
  };
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'aN' });
  expect(cred()).toMatchObject({ access: 'aN' });
  expect(store.verifyAccess(pair.accessToken)?.mmUserId).toBe('u1');
});

test('after a lost save, an inconclusive check of the refreshed token keeps the stored credential', async () => {
  const outcomes: Api[] = [
    () => mmError(503, 'x'),
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
  ];
  for (const check of outcomes) {
    store.putMmCred('u1', 'a1', 'r1');
    refresh = () => { store.putMmCred('u1', 'aC', 'rC'); return Response.json({ access_token: 'a2', refresh_token: 'r2' }); };
    api = (access, req) => (access === 'a2' ? check(access, req) : only(['aC'])(access, req));
    expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: 'aC' });
    expect(cred()).toMatchObject({ access: 'aC', refresh: 'rC' });
  }
});

test('a relogin after any response other than 401 counts the call as sent, since that request may have been handled', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  refresh = () => { store.putMmCred('u1', 'aC', 'rC'); return Response.json({ access_token: 'a2', refresh_token: 'r2' }); };
  api = (access) => (access === 'a2' ? mmError(503, 'x') : mmError(401, 'api.context.session_expired.app_error'));
  const e = await failure(client.call('u1', 'POST', '/posts', { message: 'm' }));
  expect(e).toBeInstanceOf(Reauthorize);
  expect(e.sent).toBe(true);
  expect(apiCalls.map((c) => c.access)).toEqual(['a1', 'a2', 'aC']);
});

test('after a lost save, an authenticated 4xx proves the refreshed token and it is kept', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  refresh = () => { store.putMmCred('u1', 'aC', 'rC'); return Response.json({ access_token: 'a2', refresh_token: 'r2' }); };
  api = (access) => (access === 'a2' ? mmError(403, 'api.context.permissions.app_error') : mmError(401, 'x'));
  expect(await failure(client.call('u1', 'GET', '/users/me'))).toBeInstanceOf(MmError);
  expect(cred()).toMatchObject({ access: 'a2', refresh: 'r2' });
});

test('response bodies of redirects, 429 and 5xx are released', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  for (const [status, headers] of [[302, { location: 'https://x.example/' }], [429, {}], [503, {}]] as const) {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    api = () => new Response(body, { status, headers });
    await failure(client.call('u1', 'GET', '/users/me'));
    expect(cancelled).toBe(true);
  }
});

test('retryAfterSec from Mattermost is capped at one hour', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => new Response('{}', { status: 429, headers: { 'X-RateLimit-Reset': '99999' } });
  expect((await failure(client.call('u1', 'GET', '/users/me'))).retryAfterSec).toBe(3600);
});

test('aborting the caller signal ends the call and frees its limiter slot', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = (_access, req) => new Promise((_, fail) => req.signal.addEventListener('abort', () => fail(req.signal.reason)));
  const ac = new AbortController();
  const running = [1, 2, 3, 4].map(() => failure(client.call('u1', 'GET', '/users/me', undefined, ac.signal)));
  expect(await failure(client.call('u1', 'GET', '/users/me'))).toBeInstanceOf(RateLimited);
  ac.abort();
  for (const e of await Promise.all(running)) expect(e).toBeInstanceOf(UpstreamUnavailable);
  api = () => Response.json({ ok: true });
  expect(await client.call('u1', 'GET', '/users/me')).toEqual({ ok: true });
});

test('aborting while waiting on the shared refresh frees the slot at once and the refresh still completes', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = only(['a2']);
  let open!: () => void;
  const gate = new Promise<void>((ok) => { open = ok; });
  refresh = async () => { await gate; return Response.json({ access_token: 'a2', refresh_token: 'r2' }); };
  const ac = new AbortController();
  const running = [1, 2, 3, 4].map(() => failure(client.call('u1', 'GET', '/users/me', undefined, ac.signal)));
  await vi.waitFor(() => expect(refreshCalls).toEqual(['r1']));
  ac.abort();
  for (const e of await Promise.all(running)) expect(e).toBeInstanceOf(UpstreamUnavailable);
  for (let i = 0; i < 4; i++) limiter.acquire('u1')();
  open();
  await vi.waitFor(() => expect(cred()?.access).toBe('a2'));
});

test('callBytes returns the response body as bytes, after a 401 → refresh → retry, within one limiter slot', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  const acquire = vi.spyOn(limiter, 'acquire');
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
  api = (access) => (access === 'a2'
    ? new Response(png, { headers: { 'content-type': 'image/jpeg' } })
    : mmError(401, 'api.context.session_expired.app_error'));
  expect(await client.callBytes('u1', '/files/f1/preview')).toEqual(png);
  expect(refreshCalls).toEqual(['r1']);
  expect(apiCalls.map((c) => [c.access, c.req.method, c.req.url])).toEqual([
    ['a1', 'GET', 'http://mm.internal/api/v4/files/f1/preview'],
    ['a2', 'GET', 'http://mm.internal/api/v4/files/f1/preview'],
  ]);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(cred()).toMatchObject({ access: 'a2', refresh: 'r2' });
});

test('callBytes without maxBytes sends no Range header', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => new Response(Uint8Array.from([1, 2, 3]));
  await client.callBytes('u1', '/files/f1/preview');
  expect(apiCalls[0].req.headers.get('range')).toBeNull();
});

test('callBytes with maxBytes asks for that many bytes with a Range header, also on the resend after a 401 → refresh', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = (access) => (access === 'a2'
    ? new Response(Uint8Array.from([1, 2, 3]), { status: 206 })
    : mmError(401, 'api.context.session_expired.app_error'));
  expect(await client.callBytes('u1', '/files/f1', undefined, { maxBytes: 40_000 })).toEqual(Uint8Array.from([1, 2, 3]));
  expect(apiCalls.map((c) => [c.access, c.req.headers.get('range')])).toEqual([['a1', 'bytes=0-39999'], ['a2', 'bytes=0-39999']]);
});

test('callBytes with maxBytes stops reading at that many bytes when Mattermost ignores the Range and sends an endless body', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  const cancel = vi.fn();
  api = () => new Response(new ReadableStream({
    pull: (c) => c.enqueue(new Uint8Array(7).fill(0x61)),
    cancel,
  }));
  const b = await client.callBytes('u1', '/files/f1', undefined, { maxBytes: 20 });
  expect(b).toEqual(new Uint8Array(20).fill(0x61));
  expect(cancel).toHaveBeenCalled();
});

test('callBytes with maxBytes returns the bytes up to the limit even if the body fails right after them', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  let n = 0;
  api = () => new Response(new ReadableStream({
    pull: (c) => (n++ === 0 ? c.enqueue(Uint8Array.from([1, 2, 3, 4])) : c.error(new Error('reset'))),
  }));
  expect(await client.callBytes('u1', '/files/f1', undefined, { maxBytes: 4 })).toEqual(Uint8Array.from([1, 2, 3, 4]));
});

test('callBytes with maxBytes turns a body that fails midway into UpstreamUnavailable', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  let n = 0;
  api = () => new Response(new ReadableStream({
    pull: (c) => (n++ === 0 ? c.enqueue(Uint8Array.from([1, 2])) : c.error(new Error('reset'))),
  }));
  const e = await failure(client.callBytes('u1', '/files/f1', undefined, { maxBytes: 100 }));
  expect(e).toBeInstanceOf(UpstreamUnavailable);
  expect(e).toMatchObject({ sent: true });
});

test('callBytes reads the id of a 4xx JSON error into an MmError', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  api = () => mmError(400, 'api.file.get_file_preview.no_preview.app_error');
  const e = await failure(client.callBytes('u1', '/files/f1/preview'));
  expect(e).toBeInstanceOf(MmError);
  expect(e).toMatchObject({ status: 400, id: 'api.file.get_file_preview.no_preview.app_error', sent: true });
});

test('call sends a Blob body as its bytes with the Blob\'s type, and sends the same bytes again after a 401 → refresh', async () => {
  store.putMmCred('u1', 'a1', 'r1');
  const bytes = Uint8Array.from([0, 1, 2, 0xff, 0x7b]);
  const seen: { type: string | null; bytes: Uint8Array }[] = [];
  api = async (access, req) => {
    seen.push({ type: req.headers.get('content-type'), bytes: new Uint8Array(await req.arrayBuffer()) });
    return access === 'a2' ? Response.json({ file_infos: [{ id: 'f1' }] }, { status: 201 }) : mmError(401, 'api.context.session_expired.app_error');
  };
  const r = await client.call('u1', 'POST', '/files?channel_id=c1&filename=a.bin', new Blob([bytes], { type: 'application/octet-stream' }));
  expect(r).toEqual({ file_infos: [{ id: 'f1' }] });
  expect(refreshCalls).toEqual(['r1']);
  expect(apiCalls.map((c) => [c.access, c.req.method, c.req.url])).toEqual([
    ['a1', 'POST', 'http://mm.internal/api/v4/files?channel_id=c1&filename=a.bin'],
    ['a2', 'POST', 'http://mm.internal/api/v4/files?channel_id=c1&filename=a.bin'],
  ]);
  expect(seen).toEqual([{ type: 'application/octet-stream', bytes }, { type: 'application/octet-stream', bytes }]);
});

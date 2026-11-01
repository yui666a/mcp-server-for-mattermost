import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const LOOP = 'http://127.0.0.1:1234/cb';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ENV = { MM_URL: 'http://mm.internal', MM_BROWSER_URL: 'http://mm.example' };
const ISS = 'https://mm.example/mcp';

type Over = Record<string, string | undefined>;

function mmFetch(over: { token?: () => Response; me?: () => Response } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === 'http://mm.internal/oauth/access_token') return over.token?.() ?? Response.json({ access_token: 'mm-a', refresh_token: 'mm-r' });
    if (url === 'http://mm.internal/api/v4/users/me') return over.me?.() ?? Response.json({ id: 'u1' });
    throw new Error(`unexpected fetch ${url}`);
  });
}

function setup(redirectUris = [CLAUDE], f = mmFetch()) {
  const ctx = makeApp(ENV, f);
  const client = ctx.store.createClient({ clientName: 'Claude', redirectUris });
  return { ...ctx, client, f };
}

function authorizePath(clientId: string, over: Over = {}) {
  const q: Over = {
    response_type: 'code', client_id: clientId, redirect_uri: CLAUDE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', state: 'client-state', resource: ISS, scope: 'mattermost', ...over,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, v);
  return `/mcp/oauth/authorize?${p}`;
}

const cookieOf = (r: { headers: Record<string, any> }) => (r.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)![1];

async function startConsent(s: ReturnType<typeof setup>, over: Over = {}) {
  const r = await s.req.get(authorizePath(s.client.clientId, over));
  expect(r.status).toBe(200);
  return { cookie: cookieOf(r), sessionId: field(r.text, 'session_id'), csrf: field(r.text, 'csrf') };
}

function postConsent(s: ReturnType<typeof setup>, c: { cookie: string; sessionId: string; csrf: string }, decision = 'approve') {
  return s.req.post('/mcp/oauth/consent').set('Cookie', c.cookie).type('form')
    .send({ session_id: c.sessionId, csrf: c.csrf, decision });
}

async function approved(s: ReturnType<typeof setup>, over: Over = {}) {
  const c = await startConsent(s, over);
  const r = await postConsent(s, c);
  expect(r.status).toBe(303);
  const mm = new URL(r.headers.location);
  return { ...c, upstreamState: mm.searchParams.get('state')!, upstreamChallenge: mm.searchParams.get('code_challenge')! };
}

const params = (location: string) => Object.fromEntries(new URL(location).searchParams);

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => vi.restoreAllMocks());

test('unknown client_id or unregistered redirect_uri shows error page, never redirects', async () => {
  const s = setup([CLAUDE, LOOP]);
  const paths = [
    authorizePath('nope'),
    authorizePath(s.client.clientId, { redirect_uri: 'https://claude.com/api/mcp/auth_callback' }),
    authorizePath(s.client.clientId, { redirect_uri: undefined }),
    authorizePath(s.client.clientId, { redirect_uri: 'http://127.0.0.1:1234/other' }),
    authorizePath(s.client.clientId, { client_id: undefined }),
    `/mcp/oauth/authorize?client_id=${s.client.clientId}&redirect_uri=${encodeURIComponent(CLAUDE)}&redirect_uri=${encodeURIComponent(CLAUDE)}`,
  ];
  for (const p of paths) {
    const r = await s.req.get(p);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toContain("form-action 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  }
  expect(s.f).not.toHaveBeenCalled();
});

test('a loopback redirect_uri with an out-of-range port shows the error page and never throws', async () => {
  const s = setup([LOOP]);
  for (const port of ['0', '65536', '99999']) {
    const r = await s.req.get(authorizePath(s.client.clientId, { redirect_uri: `http://127.0.0.1:${port}/cb` }));
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.text).not.toContain('server_error');
  }
});

test('missing/plain PKCE, missing resource, wrong resource, unknown scope redirect back with error and the original state', async () => {
  const s = setup();
  const cases: [Over, string][] = [
    [{ code_challenge: undefined }, 'invalid_request'],
    [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: undefined }, 'invalid_request'],
    [{ code_challenge: 'short' }, 'invalid_request'],
    [{ resource: undefined }, 'invalid_target'],
    [{ resource: `${ISS}/` }, 'invalid_target'],
    [{ scope: 'mattermost admin' }, 'invalid_scope'],
    [{ response_type: 'token' }, 'unsupported_response_type'],
  ];
  for (const [over, error] of cases) {
    const r = await s.req.get(authorizePath(s.client.clientId, over));
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.origin + loc.pathname).toBe(CLAUDE);
    expect(params(r.headers.location)).toMatchObject({ error, state: 'client-state', iss: ISS });
    expect(typeof params(r.headers.location).error_description).toBe('string');
    expect(r.headers['set-cookie']).toBeUndefined();
  }
  const noState = await s.req.get(authorizePath(s.client.clientId, { state: undefined, resource: undefined }));
  expect(params(noState.headers.location)).not.toHaveProperty('state');
});

test('scope omitted is treated as mattermost', async () => {
  const s = setup();
  const a = await approved(s, { scope: undefined });
  const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  const code = params(r.headers.location).code;
  expect(s.store.consumeCode(code)).toMatchObject({ scope: 'mattermost' });
});

test('consent page is shown before any upstream redirect and sets __Host- cookie', async () => {
  const s = setup();
  const r = await s.req.get(authorizePath(s.client.clientId));
  expect(r.status).toBe(200);
  expect(r.headers.location).toBeUndefined();
  expect(s.f).not.toHaveBeenCalled();
  const sessionId = field(r.text, 'session_id');
  const set = (r.headers['set-cookie'] as unknown as string[]);
  expect(set).toHaveLength(1);
  const attrs = set[0].split(';').map((x) => x.trim());
  expect(attrs[0]).toMatch(new RegExp(`^__Host-mcp_authz_${sessionId}=[A-Za-z0-9_-]{20,}$`));
  expect(attrs.slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=600', 'Path=/', 'SameSite=Lax', 'Secure']);
  expect(r.text).toContain(CLAUDE);
  expect(r.headers['cache-control']).toBe('no-store');
});

test('consent CSP allows form-action to Mattermost and the client redirect origin only', async () => {
  const s = setup([CLAUDE, LOOP]);
  const csp = async (over: Over) => (await s.req.get(authorizePath(s.client.clientId, over))).headers['content-security-policy'];
  const claude = await csp({});
  expect(claude).toContain("form-action 'self' http://mm.example https://claude.ai;");
  const loop = await csp({ redirect_uri: 'http://127.0.0.1:5555/cb' });
  expect(loop).toContain("form-action 'self' http://mm.example http://127.0.0.1:*;");
  for (const c of [claude, loop]) {
    expect(c).toContain("default-src 'none'");
    expect(c).toContain("frame-ancestors 'none'");
    expect(c).toContain("style-src 'self'");
    expect(c).toContain("base-uri 'none'");
  }
});

test('consent.css is served as CSS', async () => {
  const r = await setup().req.get('/mcp/oauth/consent.css');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toMatch(/^text\/css/);
});

test('two concurrent authorizations in one browser do not clobber each other', async () => {
  const s = setup();
  const a = await startConsent(s, { state: 'A' });
  const b = await startConsent(s, { state: 'B' });
  expect(a.cookie.split('=')[0]).not.toBe(b.cookie.split('=')[0]);
  const both = `${a.cookie}; ${b.cookie}`;
  const ra = await postConsent(s, { ...a, cookie: both });
  const rb = await postConsent(s, { ...b, cookie: both });
  expect([ra.status, rb.status]).toEqual([303, 303]);
  const sa = params(ra.headers.location).state;
  const sb = params(rb.headers.location).state;
  const cb = await s.req.get(`/mcp/oauth/callback?code=x&state=${sb}`).set('Cookie', both);
  const ca = await s.req.get(`/mcp/oauth/callback?code=x&state=${sa}`).set('Cookie', both);
  expect(params(cb.headers.location).state).toBe('B');
  expect(params(ca.headers.location).state).toBe('A');
});

test('consent POST without matching csrf or cookie is rejected', async () => {
  const s = setup();
  const c = await startConsent(s);
  const other = await startConsent(s);
  const bad = [
    { ...c, csrf: 'wrong' },
    { ...c, cookie: '' },
    { ...c, cookie: `${c.cookie.split('=')[0]}=wrong` },
    { ...c, cookie: other.cookie },
    { ...c, csrf: other.csrf },
  ];
  for (const b of bad) {
    for (const decision of ['approve', 'deny']) {
      const r = await postConsent(s, b, decision);
      expect(r.status).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(r.headers['content-security-policy']).toContain("form-action 'none'");
    }
  }
  expect((await postConsent(s, c)).status).toBe(303);
});

test('consent POST with a malformed or oversized body is a 4xx, not a 500', async () => {
  const s = setup();
  const r1 = await s.req.post('/mcp/oauth/consent').type('form').send('session_id=x');
  expect(r1.status).toBe(400);
  const r2 = await s.req.post('/mcp/oauth/consent').type('form').send(`session_id=${'a'.repeat(20000)}`);
  expect(r2.status).toBe(413);
});

test('consent POST redirects to Mattermost with its own state and S256 challenge', async () => {
  const s = setup();
  const c = await startConsent(s);
  const r = await postConsent(s, c);
  expect(r.status).toBe(303);
  const u = new URL(r.headers.location);
  expect(u.origin + u.pathname).toBe('http://mm.example/oauth/authorize');
  const p = params(r.headers.location);
  expect(p).toMatchObject({ response_type: 'code', client_id: 'id', redirect_uri: 'https://mm.example/mcp/oauth/callback', code_challenge_method: 'S256' });
  expect(p.state).not.toBe('client-state');
  expect(p.state.length).toBeGreaterThanOrEqual(32);
  expect(p.code_challenge).not.toBe(CHALLENGE);
  expect(p.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(s.f).not.toHaveBeenCalled();
});

test('callback with mismatched state or cookie is rejected and the session cannot be reused', async () => {
  const s = setup();
  const a = await approved(s);
  const cb = (state: string, cookie: string) => s.req.get(`/mcp/oauth/callback?code=mmcode&state=${state}`).set('Cookie', cookie);
  for (const r of [await cb('wrong', a.cookie), await cb(a.upstreamState, ''), await cb(a.upstreamState, `${a.cookie.split('=')[0]}=wrong`)]) {
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  }
  expect(s.f).not.toHaveBeenCalled();
  expect((await cb(a.upstreamState, a.cookie)).status).toBe(302);
  const replay = await cb(a.upstreamState, a.cookie);
  expect(replay.status).toBe(400);
  expect(replay.headers.location).toBeUndefined();
  expect(s.f).toHaveBeenCalledTimes(2);
});

test('callback exchanges code, stores Mattermost tokens, marks client authorized, redirects with code and client state', async () => {
  const s = setup();
  const a = await approved(s);
  const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  expect(r.status).toBe(302);
  expect(r.headers['cache-control']).toBe('no-store');
  const loc = new URL(r.headers.location);
  expect(loc.origin + loc.pathname).toBe(CLAUDE);
  const p = params(r.headers.location);
  expect(p).toMatchObject({ state: 'client-state', iss: ISS });

  const [tokenUrl, tokenInit] = s.f.mock.calls[0];
  expect(String(tokenUrl)).toBe('http://mm.internal/oauth/access_token');
  const form = Object.fromEntries(new URLSearchParams(String(tokenInit?.body)));
  expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'mmcode', redirect_uri: 'https://mm.example/mcp/oauth/callback' });
  expect(createHash('sha256').update(form.code_verifier).digest('base64url')).toBe(a.upstreamChallenge);
  const [meUrl, meInit] = s.f.mock.calls[1];
  expect(String(meUrl)).toBe('http://mm.internal/api/v4/users/me');
  expect(new Headers(meInit?.headers).get('authorization')).toBe('Bearer mm-a');

  expect(s.store.getMmCred('u1')).toMatchObject({ access: 'mm-a', refresh: 'mm-r' });
  expect(s.store.getClient(s.client.clientId)?.authorizedAt).not.toBeNull();
  expect(s.store.consumeCode(p.code)).toMatchObject({
    mmUserId: 'u1', clientId: s.client.clientId, redirectUri: CLAUDE, codeChallenge: CHALLENGE, resource: ISS, scope: 'mattermost',
  });
  const cleared = (r.headers['set-cookie'] as unknown as string[])[0].split(';').map((x) => x.trim());
  expect(cleared[0]).toBe(`__Host-mcp_authz_${a.sessionId}=`);
  expect(cleared.slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=0', 'Path=/', 'SameSite=Lax', 'Secure']);
});

test('callback redirects to the loopback port the client asked for', async () => {
  const s = setup([LOOP]);
  const a = await approved(s, { redirect_uri: 'http://127.0.0.1:5555/cb' });
  const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  expect(r.headers.location).toMatch(/^http:\/\/127\.0\.0\.1:5555\/cb\?/);
});

test('Mattermost returning an error redirects the client with access_denied and stores nothing', async () => {
  const s = setup();
  const a = await approved(s);
  const r = await s.req.get(`/mcp/oauth/callback?error=access_denied&state=${a.upstreamState}`).set('Cookie', a.cookie);
  expect(r.status).toBe(302);
  expect(params(r.headers.location)).toMatchObject({ error: 'access_denied', state: 'client-state', iss: ISS });
  expect(params(r.headers.location)).not.toHaveProperty('code');
  expect(s.f).not.toHaveBeenCalled();
  expect(s.store.getClient(s.client.clientId)?.authorizedAt).toBeNull();
});

test('a failure talking to Mattermost during the callback shows a 502 error page and stores nothing', async () => {
  const failures = [
    mmFetch({ token: () => Response.json({ id: 'x' }, { status: 400 }) }),
    mmFetch({ me: () => Response.json({ id: 'x' }, { status: 500 }) }),
    vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed'); }),
  ];
  for (const f of failures) {
    const s = setup([CLAUDE], f);
    const a = await approved(s);
    const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
    expect(r.status).toBe(502);
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['content-security-policy']).toContain("form-action 'none'");
    expect(s.store.getMmCred('u1')).toBeUndefined();
    expect(s.store.getClient(s.client.clientId)?.authorizedAt).toBeNull();
  }
});

test('deny button redirects with access_denied and the client state', async () => {
  const s = setup();
  const c = await startConsent(s);
  const r = await postConsent(s, c, 'deny');
  expect(r.status).toBe(303);
  const loc = new URL(r.headers.location);
  expect(loc.origin + loc.pathname).toBe(CLAUDE);
  expect(params(r.headers.location)).toMatchObject({ error: 'access_denied', state: 'client-state', iss: ISS });
  expect((r.headers['set-cookie'] as unknown as string[])[0]).toMatch(new RegExp(`^__Host-mcp_authz_${c.sessionId}=; .*Max-Age=0`));
  expect(s.f).not.toHaveBeenCalled();
  expect((await postConsent(s, c)).status).toBe(400);
});

test('logs never contain cookies, codes, tokens or the client state', async () => {
  const s = setup();
  const a = await approved(s);
  const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  const out = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
  for (const secret of [a.cookie.split('=')[1], a.csrf, a.upstreamState, 'mmcode', 'mm-a', 'mm-r', params(r.headers.location).code, 'client-state']) {
    expect(out).not.toContain(secret);
  }
});

test("session A's upstream state with only session B's cookie is rejected and A stays usable with its own cookie", async () => {
  const s = setup();
  const a = await approved(s, { state: 'A' });
  const b = await approved(s, { state: 'B' });
  const forged = `${a.cookie.split('=')[0]}=${b.cookie.split('=')[1]}`;
  for (const cookie of [b.cookie, forged]) {
    const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', cookie);
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
  }
  expect(s.f).not.toHaveBeenCalled();
  const ok = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  expect(params(ok.headers.location).state).toBe('A');
});

test('a store failure after the Mattermost exchange stores nothing and shows a 5xx error page', async () => {
  const s = setup();
  const a = await approved(s);
  vi.spyOn(s.store, 'createCode').mockImplementation(() => { throw new Error('disk full'); });
  const r = await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
  expect(r.status).toBe(500);
  expect(r.headers.location).toBeUndefined();
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.headers['content-security-policy']).toContain("form-action 'none'");
  expect(s.store.getMmCred('u1')).toBeUndefined();
  expect(s.store.getClient(s.client.clientId)?.authorizedAt).toBeNull();
});

test('authorize_upstream_failed says which step failed and the status, without secrets', async () => {
  const cases: [ReturnType<typeof mmFetch>, string, string][] = [
    [mmFetch({ token: () => Response.json({ id: 'x' }, { status: 400 }) }), 'exchange', '400'],
    [mmFetch({ me: () => Response.json({ id: 'x' }, { status: 401 }) }), 'users_me', '401'],
  ];
  for (const [f, step, status] of cases) {
    vi.mocked(process.stdout.write).mockClear();
    const s = setup([CLAUDE], f);
    const a = await approved(s);
    await s.req.get(`/mcp/oauth/callback?code=mmcode&state=${a.upstreamState}`).set('Cookie', a.cookie);
    const lines = vi.mocked(process.stdout.write).mock.calls.map((c) => JSON.parse(String(c[0])));
    const line = lines.find((l) => l.event === 'authorize_upstream_failed');
    expect(line).toMatchObject({ step, name: 'UpstreamUnavailable' });
    expect(line.message).toContain(status);
    for (const secret of ['mmcode', 'mm-a', 'mm-r', a.upstreamState, 's']) expect(Object.values(line)).not.toContain(secret);
    expect(JSON.stringify(line)).not.toMatch(/mm-a|mm-r|mmcode/);
  }
});

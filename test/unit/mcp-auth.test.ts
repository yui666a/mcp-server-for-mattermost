import { once } from 'node:events';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

// Not vitest's defaults (1 s for vi.waitFor, 5 s for a test): on a busy machine the awaited event can take seconds.
const SLOW = { timeout: 10_000 };
const SLOW_TEST = 30_000;

const PRM = 'https://mm.example/.well-known/oauth-protected-resource/mcp';
const CHALLENGE = `Bearer resource_metadata="${PRM}", scope="mattermost"`;
const INVALID = `${CHALLENGE}, error="invalid_token"`;
const RELOGIN_TEXT = 'Mattermost への再ログインが必要です。コネクタを再接続してください。';
const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const GET_USER = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_user', arguments: { user: '@alice' } } };

type Mm = (req: Request) => Response | Promise<Response>;
let mm: Mm;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  mm = () => Response.json({ id: 'u1', username: 'alice' });
});
afterEach(() => vi.restoreAllMocks());

const logged = () => vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');

function setup(env: Record<string, string> = {}) {
  const ctx = makeApp(env, async (input, init) => mm(new Request(input, init)));
  const code = ctx.store.createCode({
    mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: ctx.config.resource, scope: 'mattermost',
  });
  const rec = ctx.store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const tokens = ctx.store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: ctx.config.resource, fromCodeHash: rec.codeHash });
  ctx.store.putMmCred('u1', 'mm-access', 'mm-refresh');
  const rpc = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${tokens.accessToken}` }) =>
    ctx.req.post('/mcp').set({ accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers }).send(JSON.stringify(body));
  return { ...ctx, token: tokens.accessToken, rpc };
}

test('401 with resource_metadata and scope when no token', async () => {
  const s = setup();
  const none = await s.rpc(INIT, {});
  expect(none.status).toBe(401);
  expect(none.headers['www-authenticate']).toBe(CHALLENGE);

  for (const authorization of ['Bearer nope', `Bearer ${s.token} extra`, `Bearer  ${s.token}`, 'Bearer ']) {
    const r = await s.rpc(INIT, { authorization });
    expect(r.status, authorization).toBe(401);
    expect(r.headers['www-authenticate'], authorization).toBe(INVALID);
  }
  const lower = await s.rpc(INIT, { authorization: `bearer ${s.token}` });
  expect(lower.status).toBe(200);

  for (const method of ['get', 'delete'] as const) {
    const r = await s.req[method]('/mcp');
    expect(r.status, method).toBe(401);
    expect(r.headers['www-authenticate'], method).toBe(CHALLENGE);
  }
  expect(logged()).not.toContain(s.token);
});

test('403 for disallowed Origin, accepted without Origin', async () => {
  const s = setup({ EXTRA_ALLOWED_ORIGINS: 'https://extra.example' });
  expect((await s.rpc(INIT, { authorization: `Bearer ${s.token}`, origin: 'https://evil.example' })).status).toBe(403);
  expect((await s.rpc(INIT, { authorization: `Bearer ${s.token}`, origin: 'null' })).status).toBe(403);
  expect((await s.rpc(INIT, { origin: 'https://evil.example' })).status).toBe(403);
  for (const origin of ['https://claude.ai', 'https://claude.com', 'https://extra.example']) {
    expect((await s.rpc(INIT, { authorization: `Bearer ${s.token}`, origin })).status, origin).toBe(200);
  }
  expect((await s.rpc(INIT)).status).toBe(200);
});

test('initialize and tools/list over Streamable HTTP with a valid token return application/json', async () => {
  const s = setup();
  const init = await s.rpc(INIT);
  expect(init.status).toBe(200);
  expect(init.headers['content-type']).toMatch(/^application\/json/);
  expect(init.headers['mcp-session-id']).toBeUndefined();
  expect(init.body.result.protocolVersion).toBe('2025-11-25');

  const list = await s.rpc(LIST);
  expect(list.status).toBe(200);
  expect(list.headers['content-type']).toMatch(/^application\/json/);
  expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain('get_user');

  const who = await s.rpc(GET_USER);
  expect(who.body.result.isError).toBeFalsy();
  expect(who.body.result.content[0].text).toContain('alice');
  expect(logged()).toMatch(/"mm_user_id":"u1","tool":"get_user","outcome":"ok","ms":\d+.*"event":"tool_call"/);

  for (const method of ['get', 'delete'] as const) {
    const r = await s.req[method]('/mcp').set('authorization', `Bearer ${s.token}`);
    expect(r.status, method).toBe(405);
    expect(r.headers.allow, method).toBe('POST');
  }
});

test('healthz returns 200 without auth', async () => {
  const r = await makeApp().req.get('/mcp/healthz');
  expect(r.status).toBe(200);
});

test('after Reauthorize in a tool call, the next request gets 401 invalid_token', async () => {
  const s = setup();
  mm = (req) => req.url.endsWith('/oauth/access_token')
    ? Response.json({ id: 'api.oauth.get_access_token.refresh_token.app_error' }, { status: 404 })
    : Response.json({ id: 'api.context.session_expired.app_error' }, { status: 401 });
  const who = await s.rpc(GET_USER);
  expect(who.status).toBe(200);
  expect(who.body.result).toMatchObject({ isError: true, content: [{ type: 'text', text: RELOGIN_TEXT }] });
  expect(logged()).toMatch(/"tool":"get_user","outcome":"reauthorize"/);

  const next = await s.rpc(LIST);
  expect(next.status).toBe(401);
  expect(next.headers['www-authenticate']).toBe(INVALID);
});

test('other tool errors become isError results without tokens', async () => {
  const s = setup();
  const cases: [Mm, RegExp, string][] = [
    [() => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } }), /7 秒/, 'rate_limited'],
    [() => { throw new TypeError('fetch failed'); }, /Mattermost に一時的に接続できません/, 'upstream_unavailable'],
    [() => new Response('oops', { status: 503 }), /Mattermost に一時的に接続できません/, 'upstream_unavailable'],
    [() => Response.json({ id: 'api.x', message: 'You do not have permission' }, { status: 403 }), /403.*You do not have permission/, 'mm_error'],
  ];
  for (const [impl, text, outcome] of cases) {
    mm = impl;
    const r = await s.rpc(GET_USER);
    expect(r.status, outcome).toBe(200);
    expect(r.body.result.isError, outcome).toBe(true);
    expect(r.body.result.content[0].text, outcome).toMatch(text);
    expect(logged(), outcome).toContain(`"outcome":"${outcome}"`);
  }
  const all = JSON.stringify(logged());
  for (const secret of [s.token, 'mm-access', 'mm-refresh']) expect(all).not.toContain(secret);
});

test('a client disconnect aborts the Mattermost request of the running tool', async () => {
  const s = setup();
  let signal: AbortSignal | undefined;
  mm = (req) => {
    signal = req.signal;
    return new Promise((_, fail) => req.signal.addEventListener('abort', () => fail(req.signal.reason)));
  };
  // Not s.rpc: supertest closes the server it starts only when a request finishes, and an aborted one never does.
  // Bound to 127.0.0.1 as supertest does: a wildcard port can be shared with another process on macOS.
  const server = s.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    // Not disconnecting after a fixed time: on a busy machine the request may not have reached Mattermost by then.
    const req = request(server).post('/mcp')
      .set({ accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${s.token}` })
      .send(JSON.stringify(GET_USER));
    const done = expect(req).rejects.toThrow(/Aborted/);
    await vi.waitFor(() => expect(signal).toBeDefined(), SLOW);
    req.abort();
    await done;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), SLOW);
    await vi.waitFor(() => expect(logged()).toMatch(/"tool":"get_user","outcome":"upstream_unavailable"/), SLOW);
  } finally {
    const closed = new Promise((r) => server.close(r));
    server.closeAllConnections();
    await closed;
  }
}, SLOW_TEST);

test('an error after the response has started is logged by name only and ends the response', async () => {
  const s = setup();
  vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementation(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).write('{');
    throw new TypeError('SECRET-DETAIL');
  });
  const r = await s.rpc(INIT).buffer(true).parse((res, done) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done(null, b)); });
  expect(r.status).toBe(200);
  expect(r.body).toBe('{');
  expect(logged()).toMatch(/"name":"TypeError".*"event":"unhandled_error"/);
  expect(logged()).not.toContain('SECRET-DETAIL');
});

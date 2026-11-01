import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

const CB = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const RES = 'https://mm.example/mcp';

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(env: Record<string, string> = {}) {
  const ctx = makeApp(env);
  const client = ctx.store.createClient({ clientName: 'C', redirectUris: [CB] });
  const other = ctx.store.createClient({ clientName: 'O', redirectUris: [CB] });
  const newCode = (over: Partial<Parameters<typeof ctx.store.createCode>[0]> = {}) =>
    ctx.store.createCode({ mmUserId: 'u1', clientId: client.clientId, redirectUri: CB, codeChallenge: CHALLENGE, resource: RES, scope: 'mattermost', ...over });
  const exchange = (code: string, over: Record<string, string | undefined> = {}) => {
    const body: Record<string, string | undefined> = {
      grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: CB, code_verifier: VERIFIER, resource: RES, ...over,
    };
    return post(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Record<string, string>);
  };
  const post = (b: Record<string, string>) => ctx.req.post('/mcp/oauth/token').type('form').send(b);
  const refresh = (rt: string, over: Record<string, string | undefined> = {}) =>
    post(Object.fromEntries(Object.entries({ grant_type: 'refresh_token', client_id: client.clientId, refresh_token: rt, resource: RES, ...over }).filter(([, v]) => v !== undefined)) as Record<string, string>);
  return { ...ctx, client, other, newCode, exchange, refresh, post };
}

test('code exchange checks client_id, redirect_uri and PKCE (invalid_grant), resource (invalid_target)', async () => {
  const s = setup();
  const ok = await s.exchange(s.newCode());
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mattermost' });
  expect(ok.body.access_token).toBeTruthy();
  expect(ok.body.refresh_token).toBeTruthy();
  expect(ok.headers['cache-control']).toBe('no-store');
  expect(ok.headers.pragma).toBe('no-cache');
  expect(s.store.verifyAccess(ok.body.access_token)?.mmUserId).toBe('u1');

  const cases: [string, Record<string, string | undefined>, number, string][] = [
    ['other client', { client_id: s.other.clientId }, 400, 'invalid_grant'],
    ['redirect mismatch', { redirect_uri: `${CB}/x` }, 400, 'invalid_grant'],
    ['redirect missing', { redirect_uri: undefined }, 400, 'invalid_request'],
    ['wrong verifier', { code_verifier: 'w'.repeat(43) }, 400, 'invalid_grant'],
    ['short verifier', { code_verifier: 'v'.repeat(42) }, 400, 'invalid_grant'],
    ['long verifier', { code_verifier: 'v'.repeat(129) }, 400, 'invalid_grant'],
    ['bad verifier chars', { code_verifier: 'v'.repeat(42) + '!' }, 400, 'invalid_grant'],
    ['verifier missing', { code_verifier: undefined }, 400, 'invalid_request'],
    ['code missing', { code: undefined }, 400, 'invalid_request'],
    ['duplicate grant_type', { grant_type: ['authorization_code', 'authorization_code'] as any }, 400, 'invalid_request'],
    ['unknown code', { code: 'nope' }, 400, 'invalid_grant'],
    ['resource missing', { resource: undefined }, 400, 'invalid_target'],
    ['resource mismatch', { resource: `${RES}/` }, 400, 'invalid_target'],
    ['unknown client', { client_id: 'nope' }, 401, 'invalid_client'],
    ['client_id missing', { client_id: undefined }, 401, 'invalid_client'],
    ['client_secret', { client_secret: 'x' }, 401, 'invalid_client'],
    ['grant_type', { grant_type: 'password' }, 400, 'unsupported_grant_type'],
    ['grant_type missing', { grant_type: undefined }, 400, 'invalid_request'],
  ];
  for (const [name, over, status, error] of cases) {
    const r = await s.exchange(s.newCode(), over);
    expect([name, r.status, r.body.error]).toEqual([name, status, error]);
    expect(r.headers['cache-control']).toBe('no-store');
  }
});

test('a request missing redirect_uri or code_verifier does not burn the code', async () => {
  const s = setup();
  const code = s.newCode();
  expect((await s.exchange(code, { redirect_uri: undefined })).body.error).toBe('invalid_request');
  expect((await s.exchange(code, { code_verifier: undefined })).body.error).toBe('invalid_request');
  expect((await s.exchange(code)).status).toBe(200);
});

test('a rejected exchange still consumes the code', async () => {
  const s = setup();
  const code = s.newCode();
  expect((await s.exchange(code, { code_verifier: 'w'.repeat(43) })).body.error).toBe('invalid_grant');
  expect((await s.exchange(code)).body.error).toBe('invalid_grant');
});

test('Authorization header client authentication is rejected with invalid_client', async () => {
  const s = setup();
  const r = await s.req.post('/mcp/oauth/token').set('Authorization', 'Basic eDp5').type('form')
    .send({ grant_type: 'authorization_code', client_id: s.client.clientId, code: s.newCode(), redirect_uri: CB, code_verifier: VERIFIER, resource: RES });
  expect([r.status, r.body.error]).toEqual([401, 'invalid_client']);
  expect(r.headers['www-authenticate']).toBe('Basic realm="mcp"');
  const bearer = await s.req.post('/mcp/oauth/token').set('Authorization', 'Bearer abc').type('form').send({ grant_type: 'refresh_token' });
  expect(bearer.headers['www-authenticate']).toBe('Bearer realm="mcp"');
});

test('non-form content type is invalid_request', async () => {
  const s = setup();
  const r = await s.req.post('/mcp/oauth/token').send({ grant_type: 'refresh_token' });
  expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
});

test('code reuse returns invalid_grant and revokes tokens issued from it', async () => {
  const s = setup();
  const code = s.newCode();
  const first = await s.exchange(code);
  expect(s.store.verifyAccess(first.body.access_token)).toBeDefined();
  const again = await s.exchange(code);
  expect([again.status, again.body.error]).toEqual([400, 'invalid_grant']);
  expect(s.store.verifyAccess(first.body.access_token)).toBeUndefined();
  expect((await s.refresh(first.body.refresh_token)).body.error).toBe('invalid_grant');
});

test('expired code (61s) is rejected', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const s = setup();
  const code = s.newCode();
  vi.setSystemTime(Date.now() + 61_000);
  const r = await s.exchange(code);
  expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
});

test('refresh rotates; old refresh token reuse returns invalid_grant and kills the family', async () => {
  const s = setup();
  const t1 = (await s.exchange(s.newCode())).body;
  const r2 = await s.refresh(t1.refresh_token);
  expect(r2.status).toBe(200);
  expect(r2.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mattermost' });
  expect(r2.body.refresh_token).not.toBe(t1.refresh_token);
  expect(r2.headers['cache-control']).toBe('no-store');
  expect(s.store.verifyAccess(r2.body.access_token)).toBeDefined();

  const reuse = await s.refresh(t1.refresh_token);
  expect([reuse.status, reuse.body.error]).toEqual([400, 'invalid_grant']);
  expect(s.store.verifyAccess(r2.body.access_token)).toBeUndefined();
  expect((await s.refresh(r2.body.refresh_token)).body.error).toBe('invalid_grant');
});

test('refresh with another client_id is rejected', async () => {
  const s = setup();
  const t = (await s.exchange(s.newCode())).body;
  const r = await s.refresh(t.refresh_token, { client_id: s.other.clientId });
  expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
  expect((await s.refresh(t.refresh_token)).status).toBe(200);
});

test('refresh requires resource and a known public client', async () => {
  const s = setup();
  const t = (await s.exchange(s.newCode())).body;
  expect((await s.refresh(t.refresh_token, { resource: undefined })).body.error).toBe('invalid_target');
  expect((await s.refresh(t.refresh_token, { resource: 'https://x' })).body.error).toBe('invalid_target');
  expect((await s.refresh(t.refresh_token, { client_id: 'nope' })).status).toBe(401);
  expect((await s.refresh(t.refresh_token, { client_secret: 'x' })).status).toBe(401);
  expect((await s.refresh(undefined as any)).body.error).toBe('invalid_request');
  expect((await s.refresh(t.refresh_token)).status).toBe(200);
});

test('refresh cannot widen scope', async () => {
  const s = setup();
  const t = (await s.exchange(s.newCode())).body;
  for (const scope of ['mattermost other', 'admin', '']) {
    const r = await s.refresh(t.refresh_token, { scope });
    expect([scope, r.status, r.body.error]).toEqual([scope, 400, 'invalid_scope']);
  }
  expect((await s.refresh(t.refresh_token, { scope: 'mattermost' })).status).toBe(200);
});

test('expires_in follows ACCESS_TOKEN_TTL_SEC', async () => {
  const s = setup({ ACCESS_TOKEN_TTL_SEC: '5' });
  const r = await s.exchange(s.newCode());
  expect(r.body.expires_in).toBe(5);
});

test('logs token events with client_id and mm_user_id only', async () => {
  const s = setup();
  const t = (await s.exchange(s.newCode())).body;
  await s.refresh(t.refresh_token);
  await s.refresh(t.refresh_token);
  const out = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
  for (const ev of ['token_issued', 'token_refreshed', 'token_reuse_detected']) expect(out).toContain(`"event":"${ev}"`);
  expect(out).toContain(`"client_id":"${s.client.clientId}"`);
  expect(out).not.toContain(t.refresh_token);
  expect(out).not.toContain(t.access_token);
});

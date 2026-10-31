import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

const URL_OK = 'https://claude.ai/api/mcp/auth_callback';
const post = (body: unknown) => makeApp().req.post('/mcp/oauth/register').send(body as object);
beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => vi.restoreAllMocks());

test('register returns 201 with client_id and echoes metadata', async () => {
  const { req, store } = makeApp();
  const r = await req.post('/mcp/oauth/register').send({ client_name: 'Claude', redirect_uris: [URL_OK], logo_uri: 'https://x/logo.png' });
  expect(r.status).toBe(201);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body).toMatchObject({ client_name: 'Claude', redirect_uris: [URL_OK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mattermost' });
  expect(r.body.logo_uri).toBeUndefined();
  expect(typeof r.body.client_id_issued_at).toBe('number');
  expect(store.getClient(r.body.client_id)?.redirectUris).toEqual([URL_OK]);
});
test('register rejects disallowed redirect_uri with invalid_redirect_uri', async () => {
  const r = await post({ redirect_uris: ['https://evil.example/cb'] });
  expect(r.status).toBe(400);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.body.error).toBe('invalid_redirect_uri');
});
test('register rejects control chars, name > 100, > 5 uris, uri > 2000 with invalid_client_metadata', async () => {
  const long = 'http://localhost:1/' + 'a'.repeat(2000);
  const bodies: unknown[] = [
    { client_name: 'a\u0007b', redirect_uris: [URL_OK] },
    { client_name: 'a'.repeat(101), redirect_uris: [URL_OK] },
    { redirect_uris: Array(6).fill(URL_OK) },
    { redirect_uris: [long] },
    { redirect_uris: [URL_OK + '\u0085'] },
    { redirect_uris: [] },
    { redirect_uris: [URL_OK], scope: 'other' },
    { redirect_uris: [URL_OK], grant_types: ['password'] },
    { redirect_uris: [URL_OK], response_types: ['token'] },
  ];
  for (const b of bodies) {
    const r = await post(b);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_client_metadata']);
  }
});
test('register rejects malformed and oversized bodies with invalid_client_metadata', async () => {
  const { req } = makeApp();
  const bad = await req.post('/mcp/oauth/register').set('Content-Type', 'application/json').send('{nope');
  expect([bad.status, bad.body.error]).toEqual([400, 'invalid_client_metadata']);
  const big = await post({ redirect_uris: [URL_OK], client_name: 'a'.repeat(20000) });
  expect([big.status, big.body.error]).toEqual([400, 'invalid_client_metadata']);
});
test('register stores token_endpoint_auth_method none even if the client asked for another, and says so in the response', async () => {
  const r = await post({ redirect_uris: [URL_OK], token_endpoint_auth_method: 'client_secret_basic' });
  expect(r.status).toBe(201);
  expect(r.body.token_endpoint_auth_method).toBe('none');
});
test('warns when unauthorized registrations exceed 450, without logging secrets', async () => {
  const w = vi.mocked(process.stdout.write);
  const { req, store } = makeApp();
  for (let i = 0; i < 450; i++) store.createClient({ clientName: 'c', redirectUris: [URL_OK] });
  await req.post('/mcp/oauth/register').send({ redirect_uris: [URL_OK] });
  const lines = w.mock.calls.map((c) => JSON.parse(String(c[0])));
  expect(lines.find((l) => l.event === 'dcr_unauthorized_near_limit')).toMatchObject({ count: 451 });
});

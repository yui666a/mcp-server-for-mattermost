import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { authorizeUrl, exchangeCode, refreshTokens, UpstreamUnavailable, userId } from '../../src/mattermost/upstream.ts';

const cfg = loadConfig({
  PUBLIC_URL: 'https://mm.example', TOKEN_ENC_KEY: randomBytes(32).toString('base64'),
  MM_OAUTH_CLIENT_ID: 'mm-client', MM_OAUTH_CLIENT_SECRET: 'SECRET-XYZ', MM_URL: 'http://mm.internal', MM_BROWSER_URL: 'http://mm.example',
});
const stub = (res: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => res());
const deps = (f: typeof fetch) => ({ fetch: f, now: Date.now });
const mmError = (status: number, id: string) => Response.json({ id, message: 'm', status_code: status }, { status });
const logged = () => vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');

beforeEach(() => { vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => vi.restoreAllMocks());

test('authorizeUrl points the browser at MM_BROWSER_URL with our callback, state and S256 challenge', () => {
  const u = new URL(authorizeUrl(cfg, 'st', 'ch'));
  expect(u.origin + u.pathname).toBe('http://mm.example/oauth/authorize');
  expect(Object.fromEntries(u.searchParams)).toEqual({
    response_type: 'code', client_id: 'mm-client', redirect_uri: 'https://mm.example/mcp/oauth/callback',
    state: 'st', code_challenge: 'ch', code_challenge_method: 'S256',
  });
});

test('exchangeCode posts the code with redirect_uri, client secret and verifier to MM_URL', async () => {
  const f = stub(() => Response.json({ access_token: 'a', refresh_token: 'r', token_type: 'bearer' }));
  expect(await exchangeCode(cfg, deps(f), 'code1', 'ver1')).toEqual({ access: 'a', refresh: 'r' });
  const [url, init] = f.mock.calls[0];
  expect(String(url)).toBe('http://mm.internal/oauth/access_token');
  expect(init?.method).toBe('POST');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
    grant_type: 'authorization_code', code: 'code1', client_id: 'mm-client', client_secret: 'SECRET-XYZ',
    redirect_uri: 'https://mm.example/mcp/oauth/callback', code_verifier: 'ver1',
  });
});

test('exchangeCode throws UpstreamUnavailable on an error status, a malformed body or a network failure', async () => {
  await expect(exchangeCode(cfg, deps(stub(() => mmError(400, 'x'))), 'c', 'v')).rejects.toBeInstanceOf(UpstreamUnavailable);
  await expect(exchangeCode(cfg, deps(stub(() => Response.json({ access_token: 'a' }))), 'c', 'v')).rejects.toBeInstanceOf(UpstreamUnavailable);
  await expect(exchangeCode(cfg, deps(stub(() => { throw new TypeError('fetch failed'); })), 'c', 'v')).rejects.toBeInstanceOf(UpstreamUnavailable);
});

test('userId reads /api/v4/users/me with the Mattermost access token', async () => {
  const f = stub(() => Response.json({ id: 'u1', username: 'alice' }));
  expect(await userId(cfg, deps(f), 'tok')).toBe('u1');
  const [url, init] = f.mock.calls[0];
  expect(String(url)).toBe('http://mm.internal/api/v4/users/me');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
  await expect(userId(cfg, deps(stub(() => mmError(401, 'x'))), 'tok')).rejects.toBeInstanceOf(UpstreamUnavailable);
});

test('refreshTokens posts the refresh grant and returns the new pair', async () => {
  const f = stub(() => Response.json({ access_token: 'a2', refresh_token: 'r2' }));
  expect(await refreshTokens(cfg, deps(f), 'r1')).toEqual({ access: 'a2', refresh: 'r2' });
  const [url, init] = f.mock.calls[0];
  expect(String(url)).toBe('http://mm.internal/oauth/access_token');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
    grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'mm-client', client_secret: 'SECRET-XYZ',
  });
});

test('refreshTokens returns invalid_grant only for the measured re-login responses', async () => {
  expect(await refreshTokens(cfg, deps(stub(() => mmError(404, 'api.oauth.get_access_token.refresh_token.app_error'))), 'r')).toBe('invalid_grant');
  expect(await refreshTokens(cfg, deps(stub(() => mmError(403, 'api.oauth.get_access_token.expired_code.app_error'))), 'r')).toBe('invalid_grant');
});

test('other 4xx on refresh logs mm_refresh_config_error without secrets and throws UpstreamUnavailable', async () => {
  const cases = [
    mmError(401, 'model.oauth.validate_grant.credentials.app_error'),
    mmError(400, 'api.oauth.get_access_token.missing_refresh_token.app_error'),
    mmError(404, 'some.other.id'),
    mmError(403, 'api.oauth.get_access_token.refresh_token.app_error'),
    new Response('not json', { status: 400 }),
  ];
  for (const res of cases) {
    vi.mocked(process.stdout.write).mockClear();
    await expect(refreshTokens(cfg, deps(stub(() => res)), 'REFRESH-SECRET')).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(logged()).toContain('mm_refresh_config_error');
    expect(logged()).not.toContain('SECRET');
  }
});

test('5xx, network failure, timeout and malformed success on refresh throw UpstreamUnavailable', async () => {
  const fails: (() => Response)[] = [
    () => mmError(503, 'x'),
    () => { throw new TypeError('fetch failed'); },
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => Response.json({ access_token: 'a' }),
  ];
  for (const f of fails) await expect(refreshTokens(cfg, deps(stub(f)), 'r')).rejects.toBeInstanceOf(UpstreamUnavailable);
  expect(logged()).not.toContain('mm_refresh_config_error');
});

test('Mattermost calls do not follow redirects; a 3xx is UpstreamUnavailable and only its status is logged', async () => {
  const redirect = () => new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } });
  const calls: Promise<unknown>[] = [
    exchangeCode(cfg, deps(stub(redirect)), 'CODE-SECRET', 'v'),
    userId(cfg, deps(stub(redirect)), 'ACCESS-SECRET'),
    refreshTokens(cfg, deps(stub(redirect)), 'REFRESH-SECRET'),
  ];
  for (const c of calls) await expect(c).rejects.toBeInstanceOf(UpstreamUnavailable);
  const f = stub(redirect);
  await refreshTokens(cfg, deps(f), 'r').catch(() => {});
  expect(f.mock.calls[0][1]?.redirect).toBe('manual');
  expect(logged()).toContain('"status":307');
  expect(logged()).not.toContain('SECRET');
  expect(logged()).not.toContain('evil.example');
});

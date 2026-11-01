import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { MmClient } from '../../src/mattermost/client.ts';
import { Limiter } from '../../src/mattermost/limiter.ts';
import { Store } from '../../src/store.ts';

export type Cred = { id: string; username: string; password: string };
export type Team = { id: string; name: string; dupChannelId: string; privateChannelId?: string };
export type Env = {
  mmUrl: string;
  adminToken: string;
  users: { alice: Cred; bob: Cred };
  teams: { a: Team; b: Team };
  oauth: { clientId: string; clientSecret: string; callback: string };
};

const stateUrl = new URL('../../dev/.state.json', import.meta.url);

export function env(): Env {
  return JSON.parse(readFileSync(stateUrl, 'utf8'));
}

export async function mmAvailable(): Promise<boolean> {
  try {
    const e = env();
    const res = await fetch(`${e.mmUrl}/api/v4/system/ping`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function mmLoginCookie(user: Cred): Promise<string> {
  const res = await fetch(`${env().mmUrl}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ login_id: user.username, password: user.password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function mmAuthorizeCode(cookie: string, params: Record<string, string>): Promise<string> {
  const url = new URL(`${env().mmUrl}/oauth/authorize`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { cookie }, redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`no redirect from /oauth/authorize: ${res.status} ${await res.text()}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`no code in redirect: ${location}`);
  return code;
}

export async function mmDeauthorize(cookie: string, clientId: string): Promise<Response> {
  const csrf = /MMCSRF=([^;]+)/.exec(cookie)?.[1] ?? '';
  return fetch(`${env().mmUrl}/oauth/deauthorize`, {
    method: 'POST',
    headers: { cookie, 'x-requested-with': 'XMLHttpRequest', 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
}

export function intApp(extraEnv: Record<string, string> = {}) {
  const e = env();
  // The Mattermost OAuth app only accepts http://localhost:3000/mcp/oauth/callback, so PUBLIC_URL has to match it.
  const config = loadConfig({
    PUBLIC_URL: new URL(e.oauth.callback).origin, TOKEN_ENC_KEY: randomBytes(32).toString('base64'), MM_URL: e.mmUrl,
    MM_OAUTH_CLIENT_ID: e.oauth.clientId, MM_OAUTH_CLIENT_SECRET: e.oauth.clientSecret, ...extraEnv,
  });
  const store = new Store(openDb(':memory:'), config.encKey, Date.now, config.accessTokenTtlSec);
  const deps = { fetch, now: Date.now };
  const limiter = new Limiter({ perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 120, globalPerMin: 600 }, Date.now);
  const mm = new MmClient(config, store, limiter, deps);
  return { config, store, limiter, req: request(createApp({ config, store, deps, mm })) };
}

// register → authorize → consent → Mattermost login → callback, ending with the MCP authorization code.
export async function mcpAuthorize(req: ReturnType<typeof request>, resource: string, mmCookie: string, redirect: string) {
  const verifier = randomBytes(32).toString('base64url');
  const reg = await req.post('/mcp/oauth/register').send({ client_name: 'int', redirect_uris: [redirect] });
  expect(reg.status).toBe(201);
  const clientId: string = reg.body.client_id;

  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state: 'client-state', resource, scope: 'mattermost',
  });
  const page = await req.get(`/mcp/oauth/authorize?${q}`);
  expect(page.status).toBe(200);
  const cookie = (page.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(page.text)![1];

  const consent = await req.post('/mcp/oauth/consent').set('Cookie', cookie).type('form')
    .send({ session_id: field('session_id'), csrf: field('csrf'), decision: 'approve' });
  expect(consent.status).toBe(303);
  const mmAuthz = new URL(consent.headers.location);
  expect(mmAuthz.origin).toBe(env().mmUrl);

  const mmCode = await mmAuthorizeCode(mmCookie, Object.fromEntries(mmAuthz.searchParams));
  const cb = await req.get(`/mcp/oauth/callback?${new URLSearchParams({ code: mmCode, state: mmAuthz.searchParams.get('state')! })}`)
    .set('Cookie', cookie);
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location);
  expect(back.origin + back.pathname).toBe(redirect);
  expect(back.searchParams.get('state')).toBe('client-state');
  return { clientId, code: back.searchParams.get('code')!, verifier };
}

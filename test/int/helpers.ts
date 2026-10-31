import { readFileSync } from 'node:fs';

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

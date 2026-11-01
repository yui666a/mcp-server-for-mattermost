import type { Config } from '../config.ts';
import type { Deps } from '../deps.ts';
import { log } from '../log.ts';

export type MmTokens = { access: string; refresh: string };

export class UpstreamUnavailable extends Error {
  name = 'UpstreamUnavailable';
  readonly sent: boolean;
  constructor(message: string, sent = true) {
    super(message);
    this.sent = sent;
  }
}

const TIMEOUT_MS = 20_000;
const RELOGIN = [
  { status: 404, id: 'api.oauth.get_access_token.refresh_token.app_error' },
  { status: 403, id: 'api.oauth.get_access_token.expired_code.app_error' },
];

const callbackUrl = (cfg: Config) => `${cfg.publicUrl}/mcp/oauth/callback`;

export function authorizeUrl(cfg: Config, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: cfg.mmClientId, redirect_uri: callbackUrl(cfg),
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `${cfg.mmBrowserUrl}/oauth/authorize?${q}`;
}

// Redirects are not followed: the request carries client_secret and codes or tokens, which must only go to MM_URL.
async function call(deps: Deps, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new UpstreamUnavailable('Mattermost unreachable');
  }
  if (res.status >= 300 && res.status < 400) {
    log('mm_upstream_redirect', { status: res.status });
    throw new UpstreamUnavailable(`unexpected redirect: ${res.status}`);
  }
  return res;
}

async function json(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function tokens(res: Response): Promise<MmTokens> {
  const b = await json(res);
  if (typeof b?.access_token !== 'string' || typeof b?.refresh_token !== 'string') {
    throw new UpstreamUnavailable('malformed token response');
  }
  return { access: b.access_token, refresh: b.refresh_token };
}

function tokenRequest(cfg: Config, deps: Deps, form: Record<string, string>): Promise<Response> {
  return call(deps, `${cfg.mmUrl}/oauth/access_token`, {
    method: 'POST',
    body: new URLSearchParams({ ...form, client_id: cfg.mmClientId, client_secret: cfg.mmClientSecret }),
  });
}

export async function exchangeCode(cfg: Config, deps: Deps, code: string, verifier: string): Promise<MmTokens> {
  const res = await tokenRequest(cfg, deps, {
    grant_type: 'authorization_code', code, redirect_uri: callbackUrl(cfg), code_verifier: verifier,
  });
  if (!res.ok) throw new UpstreamUnavailable(`code exchange failed: ${res.status}`);
  return tokens(res);
}

export async function userId(cfg: Config, deps: Deps, access: string): Promise<string> {
  const res = await call(deps, `${cfg.mmUrl}/api/v4/users/me`, { headers: { authorization: `Bearer ${access}` } });
  const b = res.ok ? await json(res) : undefined;
  if (typeof b?.id !== 'string' || !b.id) throw new UpstreamUnavailable(`users/me failed: ${res.status}`);
  return b.id;
}

export async function refreshTokens(cfg: Config, deps: Deps, refresh: string): Promise<MmTokens | 'invalid_grant'> {
  const res = await tokenRequest(cfg, deps, { grant_type: 'refresh_token', refresh_token: refresh });
  if (res.ok) return tokens(res);
  if (res.status < 400 || res.status >= 500) throw new UpstreamUnavailable(`refresh failed: ${res.status}`);
  const id = (await json(res))?.id;
  if (RELOGIN.some((r) => r.status === res.status && r.id === id)) return 'invalid_grant';
  log('mm_refresh_config_error', { status: res.status, id: typeof id === 'string' ? id : undefined });
  throw new UpstreamUnavailable(`refresh rejected: ${res.status}`);
}

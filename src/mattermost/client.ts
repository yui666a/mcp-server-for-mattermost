import type { Config } from '../config.ts';
import type { Deps } from '../deps.ts';
import { log } from '../log.ts';
import type { Store } from '../store.ts';
import { RateLimited, type Limiter } from './limiter.ts';
import { refreshTokens, UpstreamUnavailable, type MmTokens } from './upstream.ts';

export { RateLimited, UpstreamUnavailable };

export class Reauthorize extends Error {
  name = 'Reauthorize';
  readonly sent: boolean;
  constructor(sent: boolean) {
    super('Mattermost re-login required');
    this.sent = sent;
  }
}

export class MmError extends Error {
  name = 'MmError';
  readonly sent = true;
  readonly status: number;
  readonly id: string | undefined;
  constructor(status: number, id: string | undefined, message: string | undefined) {
    super(message ?? `Mattermost API error: ${status}`);
    this.status = status;
    this.id = id;
  }
}

type Cred = { access: string; refresh: string; version: number };
type Refreshed = MmTokens & { saved: boolean };
type Attempt = { sent: boolean; requests: number; deadline: number };
type Send = (access: string) => Promise<Response>;
// res is undefined when Mattermost answered nothing usable for this pair (invalid_grant, or revoked meanwhile).
type Outcome = { res?: Response; used: number };

const TIMEOUT_MS = 20_000;
// One budget for the whole call rather than per request, so a 401 → refresh → retry cannot stretch a call
// past the send_message in-flight grace (30 s) that assumes every call has ended by then.
export const CALL_DEADLINE_MS = 25_000;
const MAX_RETRY_AFTER_SEC = 3600;
const NOT_CONNECTED = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const discard = (res: Response | undefined) => res?.body?.cancel().catch(() => {});

function retryAfterSec(h: Headers): number {
  for (const name of ['x-ratelimit-reset', 'retry-after']) {
    const n = Number(h.get(name));
    if (n > 0) return Math.min(MAX_RETRY_AFTER_SEC, Math.ceil(n));
  }
  return 1;
}

export class MmClient {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly limiter: Limiter;
  private readonly deps: Deps;
  private readonly refreshing = new Map<string, Promise<Refreshed | 'invalid_grant'>>();

  constructor(cfg: Config, store: Store, limiter: Limiter, deps: Deps) {
    this.cfg = cfg;
    this.store = store;
    this.limiter = limiter;
    this.deps = deps;
  }

  async call<T>(mmUserId: string, method: string, path: string, body?: unknown): Promise<T> {
    const release = this.limiter.acquire(mmUserId);
    try {
      return await this.run<T>(mmUserId, method, path, body);
    } finally {
      release();
    }
  }

  private async run<T>(mmUserId: string, method: string, path: string, body: unknown): Promise<T> {
    const at: Attempt = { sent: false, requests: 0, deadline: this.deps.now() + CALL_DEADLINE_MS };
    const send: Send = (access) => this.send(at, mmUserId, access, method, path, body);
    const cred = this.store.getMmCred(mmUserId);
    if (!cred) this.reauthorize(mmUserId, at);
    let res: Response | undefined = await send(cred.access);
    if (res.status !== 401) return this.parse<T>(res);
    await discard(res);
    const latest = this.store.getMmCred(mmUserId);
    if (!latest) this.reauthorize(mmUserId, at);
    const out: Outcome = latest.version !== cred.version
      ? { res: await send(latest.access), used: latest.version }
      : await this.refreshAndSend(mmUserId, latest, at, send);
    res = out.res;
    if (!res || res.status === 401) {
      await discard(res);
      res = await this.lastChance(mmUserId, at, out.used, send);
    }
    return this.parse<T>(res);
  }

  private async refreshAndSend(mmUserId: string, cred: Cred, at: Attempt, send: Send): Promise<Outcome> {
    let t: Refreshed | 'invalid_grant';
    try {
      t = await this.untilDeadline(() => this.refreshOnce(mmUserId, cred), at);
    } catch (e) {
      if (e instanceof UpstreamUnavailable) throw new UpstreamUnavailable(e.message, at.sent);
      throw e;
    }
    if (t === 'invalid_grant') return { used: cred.version };
    if (t.saved) return { res: await send(t.access), used: cred.version + 1 };
    // The save lost to a login callback's putMmCred. Mattermost keeps one valid pair per user and app,
    // so the callback's pair may be the one this refresh just replaced; keep the refreshed pair only once
    // Mattermost has authenticated it, since a 5xx, 429, timeout or redirect proves nothing either way.
    const check = await send(t.access).catch((e) => {
      if (e instanceof UpstreamUnavailable) return undefined;
      throw e;
    });
    if (check && check.status !== 401 && check.status !== 429 && check.status < 500) {
      if (this.store.getMmCred(mmUserId)) this.store.putMmCred(mmUserId, t.access, t.refresh);
      return { res: check, used: cred.version };
    }
    await discard(check);
    const stored = this.store.getMmCred(mmUserId);
    return stored ? { res: await send(stored.access), used: stored.version } : { used: cred.version };
  }

  // Revoking right away would throw away a pair that a concurrent login stored while this call was failing.
  private async lastChance(mmUserId: string, at: Attempt, used: number, send: Send): Promise<Response> {
    const stored = this.store.getMmCred(mmUserId);
    if (stored && stored.version !== used) {
      const res = await send(stored.access);
      if (res.status !== 401) return res;
      await discard(res);
    }
    this.reauthorize(mmUserId, at);
  }

  private refreshOnce(mmUserId: string, cred: Cred): Promise<Refreshed | 'invalid_grant'> {
    let p = this.refreshing.get(mmUserId);
    if (!p) {
      p = this.refresh(mmUserId, cred).finally(() => this.refreshing.delete(mmUserId));
      this.refreshing.set(mmUserId, p);
    }
    return p;
  }

  private async refresh(mmUserId: string, cred: Cred): Promise<Refreshed | 'invalid_grant'> {
    this.limiter.charge(mmUserId);
    const t = await refreshTokens(this.cfg, this.deps, cred.refresh);
    if (t === 'invalid_grant') return t;
    return { ...t, saved: this.store.casMmCred(mmUserId, cred.version, t.access, t.refresh) };
  }

  // The shared refresh is not aborted at this call's deadline: other calls may be waiting on it,
  // and letting it finish keeps the rotated pair that Mattermost has already issued.
  private async untilDeadline<T>(start: () => Promise<T>, at: Attempt): Promise<T> {
    const ms = this.remaining(at);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        start(),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new UpstreamUnavailable('call deadline exceeded', at.sent)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private remaining(at: Attempt): number {
    const ms = at.deadline - this.deps.now();
    if (ms <= 0) throw new UpstreamUnavailable('call deadline exceeded', at.sent);
    return ms;
  }

  private reauthorize(mmUserId: string, at: Attempt): never {
    this.store.revokeUser(mmUserId);
    throw new Reauthorize(at.sent);
  }

  private async send(at: Attempt, mmUserId: string, access: string, method: string, path: string, body: unknown): Promise<Response> {
    const ms = this.remaining(at);
    if (at.requests++ > 0) this.limiter.charge(mmUserId);
    const started = this.deps.now();
    const fields = { mm_user_id: mmUserId, method, path: path.split('?')[0] };
    let res: Response;
    try {
      res = await this.deps.fetch(`${this.cfg.mmUrl}/api/v4${path}`, {
        method,
        headers: body === undefined
          ? { authorization: `Bearer ${access}` }
          : { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Not following redirects keeps the bearer token from being sent anywhere but MM_URL.
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, ms)),
      });
    } catch (e) {
      // A timeout or reset may have reached Mattermost, so only failures before connecting count as unsent.
      if (!NOT_CONNECTED.includes((e as { cause?: { code?: string } })?.cause?.code ?? '')) at.sent = true;
      log('mm_api_failed', { ...fields, error: (e as Error)?.name, ms: this.deps.now() - started });
      throw new UpstreamUnavailable('Mattermost unreachable', at.sent);
    }
    at.sent = true;
    log('mm_api', { ...fields, status: res.status, ms: this.deps.now() - started });
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      throw new UpstreamUnavailable(`unexpected redirect: ${res.status}`, true);
    }
    return res;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 429) {
      await discard(res);
      throw new RateLimited(retryAfterSec(res.headers), true);
    }
    if (res.status >= 400 && res.status < 500) {
      const b = await res.json().catch(() => undefined);
      throw new MmError(res.status, str(b?.id), str(b?.message));
    }
    if (!res.ok) {
      await discard(res);
      throw new UpstreamUnavailable(`Mattermost API failed: ${res.status}`, true);
    }
    try {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new UpstreamUnavailable('unreadable Mattermost response', true);
    }
  }
}

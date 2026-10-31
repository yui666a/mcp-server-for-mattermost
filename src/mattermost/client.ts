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
type Attempt = { sent: boolean };

const TIMEOUT_MS = 20_000;
const NOT_CONNECTED = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function retryAfterSec(h: Headers): number {
  for (const name of ['x-ratelimit-reset', 'retry-after']) {
    const n = Number(h.get(name));
    if (n > 0) return Math.ceil(n);
  }
  return 1;
}

export class MmClient {
  private readonly cfg: Config;
  private readonly store: Store;
  private readonly limiter: Limiter;
  private readonly deps: Deps;
  private readonly refreshing = new Map<string, Promise<Refreshed>>();

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
    const at: Attempt = { sent: false };
    const send = (access: string) => this.send(at, mmUserId, access, method, path, body);
    const cred = this.store.getMmCred(mmUserId);
    if (!cred) this.reauthorize(mmUserId, at);
    let res = await send(cred.access);
    if (res.status === 401) {
      await res.body?.cancel();
      const latest = this.store.getMmCred(mmUserId);
      if (!latest) this.reauthorize(mmUserId, at);
      res = latest.version !== cred.version ? await send(latest.access) : await this.refreshAndSend(mmUserId, latest, at, send);
      if (res.status === 401) this.reauthorize(mmUserId, at);
    }
    return this.parse<T>(res);
  }

  private async refreshAndSend(mmUserId: string, cred: Cred, at: Attempt, send: (access: string) => Promise<Response>): Promise<Response> {
    let t: Refreshed;
    try {
      t = await this.refreshOnce(mmUserId, cred);
    } catch (e) {
      if (e instanceof Reauthorize) throw new Reauthorize(at.sent);
      if (e instanceof UpstreamUnavailable) throw new UpstreamUnavailable(e.message, at.sent);
      throw e;
    }
    const res = await send(t.access);
    if (t.saved) return res;
    // The save lost to a login callback's putMmCred. Mattermost keeps one valid pair per user and app,
    // so the callback's pair may be the one this refresh just replaced; trust whichever pair Mattermost accepts.
    if (res.status !== 401) {
      if (this.store.getMmCred(mmUserId)) this.store.putMmCred(mmUserId, t.access, t.refresh);
      return res;
    }
    await res.body?.cancel();
    const stored = this.store.getMmCred(mmUserId);
    return stored ? send(stored.access) : res;
  }

  private refreshOnce(mmUserId: string, cred: Cred): Promise<Refreshed> {
    let p = this.refreshing.get(mmUserId);
    if (!p) {
      p = this.refresh(mmUserId, cred).finally(() => this.refreshing.delete(mmUserId));
      this.refreshing.set(mmUserId, p);
    }
    return p;
  }

  private async refresh(mmUserId: string, cred: Cred): Promise<Refreshed> {
    const t = await refreshTokens(this.cfg, this.deps, cred.refresh);
    if (t === 'invalid_grant') {
      this.store.revokeUser(mmUserId);
      throw new Reauthorize(false);
    }
    return { ...t, saved: this.store.casMmCred(mmUserId, cred.version, t.access, t.refresh) };
  }

  private reauthorize(mmUserId: string, at: Attempt): never {
    this.store.revokeUser(mmUserId);
    throw new Reauthorize(at.sent);
  }

  private async send(at: Attempt, mmUserId: string, access: string, method: string, path: string, body: unknown): Promise<Response> {
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      // A timeout or reset may have reached Mattermost, so only failures before connecting count as unsent.
      if (!NOT_CONNECTED.includes((e as { cause?: { code?: string } })?.cause?.code ?? '')) at.sent = true;
      log('mm_api_failed', { ...fields, error: (e as Error)?.name, ms: this.deps.now() - started });
      throw new UpstreamUnavailable('Mattermost unreachable', at.sent);
    }
    at.sent = true;
    log('mm_api', { ...fields, status: res.status, ms: this.deps.now() - started });
    if (res.status >= 300 && res.status < 400) throw new UpstreamUnavailable(`unexpected redirect: ${res.status}`, true);
    return res;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 429) throw new RateLimited(retryAfterSec(res.headers), true);
    if (res.status >= 400 && res.status < 500) {
      const b = await res.json().catch(() => undefined);
      throw new MmError(res.status, str(b?.id), str(b?.message));
    }
    if (!res.ok) throw new UpstreamUnavailable(`Mattermost API failed: ${res.status}`, true);
    try {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      throw new UpstreamUnavailable('unreadable Mattermost response', true);
    }
  }
}

export class RateLimited extends Error {
  name = 'RateLimited';
  readonly retryAfterSec: number;
  readonly sent: boolean;
  constructor(retryAfterSec: number, sent: boolean) {
    super(`rate limited; retry after ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
    this.sent = sent;
  }
}

export type Release = () => void;
export type LimiterOpts = { perUserConcurrency: number; globalConcurrency: number; perUserPerMin: number; globalPerMin: number };
type Usage = { active: number; hits: number[] };

const WINDOW_MS = 60_000;

function prune(hits: number[], now: number): void {
  while (hits.length && hits[0] <= now - WINDOW_MS) hits.shift();
}

const waitSec = (hits: number[], now: number) => Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000));

export class Limiter {
  private readonly opts: LimiterOpts;
  private readonly now: () => number;
  // Entries are never removed: their number is bounded by the Mattermost user count.
  private readonly users = new Map<string, Usage>();
  private readonly all: Usage = { active: 0, hits: [] };

  constructor(opts: LimiterOpts, now: () => number) {
    this.opts = opts;
    this.now = now;
  }

  acquire(mmUserId: string): Release {
    const now = this.now();
    const u = this.usage(mmUserId);
    prune(u.hits, now);
    prune(this.all.hits, now);
    if (u.active >= this.opts.perUserConcurrency || this.all.active >= this.opts.globalConcurrency) throw new RateLimited(1, false);
    if (u.hits.length >= this.opts.perUserPerMin) throw new RateLimited(waitSec(u.hits, now), false);
    if (this.all.hits.length >= this.opts.globalPerMin) throw new RateLimited(waitSec(this.all.hits, now), false);
    for (const x of [u, this.all]) {
      x.active++;
      x.hits.push(now);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      u.active--;
      this.all.active--;
    };
  }

  // Not rejecting: the extra request belongs to a call that already passed acquire and is half done.
  charge(mmUserId: string): void {
    const now = this.now();
    this.usage(mmUserId).hits.push(now);
    this.all.hits.push(now);
  }

  private usage(mmUserId: string): Usage {
    let u = this.users.get(mmUserId);
    if (!u) this.users.set(mmUserId, (u = { active: 0, hits: [] }));
    return u;
  }
}

import { expect, test } from 'vitest';
import { Limiter, RateLimited } from '../../src/mattermost/limiter.ts';

const opts = { perUserConcurrency: 4, globalConcurrency: 16, perUserPerMin: 120, globalPerMin: 600 } as const;

function rejected(f: () => unknown): RateLimited {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RateLimited);
    return e as RateLimited;
  }
  throw new Error('expected RateLimited');
}

test('limiter rejects immediately beyond per-user and global limits', () => {
  let t = 0;
  const l = new Limiter(opts, () => t);

  const u1 = [1, 2, 3, 4].map(() => l.acquire('u1'));
  const busy = rejected(() => l.acquire('u1'));
  expect(busy.sent).toBe(false);
  expect(busy.retryAfterSec).toBeGreaterThanOrEqual(1);
  u1[0]();
  u1[0]();
  l.acquire('u1');
  rejected(() => l.acquire('u1'));

  const others = Array.from({ length: 12 }, (_, i) => l.acquire(`v${i % 4}`));
  rejected(() => l.acquire('w'));
  others.forEach((r) => r());

  const l2 = new Limiter(opts, () => t);
  for (let i = 0; i < 120; i++) l2.acquire('u1')();
  t = 30_000;
  expect(rejected(() => l2.acquire('u1')).retryAfterSec).toBe(30);
  for (let i = 0; i < 480; i++) l2.acquire(`v${i % 5}`)();
  expect(rejected(() => l2.acquire('w')).retryAfterSec).toBe(30);
  t = 60_000;
  l2.acquire('u1')();
  l2.acquire('w')();
});

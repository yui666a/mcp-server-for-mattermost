import { z } from 'zod';

export type PageCursor<K> = { as_of: number; checked_at: number; last: K };
export type PageRow<K> = { key: K; updatedAt: number };
export type PageResult<R, K> = { updated: R[]; body: R[]; rest: number; next?: PageCursor<K> };

// Lagging behind the page start: Mattermost's clock and ours may disagree, and a row updated in that gap must still count as updated.
const LAG_MS = 5000;

export const pageCursor = <S extends z.ZodType>(key: S) => z.object({ as_of: z.number().int(), checked_at: z.number().int(), last: key });

export function paginate<K, R extends PageRow<K>>(
  rows: R[], compare: (a: K, b: K) => number, cursor: PageCursor<K> | undefined, limit: number, startedAt: number,
): PageResult<R, K> {
  const base = startedAt - LAG_MS;
  const updated = cursor
    ? rows.filter((r) => r.updatedAt > cursor.checked_at).sort((a, b) => b.updatedAt - a.updatedAt || compare(a.key, b.key))
    : [];
  if (updated.length > limit) return { updated: updated.slice(0, limit), body: [], rest: updated.length - limit };
  const remaining = (cursor ? rows.filter((r) => r.updatedAt <= cursor.as_of && compare(r.key, cursor.last) > 0) : [...rows]).sort((a, b) => compare(a.key, b.key));
  const body = remaining.slice(0, limit - updated.length);
  const last = body.at(-1)?.key ?? cursor?.last;
  const next = remaining.length > body.length && last !== undefined
    ? { as_of: cursor?.as_of ?? base, checked_at: base, last }
    : undefined;
  return { updated, body, rest: 0, next };
}

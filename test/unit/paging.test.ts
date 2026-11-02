import { describe, expect, test } from 'vitest';
import { paginate, type PageCursor } from '../../src/mcp/paging.ts';

type Key = { t: number; id: string };
type Row = { key: Key; updatedAt: number; id: string };
const byNewest = (a: Key, b: Key) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const row = (id: string, t: number): Row => ({ id, key: { t, id }, updatedAt: t });
const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

const NOW = 1_000_000;

describe('paginate', () => {
  test('the first page takes rows from the head of the key order, without filtering by time', () => {
    const rows = [row('b', 500), row('a', NOW + 10), row('c', 400), row('d', 300)];
    const p = paginate(rows, byNewest, undefined, 3, NOW);
    expect(ids(p.body)).toEqual(['a', 'b', 'c']);
    expect(p.updated).toEqual([]);
    expect(p.rest).toBe(0);
    expect(p.next).toEqual({ as_of: NOW - 5000, checked_at: NOW - 5000, last: { t: 400, id: 'c' } });
  });

  test('the base time is the page start minus 5 seconds', () => {
    const p = paginate([row('a', 2), row('b', 1)], byNewest, undefined, 1, 123_456);
    expect(p.next?.as_of).toBe(118_456);
    const q = paginate([row('a', 2), row('b', 1)], byNewest, p.next, 1, 200_000);
    expect(q.next).toBeUndefined();
    const r = paginate([row('a', 2), row('b', 1), row('c', 0)], byNewest, p.next, 1, 200_000);
    expect(r.next).toEqual({ as_of: 118_456, checked_at: 195_000, last: { t: 1, id: 'b' } });
  });

  test('later pages continue after the last key and leave out rows updated after as_of', () => {
    const cursor: PageCursor<Key> = { as_of: 1000, checked_at: 1000, last: { t: 800, id: 'b' } };
    const rows = [row('a', 900), row('b', 800), row('c', 700), row('c2', 700), row('moved', 1500), row('d', 600)];
    const p = paginate(rows, byNewest, cursor, 4, NOW);
    expect(ids(p.body)).toEqual(['c', 'c2', 'd']);
    expect(ids(p.updated)).toEqual(['moved']);
  });

  test('the updated section holds rows updated after checked_at, newest first, and counts against the limit', () => {
    const cursor: PageCursor<Key> = { as_of: 1000, checked_at: 2000, last: { t: 900, id: 'a' } };
    const rows = [row('old-move', 1500), row('u1', 2100), row('u2', 2500), row('x', 800), row('y', 700), row('z', 600)];
    const p = paginate(rows, byNewest, cursor, 4, NOW);
    expect(ids(p.updated)).toEqual(['u2', 'u1']);
    expect(ids(p.body)).toEqual(['x', 'y']);
    expect(p.next).toEqual({ as_of: 1000, checked_at: NOW - 5000, last: { t: 700, id: 'y' } });
  });

  test('when the updated section overflows the limit, it reports how many are left and gives no next cursor', () => {
    const cursor: PageCursor<Key> = { as_of: 1000, checked_at: 1000, last: { t: 900, id: 'a' } };
    const rows = [row('u1', 1100), row('u2', 1200), row('u3', 1300), row('x', 800)];
    const p = paginate(rows, byNewest, cursor, 2, NOW);
    expect(ids(p.updated)).toEqual(['u3', 'u2']);
    expect(p.body).toEqual([]);
    expect(p.rest).toBe(1);
    expect(p.next).toBeUndefined();
  });

  test('an updated section that exactly fills the limit keeps the body position for the next page', () => {
    const cursor: PageCursor<Key> = { as_of: 1000, checked_at: 1000, last: { t: 900, id: 'a' } };
    const p = paginate([row('u1', 1100), row('x', 800)], byNewest, cursor, 1, NOW);
    expect(ids(p.updated)).toEqual(['u1']);
    expect(p.rest).toBe(0);
    expect(p.next).toEqual({ as_of: 1000, checked_at: NOW - 5000, last: { t: 900, id: 'a' } });
  });

  test('gives no next cursor once the body runs out', () => {
    const p = paginate([row('a', 2), row('b', 1)], byNewest, undefined, 2, NOW);
    expect(ids(p.body)).toEqual(['a', 'b']);
    expect(p.next).toBeUndefined();
  });

  test('a row that moves to the front between pages, and again later, is not lost', () => {
    const rows = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => [id, row(id, 100 - i)]));
    const update = (id: string, t: number) => rows.set(id, row(id, t));
    const seen = new Set<string>();
    let clock = 10_000;
    let cursor: PageCursor<Key> | undefined;
    const page = () => {
      const p = paginate([...rows.values()], byNewest, cursor, 2, clock);
      for (const r of [...p.updated, ...p.body]) seen.add(r.id);
      cursor = p.next;
      clock += 10_000;
      return p;
    };
    expect(ids(page().body)).toEqual(['a', 'b']);
    update('e', clock - 1000);
    expect(ids(page().updated)).toEqual(['e']);
    update('f', clock - 9000);
    update('e', clock - 1000);
    expect(ids(page().updated)).toEqual(['e', 'f']);
    while (cursor) page();
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  describe('with a composite key mixing two kinds of rows (as get_unreads uses)', () => {
    type UKey = { section: 0 | 1; mention: 0 | 1; t: number; id: string };
    type URow = { key: UKey; updatedAt: number; id: string };
    const cmp = (a: UKey, b: UKey) => a.section - b.section || a.mention - b.mention || b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const ch = (id: string, t: number, mentioned: boolean): URow => ({ id, updatedAt: t, key: { section: 0, mention: mentioned ? 0 : 1, t, id } });
    const th = (id: string, t: number): URow => ({ id, updatedAt: t, key: { section: 1, mention: 0, t, id } });

    test('the body runs channels (mentioned first) then threads, across the section boundary', () => {
      const rows = [th('t1', 900), ch('c1', 800, false), ch('c2', 700, true), th('t2', 950)];
      const first = paginate(rows, cmp, undefined, 2, NOW);
      expect(ids(first.body)).toEqual(['c2', 'c1']);
      const second = paginate(rows, cmp, first.next, 2, NOW);
      expect(ids(second.body)).toEqual(['t2', 't1']);
      expect(second.next).toBeUndefined();
    });

    test('the updated section mixes both kinds, newest first, wherever the body is', () => {
      const cursor: PageCursor<UKey> = { as_of: 1000, checked_at: 1000, last: { section: 1, mention: 0, t: 900, id: 't1' } };
      const rows = [ch('c1', 1200, false), th('t3', 1300), ch('c2', 1100, true), th('t2', 800)];
      const p = paginate(rows, cmp, cursor, 10, NOW);
      expect(ids(p.updated)).toEqual(['t3', 'c1', 'c2']);
      expect(ids(p.body)).toEqual(['t2']);
    });
  });
});

import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { every, tick } from '../../src/scheduler.ts';
import { makeApp, SLOW, SLOW_TEST } from './helpers.ts';

type Route = (req: Request, body: any) => unknown;
let routes: Record<string, Route>;
let hits: string[];
let writes: string[];

const NOW = Date.UTC(2026, 10, 2, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const UID = 'u1';
const UID2 = 'u2';
const CH = 'c'.repeat(26);
const ROOT = 'r'.repeat(26);
const REAUTH = 'Mattermost への再ログインが必要です。コネクタを再接続してください。';
const UNKNOWN = '投稿されたか不明です。Mattermost の画面で確かめてください。';
const LATE = '予定時刻を 1 時間過ぎたため投稿していません。';

const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
const timedOut = () => { throw new TypeError('fetch failed'); };
const mmError = (status: number, id: string, message = 'refused') => Response.json({ id, message }, { status });
const postList = (...posts: object[]) => ({ order: posts.map((p: any) => p.id), posts: Object.fromEntries(posts.map((p: any) => [p.id, p])) });
const mine = (id: string, over: object = {}) => ({ id, user_id: UID, channel_id: CH, root_id: '', message: 'hello', create_at: NOW, ...over });

beforeEach(() => {
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  hits = [];
  let n = 0;
  routes = { 'POST /posts': () => ({ id: `post${++n}`.padEnd(26, 'x') }) };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Not a plain 401: a call that got only 401 counts as not sent, so the 503 is what makes this a re-login after Mattermost may have handled the post.
function sentThenRelogin(store: { putMmCred: (u: string, a: string, r: string) => void }) {
  routes['POST /oauth/access_token'] = () => { store.putMmCred(UID, 'aC', 'rC'); return Response.json({ access_token: 'a2', refresh_token: 'r2' }); };
  routes['POST /posts'] = (req) => (req.headers.get('authorization') === 'Bearer a2' ? Response.json({ id: 'x' }, { status: 503 }) : new Response(null, { status: 401 }));
}

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname.replace('/api/v4', '')}`;
    hits.push(key + url.search);
    const body = req.method === 'POST' && key === 'POST /posts' ? await req.json() : undefined;
    const r = routes[key];
    if (!r) return Response.json({ id: 'not_found' }, { status: 404 });
    const out = await r(req, body);
    return out instanceof Response ? out : Response.json(out, { status: req.method === 'POST' ? 201 : 200 });
  });
  const { store, mm } = ctx;
  store.putMmCred(UID, 'mm-access', 'mm-refresh');
  store.putMmCred(UID2, 'mm-access', 'mm-refresh');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const row = (id: string) => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id) as Record<string, any>;
  const set = (id: string, sql: string, ...p: (string | number | null)[]) => db.prepare(`UPDATE scheduled_posts SET ${sql} WHERE id = ?`).run(...p, id);
  const make = (over: { mmUserId?: string; rootId?: string; message?: string; scheduledAt?: number; fileIds?: string[] } = {}) =>
    store.createScheduled({ mmUserId: UID, channelId: CH, message: 'hello', scheduledAt: NOW, ...over }, NOW - HOUR / 2)!;
  const run = (now = NOW) => tick(store, mm, now);
  const posts = () => hits.filter((h) => h === 'POST /posts');
  return { ...ctx, db, row, set, make, run, posts };
}

describe('a due schedule is posted with the user\'s token', () => {
  test('posts with the row\'s pending_post_id, then records the post and the time of the first attempt', async () => {
    const s = setup();
    let sent: any;
    routes['POST /posts'] = (_req, body) => { sent = body; return { id: 'p'.repeat(26) }; };
    const id = s.make({ message: 'secret body' });
    await s.run();
    const r = s.row(id);
    expect(sent).toEqual({ channel_id: CH, message: 'secret body', pending_post_id: r.pending_post_id });
    expect(r).toMatchObject({ status: 'posted', post_id: 'p'.repeat(26), first_attempt_at: NOW, error: null });
    expect(writes.join('')).not.toContain('secret body');
  });

  test('posts a reply to the root the schedule was made for', async () => {
    const s = setup();
    let sent: any;
    routes['POST /posts'] = (_req, body) => { sent = body; return { id: 'p'.repeat(26) }; };
    s.make({ rootId: ROOT });
    await s.run();
    expect(sent.root_id).toBe(ROOT);
  });

  test('leaves a schedule whose time has not come', async () => {
    const s = setup();
    const id = s.make({ scheduledAt: NOW + SEC });
    await s.run();
    expect(hits).toEqual([]);
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: null });
  });

  test('handles at most 20 schedules per tick across all users, and the rest on the next tick', async () => {
    const s = setup();
    for (let i = 0; i < 13; i++) s.make();
    for (let i = 0; i < 12; i++) s.make({ mmUserId: UID2 });
    await s.run();
    expect(s.posts()).toHaveLength(20);
    await s.run();
    expect(s.posts()).toHaveLength(25);
  });
});

test('schedules that keep failing for a while go behind ones not yet tried, so one user cannot hold every slot of a tick', async () => {
  const s = setup();
  routes['POST /posts'] = (_req, body) => (body.message === 'stuck' ? refused() : { id: 'p'.repeat(26) });
  for (let i = 0; i < 20; i++) s.make({ message: 'stuck', scheduledAt: NOW - MIN });
  const later = s.make({ mmUserId: UID2, message: 'later', scheduledAt: NOW });
  await s.run();
  expect(s.row(later)).toMatchObject({ status: 'pending' });
  vi.setSystemTime(NOW + MIN);
  await s.run(NOW + MIN);
  expect(s.row(later)).toMatchObject({ status: 'posted' });
});

describe('a refusal fails the schedule without retrying, with a reason for the user', () => {
  const cases: [string, () => Response, string][] = [
    ['archived channel', () => mmError(400, 'api.post.create_post.can_not_post_to_deleted.error'), 'チャンネルがアーカイブされたため投稿していません。'],
    ['no permission (left the channel)', () => mmError(403, 'api.context.permissions.app_error'), 'このチャンネルに投稿する権限がありません（チャンネルから抜けた、権限が変わった、など）。'],
    ['deleted root', () => mmError(400, 'api.post.create_post.root_id.app_error'), '返信先のスレッドの親投稿が削除されたため投稿していません。'],
    ['other 4xx keeps Mattermost\'s message', () => mmError(400, 'some.other.error', 'Invalid foo.'), 'Mattermost がエラーを返しました（400）: Invalid foo.'],
  ];
  for (const [name, answer, reason] of cases) {
    test(name, async () => {
      const s = setup();
      routes['POST /posts'] = answer;
      const id = s.make();
      await s.run();
      expect(s.row(id)).toMatchObject({ status: 'failed', error: reason });
      await s.run();
      expect(s.posts()).toHaveLength(1);
    });
  }

  test('re-login needed before anything was sent', async () => {
    const s = setup();
    s.store.revokeUser(UID);
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', error: REAUTH });
    expect(hits).toEqual([]);
  });

  test('re-login needed after Mattermost may have handled the post tells the user it may have been posted', async () => {
    const s = setup();
    sentThenRelogin(s.store);
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('re-login needed when Mattermost only answered 401 fails with the re-login reason, since nothing was posted', async () => {
    const s = setup();
    routes['POST /posts'] = () => { s.store.revokeUser(UID); return new Response(null, { status: 401 }); };
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', first_attempt_at: null });
    expect(s.row(id).error).toContain('再ログイン');
  });
});

describe('a temporary failure puts the schedule back to pending for the next tick', () => {
  test('certainly not sent on the first attempt: forgets the attempt so the user can still change or cancel it', async () => {
    const s = setup();
    routes['POST /posts'] = refused;
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: null, pending_post_id: null });
    expect(s.store.updateScheduled(UID, id, { message: 'changed' }, NOW)).toBeDefined();
  });

  test('a rate limit is treated as not sent', async () => {
    const s = setup();
    routes['POST /posts'] = () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '5' } });
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: null });
  });

  test('maybe sent: keeps the attempt, so the row can no longer be changed', async () => {
    const s = setup();
    routes['POST /posts'] = timedOut;
    const id = s.make();
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: NOW });
    expect(s.row(id).pending_post_id).toBeTruthy();
    expect(s.store.updateScheduled(UID, id, { message: 'changed' }, NOW)).toBeUndefined();
    expect(s.store.cancelScheduled(UID, id)).toBe(false);
  });

  test('certainly not sent on a retry: keeps the earlier attempt and its pending_post_id', async () => {
    const s = setup();
    routes['POST /posts'] = timedOut;
    routes[`GET /channels/${CH}/posts`] = () => postList();
    const id = s.make();
    await s.run();
    const first = s.row(id);
    routes['POST /posts'] = refused;
    vi.setSystemTime(NOW + MIN);
    await s.run(NOW + MIN);
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: NOW, pending_post_id: first.pending_post_id });
  });
});

describe('a retry after an unknown outcome looks for the earlier post first', () => {
  function attempted(s: ReturnType<typeof setup>, over: Parameters<ReturnType<typeof setup>['make']>[0] = {}) {
    const id = s.make(over);
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    return id;
  }

  test('a retry whose post gets only 401 before a re-login fails with the re-login reason and keeps the attempt and its files', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList();
    routes['POST /posts'] = () => { s.store.revokeUser(UID); return new Response(null, { status: 401 }); };
    const F1 = 'f'.repeat(26);
    const id = attempted(s, { fileIds: [F1] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed' });
    expect(s.row(id).error).toContain('再ログイン');
    expect(s.row(id).first_attempt_at).not.toBeNull();
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([{ fileId: F1, scheduledId: id }]);
  });

  test('finds the earlier post from the first attempt on and records it without posting again', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('found'.padEnd(26, 'x')));
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(hits).toEqual([`GET /channels/${CH}/posts?since=${NOW - 1}`]);
    expect(s.row(id)).toMatchObject({ status: 'posted', post_id: 'found'.padEnd(26, 'x') });
  });

  test.each([
    [2, 'posted'],
    [1, 'failed'],
  ])('a retry with files that finds the earlier post with its files hidden (ABAC) and %i counted ends %s', async (count, status) => {
    const s = setup();
    const F1 = 'f'.repeat(26);
    const F2 = 'g'.repeat(26);
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('found'.padEnd(26, 'x'), { file_ids: [], metadata: { redacted_file_count: count } }));
    const id = attempted(s, { fileIds: [F1, F2] });
    await s.run(NOW + MIN);
    expect(s.row(id).status).toBe(status);
    if (status === 'posted') expect(s.store.heldScheduledFiles(UID, [F1, F2])).toHaveLength(2);
    else expect(s.row(id).error).toBe(UNKNOWN);
    expect(hits.filter((h) => h === 'POST /posts')).toEqual([]);
  });

  test('posts again with the same pending_post_id when nothing is found', async () => {
    const s = setup();
    let sent: any;
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('other'.padEnd(26, 'x'), { message: 'different' }));
    routes['POST /posts'] = (_req, body) => { sent = body; return { id: 'p'.repeat(26) }; };
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(sent.pending_post_id).toBe('pending-1');
    expect(s.row(id)).toMatchObject({ status: 'posted', post_id: 'p'.repeat(26) });
  });

  const deletedWithMessageEmptiedByMattermost = (id: string, over: object = {}) => mine(id, { message: '', file_ids: [], delete_at: NOW + SEC, ...over });

  test('does not post when only a deleted post of the user\'s in the same thread exists since the first attempt, and fails as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(deletedWithMessageEmptiedByMattermost('gone'.padEnd(26, 'x')));
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('posts again when no deleted post counts: another user\'s, another thread\'s, from before the first attempt, or one another schedule recorded', async () => {
    const s = setup();
    const owned = 'owned'.padEnd(26, 'x');
    const other = s.make();
    s.set(other, "status = 'posted', post_id = ?", owned);
    routes[`GET /channels/${CH}/posts`] = () => postList(
      deletedWithMessageEmptiedByMattermost('a'.repeat(26), { user_id: 'x'.repeat(26) }),
      deletedWithMessageEmptiedByMattermost('b'.repeat(26), { root_id: ROOT }),
      deletedWithMessageEmptiedByMattermost('c'.repeat(26), { create_at: NOW - 1 }),
      deletedWithMessageEmptiedByMattermost(owned),
    );
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(1);
    expect(s.row(id)).toMatchObject({ status: 'posted' });
  });

  const editedByUser = (id: string, over: object = {}) => mine(id, { message: 'hello, edited', edit_at: NOW + 2 * SEC, ...over });

  test('does not post when the user edited a post in the same thread since the first attempt, and fails as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(editedByUser('edited'.padEnd(26, 'x')));
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('posts again when no edited post counts: another user\'s, another thread\'s, from before the first attempt, or one another schedule recorded', async () => {
    const s = setup();
    const owned = 'owned'.padEnd(26, 'x');
    const other = s.make();
    s.set(other, "status = 'posted', post_id = ?", owned);
    routes[`GET /channels/${CH}/posts`] = () => postList(
      editedByUser('a'.repeat(26), { user_id: 'x'.repeat(26) }),
      editedByUser('b'.repeat(26), { root_id: ROOT }),
      editedByUser('c'.repeat(26), { create_at: NOW - 1 }),
      editedByUser(owned),
    );
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(1);
    expect(s.row(id)).toMatchObject({ status: 'posted' });
  });

  test('does not take a post that another schedule with the same text already recorded', async () => {
    const s = setup();
    const taken = 'taken'.padEnd(26, 'x');
    const other = s.make();
    s.set(other, "status = 'posted', post_id = ?", taken);
    routes[`GET /channels/${CH}/posts`] = () => postList(mine(taken));
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(1);
    expect(s.row(id).post_id).not.toBe(taken);
  });

  test('a lookup that fails for a while puts the schedule back to pending, keeping the attempt', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => new Response(null, { status: 503 });
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'pending', first_attempt_at: NOW });
  });

  test('a lookup that Mattermost refuses fails the schedule as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => mmError(403, 'api.context.permissions.app_error');
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('a schedule left sending past the 30 second grace (a crash mid-post) is retried', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('found'.padEnd(26, 'x')));
    const stale = attempted(s);
    s.set(stale, "status = 'sending', updated_at = ?", NOW - 30 * SEC);
    const recent = attempted(s, { message: 'recent' });
    s.set(recent, "status = 'sending', updated_at = ?", NOW - 29 * SEC);
    await s.run();
    expect(s.row(stale)).toMatchObject({ status: 'posted', post_id: 'found'.padEnd(26, 'x') });
    expect(s.row(recent)).toMatchObject({ status: 'sending' });
  });
});

describe('a schedule more than an hour late is not newly posted', () => {
  test('never attempted: fails without calling Mattermost', async () => {
    const s = setup();
    const id = s.make();
    await s.run(NOW + HOUR + 1);
    expect(hits).toEqual([]);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: LATE });
  });

  test('attempted and found: recorded as posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('found'.padEnd(26, 'x')));
    const id = s.make();
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    await s.run(NOW + HOUR + 1);
    expect(s.row(id)).toMatchObject({ status: 'posted', post_id: 'found'.padEnd(26, 'x') });
  });

  test('attempted and not found: fails as late without posting', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList();
    const id = s.make();
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    await s.run(NOW + HOUR + 1);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: LATE });
  });

  test('attempted and only a deleted post of the user\'s is found: fails as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('gone'.padEnd(26, 'x'), { message: '', file_ids: [], delete_at: NOW + SEC }));
    const id = s.make();
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    await s.run(NOW + HOUR + 1);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('attempted and the lookup fails: fails as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => new Response(null, { status: 503 });
    const id = s.make();
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    await s.run(NOW + HOUR + 1);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });
});

describe('a schedule changed while the tick is running', () => {
  function actOnSecondWhileFirstIsPosting(act: (s: ReturnType<typeof setup>, second: string) => void) {
    const s = setup();
    const sent: any[] = [];
    let second = '';
    routes['POST /posts'] = (_req, body) => {
      sent.push(body);
      if (sent.length === 1) act(s, second);
      return { id: `p${sent.length}`.padEnd(26, 'x') };
    };
    s.make({ message: 'first', scheduledAt: NOW - SEC });
    second = s.make({ message: 'second' });
    return { s, sent, second };
  }

  test('postponed: not posted', async () => {
    const { s, sent, second } = actOnSecondWhileFirstIsPosting((s, id) => s.store.updateScheduled(UID, id, { scheduledAt: NOW + HOUR }, NOW));
    await s.run();
    expect(sent.map((b) => b.message)).toEqual(['first']);
    expect(s.row(second)).toMatchObject({ status: 'pending', first_attempt_at: null });
  });

  test('cancelled: not posted', async () => {
    const { s, sent } = actOnSecondWhileFirstIsPosting((s, id) => s.store.cancelScheduled(UID, id));
    await s.run();
    expect(sent.map((b) => b.message)).toEqual(['first']);
  });

  test('message changed: posted with the new message', async () => {
    const { s, sent } = actOnSecondWhileFirstIsPosting((s, id) => s.store.updateScheduled(UID, id, { message: 'changed' }, NOW));
    await s.run();
    expect(sent.map((b) => b.message)).toEqual(['first', 'changed']);
  });
});

test('a schedule whose message cannot be decrypted (TOKEN_ENC_KEY was made again) fails without calling Mattermost, asking to schedule it again', async () => {
  const s = setup();
  const id = s.make();
  s.set(id, 'message_sealed = ?', 'not-a-sealed-value');
  await s.run();
  expect(hits).toEqual([]);
  expect(s.row(id)).toMatchObject({ status: 'failed', error: '本文を復号できないため投稿していません。予約を入れ直してください。', first_attempt_at: null });
});

describe('an unexpected error fails only that schedule', () => {
  test('after the post was sent: maybe posted; a row that cannot be decrypted: asks to schedule again; the others are still posted', async () => {
    const s = setup();
    routes['POST /posts'] = (_req, body) => (body.message === 'broken reply' ? new Response('', { status: 201 }) : { id: 'p'.repeat(26) });
    const sentBroken = s.make({ message: 'broken reply', scheduledAt: NOW - 2 * SEC });
    const sealed = s.make({ message: 'sealed', scheduledAt: NOW - SEC });
    s.set(sealed, 'message_sealed = ?', 'not-a-sealed-value');
    const fine = s.make({ message: 'fine' });
    await s.run();
    expect(s.row(sentBroken)).toMatchObject({ status: 'failed', error: UNKNOWN });
    expect(s.row(sentBroken).first_attempt_at).not.toBeNull();
    expect(s.row(sealed)).toMatchObject({ status: 'failed', error: '本文を復号できないため投稿していません。予約を入れ直してください。' });
    expect(s.row(fine)).toMatchObject({ status: 'posted' });
  });
});

test('the timer and a tool request share one refresh of the user\'s Mattermost token', async () => {
  const s = setup();
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const authed = (req: Request) => req.headers.get('authorization') === 'Bearer mm-access2';
  routes['POST /oauth/access_token'] = async () => { refreshes++; await gate; return { access_token: 'mm-access2', refresh_token: 'mm-refresh2' }; };
  routes['POST /posts'] = (req) => (authed(req) ? { id: 'p'.repeat(26) } : new Response(null, { status: 401 }));
  routes['GET /users/me'] = (req) => (authed(req) ? { id: UID, username: 'alice' } : new Response(null, { status: 401 }));
  const id = s.make();
  const ticking = s.run();
  const request = s.mm.call(UID, 'GET', '/users/me');
  await vi.waitFor(() => expect(refreshes).toBe(1), { ...SLOW, interval: 5 });
  release();
  await Promise.all([ticking, request]);
  expect(refreshes).toBe(1);
  expect(s.row(id)).toMatchObject({ status: 'posted' });
}, SLOW_TEST);

describe('a schedule with files', () => {
  const F1 = 'f'.repeat(26);
  const F2 = 'g'.repeat(26);
  const uploaded = (s: ReturnType<typeof setup>) => {
    for (const f of [F1, F2]) s.store.recordUploadedFile({ mmUserId: UID, channelId: CH }, f);
    return () => s.store.uploadedFiles(UID, [F1, F2]).map((f) => f.postId);
  };
  const attempted = (s: ReturnType<typeof setup>, over: Parameters<ReturnType<typeof setup>['make']>[0] = {}) => {
    const id = s.make(over);
    s.set(id, 'first_attempt_at = ?, pending_post_id = ?', NOW, 'pending-1');
    return id;
  };

  test('is posted with its file_ids, and the files are recorded as posted', async () => {
    const s = setup();
    const marks = uploaded(s);
    let sent: any;
    routes['POST /posts'] = (_req, body) => { sent = body; return { id: 'p'.repeat(26), file_ids: body.file_ids }; };
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(sent.file_ids).toEqual([F1, F2]);
    expect(s.row(id)).toMatchObject({ status: 'posted', post_id: 'p'.repeat(26), error: null });
    expect(marks()).toEqual(['p'.repeat(26), 'p'.repeat(26)]);
  });

  test('a post that lost files to Mattermost is posted with a note naming them, keeps only the kept files, and lets the dropped ones go', async () => {
    const s = setup();
    const marks = uploaded(s);
    routes['POST /posts'] = () => ({ id: 'p'.repeat(26), file_ids: [F2] });
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'posted', error: `添付した 2 件のうち 1 件（${F1}）を Mattermost が外したため、投稿に付いていません。` });
    expect(s.store.listScheduled(UID, { limit: 10 }).find((r) => r.id === id)?.fileIds).toEqual([F2]);
    expect(marks()).toEqual([null, 'p'.repeat(26)]);
    expect(s.store.heldScheduledFiles(UID, [F1, F2])).toEqual([{ fileId: F2, scheduledId: id }]);
  });

  test('a post whose files Mattermost hid (ABAC) keeps every file as attached, with no note when all of them are counted', async () => {
    const s = setup();
    const marks = uploaded(s);
    routes['POST /posts'] = () => ({ id: 'p'.repeat(26), file_ids: [], metadata: { redacted_file_count: 2 } });
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'posted', error: null });
    expect(s.store.listScheduled(UID, { limit: 10 }).find((r) => r.id === id)?.fileIds).toEqual([F1, F2]);
    expect(marks()).toEqual(['p'.repeat(26), 'p'.repeat(26)]);
    expect(s.store.heldScheduledFiles(UID, [F1, F2])).toHaveLength(2);
  });

  test('a post whose files Mattermost hid but counted fewer notes how many were dropped, and still keeps them all', async () => {
    const s = setup();
    const marks = uploaded(s);
    routes['POST /posts'] = () => ({ id: 'p'.repeat(26), file_ids: [], metadata: { redacted_file_count: 1 } });
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(s.row(id).error).toBe('添付した 2 件のうち 1 件を Mattermost が外したため、投稿に付いていません（ファイルをダウンロードする権限が無いため、どれが外れたかは分かりません）。');
    expect(s.store.listScheduled(UID, { limit: 10 }).find((r) => r.id === id)?.fileIds).toEqual([F1, F2]);
    expect(marks()).toEqual(['p'.repeat(26), 'p'.repeat(26)]);
    expect(s.store.heldScheduledFiles(UID, [F1, F2])).toHaveLength(2);
  });

  test('a response that counts hidden files but still lists file_ids is read by its file_ids', async () => {
    const s = setup();
    const marks = uploaded(s);
    routes['POST /posts'] = () => ({ id: 'p'.repeat(26), file_ids: [F2], metadata: { redacted_file_count: 2 } });
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'posted', error: `添付した 2 件のうち 1 件（${F1}）を Mattermost が外したため、投稿に付いていません。` });
    expect(marks()).toEqual([null, 'p'.repeat(26)]);
    expect(s.store.listScheduled(UID, { limit: 10 }).find((r) => r.id === id)?.fileIds).toEqual([F2]);
    expect(s.store.heldScheduledFiles(UID, [F1, F2])).toEqual([{ fileId: F2, scheduledId: id }]);
  });

  const fileIdsOf = (s: ReturnType<typeof setup>, id: string) => s.store.listScheduled(UID, { limit: 10 }).find((r) => r.id === id)?.fileIds;

  test('a first attempt that Mattermost refuses fails, forgets the attempt, and lets its files go', async () => {
    const s = setup();
    routes['POST /posts'] = () => mmError(403, 'api.context.permissions.app_error');
    const id = s.make({ fileIds: [F1] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', first_attempt_at: null, pending_post_id: null });
    expect(fileIdsOf(s, id)).toEqual([F1]);
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([]);
  });

  test('a first attempt that needs re-login before anything was sent fails and lets its files go', async () => {
    const s = setup();
    s.store.revokeUser(UID);
    const id = s.make({ fileIds: [F1] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', error: REAUTH, first_attempt_at: null });
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([]);
  });

  test('a first attempt that needs re-login after Mattermost may have handled it fails as maybe posted and keeps its files', async () => {
    const s = setup();
    sentThenRelogin(s.store);
    const id = s.make({ fileIds: [F1] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
    expect(s.row(id).first_attempt_at).not.toBeNull();
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([{ fileId: F1, scheduledId: id }]);
  });

  test('a first attempt that only got 401 before the re-login fails, forgets the attempt and lets its files go', async () => {
    const s = setup();
    routes['POST /posts'] = () => { s.store.revokeUser(UID); return new Response(null, { status: 401 }); };
    const id = s.make({ fileIds: [F1] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'failed', first_attempt_at: null });
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([]);
  });

  test('a retry that Mattermost refuses fails but keeps the attempt and its files, since the earlier attempt may have posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList();
    routes['POST /posts'] = () => mmError(403, 'api.context.permissions.app_error');
    const id = attempted(s, { fileIds: [F1] });
    await s.run(NOW + MIN);
    expect(s.row(id)).toMatchObject({ status: 'failed', first_attempt_at: NOW, pending_post_id: 'pending-1' });
    expect(fileIdsOf(s, id)).toEqual([F1]);
    expect(s.store.heldScheduledFiles(UID, [F1])).toEqual([{ fileId: F1, scheduledId: id }]);
  });

  test('a schedule put back to pending after a temporary failure keeps its file_ids and its files', async () => {
    const s = setup();
    routes['POST /posts'] = () => new Response(null, { status: 503 });
    const id = s.make({ fileIds: [F1, F2] });
    await s.run();
    expect(s.row(id)).toMatchObject({ status: 'pending' });
    expect(fileIdsOf(s, id)).toEqual([F1, F2]);
    expect(s.store.heldScheduledFiles(UID, [F1, F2])).toHaveLength(2);
  });

  test('a retry that finds the earlier post with every file records the files without posting', async () => {
    const s = setup();
    const marks = uploaded(s);
    const found = 'found'.padEnd(26, 'x');
    routes[`GET /channels/${CH}/posts`] = () => postList(mine(found, { file_ids: [F1, F2] }), mine('nofile'.padEnd(26, 'x')));
    const id = attempted(s, { fileIds: [F1, F2] });
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'posted', post_id: found });
    expect(marks()).toEqual([found, found]);
  });

  test('a retry that finds only a post with the same text but other files does not post, and fails as maybe posted', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('dropped'.padEnd(26, 'x'), { file_ids: [F2] }));
    const id = attempted(s, { fileIds: [F1, F2] });
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('a schedule without files does not post again when the user posted the same text with a file since the first attempt', async () => {
    const s = setup();
    routes[`GET /channels/${CH}/posts`] = () => postList(mine('manual'.padEnd(26, 'x'), { file_ids: [F1] }));
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(0);
    expect(s.row(id)).toMatchObject({ status: 'failed', error: UNKNOWN });
  });

  test('posts again when no post with other files counts: another user\'s, another thread\'s, from before the first attempt, or one another schedule recorded', async () => {
    const s = setup();
    const owned = 'owned'.padEnd(26, 'x');
    const other = s.make();
    s.set(other, "status = 'posted', post_id = ?", owned);
    const withFile = (id: string, over: object = {}) => mine(id, { file_ids: [F1], ...over });
    routes[`GET /channels/${CH}/posts`] = () => postList(
      withFile('a'.repeat(26), { user_id: 'x'.repeat(26) }),
      withFile('b'.repeat(26), { root_id: ROOT }),
      withFile('c'.repeat(26), { create_at: NOW - 1 }),
      withFile(owned),
    );
    const id = attempted(s);
    await s.run(NOW + MIN);
    expect(s.posts()).toHaveLength(1);
    expect(s.row(id)).toMatchObject({ status: 'posted' });
  });

  test('a 403 names the upload permission too, only when the schedule has files', async () => {
    const s = setup();
    routes['POST /posts'] = () => mmError(403, 'api.context.permissions.app_error');
    const withFiles = s.make({ fileIds: [F1] });
    const without = s.make({ message: 'plain' });
    await s.run();
    expect(s.row(withFiles).error).toBe('このチャンネルに投稿する権限か、ファイルを添付する権限がありません（チャンネルから抜けた、権限が変わった、など）。');
    expect(s.row(without).error).toBe('このチャンネルに投稿する権限がありません（チャンネルから抜けた、権限が変わった、など）。');
  });
});

describe('every', () => {
  test('starts the next run only after the previous one ends, and keeps going after a run throws', async () => {
    let active = 0;
    let most = 0;
    let runs = 0;
    const stop = every(5, async () => {
      runs++;
      active++;
      most = Math.max(most, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (runs === 1) throw new TypeError('boom');
    });
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(3), { ...SLOW, interval: 5 });
    stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 50));
    expect(most).toBe(1);
    expect(runs).toBe(after);
    expect(writes.join('')).toContain('"name":"TypeError"');
  }, SLOW_TEST);
});

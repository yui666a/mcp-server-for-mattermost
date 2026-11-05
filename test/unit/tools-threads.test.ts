import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let hits: string[];
let urls: string[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  hits = [];
  urls = [];
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace('/api/v4', '');
    hits.push(`${req.method} ${path}`);
    urls.push(`${req.method} ${path}${url.search}`);
    const r = routes[`${req.method} ${path}`];
    if (!r) return Response.json({ id: 'not_found' }, { status: 404 });
    const out = await r(req);
    return out instanceof Response ? out : Response.json(out);
  });
  const code = ctx.store.createCode({
    mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: ctx.config.resource, scope: 'mattermost',
  });
  const rec = ctx.store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const { accessToken } = ctx.store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: ctx.config.resource, fromCodeHash: rec.codeHash });
  ctx.store.putMmCred('u1', 'mm-access', 'mm-refresh');
  const rpc = async (method: string, params: object) => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    return r.body;
  };
  // Argument validation failures come back either as an error result or as a JSON-RPC error, depending on the SDK version.
  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<{ name: string; description: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const T1 = '1'.repeat(26);
const T2 = '2'.repeat(26);
const CH1 = 'a'.repeat(26);
const CH2 = 'b'.repeat(26);
const DM = 'c'.repeat(26);
const ARCHIVED = 'd'.repeat(26);
const TH1 = 'k'.repeat(26);
const TH2 = 'm'.repeat(26);
const TH_DM = 'n'.repeat(26);
const TH_ARCH = 'p'.repeat(26);

const thread = (id: string, channel_id: string, last_reply_at: number, o: Record<string, unknown> = {}) => ({
  id, last_reply_at, reply_count: 3, unread_replies: 1, unread_mentions: 0,
  post: { id, user_id: 'u2', channel_id, root_id: '', message: `root ${id[0]}`, create_at: 100 }, ...o,
});
const page = (threads: unknown[], total = threads.length) => ({ total, total_unread_threads: 0, total_unread_mentions: 0, threads });
const order = (out: string) => [...out.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);
const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

describe('list_followed_threads', () => {
  const base = (crt = 'always_on'): Record<string, Route> => ({
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': () => Response.json({ id: 'app.preference.get.app_error', message: 'm', status_code: 400 }, { status: 400 }),
    'GET /users/me/teams': () => [{ id: T1, name: 'team-a' }, { id: T2, name: 'team-b' }],
    'GET /users/me/channels': () => [
      { id: CH1, name: 'one', display_name: 'One', team_id: T1, type: 'O' },
      { id: CH2, name: 'two', display_name: 'Two', team_id: T2, type: 'O' },
      { id: DM, name: 'u1__u3', display_name: '', team_id: '', type: 'D' },
    ],
    [`GET /users/u1/teams/${T1}/threads`]: () => page([thread(TH1, CH1, 5000, { unread_mentions: 2 }), thread(TH_DM, DM, 4000)]),
    [`GET /users/u1/teams/${T2}/threads`]: () => page([thread(TH2, CH2, 6000), thread(TH_ARCH, ARCHIVED, 3000)]),
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }, { id: 'u3', username: 'carol' }],
  });

  test('refuses without asking for threads when collapsed reply threads are off for the user', async () => {
    for (const crt of ['disabled', 'default_off']) {
      routes = base(crt);
      hits = [];
      const r = await setup().call('list_followed_threads', {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain('スレッドの折りたたみ（CRT）が無効なため、スレッドのフォローは画面にも通知にも効きません');
      expect(r.text).toContain('スレッドごとには止められず');
      expect(hits).toEqual(['GET /config/client', 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads'].slice(0, crt === 'disabled' ? 1 : 2));
    }
  });

  test('lists followed threads of every team newest reply first, taking DM threads from the first team only', async () => {
    routes = base();
    const { text: out } = await setup().call('list_followed_threads', {});
    expect(urls).toContain(`GET /users/u1/teams/${T1}/threads?per_page=200`);
    expect(urls).toContain(`GET /users/u1/teams/${T2}/threads?per_page=200&excludeDirect=true`);
    expect(order(out)).toEqual([TH2, TH1, TH_DM, TH_ARCH]);
    expect(out.split('\n').slice(0, 3)).toEqual([
      'スレッドの折りたたみ（CRT）: 有効（サーバー設定: always_on）',
      'フォロー中のスレッド: 4 件',
      'フォロー中のスレッド（最終返信の新しい順）:',
    ]);
    expect(out).toContain(`--- post_id: ${TH1}\n@bob | `);
    expect(out).toContain(`チーム: team-a（team_id: ${T1}） | チャンネル: channel_id: ${CH1}、name: one、表示名: One`);
    expect(out).toContain('返信: 3、未読の返信: 1、未読のメンション: 2、最終返信: 1970-01-01T00:00:05Z | 1970-01-01T09:00:05+09:00');
    expect(out).toContain(`https://mm.example/team-b/pl/${TH2}`);
    expect(out).toContain('（続きはありません）');
  });

  test('a thread whose replies were all deleted (last_reply_at 0) shows no last reply rather than 1970', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: () => page([thread(TH1, CH1, 0, { reply_count: 0 })]), [`GET /users/u1/teams/${T2}/threads`]: () => page([]) };
    const { text: out } = await setup().call('list_followed_threads', {});
    expect(out).toContain('最終返信: なし（返信がすべて削除された）');
    expect(out).not.toContain('最終返信: 1970');
  });

  test('shows a DM thread under the other user\'s name and a thread of a channel missing from the user\'s list by channel_id with the team it came from', async () => {
    routes = base();
    const { text: out } = await setup().call('list_followed_threads', {});
    expect(out).toContain(`チーム: なし（DM またはグループ DM） | チャンネル: channel_id: ${DM}、name: u1__u3、表示名: @carol`);
    expect(out).toContain(`--- post_id: ${TH_ARCH}\n@bob | 1970-01-01T00:00:00Z | 1970-01-01T09:00:00+09:00\nchannel_id: ${ARCHIVED}\n`);
    expect(out).toContain(`https://mm.example/team-b/pl/${TH_ARCH}`);
  });

  test('asks for archived channels too, and shows an archived channel\'s thread with its name marked archived and its team', async () => {
    routes = { ...base(), 'GET /users/me/channels': () => [
      { id: CH1, name: 'one', display_name: 'One', team_id: T1, type: 'O', delete_at: 0 },
      { id: CH2, name: 'two', display_name: 'Two', team_id: T2, type: 'O', delete_at: 0 },
      { id: DM, name: 'u1__u3', display_name: '', team_id: '', type: 'D', delete_at: 0 },
      { id: ARCHIVED, name: 'old', display_name: 'Old', team_id: T2, type: 'O', delete_at: 7000 },
    ] };
    const { text: out } = await setup().call('list_followed_threads', {});
    expect(urls).toContain('GET /users/me/channels?include_deleted=true');
    expect(out).toContain(`チーム: team-b（team_id: ${T2}） | チャンネル: channel_id: ${ARCHIVED}、name: old、アーカイブ済み、表示名: Old\n`);
    expect(out).toContain(`チャンネル: channel_id: ${CH1}、name: one、表示名: One`);
  });

  test('says where it stopped when a team follows more threads than one page returns', async () => {
    const full = (last: (i: number) => number) => Array.from({ length: 200 }, (_, i) => thread(`f${String(i).padStart(25, '0')}`, CH2, last(i)));
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => page(full((i) => 9000 - i), 450) };
    const { text: out } = await setup().call('list_followed_threads', {});
    expect(out).toContain('フォロー中のスレッド: 452 件');
    expect(out).toContain('（team-b のフォロー中のスレッドは、最終返信の新しい 200 件だけを取得しています（total: 450）。最終返信が 1970-01-01T00:00:08Z | 1970-01-01T09:00:08+09:00 以前のスレッドは出ていないことがあります）');
    expect(out).not.toContain('team-a と DM、グループ DM の');
    routes[`GET /users/u1/teams/${T2}/threads`] = () => page(full((i) => (i < 199 ? 9000 - i : 0)), 450);
    const zero = (await setup().call('list_followed_threads', {})).text;
    expect(zero).toContain('最終返信の新しい 200 件だけを取得しています（total: 450）。返信がすべて削除されたほかのスレッドは出ていないことがあります）');
    expect(zero).not.toContain('（total: 450）。最終返信が');
  });

  test('says a short page under a larger total holds follows the list cannot return, not that it stopped', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: () => page([thread(TH1, CH1, 5000)], 3) };
    const out = (await setup().call('list_followed_threads', {})).text;
    expect(out).toContain('（team-a と DM、グループ DM の total: 3 のうち 2 件は一覧に出せません。データ保持ポリシーで根の投稿が消えたスレッドのフォロー（unfollow_thread でも外せません）か、取得の合間に増えたフォローです）');
    expect(out).not.toContain('だけを取得しています');
    routes[`GET /users/u1/teams/${T2}/threads`] = () => page([], 4);
    expect((await setup().call('list_followed_threads', {})).text).toContain('（team-b の total: 4 のうち 4 件は一覧に出せません。');
    const many = (n: number) => Array.from({ length: n }, (_, i) => thread(`f${String(i).padStart(25, '0')}`, CH2, 9000 - i));
    routes[`GET /users/u1/teams/${T2}/threads`] = () => page(many(199), 250);
    const short = (await setup().call('list_followed_threads', {})).text;
    expect(short).toContain('（team-b の total: 250 のうち 51 件は一覧に出せません。');
    expect(short).not.toContain('だけを取得しています');
    routes[`GET /users/u1/teams/${T2}/threads`] = () => page(many(200), 200);
    const exact = (await setup().call('list_followed_threads', {})).text;
    expect(exact).not.toContain('team-b の total');
    expect(exact).not.toContain('team-b のフォロー中のスレッドは');
  });

  test('looks up more than 1,000 users in calls of at most 1,000 ids, and names the users of every call', async () => {
    const user = (i: number, j: number) => `r${String(i * 20 + j).padStart(4, '0')}`;
    const many = Array.from({ length: 50 }, (_, i) => thread(`t${String(i).padStart(25, '0')}`, CH1, 9000 - i, {
      post: { id: `t${String(i).padStart(25, '0')}`, user_id: `a${i}`, channel_id: CH1, root_id: '', message: `m${i}`, create_at: 100,
        metadata: { reactions: Array.from({ length: 20 }, (_, j) => ({ user_id: user(i, j), emoji_name: j < 10 ? 'x' : 'y', create_at: j })) } },
    }));
    const asked: string[][] = [];
    routes = {
      ...base(),
      [`GET /users/u1/teams/${T1}/threads`]: () => page(many),
      [`GET /users/u1/teams/${T2}/threads`]: () => page([]),
      'POST /users/ids': async (req) => { const ids = await req.json() as string[]; asked.push(ids); return ids.map((x) => ({ id: x, username: `n${x}` })); },
    };
    const { text: out } = await setup().call('list_followed_threads', { limit: 50 });
    expect(asked.map((x) => x.length)).toEqual([1000, 50]);
    for (const x of asked[1]) expect(out).toContain(`@n${x}`);
  });

  test('takes limit up to 50 and pages with next_cursor', async () => {
    routes = base();
    const { call } = setup();
    expect((await call('list_followed_threads', { limit: 51 })).isError).toBe(true);
    const first = await call('list_followed_threads', { limit: 3 });
    expect(order(first.text)).toEqual([TH2, TH1, TH_DM]);
    const second = await call('list_followed_threads', { cursor: cursorIn(first.text) });
    expect(order(second.text)).toEqual([TH_ARCH]);
    expect(second.text).not.toContain('前のページの後に');
  });

  test('orders threads with the same last reply by id, so a page boundary between them neither skips nor repeats', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => page([thread(TH2, CH2, 5000), thread(TH_ARCH, ARCHIVED, 3000)]) };
    const { call } = setup();
    const first = await call('list_followed_threads', { limit: 1 });
    expect(order(first.text)).toEqual([TH1]);
    expect(order((await call('list_followed_threads', { cursor: cursorIn(first.text) })).text)).toEqual([TH2]);
  });

  test('rejects another tool\'s cursor', async () => {
    routes = base();
    const unreads = Buffer.from(JSON.stringify({ as_of: 1, checked_at: 1, last: { s: 1, m: 0, t: 5000, id: TH1 }, per_page: 30, crt: true })).toString('base64url');
    const r = await setup().call('list_followed_threads', { cursor: unreads });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('cursor が不正です');
  });

  test('puts threads with a reply after the previous page in a section before the rest', async () => {
    routes = base();
    const { call } = setup();
    const first = await call('list_followed_threads', { limit: 2 });
    const now = Date.now() + 60_000;
    routes[`GET /users/u1/teams/${T2}/threads`] = () => page([thread(TH_ARCH, ARCHIVED, now), thread(TH2, CH2, 6000)]);
    const second = await call('list_followed_threads', { cursor: cursorIn(first.text) });
    expect(second.text).toContain('前のページの後に返信があったスレッド（前のページまでに出したものを含むことがあります）:');
    expect(order(second.text)).toEqual([TH_ARCH, TH_DM]);
  });

  test('asks to start over without next_cursor when the threads replied to since the previous page do not fit', async () => {
    routes = base();
    const { call } = setup();
    const first = await call('list_followed_threads', { limit: 1 });
    const now = Date.now() + 60_000;
    routes[`GET /users/u1/teams/${T1}/threads`] = () => page([thread(TH1, CH1, now), thread(TH_DM, DM, now + 1)]);
    const second = await call('list_followed_threads', { cursor: cursorIn(first.text) });
    expect(order(second.text)).toEqual([TH_DM]);
    expect(second.text).toContain('（前のページの後に返信があったスレッドがほかに 1 件あり、このページに収まりませんでした。cursor を付けずに最初のページから取り直してください）');
    expect(cursorIn(second.text)).toBeUndefined();
  });

  test('says so when nothing is followed, and refuses when the user belongs to no team', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: () => page([]), [`GET /users/u1/teams/${T2}/threads`]: () => ({ total: 0, threads: null }) };
    expect((await setup().call('list_followed_threads', {})).text).toContain('フォロー中のスレッド: 0 件\nフォロー中のスレッドはありません。\n（続きはありません）');
    routes['GET /users/me/teams'] = () => [];
    const r = await setup().call('list_followed_threads', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('所属しているチームがないため');
  });

  test('is a read-only tool', async () => {
    routes = base();
    const t = (await setup().tools()).find((x) => x.name === 'list_followed_threads')!;
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.description).toContain('返信がまだないルート投稿は');
  });
});

describe('follow_thread and unfollow_thread', () => {
  const ROOT = 'r'.repeat(26);
  const REPLY = 's'.repeat(26);
  const base = (crt = 'always_on'): Record<string, Route> => ({
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    [`GET /posts/${ROOT}`]: () => ({ id: ROOT, user_id: 'u2', channel_id: CH1, root_id: '', message: 'root', create_at: 1, reply_count: 2 }),
    [`GET /posts/${REPLY}`]: () => ({ id: REPLY, user_id: 'u2', channel_id: CH1, root_id: ROOT, message: 'reply', create_at: 2, reply_count: 2 }),
    [`GET /channels/${CH1}`]: () => ({ id: CH1, team_id: T1, type: 'O' }),
    [`GET /channels/${CH1}/members/me`]: () => ({ channel_id: CH1, user_id: 'u1' }),
    'GET /users/me/teams': () => [{ id: T2, name: 'team-b' }],
    [`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]: () => ({ status: 'OK' }),
    [`DELETE /users/u1/teams/${T1}/threads/${ROOT}/following`]: () => ({ status: 'OK' }),
  });
  const writes = () => hits.filter((h) => h.startsWith('PUT') || h.startsWith('DELETE'));

  test('both refuse without touching the thread when collapsed reply threads are off', async () => {
    for (const name of ['follow_thread', 'unfollow_thread']) {
      routes = base('disabled');
      hits = [];
      const r = await setup().call(name, { post_id: ROOT });
      expect(r.isError, name).toBe(true);
      expect(r.text).toContain('スレッドの折りたたみ（CRT）が無効なため');
      expect(hits, name).toEqual(['GET /config/client']);
    }
  });

  test('follow_thread follows the root of the thread a reply belongs to, in the channel\'s team', async () => {
    routes = base();
    const r = await setup().call('follow_thread', { post_id: REPLY });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]);
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。`);
  });

  test('follow_thread leaves an already followed thread alone so its unread replies stay unread', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads/${ROOT}`]: () => ({ id: ROOT, unread_replies: 1 }) };
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）はすでにフォローしています。`);
    expect(writes()).toEqual([]);
  });

  test('follow_thread refuses a thread in a channel the user has not joined, whether Mattermost answers 403 or 404', async () => {
    for (const status of [403, 404]) {
      routes = { ...base(), [`GET /channels/${CH1}/members/me`]: () => Response.json({ id: status === 403 ? 'api.context.permissions.app_error' : 'app.channel.get_member.missing.app_error' }, { status }) };
      hits = [];
      const r = await setup().call('follow_thread', { post_id: ROOT });
      expect(r.isError, String(status)).toBe(true);
      expect(r.text).toContain(status === 404 ? 'このチャンネルに参加していません。' : 'このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。');
      expect(r.text).toContain('参加していないチャンネルのスレッドは、フォローしても一覧にも通知にも出ません。');
      if (status === 403) expect(r.text).toContain('続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
      expect(writes()).toEqual([]);
    }
  });

  const noReplies = (isFollowing?: boolean): Record<string, Route> => ({
    ...base(),
    [`GET /posts/${ROOT}`]: () => ({ id: ROOT, user_id: 'u2', channel_id: CH1, root_id: '', message: 'root', create_at: 1, reply_count: 0 }),
    [`GET /posts/${ROOT}/thread`]: () => ({ order: [ROOT], posts: { [ROOT]: { id: ROOT, ...(isFollowing === undefined ? {} : { is_following: isFollowing }) } } }),
  });

  test('follow_thread follows a root post without replies the user does not follow, and says it shows up in the list only after its first reply', async () => {
    for (const isFollowing of [undefined, false]) {
      routes = noReplies(isFollowing);
      hits = [];
      urls = [];
      const r = await setup().call('follow_thread', { post_id: ROOT });
      expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。\n返信がまだないため、最初の返信があるまで list_followed_threads には出ません。`);
      expect(writes(), String(isFollowing)).toEqual([`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]);
      expect(urls, String(isFollowing)).toContain(`GET /posts/${ROOT}/thread?collapsedThreads=true`);
    }
  });

  test('follow_thread leaves a followed root post without replies alone, telling it from the thread\'s is_following', async () => {
    routes = noReplies(true);
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）はすでにフォローしています。\n返信がまだないため、最初の返信があるまで list_followed_threads には出ません。`);
    expect(writes()).toEqual([]);
  });

  test('follow_thread does not say a followed thread whose replies were all deleted waits for its first reply', async () => {
    routes = { ...noReplies(), [`GET /users/u1/teams/${T1}/threads/${ROOT}`]: () => ({ id: ROOT, unread_replies: 0 }) };
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）はすでにフォローしています。`);
    expect(hits).not.toContain(`GET /posts/${ROOT}/thread`);
  });

  test('follow_thread does not say a thread whose replies were all deleted waits for its first reply, once it has a state after following', async () => {
    let follows = 0;
    routes = {
      ...noReplies(),
      [`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]: () => { follows++; return { status: 'OK' }; },
      [`GET /users/u1/teams/${T1}/threads/${ROOT}`]: () => follows ? { id: ROOT, unread_replies: 0 } : Response.json({ id: 'app.user.get_threads_for_user.not_found' }, { status: 404 }),
    };
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。`);
    expect(writes()).toEqual([`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]);
  });

  test.each([400, 500])('follow_thread still reports the follow when checking the state afterwards fails (%i)', async (status) => {
    let follows = 0;
    routes = {
      ...noReplies(),
      [`PUT /users/u1/teams/${T1}/threads/${ROOT}/following`]: () => { follows++; return { status: 'OK' }; },
      [`GET /users/u1/teams/${T1}/threads/${ROOT}`]: () => follows ? Response.json({ id: 'app.user.get_thread_membership_for_user.app_error' }, { status }) : Response.json({ id: 'app.user.get_threads_for_user.not_found' }, { status: 404 }),
    };
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.isError).toBe(false);
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。`);
  });

  test('follow_thread checks the state only once for a thread with replies', async () => {
    routes = base();
    await setup().call('follow_thread', { post_id: ROOT });
    expect(hits.filter((h) => h === `GET /users/u1/teams/${T1}/threads/${ROOT}`)).toHaveLength(1);
  });

  test('follow_thread does not fetch the thread when it has replies', async () => {
    routes = base();
    await setup().call('follow_thread', { post_id: ROOT });
    expect(hits).not.toContain(`GET /posts/${ROOT}/thread`);
  });

  test('follow_thread passes on a failure to fetch the thread of a root post without replies instead of following', async () => {
    routes = { ...noReplies(), [`GET /posts/${ROOT}/thread`]: () => Response.json({ id: 'app.post.get.app_error' }, { status: 404 }) };
    const r = await setup().call('follow_thread', { post_id: ROOT });
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
  });

  test('a DM thread uses the user\'s first team, and is refused when the user has no team', async () => {
    const dm = (): Record<string, Route> => ({
      ...base(),
      [`GET /posts/${ROOT}`]: () => ({ id: ROOT, user_id: 'u2', channel_id: DM, root_id: '', message: 'root', create_at: 1, reply_count: 1 }),
      [`GET /channels/${DM}`]: () => ({ id: DM, team_id: '', type: 'D' }),
      [`GET /channels/${DM}/members/me`]: () => ({ channel_id: DM, user_id: 'u1' }),
      [`PUT /users/u1/teams/${T2}/threads/${ROOT}/following`]: () => ({ status: 'OK' }),
      [`DELETE /users/u1/teams/${T2}/threads/${ROOT}/following`]: () => ({ status: 'OK' }),
    });
    routes = dm();
    expect((await setup().call('follow_thread', { post_id: ROOT })).isError).toBe(false);
    expect((await setup().call('unfollow_thread', { post_id: ROOT })).isError).toBe(false);
    expect(writes()).toEqual([`PUT /users/u1/teams/${T2}/threads/${ROOT}/following`, `DELETE /users/u1/teams/${T2}/threads/${ROOT}/following`]);
    for (const name of ['follow_thread', 'unfollow_thread']) {
      routes = { ...dm(), 'GET /users/me/teams': () => [] };
      hits = [];
      const r = await setup().call(name, { post_id: ROOT });
      expect(r.text, name).toContain('所属しているチームがないため');
      expect(writes(), name).toEqual([]);
    }
  });

  test('unfollow_thread on a DM or group DM thread says the other members\' replies will follow it again and notify', async () => {
    for (const type of ['D', 'G']) {
      routes = {
        ...base(),
        [`GET /posts/${ROOT}`]: () => ({ id: ROOT, user_id: 'u2', channel_id: DM, root_id: '', message: 'root', create_at: 1, reply_count: 1 }),
        [`GET /channels/${DM}`]: () => ({ id: DM, team_id: '', type }),
        [`DELETE /users/u1/teams/${T2}/threads/${ROOT}/following`]: () => ({ status: 'OK' }),
      };
      hits = [];
      const r = await setup().call('unfollow_thread', { post_id: ROOT });
      expect(r.isError, type).toBe(false);
      expect(r.text, type).toBe(`スレッド（親 post_id: ${ROOT}）のフォローを外しました。ただし、DM とグループ DM のスレッドでは、Mattermost は相手の返信をすべて自分へのメンションとして扱い、相手が返信するたびに再びフォローして通知します。このスレッドの通知は、外しても止まりません。`);
      expect(writes(), type).toEqual([`DELETE /users/u1/teams/${T2}/threads/${ROOT}/following`]);
    }
  });

  test('unfollow_thread deletes the follow without checking membership or the current follow first', async () => {
    routes = base();
    const r = await setup().call('unfollow_thread', { post_id: REPLY });
    expect(r.text).toBe(`スレッド（親 post_id: ${ROOT}）のフォローを外しました。このスレッドの返信の通知は届かなくなります。ただし、メンションの通知は届き、メンションされるか自分が返信すると、Mattermost は再びフォローします。`);
    expect(hits).toEqual(['GET /config/client', `GET /posts/${REPLY}`, `GET /channels/${CH1}`, `DELETE /users/u1/teams/${T1}/threads/${ROOT}/following`]);
  });

  test('both report a deleted post and a post they cannot see in the same words as save_post, and reject a malformed post_id', async () => {
    const GONE = 'z'.repeat(26);
    const HIDDEN = 'y'.repeat(26);
    routes = {
      ...base(),
      [`GET /posts/${GONE}`]: () => Response.json({ id: 'app.post.get.app_error' }, { status: 404 }),
      [`GET /posts/${HIDDEN}`]: () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }),
    };
    for (const name of ['follow_thread', 'unfollow_thread']) {
      expect((await setup().call(name, { post_id: GONE })).text, name).toContain('投稿が見つかりません（削除されたか、存在しません）。');
      expect((await setup().call(name, { post_id: HIDDEN })).text, name).toContain('この投稿は見られません（参加していない非公開チャンネルの投稿など）。');
      expect((await setup().call(name, { post_id: 'bad' })).isError, name).toBe(true);
    }
    expect(writes()).toEqual([]);
  });

  test('both are non-destructive idempotent writes', async () => {
    routes = base();
    const all = await setup().tools();
    for (const name of ['follow_thread', 'unfollow_thread']) {
      expect(all.find((x) => x.name === name)!.annotations, name).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    }
  });
});

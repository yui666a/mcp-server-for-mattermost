import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];
let urls: string[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  bodies = {};
  hits = [];
  urls = [];
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST') bodies[path] = await req.clone().json();
    hits.push(`${req.method} ${path}`);
    urls.push(`${req.method} ${path}${new URL(req.url).search}`);
    const r = routes[`${req.method} ${path}`];
    if (!r) return Response.json({ id: 'not_found' }, { status: 404 });
    const out = r(req);
    return out instanceof Response ? out : Response.json(out);
  });
  const code = ctx.store.createCode({
    mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: ctx.config.resource, scope: 'mattermost',
  });
  const rec = ctx.store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const { accessToken } = ctx.store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: ctx.config.resource, fromCodeHash: rec.codeHash });
  ctx.store.putMmCred('u1', 'mm-access', 'mm-refresh');
  return async (name: string, args: Record<string, unknown>, isError = false): Promise<string> => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.body.result.isError ?? false).toBe(isError);
    return r.body.result.content[0].text;
  };
}

const id = (n: number) => `p${String(n).padStart(25, '0')}`;
const posts = (n: number) => {
  const order = Array.from({ length: n }, (_, i) => id(i));
  return { order, posts: Object.fromEntries(order.map((p, i) => [p, { id: p, user_id: 'u1', channel_id: 'c'.repeat(26), root_id: '', message: `m${i}`, create_at: 0 }])) };
};

test('search_posts sends the JST offset, shows the channel and team names, and notes the 100-result cap', async () => {
  routes = {
    'POST /posts/search': () => posts(100),
    'GET /users/me/channels': () => [{ id: 'c'.repeat(26), name: 'general-dup', display_name: 'General', team_id: 't'.repeat(26), type: 'O' }],
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  const call = setup();
  const out = await call('search_posts', { terms: 'x on:2026-10-15', limit: 50 });
  expect(bodies['/posts/search']).toMatchObject({ terms: 'x on:2026-10-15', time_zone_offset: 32400 });
  expect(out).toContain('name: general-dup');
  expect(out).toContain('team-a');
  expect(out).toContain('これより古い一致');
  routes['POST /posts/search'] = () => posts(99);
  expect(await call('search_posts', { terms: 'x' })).not.toContain('100 件まで');
});

test('search_users notes the 100-result cap', async () => {
  routes = { 'POST /users/search': () => Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, username: `user${i}` })) };
  const call = setup();
  expect(await call('search_users', { query: 'user' })).toContain('100 件まで');
});

describe('get_post', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const ROOT = 'r'.repeat(26);
  const REPLY = 'q'.repeat(26);
  const mmError = (status: number) => () => Response.json({ id: 'x', message: 'm', status_code: status }, { status });
  const post = (o: Record<string, unknown>) => ({ user_id: 'u1', channel_id: C, root_id: '', message: 'hello', create_at: 0, reply_count: 0, ...o });
  const base = {
    [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O' }),
    [`GET /teams/${T}`]: () => ({ id: T, name: 'team-b' }),
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };

  test('reads a post from its permalink, with the channel and team, and builds the permalink from the post\'s own team', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, reply_count: 0 }) };
    const out = await setup()('get_post', { post: `https://mm.example/team-a/pl/${ROOT}` });
    expect(hits).toContain(`GET /posts/${ROOT}`);
    expect(out).toContain(`channel_id: ${C}`);
    expect(out).toContain(`team_id: ${T}`);
    expect(out).toContain('@alice');
    expect(out).toContain('hello');
    expect(out).toContain(`https://mm.example/team-b/pl/${ROOT}`);
    expect(out).toContain('返信数: 0');
    expect(out).not.toContain('read_thread');
  });

  test('accepts a bare post_id', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT }) };
    expect(await setup()('get_post', { post: ROOT })).toContain(`post_id: ${ROOT}`);
  });

  test('for a reply, gives the parent post_id and points to read_thread', async () => {
    routes = { ...base, [`GET /posts/${REPLY}`]: () => post({ id: REPLY, root_id: ROOT, reply_count: 3 }) };
    const out = await setup()('get_post', { post: REPLY });
    expect(out).toContain(`親 post_id: ${ROOT}`);
    expect(out).toContain('read_thread');
  });

  test('for a root post with replies, gives the reply count and points to read_thread', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, reply_count: 2 }) };
    const out = await setup()('get_post', { post: ROOT });
    expect(out).toContain('返信数: 2');
    expect(out).toContain('read_thread');
  });

  test('rejects a URL on another host without calling Mattermost', async () => {
    routes = { ...base };
    const out = await setup()('get_post', { post: `https://evil.example/team-a/pl/${ROOT}` }, true);
    expect(out).toContain('https://mm.example');
    expect(hits).toEqual([]);
  });

  test('turns 403 from GET /posts/{id} into a permission message', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: mmError(403) };
    expect(await setup()('get_post', { post: ROOT }, true)).toBe('この投稿を見る権限がありません（参加していない非公開チャンネルなど）');
  });

  test('turns 404 from GET /posts/{id} into a not-found message', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: mmError(404) };
    expect(await setup()('get_post', { post: ROOT }, true)).toBe('投稿が見つかりません（削除されたか、存在しません）');
  });

  test('leaves a 403 from a later API call as the generic Mattermost error', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT }), [`GET /channels/${C}`]: mmError(403) };
    const out = await setup()('get_post', { post: ROOT }, true);
    expect(out).toContain('Mattermost がエラーを返しました（403）');
  });
});

describe('list_my_channels', () => {
  const T = 't'.repeat(26);
  const GONE = 'x'.repeat(26);
  const PUB = 'a'.repeat(26);
  const PRIV = 'b'.repeat(26);
  const TIE = 'c'.repeat(26);
  const DM = 'd'.repeat(26);
  const GM = 'g'.repeat(26);
  const ORPHAN = 'o'.repeat(26);
  const channels = () => [
    { id: GM, type: 'G', name: 'gm-name', display_name: 'alice, bob, carol', team_id: '', last_post_at: 0 },
    { id: ORPHAN, type: 'O', name: 'lost', display_name: 'Lost', team_id: GONE, last_post_at: 1000 },
    { id: TIE, type: 'O', name: 'tie', display_name: 'Tie', team_id: T, last_post_at: 2000 },
    { id: PRIV, type: 'P', name: 'secret', display_name: 'Secret', team_id: T, last_post_at: 2000 },
    { id: DM, type: 'D', name: 'u1__u2', display_name: '', team_id: '', last_post_at: 2500 },
    { id: PUB, type: 'O', name: 'town', display_name: 'Town', team_id: T, last_post_at: Date.UTC(2026, 9, 1, 20, 4, 5) },
  ];
  const base = () => ({
    'GET /users/me/channels': () => channels(),
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const order = (out: string) => [...out.matchAll(/channel_id: ([a-z]{26})/g)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('lists every channel the user is in, newest post first (ties by channel_id), with team, name, kind, ids and the last post time', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(order(out)).toEqual([PUB, DM, PRIV, TIE, ORPHAN, GM]);
    expect(out).toContain(`- team-a/town（表示名: Town、種類: 公開、channel_id: ${PUB}、team_id: ${T}、最終投稿: 2026-10-01T20:04:05Z | 2026-10-02T05:04:05+09:00）`);
    expect(out).toContain(`- team-a/secret（表示名: Secret、種類: 非公開、channel_id: ${PRIV}`);
    expect(out).toContain('（続きはありません）');
    expect(urls).toContain('GET /users/me/channels');
  });

  test('names a DM by the other user and a group DM by its display name, without a team', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(bodies['/users/ids']).toEqual(['u2']);
    expect(out).toContain(`- @bob（表示名: @bob、種類: DM、channel_id: ${DM}、最終投稿:`);
    expect(out).toContain(`- alice, bob, carol（表示名: alice, bob, carol、種類: グループ DM、channel_id: ${GM}、最終投稿: 投稿なし）`);
  });

  test('shows only the team_id when the team name cannot be looked up', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(out).toContain(`- lost（表示名: Lost、種類: 公開、channel_id: ${ORPHAN}、team_id: ${GONE}、最終投稿:`);
  });

  test('filters by types', async () => {
    routes = base();
    const call = setup();
    expect(order(await call('list_my_channels', { types: ['private'] }))).toEqual([PRIV]);
    expect(order(await call('list_my_channels', { types: ['dm', 'group_dm'] }))).toEqual([DM, GM]);
    expect(hits.filter((h) => h === 'POST /users/ids')).toHaveLength(1);
  });

  test('a cursor keeps the types and the page size of the first call, ignoring the arguments', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { types: ['public'], limit: 1 });
    expect(order(first)).toEqual([PUB]);
    const second = await call('list_my_channels', { types: ['dm'], limit: 50, cursor: cursorIn(first) });
    expect(order(second)).toEqual([TIE]);
    const third = await call('list_my_channels', { cursor: cursorIn(second) });
    expect(order(third)).toEqual([ORPHAN]);
    expect(cursorIn(third)).toBeUndefined();
  });

  test('a later page first lists the channels updated since the previous page', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { limit: 2 });
    const now = Date.now();
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === TIE ? { ...c, last_post_at: now } : c));
    const second = await call('list_my_channels', { cursor: cursorIn(first) });
    expect(second).toContain('前のページの後に更新されたチャンネル（前のページまでに出したものを含むことがあります）');
    expect(order(second)).toEqual([TIE, PRIV]);
    expect(cursorIn(second)).toBeDefined();
  });

  test('when the updated channels do not fit in the page, says how many are left and asks to start over instead of giving a cursor', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { limit: 1 });
    const now = Date.now();
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === TIE || c.id === GM ? { ...c, last_post_at: now } : c));
    const second = await call('list_my_channels', { cursor: cursorIn(first) });
    expect(order(second)).toHaveLength(1);
    expect(second).toContain('ほかに 1 件');
    expect(second).toContain('cursor を付けずに最初のページから取り直してください');
    expect(second).not.toContain('next_cursor');
    expect(second).not.toContain('続きはありません');
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('list_my_channels', { cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 20 })).toString('base64url') }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });
});

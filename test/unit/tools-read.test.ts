import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];
let urls: string[];
let last: { content: { type: string; text?: string; data?: string; mimeType?: string }[] };

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
    last = r.body.result;
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

describe('search_posts in: filters', () => {
  const pad = (s: string) => s.padEnd(26, '0');
  const T1 = pad('ta'), T2 = pad('tb');
  const CA = pad('ca'), CB = pad('cb'), CX = pad('cx'), PV = pad('pv');
  const BOB = pad('bob');
  const DM_NAME = [BOB, 'u1'].sort().join('__');
  const DM = pad('dm');
  const ch = (id: string, name: string, team_id: string, type = 'O') => ({ id, name, display_name: name, team_id, type, purpose: '', header: '' });
  const base = (): Record<string, Route> => ({
    'POST /posts/search': () => posts(0),
    'GET /users/me/teams': () => [{ id: T1, name: 'team-a' }, { id: T2, name: 'team-b' }],
    [`GET /teams/${T1}`]: () => ({ id: T1, name: 'team-a' }),
    [`GET /teams/${T2}`]: () => ({ id: T2, name: 'team-b' }),
    [`GET /teams/${T1}/channels/name/town`]: () => ch(CA, 'town', T1),
    [`GET /teams/${T2}/channels/name/town`]: () => ch(CB, 'town', T2),
    [`GET /teams/${T1}/channels/name/only-a`]: () => ch(CX, 'only-a', T1),
    'GET /teams/name/team-a/channels/name/only-a': () => ch(CX, 'only-a', T1),
    [`GET /channels/${CX}`]: () => ch(CX, 'only-a', T1),
    [`GET /channels/${CB}`]: () => ch(CB, 'town', T2),
    'GET /users/username/bob': () => ({ id: BOB, username: 'bob' }),
    [`GET /channels/${PV}`]: () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }),
    'GET /teams/name/team-a/channels/name/private': () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }),
  });
  const withDm = () => ({
    ...base(),
    [`GET /teams/${T1}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D'),
    [`GET /teams/${T2}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D'),
  });
  const sent = () => (bodies['/posts/search'] as { terms: string } | undefined)?.terms;

  test.each([
    ['x in:only-a', `x in:${CX}`],
    ['x -in:only-a', `x -in:${CX}`],
    ['x channel:only-a', `x in:${CX}`],
    ['x IN:only-a', `x in:${CX}`],
    ['x in: only-a', `x in:${CX}`],
    ['x in:~only-a', `x in:${CX}`],
    ['x in:team-a/only-a', `x in:${CX}`],
    [`x in:${CX}`, `x in:${CX}`],
    ['x　in:only-a', `x in:${CX}`],
    ['foo "bar in:only-a', `foo "bar in:${CX}`],
    [`x in:only-a in:${CB}`, `x in:${CX} in:${CB}`],
    ['x -channel:only-a', `x -in:${CX}`],
  ])('sends %j to Mattermost as %j', async (terms, expected) => {
    routes = base();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(expected);
  });

  test('a channel ID is looked up to check it is visible before it is sent', async () => {
    routes = base();
    await setup()('search_posts', { terms: `x in:${CX}` });
    expect(hits).toContain(`GET /channels/${CX}`);
  });

  test.each([
    ['a  "b in:only-a" c'],
    ['from: in:only-a x'],
    ['x in:'],
    ['x in:@bob,carol'],
  ])('passes %j through unchanged', async (terms) => {
    routes = base();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(terms);
    expect(hits).toEqual(['POST /posts/search']);
  });

  test('searches every team for a name that several teams have, notes it, and keeps the original terms in the header', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: 'x in:town' });
    expect(sent()).toBe(`x in:${CA} in:${CB}`);
    expect(out.split('\n')[0]).toBe('検索: x in:town');
    expect(out).toContain('in:town は複数のチームにあるため、すべてで探しました（team-a、team-b）。');
  });

  test('excludes every channel of a name that several teams have', async () => {
    routes = base();
    await setup()('search_posts', { terms: 'x -in:town' });
    expect(sent()).toBe(`x -in:${CA} -in:${CB}`);
  });

  test('a DM name found through every team counts as one channel, without the note', async () => {
    routes = withDm();
    const out = await setup()('search_posts', { terms: `x in:${DM_NAME}` });
    expect(sent()).toBe(`x in:${DM}`);
    expect(out).not.toContain('複数のチーム');
  });

  test('in:@user uses the existing DM without creating one', async () => {
    routes = withDm();
    await setup()('search_posts', { terms: 'x in:@bob' });
    expect(sent()).toBe(`x in:${DM}`);
    expect(hits).not.toContain('POST /channels/direct');
  });

  test('in:@user without a DM is an error, and neither creates the DM nor searches', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: 'x in:@bob' }, true);
    expect(out).toContain('@bob との DM はまだありません。');
    expect(hits).not.toContain('POST /channels/direct');
    expect(hits).not.toContain('POST /posts/search');
  });

  test('-in:@user with a DM excludes that DM', async () => {
    routes = withDm();
    await setup()('search_posts', { terms: 'x -in:@bob' });
    expect(sent()).toBe(`x -in:${DM}`);
  });

  test('-in:@user without a DM drops the condition', async () => {
    routes = base();
    await setup()('search_posts', { terms: 'x -in:@bob' });
    expect(sent()).toBe('x');
    expect(hits).not.toContain('POST /channels/direct');
  });

  test('dropping the only condition leaves nothing to search, which is an error', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: '-in:@bob' }, true);
    expect(out).toContain('検索語か条件を 1 つ以上指定してください。');
    expect(hits).not.toContain('POST /posts/search');
  });

  test.each([
    ['x in:nowhere', 'チャンネル「nowhere」が見つかりません。'],
    ['x -in:nowhere', 'チャンネル「nowhere」が見つかりません。'],
    [`x in:${pad('zz')}`, `チャンネル「${pad('zz')}」が見つかりません。`],
    ['x in:team-a/nowhere', 'チャンネル「team-a/nowhere」が見つかりません。'],
    [`x in:${PV}`, `チャンネル「${PV}」が見つかりません。`],
    ['x in:team-a/private', 'チャンネル「team-a/private」が見つかりません。'],
    ['x in:@ghost', 'ユーザー「@ghost」が見つかりません。'],
    ['x -in:@ghost', 'ユーザー「@ghost」が見つかりません。'],
  ])('%j is an input error without searching', async (terms, message) => {
    routes = base();
    const out = await setup()('search_posts', { terms }, true);
    expect(out).toContain(message);
    expect(hits).not.toContain('POST /posts/search');
  });
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

describe('get_channel', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const DM = 'd'.repeat(26);
  const BOB = 'b'.repeat(26);
  const pinned = (n: number, create_at: number) => ({ id: `${String.fromCharCode(96 + n)}`.repeat(26), user_id: 'u1', channel_id: C, root_id: '', message: `pin ${n}`, create_at, is_pinned: true });
  const [P1, P2, P3] = [pinned(1, 3000), pinned(2, 2000), pinned(3, 2000)];
  const mmError = (status: number, id = 'x') => () => Response.json({ id, message: 'm', status_code: status }, { status });
  const base = () => ({
    [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O', purpose: '雑談用', header: '仕事の話は #work へ' }),
    [`GET /teams/${T}`]: () => ({ id: T, name: 'team-a' }),
    [`GET /channels/${C}/stats`]: () => ({ channel_id: C, member_count: 42, guest_count: 0, pinnedpost_count: 3, files_count: -1 }),
    // Returned oldest first, as Mattermost does.
    [`GET /channels/${C}/pinned`]: () => ({ order: [P3.id, P2.id, P1.id], posts: { [P1.id]: P1, [P2.id]: P2, [P3.id]: P3 } }),
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  });
  const pinIds = (out: string) => [...out.matchAll(/^--- post_id: ([a-z]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('shows the channel and team, kind, purpose, header, member count and the pinned posts newest first (ties by post_id)', async () => {
    routes = base();
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain(`チャンネル: Town（name: town、channel_id: ${C}）`);
    expect(out).toContain(`チーム: team-a（team_id: ${T}）`);
    expect(out).toContain('種類: 公開');
    expect(out).toContain('目的: 雑談用');
    expect(out).toContain('ヘッダー: 仕事の話は #work へ');
    expect(out).toContain('メンバー数: 42');
    expect(out).toContain('ピン留め: 3 件');
    expect(pinIds(out)).toEqual([P1.id, P2.id, P3.id]);
    expect(out).toContain('@alice');
    expect(out).toContain(`https://mm.example/team-a/pl/${P1.id}`);
    expect(out).toContain('（続きはありません）');
    expect(urls).toContain(`GET /channels/${C}/stats?exclude_files_count=true`);
    expect(hits.filter((h) => h === `GET /channels/${C}`)).toHaveLength(1);
  });

  test('says when the purpose or header is empty and when nothing is pinned', async () => {
    routes = {
      ...base(),
      [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'P', purpose: '', header: '' }),
      [`GET /channels/${C}/pinned`]: () => ({ order: [], posts: {} }),
    };
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain('種類: 非公開');
    expect(out).toContain('目的: なし');
    expect(out).toContain('ヘッダー: なし');
    expect(out).toContain('ピン留め: 0 件');
    expect(out).toContain('ピン留めされた投稿はありません。');
    expect(hits).not.toContain('POST /users/ids');
  });

  test('when /stats is refused (a public channel the user has not joined), says the member count is unavailable and returns the rest', async () => {
    routes = { ...base(), [`GET /channels/${C}/stats`]: mmError(403) };
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain('メンバー数: 参加していないため取得できません');
    expect(out).toContain('目的: 雑談用');
    expect(pinIds(out)).toEqual([P1.id, P2.id, P3.id]);
  });

  test('pages through the pinned posts with pinned_limit; a cursor gives only the rest of the pinned posts', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_channel', { channel: C, pinned_limit: 2 });
    expect(pinIds(first)).toEqual([P1.id, P2.id]);
    expect(first).toContain('ピン留め: 3 件');
    hits = [];
    const second = await call('get_channel', { channel: C, pinned_limit: 50, cursor: cursorIn(first) });
    expect(pinIds(second)).toEqual([P3.id]);
    expect(second).toContain(`channel_id: ${C}`);
    expect(second).not.toContain('目的');
    expect(second).not.toContain('メンバー数');
    expect(second).toContain('（続きはありません）');
    expect(hits).not.toContain(`GET /channels/${C}/stats`);
  });

  test('rejects a cursor issued for another channel', async () => {
    routes = { ...base(), [`GET /channels/${OTHER}`]: () => ({ id: OTHER, name: 'other', display_name: 'Other', team_id: T, type: 'O', purpose: '', header: '' }) };
    const call = setup();
    const first = await call('get_channel', { channel: C, pinned_limit: 1 });
    const out = await call('get_channel', { channel: OTHER, cursor: cursorIn(first) }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });

  test('shows a DM given as @username with its kind', async () => {
    const name = [BOB, 'u1'].sort().join('__');
    routes = {
      ...base(),
      'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
      'GET /users/username/bob': () => ({ id: BOB, username: 'bob' }),
      [`GET /teams/${T}/channels/name/${name}`]: () => ({ id: DM, name, display_name: '', team_id: '', type: 'D', purpose: '', header: '' }),
      [`GET /channels/${DM}/stats`]: () => ({ channel_id: DM, member_count: 2 }),
      [`GET /channels/${DM}/pinned`]: () => ({ order: [], posts: {} }),
    };
    const out = await setup()('get_channel', { channel: '@bob' });
    expect(out).toContain(`チャンネル: @bob（name: ${name}、channel_id: ${DM}）`);
    expect(out).toContain('種類: DM');
    expect(out).toContain('メンバー数: 2');
    expect(hits).not.toContain(`GET /channels/${DM}`);
  });

  test('turns 403 from fetching the channel into a permission message', async () => {
    routes = { ...base(), [`GET /channels/${C}`]: mmError(403) };
    expect(await setup()('get_channel', { channel: C }, true)).toBe('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）');
  });

  test('turns 404 from fetching the channel, by id or by team/name, into a not-found message', async () => {
    routes = { ...base(), [`GET /channels/${C}`]: mmError(404) };
    const call = setup();
    expect(await call('get_channel', { channel: C }, true)).toBe('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
    routes['GET /teams/name/team-a/channels/name/nope'] = mmError(404, 'app.channel.get_by_name.missing.app_error');
    expect(await call('get_channel', { channel: 'team-a/nope' }, true)).toBe('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
  });

  test('does not turn errors about the user or the team into the channel messages', async () => {
    routes = {
      ...base(),
      'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
      'GET /users/username/nobody': mmError(404, 'app.user.missing_account.const'),
      'GET /teams/name/no-team/channels/name/town': mmError(404, 'app.team.get_by_name.missing.app_error'),
    };
    const call = setup();
    expect(await call('get_channel', { channel: '@nobody' }, true)).toContain('Mattermost がエラーを返しました（404）');
    expect(await call('get_channel', { channel: 'no-team/town' }, true)).toContain('Mattermost がエラーを返しました（404）');
  });
});

describe('get_user', () => {
  const BOB = 'b'.repeat(26);
  const profile = (timezone?: Record<string, string>) => () => ({ id: BOB, username: 'bob', ...(timezone ? { timezone } : {}) });
  const status = (o: Record<string, unknown>) => () => ({ user_id: BOB, status: 'online', manual: false, last_activity_at: 0, dnd_end_time: 0, ...o });
  const tz = (useAutomaticTimezone: string, automaticTimezone: string, manualTimezone: string) => ({ useAutomaticTimezone, automaticTimezone, manualTimezone });
  const call = (routesFor: Record<string, Route>) => {
    routes = { 'GET /users/username/bob': profile(tz('true', 'Asia/Tokyo', '')), [`GET /users/${BOB}/status`]: status({}), ...routesFor };
    return setup();
  };

  test('shows the automatic time zone when useAutomaticTimezone is the string "true", with the local time now', async () => {
    const out = await call({})('get_user', { user: '@bob' });
    expect(out).toContain('タイムゾーン: Asia/Tokyo（自動）');
    expect(out).toMatch(/現地時刻: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00/);
  });

  test('shows the manual time zone when useAutomaticTimezone is the string "false"', async () => {
    const out = await call({ 'GET /users/username/bob': profile(tz('false', 'Asia/Tokyo', 'America/New_York')) })('get_user', { user: '@bob' });
    expect(out).toContain('タイムゾーン: America/New_York（手動）');
    expect(out).toMatch(/現地時刻: \S+-0[45]:00/);
  });

  test('says the time zone is not set, without a local time, when it is empty, unknown to Intl, or missing', async () => {
    for (const p of [profile(tz('true', '', 'Asia/Tokyo')), profile(tz('false', '', 'Mars/Olympus_Mons')), profile()]) {
      const out = await call({ 'GET /users/username/bob': p })('get_user', { user: '@bob' });
      expect(out).toContain('タイムゾーン: 未設定');
      expect(out).not.toContain('現地時刻');
    }
  });

  test('shows each presence status in Japanese', async () => {
    const names = { online: 'オンライン', away: '離席', dnd: '取り込み中', offline: 'オフライン', ooo: '不在' };
    for (const [s, ja] of Object.entries(names)) {
      const out = await call({ [`GET /users/${BOB}/status`]: status({ status: s }) })('get_user', { user: '@bob' });
      expect(out, s).toContain(`在席: ${ja}`);
    }
  });

  test('adds the end of do-not-disturb in UTC and JST only while dnd has an end time', async () => {
    const end = Date.UTC(2026, 10, 1, 20, 4, 0) / 1000;
    const until = await call({ [`GET /users/${BOB}/status`]: status({ status: 'dnd', manual: true, dnd_end_time: end }) })('get_user', { user: '@bob' });
    expect(until).toContain('在席: 取り込み中（終了: 2026-11-01T20:04:00Z | 2026-11-02T05:04:00+09:00）（手動で設定）');
    const open = await call({ [`GET /users/${BOB}/status`]: status({ status: 'dnd', dnd_end_time: 0 }) })('get_user', { user: '@bob' });
    expect(open).toMatch(/在席: 取り込み中$/m);
    const stale = await call({ [`GET /users/${BOB}/status`]: status({ status: 'away', dnd_end_time: end }) })('get_user', { user: '@bob' });
    expect(stale).toMatch(/在席: 離席$/m);
  });

  test('says when the status was set by hand', async () => {
    const out = await call({ [`GET /users/${BOB}/status`]: status({ status: 'away', manual: true }) })('get_user', { user: '@bob' });
    expect(out).toContain('在席: 離席（手動で設定）');
  });

  test('still returns the profile when the status API answers with a Mattermost error', async () => {
    const out = await call({ [`GET /users/${BOB}/status`]: () => Response.json({ id: 'x', message: 'm' }, { status: 403 }) })('get_user', { user: '@bob' });
    expect(out).toContain('username: @bob');
    expect(out).toContain('在席: 取得できませんでした');
  });

  test('fails the tool when the status API is rate limited, unavailable, or needs re-authorization', async () => {
    const cases: Route[] = [
      () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } }),
      () => new Response('oops', { status: 503 }),
      () => Response.json({ id: 'api.context.session_expired.app_error' }, { status: 401 }),
    ];
    for (const r of cases) {
      const out = await call({ [`GET /users/${BOB}/status`]: r })('get_user', { user: '@bob' }, true);
      expect(out).not.toContain('username:');
    }
  });

  test('calls the status API after the profile, with the resolved user id', async () => {
    await call({})('get_user', { user: '@bob' });
    expect(hits).toEqual(['GET /users/username/bob', `GET /users/${BOB}/status`]);
  });
});

describe('get_unreads', () => {
  const T1 = '1'.repeat(26);
  const T2 = '2'.repeat(26);
  const QUIET = 'a'.repeat(26);
  const OLD = 'b'.repeat(26);
  const NEW = 'c'.repeat(26);
  const MENTIONED = 'd'.repeat(26);
  const MUTED = 'e'.repeat(26);
  const MUTED_MENTION = 'f'.repeat(26);
  const DM = 'g'.repeat(26);
  const ARCHIVED = 'h'.repeat(26);
  const TH1 = 'k'.repeat(26);
  const TH2 = 'm'.repeat(26);
  const TH_DM = 'n'.repeat(26);
  const ch = (id: string, name: string, o: Record<string, unknown>) => ({
    id, name, display_name: name.toUpperCase(), team_id: T1, type: 'O', last_post_at: 0, last_root_post_at: 0, total_msg_count: 0, total_msg_count_root: 0, ...o,
  });
  const channels = () => [
    ch(QUIET, 'quiet', { total_msg_count: 5, total_msg_count_root: 5, last_post_at: 9000, last_root_post_at: 9000 }),
    ch(OLD, 'old', { total_msg_count: 10, total_msg_count_root: 6, last_post_at: 8000, last_root_post_at: 1000 }),
    ch(NEW, 'new', { team_id: T2, total_msg_count: 4, total_msg_count_root: 3, last_post_at: 3000, last_root_post_at: 2000 }),
    ch(MENTIONED, 'mentioned', { total_msg_count: 2, total_msg_count_root: 2, last_post_at: 500, last_root_post_at: 500 }),
    ch(MUTED, 'muted', { total_msg_count: 3, total_msg_count_root: 3, last_post_at: 7000, last_root_post_at: 7000 }),
    ch(MUTED_MENTION, 'muted-mention', { total_msg_count: 3, total_msg_count_root: 3, last_post_at: 600, last_root_post_at: 600 }),
    ch(DM, 'u1__u2', { team_id: '', type: 'D', display_name: '', total_msg_count: 1, total_msg_count_root: 1, last_post_at: 400, last_root_post_at: 400 }),
  ];
  const mem = (channel_id: string, o: Record<string, unknown> = {}) => ({
    channel_id, msg_count: 0, msg_count_root: 0, mention_count: 0, mention_count_root: 0, notify_props: { mark_unread: 'all' }, ...o,
  });
  const members = () => [
    mem(QUIET, { msg_count: 5, msg_count_root: 5 }),
    mem(OLD, { msg_count: 7, msg_count_root: 4, mention_count: 1 }),
    mem(NEW, { msg_count: 2, msg_count_root: 1 }),
    mem(MENTIONED, { msg_count: 1, msg_count_root: 1, mention_count: 1, mention_count_root: 1 }),
    mem(MUTED, { notify_props: { mark_unread: 'mention' } }),
    mem(MUTED_MENTION, { msg_count: 2, msg_count_root: 2, mention_count: 1, notify_props: { mark_unread: 'mention' } }),
    mem(DM, { mention_count: 1, mention_count_root: 1 }),
    mem(ARCHIVED, { msg_count: 0, mention_count: 3 }),
  ];
  const thread = (id: string, channel_id: string, last_reply_at: number, o: Record<string, unknown> = {}) => ({
    id, last_reply_at, reply_count: 3, unread_replies: 2, unread_mentions: 0,
    post: { id, user_id: 'u2', channel_id, root_id: '', message: `root ${id[0]}`, create_at: 100 }, ...o,
  });
  const threadPage = (threads: unknown[], total = threads.length) => ({ total: 999, total_unread_threads: total, total_unread_mentions: 0, threads });
  const pref = (value?: string) => () => (value ? { user_id: 'u1', category: 'display_settings', name: 'collapsed_reply_threads', value }
    : Response.json({ id: 'app.preference.get.app_error', message: 'm', status_code: 400 }, { status: 400 }));
  const base = (crt = 'always_on'): Record<string, Route> => ({
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    'GET /users/me/channels': () => channels(),
    'GET /users/me/channel_members': () => members(),
    'GET /users/me/teams': () => [{ id: T1, name: 'team-a' }, { id: T2, name: 'team-b' }],
    [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH1, OLD, 5000, { unread_mentions: 1 }), thread(TH_DM, DM, 4000)]),
    [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([thread(TH2, NEW, 6000), thread(TH_DM, DM, 4000)]),
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const order = (out: string) => [...out.matchAll(/^(?:- .*?channel_id: |--- post_id: )([a-z0-9]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('decides whether collapsed reply threads apply from the server setting and, for default_on/default_off only, the user\'s preference', async () => {
    const cases: [string, string | undefined, string][] = [
      ['always_on', undefined, '有効（サーバー設定: always_on）'],
      ['disabled', undefined, '無効（サーバー設定: disabled）'],
      ['default_on', undefined, '有効（サーバー設定: default_on、利用者の設定: なし）'],
      ['default_off', undefined, '無効（サーバー設定: default_off、利用者の設定: なし）'],
      ['default_on', 'off', '無効（サーバー設定: default_on、利用者の設定: off）'],
      ['default_off', 'on', '有効（サーバー設定: default_off、利用者の設定: on）'],
    ];
    for (const [server, user, expected] of cases) {
      routes = { ...base(server), 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': pref(user) };
      hits = [];
      urls = [];
      const out = await setup()('get_unreads', {});
      expect(out.split('\n')[0], `${server}/${user}`).toBe(`スレッドの折りたたみ（CRT）: ${expected}`);
      expect(hits.includes('GET /users/me/preferences/display_settings/name/collapsed_reply_threads'), server).toBe(server.startsWith('default_'));
      expect(urls).toContain('GET /config/client?format=old');
      expect(hits.some((h) => h.includes('/threads')), server).toBe(expected.startsWith('有効'));
    }
  });

  test('with CRT on, counts root posts only, puts channels with mentions first, then newest root post first, and hides read, archived and mention-only channels without mentions', async () => {
    routes = base();
    const out = await setup()('get_unreads', {});
    expect(order(out).slice(0, 4)).toEqual([MENTIONED, DM, NEW, OLD]);
    expect(out).toContain(`- team-a/mentioned（表示名: MENTIONED、channel_id: ${MENTIONED}、team_id: ${T1}）未読: 1、メンション: 1、最終のルート投稿: ${'1970-01-01T00:00:00Z | 1970-01-01T09:00:00+09:00'}`);
    expect(out).toContain(`- team-a/old（表示名: OLD、channel_id: ${OLD}、team_id: ${T1}）未読: 2、メンション: 0、最終のルート投稿:`);
    expect(out).toContain(`- @bob（表示名: @bob、channel_id: ${DM}）未読: 1、メンション: 1`);
    for (const hidden of [QUIET, MUTED, ARCHIVED]) expect(out).not.toContain(hidden);
    expect(out).not.toContain(`channel_id: ${MUTED_MENTION}`);
  });

  test('a mention-only channel is shown when it has a mention', async () => {
    routes = { ...base('disabled') };
    const out = await setup()('get_unreads', {});
    expect(out).toContain(`channel_id: ${MUTED_MENTION}`);
    expect(out).not.toContain(`channel_id: ${MUTED}`);
  });

  test('with CRT off, counts replies too, orders by the last post, and does not ask for threads', async () => {
    routes = base('disabled');
    const out = await setup()('get_unreads', {});
    expect(order(out)).toEqual([OLD, MUTED_MENTION, MENTIONED, DM, NEW]);
    expect(out).toContain(`channel_id: ${OLD}、team_id: ${T1}）未読: 3、メンション: 1、最終投稿:`);
    expect(out).toContain('- team-b/new');
    expect(hits.some((h) => h.includes('/threads'))).toBe(false);
    expect(out).toContain('未読のあるチャンネル: 5 件');
  });

  test('pages through channel_members 200 at a time until a short page', async () => {
    const many = Array.from({ length: 200 }, (_, i) => mem(`z${String(i).padStart(25, '0')}`));
    routes = { ...base(), 'GET /users/me/channel_members': (req) => (new URL(req.url).searchParams.get('page') === '0' ? many : members()) };
    const out = await setup()('get_unreads', {});
    expect(urls.filter((u) => u.startsWith('GET /users/me/channel_members'))).toEqual([
      'GET /users/me/channel_members?page=0&per_page=200', 'GET /users/me/channel_members?page=1&per_page=200',
    ]);
    expect(out).toContain(`channel_id: ${MENTIONED}`);
  });

  test('lists unread threads newest reply first after the channels, taking DM threads from the first team only and counting a thread once', async () => {
    routes = base();
    const out = await setup()('get_unreads', {});
    expect(urls).toContain(`GET /users/u1/teams/${T1}/threads?unread=true&per_page=50`);
    expect(urls).toContain(`GET /users/u1/teams/${T2}/threads?unread=true&per_page=50&excludeDirect=true`);
    expect(order(out).slice(-3)).toEqual([TH2, TH1, TH_DM]);
    expect(out.match(new RegExp(`post_id: ${TH_DM}`, 'g'))).toHaveLength(1);
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 3 件');
    expect(out).toContain(`--- post_id: ${TH1}\n@bob | `);
    expect(out).toContain(`https://mm.example/team-a/pl/${TH1}`);
    expect(out).toContain(`https://mm.example/team-b/pl/${TH2}`);
    expect(out).toContain('未読の返信: 2、未読のメンション: 1、最終返信: 1970-01-01T00:00:05Z | 1970-01-01T09:00:05+09:00');
    expect(out.indexOf(`post_id: ${TH2}`)).toBeGreaterThan(out.indexOf(`channel_id: ${OLD}`));
  });

  test('leaves out unread threads in channels that /users/me/channels does not list (archived ones) and does not count them', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([thread(TH2, ARCHIVED, 6000), thread(TH_DM, DM, 4000)]) };
    const out = await setup()('get_unreads', {});
    expect(out).not.toContain(TH2);
    expect(out).not.toContain(ARCHIVED);
    expect(order(out).slice(-2)).toEqual([TH1, TH_DM]);
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 2 件');
  });

  test('follows a team\'s unread threads with before= for at most 4 pages, then says it stopped and gives total_unread_threads', async () => {
    let n = 0;
    const full = () => threadPage(Array.from({ length: 50 }, () => thread(`t${String(n++).padStart(25, '0')}`, OLD, 5000)), 321);
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: full, [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
    const out = await setup()('get_unreads', { limit: 100 });
    const t1 = urls.filter((u) => u.includes(`/teams/${T1}/threads`));
    expect(t1).toHaveLength(4);
    expect(t1[1]).toBe(`GET /users/u1/teams/${T1}/threads?unread=true&per_page=50&before=t${String(49).padStart(25, '0')}`);
    expect(out).toContain('team-a の未読スレッドは 200 件までしか取得していません（total_unread_threads: 321）');
  });

  test('when the threads API answers 4xx, returns the channel unreads and says the threads could not be fetched', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => Response.json({ id: 'x', message: 'nope' }, { status: 403 }) };
    const out = await setup()('get_unreads', {});
    expect(out).toContain(`channel_id: ${MENTIONED}`);
    expect(out).not.toContain(`post_id: ${TH1}`);
    expect(out).toContain('未読のスレッドを取得できませんでした');
  });

  test('when the threads API answers 4xx after a team hit the 4-page cap, drops that cap note and says the thread count is unavailable', async () => {
    let n = 0;
    const full = () => threadPage(Array.from({ length: 50 }, () => thread(`t${String(n++).padStart(25, '0')}`, OLD, 5000)), 321);
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: full, [`GET /users/u1/teams/${T2}/threads`]: () => Response.json({ id: 'x', message: 'nope' }, { status: 403 }) };
    const out = await setup()('get_unreads', {});
    expect(out).not.toContain('200 件までしか');
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 取得できませんでした');
    expect(out).toContain('未読のスレッドを取得できませんでした');
  });

  test('when the threads API fails otherwise, the tool fails', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: () => new Response('oops', { status: 503 }) };
    const out = await setup()('get_unreads', {}, true);
    expect(out).not.toContain('channel_id');
  });

  test('names the DM of a DM thread by the other user', async () => {
    routes = {
      ...base(),
      'GET /users/me/channel_members': () => members().filter((m) => m.channel_id !== DM),
      [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH_DM, DM, 4000, { post: { id: TH_DM, user_id: 'u1', channel_id: DM, root_id: '', message: 'mine', create_at: 100 } })]),
      [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]),
      'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }].filter((u) => (bodies['/users/ids'] as string[]).includes(u.id)),
    };
    const out = await setup()('get_unreads', {});
    expect(out).toContain(`チャンネル: @bob（name: u1__u2、channel_id: ${DM}）`);
  });

  test('says when there is nothing unread', async () => {
    routes = { ...base(), 'GET /users/me/channel_members': () => [], [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([]), [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
    const out = await setup()('get_unreads', {});
    expect(out).toContain('未読はありません。');
    expect(out).toContain('（続きはありません）');
  });

  test('pages channels then threads with limit, and a cursor keeps the page size', async () => {
    routes = base();
    const call = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await call('get_unreads', cursor ? { cursor, limit: 50 } : { limit: 2 });
      const rows = order(out);
      expect(rows.length).toBeLessThanOrEqual(2);
      seen.push(...rows);
      cursor = cursorIn(out);
      if (!cursor) break;
    }
    expect(seen).toEqual([MENTIONED, DM, NEW, OLD, TH2, TH1, TH_DM]);
  });

  test('a later page first lists channels and threads updated since the previous page, newest first', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 2 });
    const now = Date.now() + 60_000;
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === OLD ? { ...c, last_root_post_at: now } : c));
    routes[`GET /users/u1/teams/${T1}/threads`] = () => threadPage([thread(TH1, OLD, now + 1, { unread_mentions: 1 }), thread(TH_DM, DM, 4000)]);
    const out = await call('get_unreads', { cursor: cursorIn(first) });
    expect(out).toContain('前のページの後に更新されたチャンネルとスレッド（前のページまでに出したものを含むことがあります）:');
    expect(order(out)).toEqual([TH1, OLD]);
  });

  test('when the updated rows do not fit, says how many are left and asks to start over instead of giving a cursor', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 1 });
    const now = Date.now() + 60_000;
    routes['GET /users/me/channels'] = () => channels().map((c) => ({ ...c, last_root_post_at: now }));
    const out = await call('get_unreads', { cursor: cursorIn(first) });
    expect(out).toContain('ほかに 3 件');
    expect(out).toContain('cursor を付けずに最初のページから取り直してください');
    expect(cursorIn(out)).toBeUndefined();
  });

  test('when the CRT decision changes between pages, refuses the cursor and asks to start over', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 1 });
    routes['GET /config/client'] = () => ({ CollapsedThreads: 'disabled' });
    const out = await call('get_unreads', { cursor: cursorIn(first) }, true);
    expect(out).toContain('スレッドの折りたたみ（CRT）の判定がページの合間に変わりました');
    expect(out).toContain('cursor を付けずに最初のページから取り直してください');
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('get_unreads', { cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 5 })).toString('base64url') }, true);
    expect(out).toContain('cursor が不正です');
  });

  test('stays within 2 + 1 + (members pages) + 1 + 4T + 1 Mattermost calls, in that order, and never marks anything read', async () => {
    routes = { ...base('default_on'), 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': pref('on') };
    await setup()('get_unreads', {});
    expect(hits.length).toBeLessThanOrEqual(2 + 1 + 1 + 1 + 4 * 2 + 1);
    expect(hits).toEqual([
      'GET /config/client', 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads', 'GET /users/me/channels',
      'GET /users/me/channel_members', 'GET /users/me/teams', `GET /users/u1/teams/${T1}/threads`, `GET /users/u1/teams/${T2}/threads`, 'POST /users/ids',
    ]);
    expect(hits.some((h) => h.includes('/view'))).toBe(false);
  });
});

describe('get_mentions', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  type P = { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number };
  let corpus: P[];
  let searches: string[];
  let n: number;
  const at = (day: number, i: number) => Date.parse(`2026-10-${day}T03:00:00Z`) + i * 1000;
  const add = (day: number, count: number, message = '@alice hi') => {
    for (let i = 0; i < count; i++) corpus.push({ id: `p${String(n++).padStart(25, '0')}`, user_id: 'u2', channel_id: C, root_id: '', message, create_at: at(day, i) });
  };
  const jstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  // Like Mattermost's database search: up to 100 hits, newest first, "@alice" also hitting a bare "alice", before: excluding that JST day.
  const search = () => {
    const { terms } = bodies['/posts/search'] as { terms: string };
    searches.push(terms);
    const before = /before:(\S+)/.exec(terms)?.[1];
    const hits = corpus.filter((p) => /alice/i.test(p.message) && (!before || jstDay(p.create_at) < before))
      .sort((a, b) => b.create_at - a.create_at).slice(0, 100);
    return { order: hits.map((p) => p.id), posts: Object.fromEntries(hits.map((p) => [p.id, p])) };
  };
  const base = (): Record<string, Route> => ({
    'GET /users/me': () => ({ id: 'u1', username: 'alice', first_name: 'Alice', notify_props: { mention_keys: ' aiso ,,say "hi"', first_name: 'false' } }),
    'POST /posts/search': search,
    'GET /users/me/channels': () => [{ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O' }],
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const ids = (out: string) => [...out.matchAll(/^--- post_id: (\S{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];
  const mentions = () => corpus.filter((p) => p.message.startsWith('@alice')).sort((a, b) => b.create_at - a.create_at).map((p) => p.id);
  const pageAll = async (call: ReturnType<typeof setup>, limit: number, between?: (page: number) => void) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const out = await call('get_mentions', cursor ? { cursor } : { limit });
      seen.push(...ids(out));
      cursor = cursorIn(out);
      if (!cursor) return seen;
      between?.(page);
    }
    throw new Error('did not finish');
  };

  beforeEach(() => {
    corpus = [];
    searches = [];
    n = 0;
  });

  test('searches the user\'s mention terms, each quoted, as an OR search over all teams in JST, asking for 100', async () => {
    add(22, 1);
    routes = base();
    await setup()('get_mentions', {});
    expect(hits.slice(0, 2)).toEqual(['GET /users/me', 'POST /posts/search']);
    expect(bodies['/posts/search']).toEqual({ terms: '"@alice" "aiso"', is_or_search: true, include_deleted_channels: false, time_zone_offset: 32400, page: 0, per_page: 100 });
  });

  test('keeps only posts the server would count as a mention, newest first, with channel, team and permalink', async () => {
    add(21, 1, '@alice older');
    add(22, 1, 'alice without the at sign');
    add(22, 1, 'mail x@alice.example');
    add(22, 1, '`@alice` in code');
    add(23, 1, '@alice newest');
    routes = base();
    const out = await setup()('get_mentions', {});
    expect(ids(out)).toEqual([corpus[4].id, corpus[0].id]);
    expect(out).toContain(`channel_id: ${C}`);
    expect(out).toContain(`team_id: ${T}`);
    expect(out).toContain(`https://mm.example/team-a/pl/${corpus[4].id}`);
    expect(out).toContain('（続きはありません）');
  });

  test('says when there are no mentions', async () => {
    routes = base();
    const out = await setup()('get_mentions', {});
    expect(out).toContain('メンションはありません。');
    expect(out).toContain('（続きはありません）');
  });

  test('pages within one search with limit, and the cursor keeps the page size', async () => {
    add(22, 5);
    routes = base();
    const call = setup();
    const first = await call('get_mentions', { limit: 2 });
    expect(ids(first)).toHaveLength(2);
    expect(ids(await call('get_mentions', { cursor: cursorIn(first), limit: 50 }))).toHaveLength(2);
    expect(searches.every((t) => !t.includes('before:'))).toBe(true);
  });

  test('when a search hits 100, holds back the oldest day D and continues with before:<D+1>, so every mention comes out once', async () => {
    add(20, 30);
    add(21, 40);
    add(21, 20, 'alice no mention');
    add(22, 60);
    routes = base();
    const seen = await pageAll(setup(), 50);
    expect(seen).toEqual(mentions());
    expect(searches).toContain('"@alice" "aiso" before:2026-10-22');
  });

  test('re-derives D on every page, so mentions pushed out of the 100 by new ones are not skipped', async () => {
    add(20, 20);
    add(21, 50);
    add(22, 30);
    const original = mentions();
    routes = base();
    const seen = await pageAll(setup(), 50, (page) => page === 0 && add(23, 30));
    for (const id of original) expect(seen).toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('when a single day has 100 hits, shows what it can of that day, says the day is not complete, and moves to the day before', async () => {
    add(20, 5);
    add(22, 150);
    routes = base();
    const call = setup();
    const outs: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await call('get_mentions', cursor ? { cursor } : { limit: 50 });
      outs.push(out);
      cursor = cursorIn(out);
      if (!cursor) break;
    }
    const seen = outs.flatMap(ids);
    expect(seen).toEqual([...mentions().slice(0, 100), ...mentions().slice(150)]);
    expect(outs.join('\n')).toContain('2026-10-22 のメンションは 1 日で 100 件を超えるため、新しい 100 件だけを照合しました');
    expect(searches).toContain('"@alice" "aiso" before:2026-10-22');
  });

  test('when no hit is a mention, searches again up to 3 times, then says so and gives a cursor to go further back', async () => {
    for (const day of [22, 21, 20, 19]) add(day, 60, 'alice no mention');
    add(18, 5);
    routes = base();
    const call = setup();
    const first = await call('get_mentions', {});
    expect(searches).toEqual(['"@alice" "aiso"', '"@alice" "aiso" before:2026-10-22', '"@alice" "aiso" before:2026-10-21']);
    expect(ids(first)).toEqual([]);
    expect(first).toContain('この範囲には照合に当たる投稿がありませんでした');
    const second = await call('get_mentions', { cursor: cursorIn(first) });
    expect(searches.at(-1)).toBe('"@alice" "aiso" before:2026-10-20');
    expect(ids(second)).toEqual(mentions());
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('get_mentions', { cursor: Buffer.from(JSON.stringify({ page: 1, per_page: 5 })).toString('base64url') }, true);
    expect(out).toContain('cursor が不正です');
  });
});

describe('get_file', () => {
  const F = 'f'.repeat(26);
  const INFO = `GET /files/${F}/info`;
  const PREVIEW = `GET /files/${F}/preview`;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0];
  const GIF = [...Buffer.from('GIF89a')];
  const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];
  const bytes = (head: number[], size = 64) => { const b = new Uint8Array(size); b.set(head); return b; };
  // Mattermost labels every preview image/jpeg, whatever its format.
  const preview = (b: Uint8Array<ArrayBuffer>) => () => new Response(b, { headers: { 'content-type': 'image/jpeg' } });
  const info = (o: Record<string, unknown>) => () => ({ id: F, name: 'shot.png', extension: 'png', mime_type: 'image/png', size: 11393, ...o });
  const image = () => last.content.find((c) => c.type === 'image');
  const mmError = (status: number, id: string) => () => Response.json({ id, message: 'm', status_code: status }, { status });

  test('returns a JPEG preview as an MCP image with the file\'s name, type, size and dimensions as text', async () => {
    const b = bytes(JPEG);
    routes = { [INFO]: info({ name: 'photo.jpg', mime_type: 'image/jpeg', size: 58626, width: 1920, height: 1080, has_preview_image: true }), [PREVIEW]: preview(b) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO, PREVIEW]);
    expect(image()).toEqual({ type: 'image', data: Buffer.from(b).toString('base64'), mimeType: 'image/jpeg' });
    for (const s of [F, 'photo.jpg', 'image/jpeg', '58626 バイト', '1920x1080']) expect(out).toContain(s);
  });

  test.each([['PNG', PNG, 'image/png'], ['GIF', GIF, 'image/gif'], ['WebP', WEBP, 'image/webp']])(
    'tells a %s preview by its first bytes, not by Mattermost\'s image/jpeg header', async (_, head, mime) => {
      routes = { [INFO]: info({ width: 200, height: 100, has_preview_image: true }), [PREVIEW]: preview(bytes(head)) };
      await setup()('get_file', { file_id: F });
      expect(image()?.mimeType).toBe(mime);
    });

  test('fetches the preview of a GIF even though Mattermost reports no preview image for it', async () => {
    routes = { [INFO]: info({ name: 'anim.gif', mime_type: 'image/gif', width: 400, height: 300 }), [PREVIEW]: preview(bytes(JPEG)) };
    await setup()('get_file', { file_id: F });
    expect(hits).toContain(PREVIEW);
    expect(image()?.mimeType).toBe('image/jpeg');
  });

  test('for a file without width and height (HEIC, PDF), returns only its information without fetching a preview', async () => {
    routes = { [INFO]: info({ name: 'IMG.heic', mime_type: 'image/heic', size: 900 }) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO]);
    expect(image()).toBeUndefined();
    for (const s of ['IMG.heic', 'image/heic', '900 バイト']) expect(out).toContain(s);
  });

  test('when Mattermost has no preview for the file (SVG), returns only its information', async () => {
    routes = { [INFO]: info({ name: 'a.svg', mime_type: 'image/svg+xml', width: 300, height: 150 }), [PREVIEW]: mmError(400, 'api.file.get_file_preview.no_preview.app_error') };
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('a.svg');
  });

  test('when the preview bytes are of no known image format, returns only the information', async () => {
    routes = { [INFO]: info({ width: 200, height: 100 }), [PREVIEW]: preview(bytes([1, 2, 3, 4])) };
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('shot.png');
  });

  test('fetches a preview whose longer side is exactly 3000px', async () => {
    routes = { [INFO]: info({ width: 1000, height: 3000 }), [PREVIEW]: preview(bytes(PNG)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
  });

  test.each([[1000, 3001], [4000, 6260]])('does not fetch the preview of a %ix%i image, whose preview would be taller than 3000px', async (width, height) => {
    routes = { [INFO]: info({ width, height }), [PREVIEW]: preview(bytes(PNG)) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO]);
    expect(image()).toBeUndefined();
    expect(out).toContain('縦横が大きすぎるため');
  });

  test('a wide image is scaled to 1920px by Mattermost, so its preview is fetched', async () => {
    routes = { [INFO]: info({ width: 7000, height: 4500 }), [PREVIEW]: preview(bytes(PNG)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
  });

  test('returns a preview of 3.75MB, but not a larger one', async () => {
    routes = { [INFO]: info({ width: 1920, height: 1080 }), [PREVIEW]: preview(bytes(PNG, 3_750_000)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
    routes[PREVIEW] = preview(bytes(PNG, 3_750_001));
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('画像が大きすぎるため');
  });

  test('says the caller may not see the file on a 403', async () => {
    routes = { [INFO]: mmError(403, 'api.context.permissions.app_error') };
    expect(await setup()('get_file', { file_id: F }, true)).toBe('このファイルを見る権限がありません');
  });

  test('says the file is not found on a 404', async () => {
    routes = { [INFO]: mmError(404, 'app.file_info.get.app_error') };
    expect(await setup()('get_file', { file_id: F }, true)).toBe('ファイルが見つかりません（投稿が削除されたか、存在しません）');
  });

  test.each(['..', '.', 'a/b', '%2F', '../../posts/x', '%2e%2e', 'f'.repeat(25)])('rejects the file_id %j without calling Mattermost', async (file_id) => {
    routes = {};
    await setup()('get_file', { file_id }, true);
    expect(hits).toEqual([]);
  });

  test('does not log the image', async () => {
    const b = bytes(PNG);
    b.set(Buffer.from('SECRETPIXELS'), 16);
    routes = { [INFO]: info({ width: 200, height: 100 }), [PREVIEW]: preview(b) };
    await setup()('get_file', { file_id: F });
    const logged = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('get_file');
    expect(logged).not.toContain(Buffer.from(b).toString('base64').slice(16, 40));
    expect(logged).not.toContain('SECRETPIXELS');
  });
});

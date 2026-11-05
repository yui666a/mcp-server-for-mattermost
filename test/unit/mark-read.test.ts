import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];
let urls: string[];
let marked: unknown[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  bodies = {};
  hits = [];
  urls = [];
  marked = [];
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace('/api/v4', '');
    if (req.method === 'POST') bodies[path] = await req.clone().json();
    if (path.endsWith('/mark_read')) marked.push(bodies[path]);
    hits.push(`${req.method} ${path}`);
    urls.push(`${req.method} ${path}${url.search}`);
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
  const rpc = async (method: string, params: object) => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    return r.body;
  };
  // Argument validation failures come back either as an error result or as a JSON-RPC error, depending on the SDK version.
  const call = async (args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
    const body = await rpc('tools/call', { name: 'mark_as_read', arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<{ name: string; description: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const CH = 'c'.repeat(26);
const CH2 = 'd'.repeat(26);
const DM = 'e'.repeat(26);
const TEAM = 't'.repeat(26);
const TEAM2 = 's'.repeat(26);
const ROOT = 'r'.repeat(26);
const id = (n: number) => `p${String(n).padStart(25, '0')}`;
const LAST = id(0);
const mmError = (status: number, mmId: string) => () => Response.json({ id: mmId, message: 'm', status_code: status }, { status });
const post = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n), user_id: 'u2', channel_id: CH, root_id: '', message: `m${n}`, create_at: 1000 + n, ...o });
const after = (ps: ReturnType<typeof post>[], extra: ReturnType<typeof post>[] = []) => ({
  order: ps.map((p) => p.id).reverse(),
  posts: Object.fromEntries([...ps, ...extra].map((p) => [p.id, p])),
});
const channel = (cid: string, name: string, o: Record<string, unknown> = {}) => ({
  id: cid, name, display_name: name.toUpperCase(), team_id: TEAM, type: 'O', total_msg_count: 10, total_msg_count_root: 6, ...o,
});

function base(crt = 'always_on'): Record<string, Route> {
  return {
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': mmError(400, 'app.preference.get.app_error'),
    [`GET /channels/${CH}`]: () => channel(CH, 'town'),
    [`GET /channels/${CH2}`]: () => channel(CH2, 'square'),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    [`GET /channels/${CH}/members/me`]: () => ({ msg_count: 8, msg_count_root: 5, mention_count: 0, mention_count_root: 0 }),
    [`GET /channels/${CH2}/members/me`]: () => ({ msg_count: 9, msg_count_root: 5, mention_count: 0, mention_count_root: 0 }),
    [`GET /posts/${LAST}`]: () => post(0),
    [`GET /channels/${CH}/posts`]: () => after([]),
    [`GET /channels/${CH2}/posts`]: () => after([]),
    'POST /channels/members/u1/mark_read': () => ({ status: 'OK', last_viewed_at_times: {} }),
  };
}
const query = (prefix: string) => Object.fromEntries(new URLSearchParams(urls.find((u) => u.startsWith(prefix))!.split('?')[1]));

describe('mark_as_read for channels', () => {
  test('does not create a DM with a user never messaged before', async () => {
    routes = {
      ...base(),
      'GET /users/me/teams': () => [{ id: TEAM, name: 'team-a' }],
      'GET /users/username/carol': () => ({ id: 'k'.repeat(26), username: 'carol', delete_at: 0 }),
    };
    const r = await setup().call({ channels: [{ channel: '@carol', last_post_id: LAST }] });
    expect(r.text).toContain('@carol との DM はまだありません');
    expect(hits).not.toContain('POST /channels/direct');
  });

  test('marks each channel read right after checking it when nothing but the user\'s own posts (sent through this app) follow last_post_id', async () => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after([post(1, { user_id: 'u1', props: { from_oauth_app: 'true' } })]) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }, { channel: CH2 }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`チャンネル TOWN（channel_id: ${CH}）: 既読にしました。`);
    expect(r.text).toContain(`チャンネル SQUARE（channel_id: ${CH2}）: 呼んだ時点までのすべてを既読にしました。`);
    expect(marked).toEqual([[CH], [CH2]]);
    expect(hits.indexOf('POST /channels/members/u1/mark_read')).toBeLessThan(hits.indexOf(`GET /channels/${CH2}`));
    expect(query(`GET /channels/${CH}/posts`)).toEqual({ after: LAST, per_page: '200', collapsedThreads: 'true', skipFetchThreads: 'true' });
    expect(hits).not.toContain(`GET /channels/${CH2}/posts`);
  });

  test('says a channel with no unread posts or mentions is already read, without calling mark_read', async () => {
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: () => ({ msg_count: 3, msg_count_root: 6, mention_count: 2, mention_count_root: 0 }) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('すでに既読です。');
    expect(hits).not.toContain('POST /channels/members/u1/mark_read');
    expect(hits).not.toContain(`GET /posts/${LAST}`);
  });

  test('a mention alone keeps the channel unread', async () => {
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: () => ({ msg_count: 10, msg_count_root: 6, mention_count: 0, mention_count_root: 1 }) };
    const r = await setup().call({ channels: [{ channel: CH }] });
    expect(r.text).toContain('既読にしました。');
  });

  test.each([
    ['another user\'s post', post(1)],
    ['a webhook post the user created', post(1, { user_id: 'u1', props: { from_webhook: 'true' } })],
    ['a bot post', post(1, { user_id: 'u1', props: { from_bot: 'true' } })],
    ['another user\'s header change', post(1, { type: 'system_header_change' })],
  ])('does not mark the channel read when %s follows last_post_id', async (_, p) => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after([post(2, { user_id: 'u1' }), p]) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('読んでいない投稿があります。既読にしていません。');
    expect(hits).not.toContain('POST /channels/members/u1/mark_read');
  });

  test('does not count other users\' join and leave messages as unread posts', async () => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after([post(1, { type: 'system_join_channel' }), post(2, { type: 'system_add_to_channel' })]) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.text).toContain('既読にしました。');
  });

  test('ignores posts outside order, such as the parent of a reply', async () => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after([post(1, { user_id: 'u1' })], [post(9, { create_at: 1 })]) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.text).toContain('既読にしました。');
  });

  test('refuses when 200 of the user\'s own posts follow, since what lies beyond is unknown, and marks with 199', async () => {
    const own = (k: number) => Array.from({ length: k }, (_, i) => post(i + 1, { user_id: 'u1' }));
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after(own(200)) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('自分の投稿（と参加・退出の通知）が 200 件以上あり、その先を確かめられないため既読にしていません。');
    routes[`GET /channels/${CH}/posts`] = () => after(own(199));
    expect((await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] })).text).toContain('既読にしました。');
  });

  test.each([[403, 'api.context.permissions.app_error'], [404, 'app.post.get.app_error']])('a last_post_id that cannot be fetched (%i) is an error for that item, pointing to read_channel', async (status, mmId) => {
    routes = { ...base(), [`GET /posts/${LAST}`]: mmError(status, mmId) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`last_post_id ${LAST} の投稿が見つかりません（削除されたか、見る権限がありません）。read_channel で読み直して`);
  });

  test('keeps a channel\'s display name with a line break on one line in the result', async () => {
    routes = { ...base(), [`GET /channels/${CH}`]: () => channel(CH, 'town', { display_name: 'To\nwn' }) };
    const r = await setup().call({ channels: [{ channel: CH }] });
    expect(r.text).toContain(`- チャンネル To wn（channel_id: ${CH}）: `);
  });

  test('rejects a last_post_id from another channel', async () => {
    routes = { ...base(), [`GET /posts/${LAST}`]: () => post(0, { channel_id: CH2 }) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.text).toContain(`last_post_id ${LAST} の投稿はこのチャンネルにありません。`);
    expect(hits).not.toContain('POST /channels/members/u1/mark_read');
  });

  test('rejects a channel given twice, by id and by name, as an input error for the second item', async () => {
    routes = { ...base(), [`GET /teams/name/team-a/channels/name/town`]: () => channel(CH, 'town') };
    const r = await setup().call({ channels: [{ channel: CH }, { channel: 'team-a/town' }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('同じチャンネルがほかの項目と重なっています。');
    expect(marked).toEqual([[CH]]);
  });

  test('points to reading the unread posts to the end when it refuses', async () => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => after([post(1)]) };
    const r = await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] });
    expect(r.text).toContain('read_channel の from: "unread" で最後まで読んでから、読んだ中で最も新しい投稿を渡してください。');
  });

  test('says the user has not joined the channel when members/me answers 404', async () => {
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: mmError(404, 'app.channel.get_member.missing.app_error') };
    const r = await setup().call({ channels: [{ channel: CH }] });
    expect(r.text).toContain('このチャンネルに参加していません。');
  });

  test('does not say the user has not joined when members/me answers 403, which a transient failure also gives', async () => {
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: mmError(403, 'api.context.permissions.app_error') };
    const r = await setup().call({ channels: [{ channel: CH }] });
    expect(r.text).toContain('このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。参加しているはずなら、少し待ってから再試行してください。');
    expect(r.text).not.toContain('参加していません');
  });

  test('with CRT off, counts replies and checks for replies after last_post_id', async () => {
    routes = { ...base('disabled'), [`GET /channels/${CH}/members/me`]: () => ({ msg_count: 10, msg_count_root: 0, mention_count: 0, mention_count_root: 5 }) };
    expect((await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] })).text).toContain('すでに既読です。');
    routes[`GET /channels/${CH}/members/me`] = () => ({ msg_count: 9, msg_count_root: 6, mention_count: 0, mention_count_root: 0 });
    urls = [];
    expect((await setup().call({ channels: [{ channel: CH, last_post_id: LAST }] })).text).toContain('既読にしました。');
    expect(query(`GET /channels/${CH}/posts`).collapsedThreads).toBe('false');
  });

  test('when mark_read fails for a channel, that item fails with the error and the others keep their results', async () => {
    routes = {
      ...base(), 'POST /channels/members/u1/mark_read': mmError(400, 'app.channel.update_last_viewed_at.app_error'),
      [`GET /channels/${CH2}/members/me`]: () => ({ msg_count: 10, msg_count_root: 6, mention_count: 0, mention_count_root: 0 }),
    };
    const r = await setup().call({ channels: [{ channel: CH }, { channel: CH2 }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`（channel_id: ${CH}）: 既読にできませんでした。Mattermost がエラーを返しました（400）`);
    expect(r.text).toContain(`（channel_id: ${CH2}）: すでに既読です。`);
  });

  test.each([
    ['rate limited', () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } })],
    ['unavailable', () => new Response('oops', { status: 503 })],
  ])('fails the whole tool when Mattermost is %s', async (_, r) => {
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: r };
    const out = await setup().call({ channels: [{ channel: CH }] });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain('既読にした結果');
  });
});

describe('mark_as_read for threads', () => {
  const read = (o: Record<string, unknown> = {}) => ({ id: ROOT, unread_replies: 0, unread_mentions: 0, ...o });
  const state = (last_viewed_at: number, o: Record<string, unknown> = {}) => ({ id: ROOT, last_viewed_at, last_reply_at: 1009, unread_replies: 0, unread_mentions: 0, ...o });
  const puts = () => hits.filter((h) => h.startsWith('PUT '));
  const reply = (n: number, o: Record<string, unknown> = {}) => post(n, { root_id: ROOT, ...o });
  const threads = (o: Record<string, Route> = {}, crt = 'always_on'): Record<string, Route> => ({
    ...base(crt),
    [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT }),
    [`GET /posts/${id(5)}`]: () => reply(5),
    [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1001, { unread_replies: 3 }),
    [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read(),
    [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1010`]: () => read(),
    ...o,
  });

  test('takes a reply\'s post_id as its thread and marks it read through last_post_id, writing one millisecond past it so a mention on it is cleared too', async () => {
    routes = threads();
    const r = await setup().call({ threads: [{ post_id: id(5), last_post_id: id(5) }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 既読にしました。`);
    expect(hits).toContain(`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`);
  });

  test('without last_post_id, marks it read through the last reply Mattermost reported', async () => {
    routes = threads();
    await setup().call({ threads: [{ post_id: ROOT }] });
    expect(hits).toContain(`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1010`);
  });

  test.each([1006, 1008])('says it is read through last_post_id, without writing or moving the position back, when the position is already %i', async (lva) => {
    routes = threads({ [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(lva, { unread_replies: lva < 1009 ? 1 : 0 }) });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('last_post_id までは既読です。');
    expect(hits.some((h) => h.startsWith('PUT '))).toBe(false);
  });

  test('says a thread is already read when nothing is left past the last reply', async () => {
    routes = threads({ [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1010) });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('すでに既読です。');
    expect(hits.some((h) => h.startsWith('PUT '))).toBe(false);
  });

  test('leaves the position alone when it is already past last_post_id and replies after it are unread, even with a mention left', async () => {
    routes = threads({ [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1008, { unread_replies: 1, unread_mentions: 1 }) });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.text).toContain('last_post_id までは既読です。');
    expect(puts()).toEqual([]);
  });

  test('moves the position one millisecond on when a mention is left with no unread reply, and says the mention was cleared', async () => {
    routes = threads({
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1008, { unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1009`]: () => read(),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.text).toContain('last_post_id までは既読です（残っていたメンションを消しました）。');
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1009`]);
    hits = [];
    routes[`GET /users/u1/teams/${TEAM}/threads/${ROOT}`] = () => state(1010, { unread_mentions: 1 });
    routes[`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`] = () => read();
    expect((await setup().call({ threads: [{ post_id: ROOT }] })).text).toContain('すでに既読です（残っていたメンションを消しました）。');
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`]);
  });

  test('does not claim the mention was cleared when Mattermost still counts one after moving the position on, and does not move it further', async () => {
    routes = threads({
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1010, { unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`]: () => read({ unread_mentions: 1 }),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('すでに既読です。');
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`]);
    hits = [];
    expect((await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] })).text).toContain('last_post_id までは既読です。');
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`]);
  });

  test('writes one millisecond further when a mention is left with no unread reply after marking, so a mention on a reply at the position is cleared', async () => {
    routes = threads({
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read({ unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1007`]: () => read(),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 既読にしました。`);
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`, `PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1007`]);
  });

  test('writes once when the mention left after marking belongs to a reply that is still unread', async () => {
    routes = threads({ [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read({ unread_replies: 2, unread_mentions: 1 }) });
    await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(puts()).toEqual([`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]);
  });

  test('reports the item as read, and how to clear the mention, when only the write clearing it fails', async () => {
    routes = threads({
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read({ unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1007`]: mmError(403, 'api.context.permissions.app_error'),
    });
    let r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 既読にしました。ただし、位置ちょうどの返信のメンションは消せませんでした。Mattermost がエラーを返しました（403）`);
    expect(r.text).toContain('このスレッドを同じ last_post_id で再実行すると消せることがあります。');
    routes[`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1010`] = () => read({ unread_mentions: 1 });
    routes[`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`] = mmError(403, 'api.context.permissions.app_error');
    r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('呼んだ時点の最終返信までを既読にしました。ただし、位置ちょうどの返信のメンションは消せませんでした。');
    expect(r.text).toContain('このスレッドを read_thread で読み、読んだ最終返信を last_post_id に渡して再実行すると消せることがあります。');
    expect(r.text).not.toContain('同じ last_post_id で再実行');
  });

  test('reports a thread already read past the position as read when clearing its mention fails', async () => {
    routes = threads({
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1008, { unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1009`]: mmError(403, 'api.context.permissions.app_error'),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('last_post_id までは既読です。ただし、位置ちょうどの返信のメンションは消せませんでした。');
    routes[`GET /users/u1/teams/${TEAM}/threads/${ROOT}`] = () => state(1010, { unread_mentions: 1 });
    routes[`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1011`] = mmError(403, 'api.context.permissions.app_error');
    const all = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(all.isError).toBe(false);
    expect(all.text).toContain('すでに既読です。ただし、位置ちょうどの返信のメンションは消せませんでした。');
    expect(all.text).toContain('このスレッドを read_thread で読み、読んだ最終返信を last_post_id に渡して再実行すると消せることがあります。');
  });

  const unavailable = () => new Response('oops', { status: 503 });
  const once = (first: Route, then: Route): Route => { let n = 0; return (req) => (n++ ? then : first)(req); };

  test.each([
    ['after marking it', { [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read({ unread_mentions: 1 }), [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1007`]: unavailable }, '既読にしました。'],
    ['when already read past the position', { [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(1008, { unread_mentions: 1 }), [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1009`]: unavailable }, 'last_post_id までは既読です。'],
  ])('reports the thread as read and stops when Mattermost is unavailable while clearing the mention (%s)', async (_, o, read) => {
    routes = threads(o);
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: ${read}ただし、位置ちょうどの返信のメンションを消す書き込みの途中で中断しました（消せたかは分かりません）。このスレッドを同じ last_post_id で再実行すると消せることがあります。`);
    expect(r.text).toContain('ここで中断しました。Mattermost に一時的に接続できません。');
    expect(r.text).not.toContain('処理していません');
  });

  const refused = () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); };

  test('says the mention was not cleared when the write clearing it could not connect', async () => {
    routes = threads({
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1006`]: () => read({ unread_mentions: 1 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1007`]: refused,
    });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 既読にしました。ただし、位置ちょうどの返信のメンションを消す前に中断しました。`);
  });

  test('says an item was not marked when its write could not connect', async () => {
    routes = threads({ 'POST /channels/members/u1/mark_read': once(() => ({ status: 'OK', last_viewed_at_times: {} }), refused) });
    const r = await setup().call({ channels: [{ channel: CH }, { channel: CH2 }] });
    expect(r.text).toContain(`（channel_id: ${CH}）: 呼んだ時点までのすべてを既読にしました。`);
    expect(r.text).toContain(`（channel_id: ${CH2}）: 処理中に中断しました（既読にしていません）。`);
  });

  test('stops at an unavailable write, keeping the items before it and listing the ones not started', async () => {
    routes = threads({ 'POST /channels/members/u1/mark_read': once(() => ({ status: 'OK', last_viewed_at_times: {} }), unavailable) });
    const r = await setup().call({ channels: [{ channel: CH }, { channel: CH2 }], threads: [{ post_id: ROOT }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`（channel_id: ${CH}）: 呼んだ時点までのすべてを既読にしました。`);
    expect(r.text).toContain(`（channel_id: ${CH2}）: 処理中に中断しました（既読になったかは分かりません）。`);
    expect(r.text).toContain(`ここで中断しました。Mattermost に一時的に接続できません。しばらくしてから再試行してください。次の 1 件は処理していません: スレッド（post_id: ${ROOT}）。再実行するときは、中断した項目と処理していない項目だけを渡してください。`);
    expect(hits.filter((h) => h.startsWith('GET /users/u1/teams/'))).toEqual([]);
    const logged = vi.mocked(process.stdout.write).mock.calls.map(([l]) => JSON.parse(String(l)));
    expect(logged).toContainEqual(expect.objectContaining({ event: 'tool_interrupted', mm_user_id: 'u1', tool: 'mark_as_read', outcome: 'upstream_unavailable' }));
    expect(logged).toContainEqual(expect.objectContaining({ event: 'tool_call', tool: 'mark_as_read', outcome: 'tool_error' }));
  });

  test('stops at a rate limit in the threads before writing, saying that thread was not marked', async () => {
    routes = threads({ [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } }) });
    const r = await setup().call({ channels: [{ channel: CH }], threads: [{ post_id: ROOT }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`（channel_id: ${CH}）: 呼んだ時点までのすべてを既読にしました。`);
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 処理中に中断しました（既読にしていません）。`);
    expect(r.text).toContain('ここで中断しました。呼び出しが多すぎます。7 秒後に再試行してください。再実行するときは');
  });

  test('says an item was not marked when its write is rate limited', async () => {
    routes = threads({ 'POST /channels/members/u1/mark_read': once(() => ({ status: 'OK', last_viewed_at_times: {} }), () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } })) });
    const r = await setup().call({ channels: [{ channel: CH }, { channel: CH2 }] });
    expect(r.text).toContain(`（channel_id: ${CH2}）: 処理中に中断しました（既読にしていません）。`);
  });

  test('stops with the results so far even when they are all failures', async () => {
    routes = threads({ 'POST /channels/members/u1/mark_read': once(mmError(400, 'app.channel.update_last_viewed_at.app_error'), unavailable) });
    const r = await setup().call({ channels: [{ channel: CH }, { channel: CH2 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`（channel_id: ${CH}）: 既読にできませんでした。`);
    expect(r.text).toContain(`（channel_id: ${CH2}）: 処理中に中断しました（既読になったかは分かりません）。`);
  });

  test('stops on an unexpected failure too, with the results so far', async () => {
    routes = threads({ [`GET /channels/${CH}/posts`]: () => ({}) });
    const r = await setup().call({ channels: [{ channel: CH2 }, { channel: CH, last_post_id: LAST }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`（channel_id: ${CH2}）: 呼んだ時点までのすべてを既読にしました。`);
    expect(r.text).toContain(`（channel_id: ${CH}）: 処理中に中断しました（既読にしていません）。`);
    expect(r.text).toContain('ここで中断しました。ツールの実行中に予期しないエラーが発生しました。');
  });

  test('reports the first item when its write was sent before Mattermost became unavailable', async () => {
    routes = threads({ 'POST /channels/members/u1/mark_read': unavailable });
    const r = await setup().call({ channels: [{ channel: CH }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`（channel_id: ${CH}）: 処理中に中断しました（既読になったかは分かりません）。`);
  });

  test('accepts the root post itself as last_post_id', async () => {
    routes = threads({ [`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1001`]: () => read(), [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: () => state(900, { unread_replies: 3 }) });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: ROOT }] });
    expect(r.isError).toBe(false);
    expect(hits).toContain(`PUT /users/u1/teams/${TEAM}/threads/${ROOT}/read/1001`);
  });

  test('a thread post_id that cannot be fetched is an error for that item only', async () => {
    routes = threads({ [`GET /posts/${id(7)}`]: mmError(404, 'app.post.get.app_error') });
    const r = await setup().call({ threads: [{ post_id: id(7) }, { post_id: ROOT }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`スレッド（post_id: ${id(7)}）: 既読にできませんでした。投稿が見つかりません（削除されたか、存在しません）。`);
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT}）: 呼んだ時点の最終返信までを既読にしました。`);
    routes[`GET /posts/${id(7)}`] = mmError(403, 'api.context.permissions.app_error');
    expect((await setup().call({ threads: [{ post_id: id(7) }] })).text).toContain('この投稿は見られません（参加していない非公開チャンネルの投稿など）。');
  });

  test('says so when the user belongs to no team, for a DM thread', async () => {
    routes = threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, channel_id: DM }),
      [`GET /channels/${DM}`]: () => channel(DM, 'u1__u2', { team_id: '', type: 'D' }),
      'GET /users/me/teams': () => [],
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('所属しているチームがないため');
  });

  test('rejects a last_post_id from another thread', async () => {
    routes = threads({ [`GET /posts/${id(5)}`]: () => reply(5, { root_id: 'x'.repeat(26) }) });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`last_post_id ${id(5)} の投稿はこのスレッドにありません。`);
  });

  test('a last_post_id that cannot be fetched points to read_thread', async () => {
    routes = threads({ [`GET /posts/${id(5)}`]: mmError(404, 'app.post.get.app_error') });
    const r = await setup().call({ threads: [{ post_id: ROOT, last_post_id: id(5) }] });
    expect(r.text).toContain('read_thread で読み直して');
  });

  test('points to follow_thread for a thread with replies the user does not follow', async () => {
    routes = threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, reply_count: 3 }),
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: mmError(404, 'app.user.get_threads_for_user.not_found'),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('このスレッドはフォローしていないため、既読の状態がありません');
    expect(r.text).toContain('follow_thread を使ってください');
    routes[`GET /posts/${id(5)}`] = () => reply(5);
    expect((await setup().call({ threads: [{ post_id: id(5) }] })).text).toContain('follow_thread を使ってください');
  });

  test('says there is nothing to mark for a root post without replies, without pointing to follow_thread', async () => {
    routes = threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, reply_count: 0 }),
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: mmError(404, 'app.user.get_threads_for_user.not_found'),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('このスレッドには返信が無いため、既読にするものがありません。');
    expect(r.text).not.toContain('follow_thread');
  });

  const unfollowed = (o: Record<string, Route> = {}) => threads({
    [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, reply_count: 3 }),
    [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: mmError(404, 'app.user.get_thread_membership_for_user.not_found'),
    ...o,
  });

  test.each([[403, 'api.context.permissions.app_error'], [404, 'app.channel.get_member.missing.app_error']] as const)('does not point to follow_thread for a thread in a channel the user has not joined (members/me answers %i)', async (status, errorId) => {
    routes = unfollowed({ [`GET /channels/${CH}/members/me`]: mmError(status, errorId) });
    for (const postId of [ROOT, id(5)]) {
      const r = await setup().call({ threads: [{ post_id: postId }] });
      expect(r.text, postId).toContain(status === 404
        ? 'このスレッドのチャンネルに参加していません。参加していないチャンネルのスレッドは未読に数えられないので、既読にするものがありません。'
        : 'このスレッドのチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。参加していないなら、既読にするものはありません。参加しているはずなら、少し待ってから再試行してください。');
      expect(r.text, postId).not.toContain('follow_thread');
    }
  });

  test('checks the membership only when the thread has no state and replies', async () => {
    routes = unfollowed();
    await setup().call({ threads: [{ post_id: ROOT }] });
    expect(hits).toContain(`GET /channels/${CH}/members/me`);
    for (const r of [threads(), threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, reply_count: 0 }),
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT}`]: mmError(404, 'app.user.get_threads_for_user.not_found'),
    })]) {
      routes = r;
      hits = [];
      await setup().call({ threads: [{ post_id: ROOT }] });
      expect(hits).not.toContain(`GET /channels/${CH}/members/me`);
    }
  });

  test('passes on an outage while checking the membership instead of pointing to follow_thread', async () => {
    routes = unfollowed({ [`GET /channels/${CH}/members/me`]: mmError(500, 'app.channel.get_member.app_error') });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('follow_thread');
    expect(r.text).not.toContain('既読にした結果');
  });

  test('uses the user\'s first team for a DM thread', async () => {
    routes = threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, channel_id: DM }),
      [`GET /channels/${DM}`]: () => channel(DM, 'u1__u2', { team_id: '', type: 'D' }),
      'GET /users/me/teams': () => [{ id: TEAM2, name: 'team-b' }, { id: TEAM, name: 'team-a' }],
      [`GET /users/u1/teams/${TEAM2}/threads/${ROOT}`]: () => state(1001, { unread_replies: 3 }),
      [`PUT /users/u1/teams/${TEAM2}/threads/${ROOT}/read/1010`]: () => read(),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.text).toContain('既読にしました。');
  });

  test('looks up the user\'s teams once for several DM threads in one call', async () => {
    const DM2 = 'f'.repeat(26);
    const ROOT2 = 'q'.repeat(26);
    routes = threads({
      [`GET /posts/${ROOT}`]: () => post(0, { id: ROOT, channel_id: DM }),
      [`GET /posts/${ROOT2}`]: () => post(0, { id: ROOT2, channel_id: DM2 }),
      [`GET /channels/${DM}`]: () => channel(DM, 'u1__u2', { team_id: '', type: 'D' }),
      [`GET /channels/${DM2}`]: () => channel(DM2, 'u1__u3', { team_id: '', type: 'D' }),
      'GET /users/me/teams': () => [{ id: TEAM, name: 'team-a' }],
      [`GET /users/u1/teams/${TEAM}/threads/${ROOT2}`]: () => ({ ...state(1001, { unread_replies: 3 }), id: ROOT2 }),
      [`PUT /users/u1/teams/${TEAM}/threads/${ROOT2}/read/1010`]: () => read(),
    });
    const r = await setup().call({ threads: [{ post_id: ROOT }, { post_id: ROOT2 }] });
    expect(r.text).toContain(`スレッド（親 post_id: ${ROOT2}）: 呼んだ時点の最終返信までを既読にしました。`);
    expect(hits.filter((h) => h === 'GET /users/me/teams')).toHaveLength(1);
  });

  test('with CRT off, leaves threads alone and points to marking the channel', async () => {
    routes = threads({}, 'disabled');
    const r = await setup().call({ threads: [{ post_id: ROOT }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('チャンネルを既読にすれば足ります。');
    expect(hits).not.toContain(`GET /posts/${ROOT}`);
  });
});

describe('mark_as_read input and annotations', () => {
  test.each([
    ['no items', {}],
    ['21 items', { channels: Array.from({ length: 11 }, () => ({ channel: CH })), threads: Array.from({ length: 10 }, () => ({ post_id: ROOT })) }],
  ])('rejects %s without calling Mattermost', async (_, args) => {
    routes = base();
    const r = await setup().call(args);
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  test.each([
    ['channels', { channels: [{ channel: CH, last_post: LAST }] }, 'at channels[0]'],
    ['threads', { threads: [{ post_id: ROOT, last_post: LAST }] }, 'at threads[0]'],
    ['a valid item next to one with an unknown key', { channels: [{ channel: CH2 }, { channel: CH, last_post: LAST }], threads: [{ post_id: ROOT }] }, 'at channels[1]'],
  ])('refuses an item with an unknown key (%s) before marking anything read', async (_, args, at) => {
    routes = base();
    const r = await setup().call(args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('受けない引数です: last_post。');
    expect(r.text).toContain(at);
    expect(hits).toEqual([]);
  });

  test('is marked non-read-only, non-destructive and not idempotent, and asks for the newest post read', async () => {
    routes = base();
    const t = (await setup().tools()).find((x) => x.name === 'mark_as_read')!;
    expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(t.description).toContain('last_post_id を付けた呼び出しは、失敗したらそのまま再実行してよい');
    expect(t.description).toContain('last_post_id には、そのチャンネルやスレッドで読んだ投稿のうち最も新しいものの post_id を渡す');
    expect(t.description).toContain('read_channel の from: "unread" で未読を最後まで読んでから渡すこと');
  });
});

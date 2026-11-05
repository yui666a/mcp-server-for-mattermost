import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  routes = {};
  bodies = {};
  hits = [];
});
afterEach(() => vi.restoreAllMocks());

type Rpc = { isError: boolean; text: string };

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST' || req.method === 'PUT') bodies[path] = await req.clone().text().then((t) => (t ? JSON.parse(t) : undefined));
    hits.push(`${req.method} ${path}`);
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
  const call = async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<{ name: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const POST = 'p'.repeat(26);
const CH = 'c'.repeat(26);
const mmError = (status: number, id: string) => () => Response.json({ id, message: 'm', status_code: status }, { status });
const post = (is_pinned = false) => ({ [`GET /posts/${POST}`]: () => ({ id: POST, channel_id: CH, is_pinned }), [`GET /channels/${CH}/members/me`]: () => ({ channel_id: CH, user_id: 'u1' }) });
const FLAG = [{ user_id: 'u1', category: 'flagged_post', name: POST, value: 'true' }];
const GONE = '投稿が見つかりません（削除されたか、存在しません）。';
const HIDDEN = 'この投稿は見られません（参加していない非公開チャンネルの投稿など）。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。';
const ALL = ['save_post', 'unsave_post', 'pin_post', 'unpin_post'];
const CHECKED = ['save_post', 'pin_post', 'unpin_post'];
const WRITE: Record<string, string> = { save_post: 'PUT /users/u1/preferences', pin_post: `POST /posts/${POST}/pin`, unpin_post: `POST /posts/${POST}/unpin` };

test('all four tools are marked as non-read-only, non-destructive and idempotent', async () => {
  const list = await setup().tools();
  for (const name of ALL) {
    expect(list.find((t) => t.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  }
});

test.each(ALL.flatMap((name) => ['p'.repeat(25), 'p'.repeat(27), `${'p'.repeat(25)}/`, '../../users/me'].map((post_id) => [name, post_id])))(
  '%s rejects post_id %j without calling Mattermost', async (name, post_id) => {
    const r = await setup().call(name, { post_id });
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

describe('save_post', () => {
  test('checks the post and the membership, then saves it as a flagged_post preference', async () => {
    routes = { ...post(), 'PUT /users/u1/preferences': () => ({ status: 'OK' }) };
    const r = await setup().call('save_post', { post_id: POST });
    expect(r).toEqual({ isError: false, text: `投稿を保存しました。list_saved_posts で一覧できます。\npost_id: ${POST}` });
    expect(hits).toEqual([`GET /posts/${POST}`, `GET /channels/${CH}/members/me`, 'PUT /users/u1/preferences']);
    expect(bodies['/users/u1/preferences']).toEqual(FLAG);
  });

  test.each([
    [400, 'api.context.invalid_body_param.app_error', GONE],
    [403, 'api.context.permissions.app_error', HIDDEN],
  ])('words a %i %s from the save', async (status, id, want) => {
    routes = { ...post(), 'PUT /users/u1/preferences': mmError(status, id) };
    const r = await setup().call('save_post', { post_id: POST });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(want);
  });
});

describe('unsave_post', () => {
  test('deletes the flagged_post preference without reading the post or the membership', async () => {
    routes = { 'POST /users/u1/preferences/delete': () => ({ status: 'OK' }) };
    const r = await setup().call('unsave_post', { post_id: POST });
    expect(r).toEqual({ isError: false, text: `投稿を保存していれば、保存した投稿から外しました。\npost_id: ${POST}` });
    expect(hits).toEqual(['POST /users/u1/preferences/delete']);
    expect(bodies['/users/u1/preferences/delete']).toEqual(FLAG);
  });
});

describe('pin_post and unpin_post', () => {
  test.each([
    ['pin_post', false, '投稿をピン留めしました。'],
    ['pin_post', true, '投稿は既にピン留めされています。'],
    ['unpin_post', true, '投稿のピン留めを外しました。'],
    ['unpin_post', false, '投稿はピン留めされていません。'],
  ])('%s on a post with is_pinned %s reports "%s" with the post and channel ids', async (name, pinned, head) => {
    routes = { ...post(pinned), [WRITE[name]]: () => ({ status: 'OK' }) };
    const r = await setup().call(name, { post_id: POST });
    expect(r).toEqual({ isError: false, text: `${head}\npost_id: ${POST}\nchannel_id: ${CH}` });
    expect(hits).toEqual([`GET /posts/${POST}`, `GET /channels/${CH}/members/me`, WRITE[name]]);
  });

  test.each(['pin_post', 'unpin_post'].flatMap((name) => [
    [name, 400, 'api.post.update_post.system_message.app_error', 'システムメッセージはピン留めできません。'],
    [name, 400, 'api.post.patch_post.can_not_update_post_in_deleted.error', 'アーカイブ済みのチャンネルの投稿のピン留めは変えられません。'],
    [name, 400, 'api.post.update_post.permissions_time_limit.app_error', '投稿から時間が経った投稿のピン留めは変えられません'],
    [name, 403, 'api.context.permissions.app_error', 'この投稿のピン留めを変えられません（見られない投稿か、削除された投稿）。'],
  ] as const))('%s words a %i %s', async (name, status, id, want) => {
    routes = { ...post(), [WRITE[name]]: mmError(status, id) };
    const r = await setup().call(name, { post_id: POST });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(want);
  });

  test.each(['pin_post', 'unpin_post'] as const)('%s leaves a 400 it has no wording for as Mattermost\'s own error', async (name) => {
    routes = { ...post(name === 'unpin_post'), [WRITE[name]]: mmError(400, 'api.post.patch_post.can_not_update_burn_on_read_post.error') };
    const r = await setup().call(name, { post_id: POST });
    expect(r).toEqual({ isError: true, text: 'Mattermost がエラーを返しました（400）: m' });
  });
});

describe('the checks before save_post, pin_post and unpin_post', () => {
  test.each(CHECKED.flatMap((name) => [[name, 404, 'app.post.get.app_error', GONE], [name, 403, 'api.context.permissions.app_error', HIDDEN]] as const))(
    '%s stops at a %i %s from reading the post', async (name, status, id, want) => {
      routes = { [`GET /posts/${POST}`]: mmError(status, id) };
      const r = await setup().call(name, { post_id: POST });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(want);
      expect(hits).toEqual([`GET /posts/${POST}`]);
    });

  const NOT_MEMBER: Record<string, string> = {
    save_post: '参加していないチャンネルの投稿は保存できません。',
    pin_post: '参加していないチャンネルの投稿はピン留めできません。',
    unpin_post: '参加していないチャンネルの投稿のピン留めは外せません。',
  };
  test.each(CHECKED.flatMap((name) => [[name, 403], [name, 404]] as const))(
    '%s refuses a post of a channel the user has not joined (members/me %i)', async (name, status) => {
      routes = { ...post(), [`GET /channels/${CH}/members/me`]: mmError(status, status === 403 ? 'api.context.permissions.app_error' : 'app.channel.get_member.missing.app_error') };
      const r = await setup().call(name, { post_id: POST });
      expect(r).toEqual({ isError: true, text: status === 404 ? NOT_MEMBER[name] : `このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。${NOT_MEMBER[name]}参加しているはずなら、少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。` });
      expect(hits).not.toContain(WRITE[name]);
    });
});

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];
let uploads: { query: URLSearchParams; type: string | null; bytes: Uint8Array }[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  routes = {};
  bodies = {};
  hits = [];
  uploads = [];
});
afterEach(() => vi.restoreAllMocks());

type Rpc = { isError: boolean; text: string };

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (path === '/files') uploads.push({ query: new URL(req.url).searchParams, type: req.headers.get('content-type'), bytes: new Uint8Array(await req.clone().arrayBuffer()) });
    else if (req.method === 'POST' || req.method === 'PUT') bodies[path] = await req.clone().json();
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
  const tools = async (): Promise<{ name: string; description: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const POST = 'p'.repeat(26);
const mmError = (status: number, id: string) => () => Response.json({ id, message: 'm', status_code: status }, { status });
const ESCAPES = ['..', '.', 'a/b', '%2F', '../../posts/x', '%2e%2e'];
const EMOJI_HINT = '標準の絵文字名（例: white_check_mark、+1）か、search_emoji で調べたカスタム絵文字名を指定してください';
const REACT_403 = 'この投稿にリアクションできません（見られない投稿、存在しない投稿、アーカイブ済みチャンネルの投稿）';

describe('add_reaction', () => {
  const ok = { 'POST /reactions': () => ({}) };

  test('the emoji argument points to search_emoji for custom emoji names', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'add_reaction')! as unknown as { inputSchema: { properties: { emoji: { description: string } } } };
    expect(t.inputSchema.properties.emoji.description).toContain('カスタム絵文字の名前は search_emoji で調べる');
  });

  test('adds the caller\'s reaction to the post and reports the post_id and emoji name', async () => {
    routes = ok;
    const r = await setup().call('add_reaction', { post_id: POST, emoji: 'white_check_mark' });
    expect(r.isError).toBe(false);
    expect(hits).toEqual(['POST /reactions']);
    expect(bodies['/reactions']).toEqual({ user_id: 'u1', post_id: POST, emoji_name: 'white_check_mark' });
    expect(r.text).toContain(`post_id: ${POST}`);
    expect(r.text).toContain('white_check_mark');
  });

  test.each([
    ['  white_check_mark  ', 'white_check_mark'],
    [':white_check_mark:', 'white_check_mark'],
    [' :+1: ', '+1'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['Smile', 'Smile'],
  ])('normalises the emoji %j to %j before sending it', async (given, sent) => {
    routes = ok;
    expect((await setup().call('add_reaction', { post_id: POST, emoji: given })).isError).toBe(false);
    expect(bodies['/reactions']).toMatchObject({ emoji_name: sent });
  });

  test.each(['✅', '::white_check_mark::', 'a'.repeat(65), 'white check mark', '   ', '::'])('rejects the emoji %j with the emoji-name hint, without calling Mattermost', async (emoji) => {
    routes = ok;
    const r = await setup().call('add_reaction', { post_id: POST, emoji });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(EMOJI_HINT);
    expect(hits).toEqual([]);
  });

  test.each(ESCAPES)('rejects the post_id %j without calling Mattermost', async (post_id) => {
    routes = ok;
    const r = await setup().call('add_reaction', { post_id, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('post_id');
    expect(hits).toEqual([]);
  });

  test('an unknown emoji name says the emoji does not exist and how to name one', async () => {
    routes = { 'POST /reactions': mmError(404, 'app.emoji.get_by_name.no_result') };
    const r = await setup().call('add_reaction', { post_id: POST, emoji: ':no_such:' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('絵文字「no_such」がありません');
    expect(r.text).toContain(EMOJI_HINT);
  });

  test('a deleted post (404 app.post.get.app_error) is reported as a missing post, not as a missing emoji', async () => {
    routes = { 'POST /reactions': mmError(404, 'app.post.get.app_error') };
    const r = await setup().call('add_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('投稿が見つかりません');
    expect(r.text).not.toContain('絵文字');
  });

  test.each([
    [400, 'app.post.get.app_error'],
    [400, 'constructor'],
    [400, '__proto__'],
    [400, 'hasOwnProperty'],
  ])('an error whose status and id are not in the wording table (%i %s) stays a generic Mattermost error', async (status, id) => {
    routes = { 'POST /reactions': mmError(status, id) };
    const r = await setup().call('add_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`Mattermost がエラーを返しました（${status}）: m`);
  });

  test('403 says the post cannot be reacted to, naming the possible causes', async () => {
    routes = { 'POST /reactions': mmError(403, 'api.context.permissions.app_error') };
    const r = await setup().call('add_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(REACT_403);
  });

  test('an archived channel is reported as such, ahead of the generic 403 wording', async () => {
    routes = { 'POST /reactions': mmError(403, 'api.reaction.save.archived_channel.app_error') };
    const r = await setup().call('add_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('アーカイブ済み');
    expect(r.text).not.toContain(REACT_403);
  });
});

describe('remove_reaction', () => {
  const path = (emoji: string) => `DELETE /users/u1/posts/${POST}/reactions/${emoji}`;

  test('removes only the caller\'s own reaction and says it was removed if it was there', async () => {
    routes = { [path('+1')]: () => ({ status: 'OK' }) };
    const r = await setup().call('remove_reaction', { post_id: POST, emoji: ':+1:' });
    expect(r.isError).toBe(false);
    expect(hits).toEqual([path('+1')]);
    expect(r.text).toContain('付いていれば外しました');
    expect(r.text).toContain(`post_id: ${POST}`);
    expect(r.text).toContain('+1');
  });

  test.each(ESCAPES)('rejects the post_id %j without calling Mattermost', async (post_id) => {
    const r = await setup().call('remove_reaction', { post_id, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('post_id');
    expect(hits).toEqual([]);
  });

  test.each(ESCAPES)('rejects the emoji %j without calling Mattermost', async (emoji) => {
    const r = await setup().call('remove_reaction', { post_id: POST, emoji });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(EMOJI_HINT);
    expect(hits).toEqual([]);
  });

  test('a deleted post (404 app.post.get.app_error) is reported as a missing post', async () => {
    routes = { [path('smile')]: mmError(404, 'app.post.get.app_error') };
    const r = await setup().call('remove_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('投稿が見つかりません');
  });

  test('403 and an archived channel are worded, the archived one first', async () => {
    routes = { [path('smile')]: mmError(403, 'api.context.permissions.app_error') };
    const s = setup();
    expect((await s.call('remove_reaction', { post_id: POST, emoji: 'smile' })).text).toContain(REACT_403);
    routes = { [path('smile')]: mmError(403, 'api.reaction.delete.archived_channel.app_error') };
    const r = await s.call('remove_reaction', { post_id: POST, emoji: 'smile' });
    expect(r.text).toContain('アーカイブ済み');
    expect(r.text).not.toContain(REACT_403);
  });
});

test('add_reaction and remove_reaction are marked as non-read-only, non-destructive and idempotent', async () => {
  const list = await setup().tools();
  for (const name of ['add_reaction', 'remove_reaction']) {
    expect(list.find((t) => t.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  }
});


describe('edit_message and delete_message', () => {
  const CH = 'c'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const mine = (over: Record<string, unknown> = {}) => ({
    id: POST, user_id: 'u1', channel_id: CH, root_id: '', message: 'old', create_at: 1, type: '', props: {}, reply_count: 0, ...over,
  });
  const GET_POST = `GET /posts/${POST}`;
  const PATCH = `PUT /posts/${POST}/patch`;
  const DELETE = `DELETE /posts/${POST}`;
  const writes = () => hits.filter((h) => !h.startsWith('GET '));
  const serve = (post: object, extra: Record<string, Route> = {}) => {
    routes = {
      [GET_POST]: () => post,
      [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: 't1', type: 'O' }),
      'GET /teams/t1': () => ({ id: 't1', name: 'team-a' }),
      [PATCH]: () => mine({ message: 'new' }),
      [DELETE]: () => ({ status: 'OK' }),
      'GET /users/u1/teams/t1/drafts': () => null,
      ...extra,
    };
  };
  const edit = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) => s.call('edit_message', { post_id: POST, message: 'new', ...over });
  const del = (s: ReturnType<typeof setup>) => s.call('delete_message', { post_id: POST });

  describe('only the caller\'s own posts are edited or deleted', () => {
    test.each([
      ['another user\'s post', { user_id: 'u2' }, '本人の投稿ではありません'],
      ['the caller\'s webhook post', { props: { from_webhook: 'true' } }, 'webhook'],
      ['the caller\'s bot post', { props: { from_bot: 'true' } }, 'Bot'],
      ['the caller\'s system message', { type: 'system_join_channel' }, 'この種類の投稿は扱えません（type: system_join_channel）'],
      ['the caller\'s /me post', { type: 'me' }, 'この種類の投稿は扱えません（type: me）'],
    ])('refuses %s, reading the post and sending neither PATCH nor DELETE', async (_, over, wording) => {
      serve(mine(over));
      const s = setup();
      for (const r of [await edit(s), await del(s)]) {
        expect(r.isError).toBe(true);
        expect(r.text).toContain(wording);
      }
      expect(hits).toEqual([GET_POST, GET_POST]);
    });

    test('accepts the caller\'s post made through an OAuth app, such as this MCP\'s send_message', async () => {
      serve(mine({ props: { from_oauth_app: 'true' } }));
      const s = setup();
      expect((await edit(s)).isError).toBe(false);
      expect((await del(s)).isError).toBe(false);
      expect(writes()).toEqual([PATCH, DELETE]);
    });

    test.each(ESCAPES)('rejects the post_id %j without calling Mattermost', async (post_id) => {
      serve(mine());
      const s = setup();
      for (const r of [await s.call('edit_message', { post_id, message: 'new' }), await s.call('delete_message', { post_id })]) {
        expect(r.isError).toBe(true);
        expect(r.text).toContain('post_id');
      }
      expect(hits).toEqual([]);
    });

    test('a post that no longer exists says it may have been deleted by the previous call', async () => {
      serve(mine(), { [GET_POST]: mmError(404, 'app.post.get.app_error') });
      const s = setup();
      for (const r of [await edit(s), await del(s)]) {
        expect(r.isError).toBe(true);
        expect(r.text).toContain('投稿が見つかりません。直前の呼び出しで削除済みの可能性があります');
      }
      expect(writes()).toEqual([]);
    });
  });

  describe('edit_message', () => {
    test('replaces only the message through the patch API and reports the post_id, channel and permalink', async () => {
      serve(mine({ is_pinned: true }));
      const r = await edit(setup());
      expect(r.isError).toBe(false);
      expect(writes()).toEqual([PATCH]);
      expect(bodies[`/posts/${POST}/patch`]).toEqual({ message: 'new' });
      expect(r.text).toContain(`post_id: ${POST}`);
      expect(r.text).toContain('Town');
      expect(r.text).toContain(`https://mm.example/team-a/pl/${POST}`);
    });

    test('says mentions added by the edit are not notified', async () => {
      serve(mine());
      expect((await edit(setup())).text).toContain('編集で足したメンションは通知されません');
    });

    test.each(['   ', ' \n\t '])('refuses a whitespace-only message %j, pointing to delete_message, without calling Mattermost', async (message) => {
      serve(mine());
      const r = await edit(setup(), { message });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('delete_message');
      expect(hits).toEqual([]);
    });

    test('accepts a 16383-character message and refuses a 16384-character one without calling Mattermost', async () => {
      serve(mine());
      const s = setup();
      expect((await edit(s, { message: 'a'.repeat(16383) })).isError).toBe(false);
      hits = [];
      expect((await edit(s, { message: 'a'.repeat(16384) })).isError).toBe(true);
      expect(hits).toEqual([]);
    });

    test.each([
      ['the edit time limit has passed', 'api.post.update_post.permissions_time_limit.app_error', '編集できる期間を過ぎています'],
      ['the channel is archived', 'api.post.patch_post.can_not_update_post_in_deleted.error', 'アーカイブ済み'],
    ])('when %s, says so', async (_, id, wording) => {
      serve(mine(), { [PATCH]: mmError(400, id) });
      const r = await edit(setup());
      expect(r.isError).toBe(true);
      expect(r.text).toContain(wording);
    });
  });

  describe('delete_message', () => {
    test('deletes the caller\'s post and reports the post_id and channel', async () => {
      serve(mine());
      const r = await del(setup());
      expect(r.isError).toBe(false);
      expect(writes()).toEqual([DELETE]);
      expect(r.text).toContain(`post_id: ${POST}`);
      expect(r.text).toContain('Town');
    });

    test('refuses a thread root that has replies, pointing to the Mattermost UI, without sending DELETE', async () => {
      serve(mine({ root_id: '', reply_count: 2 }));
      const r = await del(setup());
      expect(r.isError).toBe(true);
      expect(r.text).toContain('返信');
      expect(r.text).toContain('Mattermost の画面');
      expect(hits).toEqual([GET_POST]);
    });

    test('deletes the caller\'s reply even though Mattermost reports the whole thread\'s reply_count on it', async () => {
      serve(mine({ root_id: OTHER, reply_count: 3 }));
      const r = await del(setup());
      expect(r.isError).toBe(false);
      expect(writes()).toEqual([DELETE]);
    });

    test.each([
      ['has no reply_count', { reply_count: undefined }],
      ['has a non-numeric reply_count', { reply_count: '2' }],
      ['has no root_id and no reply_count', { root_id: undefined, reply_count: undefined }],
      ['has no root_id and replies', { root_id: undefined, reply_count: 1 }],
    ])('refuses a post that %s, treating it as a thread root that may have replies, without sending DELETE', async (_, over) => {
      serve(mine(over));
      const r = await del(setup());
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Mattermost の画面');
      expect(hits).toEqual([GET_POST]);
    });

    test('an archived channel is reported as such', async () => {
      serve(mine(), { [DELETE]: mmError(400, 'api.post.delete_post.can_not_delete_post_in_deleted.error') });
      const r = await del(setup());
      expect(r.isError).toBe(true);
      expect(r.text).toContain('アーカイブ済み');
    });

    test('a post deleted between the check and DELETE says it may have been deleted by the previous call', async () => {
      serve(mine(), { [DELETE]: mmError(404, 'app.post.get.app_error') });
      const r = await del(setup());
      expect(r.isError).toBe(true);
      expect(r.text).toContain('直前の呼び出しで削除済みの可能性があります');
    });
  });

  describe('send_message\'s duplicate guard no longer treats the post as already sent', () => {
    const send = (s: ReturnType<typeof setup>, message: string) => s.call('send_message', { channel: CH, message });
    const POSTS = 'POST /posts';
    const sent = () => hits.filter((h) => h === POSTS).length;

    test('after delete_message, sending the same body again posts it', async () => {
      serve(mine(), { [POSTS]: () => mine() });
      const s = setup();
      expect((await send(s, 'old')).isError).toBe(false);
      expect((await del(s)).isError).toBe(false);
      const r = await send(s, 'old');
      expect(r.text).toContain('投稿しました');
      expect(sent()).toBe(2);
    });

    test.each([
      ['the post lookup', GET_POST],
      ['DELETE', DELETE],
    ])('after a retried delete_message gets 404 from %s because the first DELETE went through, sending the same body again posts it', async (_, route) => {
      serve(mine(), { [POSTS]: () => mine(), [route]: mmError(404, 'app.post.get.app_error') });
      const s = setup();
      expect((await send(s, 'old')).isError).toBe(false);
      expect((await del(s)).isError).toBe(true);
      const r = await send(s, 'old');
      expect(r.text).toContain('投稿しました');
      expect(sent()).toBe(2);
    });

    test('a refused delete_message keeps send_message\'s duplicate guard, since the post is still there', async () => {
      serve(mine(), { [POSTS]: () => mine(), [DELETE]: mmError(400, 'api.post.delete_post.can_not_delete_post_in_deleted.error') });
      const s = setup();
      expect((await send(s, 'old')).isError).toBe(false);
      expect((await del(s)).isError).toBe(true);
      expect((await send(s, 'old')).text).toContain('同じ本文を直前に投稿済み');
      expect(sent()).toBe(1);
    });

    test('after edit_message, sending the original body again posts it', async () => {
      serve(mine(), { [POSTS]: () => mine() });
      const s = setup();
      expect((await send(s, 'old')).isError).toBe(false);
      expect((await edit(s)).isError).toBe(false);
      const r = await send(s, 'old');
      expect(r.text).toContain('投稿しました');
      expect(sent()).toBe(2);
    });
  });

  test('both are marked destructive and idempotent, and delete_message tells the client to confirm with the user', async () => {
    const list = await setup().tools();
    for (const name of ['edit_message', 'delete_message']) {
      expect(list.find((t) => t.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    }
    const d = list.find((t) => t.name === 'delete_message')!.description;
    expect(d).toContain('取り消せない');
    expect(d).toContain('利用者に確認');
  });
});

describe('save_draft', () => {
  const CH = 'c'.repeat(26);
  const ROOT = 'r'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const PREF = 'GET /users/me/preferences/advanced_settings/name/sync_drafts';
  const LIST = 'GET /users/u1/teams/t1/drafts';
  const SAVE = 'POST /drafts';
  const SYNC_OFF = '設定 > 詳細設定';
  const LEFT_BEHIND = 'この下書きと同じ本文を send_message で送ると、投稿の後にこの下書きを消します（画面で添付を付けた場合は消しません）';
  const writes = () => hits.filter((h) => !h.startsWith('GET '));
  const draft = (over: Record<string, unknown> = {}) => ({ user_id: 'u1', channel_id: CH, root_id: '', message: 'mine', create_at: 1, update_at: 1, ...over });
  const serve = (extra: Record<string, Route> = {}) => {
    routes = {
      [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: 't1', type: 'O' }),
      'GET /teams/t1': () => ({ id: 't1', name: 'team-a' }),
      [`GET /posts/${ROOT}`]: () => ({ id: ROOT, channel_id: CH, root_id: '', user_id: 'u2', message: 'root', create_at: 1 }),
      [PREF]: mmError(400, 'app.preference.get.app_error'),
      [LIST]: () => null,
      [SAVE]: () => new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }),
      ...extra,
    };
  };
  const save = (over: Record<string, unknown> = {}) => setup().call('save_draft', { channel: CH, message: 'hello', ...over });

  describe('saving', () => {
    test('saves a channel draft and says it is in the input box, that the user sends it, and to reopen the channel if it was open', async () => {
      serve();
      const r = await save();
      expect(r.isError).toBe(false);
      expect(hits).toEqual([PREF, `GET /channels/${CH}`, 'GET /teams/t1', LIST, SAVE]);
      expect(bodies['/drafts']).toEqual({ channel_id: CH, root_id: '', message: 'hello' });
      expect(r.text).toContain('入力欄');
      expect(r.text).toContain('送信は本人');
      expect(r.text).toContain(`channel_id: ${CH}`);
      expect(r.text).toContain('Town');
      expect(r.text).toContain('チャンネルを開き直して');
      expect(r.text).toContain('置き換わります');
      expect(r.text).toContain(LEFT_BEHIND);
    });

    test('saves a reply draft after checking the root post, saying only that it was saved as a draft', async () => {
      serve();
      const r = await save({ root_id: ROOT });
      expect(r.isError).toBe(false);
      expect(hits).toEqual([PREF, `GET /channels/${CH}`, 'GET /teams/t1', `GET /posts/${ROOT}`, LIST, SAVE]);
      expect(bodies['/drafts']).toEqual({ channel_id: CH, root_id: ROOT, message: 'hello' });
      expect(r.text).toContain('下書きとして保存しました');
      expect(r.text).toContain(`返信先 post_id: ${ROOT}`);
      expect(r.text).toContain(LEFT_BEHIND);
      expect(r.text).toContain('送信は本人');
      expect(r.text).not.toContain('入力欄');
      expect(r.text).not.toContain('開き直して');
    });

    test('a draft list of null (no drafts at all) is treated as empty', async () => {
      serve({ [LIST]: () => null });
      expect((await save()).isError).toBe(false);
      expect(writes()).toEqual([SAVE]);
    });

    test('drafts for another channel or another thread do not count as an existing draft', async () => {
      serve({ [LIST]: () => [draft({ channel_id: OTHER }), draft({ root_id: ROOT })] });
      expect((await save()).isError).toBe(false);
      expect(writes()).toEqual([SAVE]);
    });

    test('for a DM, checks the draft list of the caller\'s first team, since DM drafts appear in every team\'s list', async () => {
      serve({
        [`GET /channels/${CH}`]: () => ({ id: CH, name: 'u1__u2', display_name: '', team_id: '', type: 'D' }),
        'GET /users/me/teams': () => [{ id: 't9', name: 'team-z' }, { id: 't1', name: 'team-a' }],
        'GET /users/u1/teams/t9/drafts': () => [draft({ message: 'dm draft' })],
      });
      const r = await save();
      expect(r.isError).toBe(true);
      expect(r.text).toContain('dm draft');
      expect(hits).toContain('GET /users/u1/teams/t9/drafts');
      expect(hits).not.toContain(LIST);
      expect(writes()).toEqual([]);
    });

    test('accepts a 16383-character message and refuses a 16384-character one without calling Mattermost', async () => {
      serve();
      expect((await save({ message: 'a'.repeat(16383) })).isError).toBe(false);
      hits = [];
      expect((await save({ message: 'a'.repeat(16384) })).isError).toBe(true);
      expect(hits).toEqual([]);
    });
  });

  describe('an existing draft is not overwritten unless asked', () => {
    test('a different existing draft is kept, quoting its first 200 characters, without sending POST /drafts', async () => {
      serve({ [LIST]: () => [draft({ message: 'a'.repeat(200) + 'B'.repeat(50) })] });
      const r = await save();
      expect(r.isError).toBe(true);
      expect(r.text).toContain('a'.repeat(200));
      expect(r.text).not.toContain('B');
      expect(r.text).toContain('overwrite');
      expect(writes()).toEqual([]);
    });

    test('overwrite: true replaces a different existing draft', async () => {
      serve({ [LIST]: () => [draft({ message: 'old' })] });
      expect((await save({ overwrite: true })).isError).toBe(false);
      expect(writes()).toEqual([SAVE]);
    });

    test.each([false, true])('an existing draft with the same message is reported as already there without sending POST /drafts (overwrite: %s)', async (overwrite) => {
      serve({ [LIST]: () => [draft({ message: 'hello' })] });
      const r = await save({ overwrite });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('同じ下書きがあります');
      expect(r.text).toContain(LEFT_BEHIND);
      expect(writes()).toEqual([]);
    });

    test('an existing reply draft is matched by both channel and root_id', async () => {
      serve({ [LIST]: () => [draft({ message: 'other' }), draft({ root_id: ROOT, message: 'thread draft' })] });
      const r = await save({ root_id: ROOT });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('thread draft');
      expect(writes()).toEqual([]);
    });
  });

  describe('root_id', () => {
    test.each(ESCAPES)('rejects the root_id %j without calling Mattermost', async (root_id) => {
      serve();
      const r = await save({ root_id });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('root_id');
      expect(hits).toEqual([]);
    });

    test.each([
      ['in another channel', { channel_id: OTHER }, 'ありません'],
      ['that is itself a reply', { root_id: OTHER }, '返信'],
    ])('refuses a root post %s without sending POST /drafts', async (_, over, wording) => {
      serve({ [`GET /posts/${ROOT}`]: () => ({ id: ROOT, channel_id: CH, root_id: '', ...over }) });
      const r = await save({ root_id: ROOT });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(wording);
      expect(writes()).toEqual([]);
    });

    test('a root post that does not exist (404) says it was not found', async () => {
      serve({ [`GET /posts/${ROOT}`]: mmError(404, 'app.post.get.app_error') });
      const r = await save({ root_id: ROOT });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('見つかりません');
      expect(writes()).toEqual([]);
    });

    test('a root post the caller cannot see (403) says so, not that drafts cannot be saved', async () => {
      serve({ [`GET /posts/${ROOT}`]: mmError(403, 'api.context.permissions.app_error') });
      const r = await save({ root_id: ROOT });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('見られません');
      expect(r.text).not.toContain('下書きを保存する権限');
      expect(writes()).toEqual([]);
    });
  });

  describe('the caller\'s draft sync setting', () => {
    test('refuses without saving when the caller has turned draft sync off, pointing to the setting', async () => {
      serve({ [PREF]: () => ({ user_id: 'u1', category: 'advanced_settings', name: 'sync_drafts', value: 'false' }) });
      const r = await save();
      expect(r.isError).toBe(true);
      expect(r.text).toContain('同期');
      expect(r.text).toContain(SYNC_OFF);
      expect(writes()).toEqual([]);
    });

    test('saves when the setting is true', async () => {
      serve({ [PREF]: () => ({ user_id: 'u1', category: 'advanced_settings', name: 'sync_drafts', value: 'true' }) });
      expect((await save()).isError).toBe(false);
      expect(writes()).toEqual([SAVE]);
    });

    test('saves when the setting is absent (400 app.preference.get.app_error), since absent means on', async () => {
      serve({ [PREF]: mmError(400, 'app.preference.get.app_error') });
      expect((await save()).isError).toBe(false);
      expect(writes()).toEqual([SAVE]);
    });

    test.each([
      [404, 'app.preference.get.app_error'],
      [400, 'other.id'],
      [403, 'api.context.permissions.app_error'],
      [500, 'x'],
    ])('does not save when the setting cannot be read (%i %s)', async (status, id) => {
      serve({ [PREF]: mmError(status, id) });
      const r = await save();
      expect(r.isError).toBe(true);
      expect(writes()).toEqual([]);
    });
  });

  describe('Mattermost errors', () => {
    test.each([
      ['draft sync is disabled on the server (501)', SAVE, 501, 'api.drafts.disabled.app_error', 'このサーバーでは下書きの同期が無効です'],
      ['draft sync is disabled, seen on the list (501)', LIST, 501, 'api.drafts.disabled.app_error', 'このサーバーでは下書きの同期が無効です'],
      ['the caller may not post there (403)', SAVE, 403, 'api.context.permissions.app_error', 'このチャンネルに下書きを保存する権限がありません'],
      ['the channel is archived', SAVE, 400, 'api.draft.create_draft.can_not_draft_to_deleted.error', 'アーカイブ済み'],
    ])('when %s, says so', async (_, route, status, id, wording) => {
      serve({ [route]: mmError(status, id) });
      const r = await save();
      expect(r.isError).toBe(true);
      expect(r.text).toContain(wording);
    });
  });

  test('is marked destructive and idempotent, says that sending the same text with send_message clears the draft, and overwrite warns that attachments and priority are lost too', async () => {
    const list = await setup().tools() as unknown as { name: string; description: string; annotations: object; inputSchema: { properties: Record<string, { description?: string }> } }[];
    const t = list.find((x) => x.name === 'save_draft')!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(t.description).toContain('この下書きと同じ本文を send_message で送ると、投稿の後に下書きを消す');
    expect(t.description).toContain('画面で添付を付けた下書きは消さない');
    const d = t.inputSchema.properties.overwrite.description!;
    expect(d).toContain('添付');
    expect(d).toContain('優先度');
  });
});

describe('send_message with files', () => {
  const CH = 'c'.repeat(26);
  const UPLOAD = 'POST /files';
  const serve = (extra: Record<string, Route> = {}) => {
    let n = 0;
    routes = {
      [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: 't1', type: 'O' }),
      'GET /teams/t1': () => ({ id: 't1', name: 'team-a' }),
      [UPLOAD]: () => Response.json({ file_infos: [{ id: `f${String(n++).padStart(25, '0')}` }] }, { status: 201 }),
      'POST /posts': () => ({ id: POST, user_id: 'u1', channel_id: CH, root_id: '', message: 'm', create_at: 1, file_ids: (bodies['/posts'] as { file_ids?: string[] }).file_ids }),
      'GET /users/u1/teams/t1/drafts': () => null,
      ...extra,
    };
  };
  const send = (files: unknown, over: Record<string, unknown> = {}) => setup().call('send_message', { channel: CH, message: 'm', files, ...over });
  const KiB128 = 128 * 1024;

  test('sends content_text as its UTF-8 bytes and content_base64 as the decoded bytes, each as an octet-stream named by filename', async () => {
    serve();
    const r = await send([{ name: '図 1.svg', content_text: '<svg>日本</svg>' }, { name: 'b.bin', content_base64: 'AAH/' }]);
    expect(r.isError).toBe(false);
    expect(hits).toEqual([`GET /channels/${CH}`, 'GET /teams/t1', UPLOAD, UPLOAD, 'POST /posts', 'GET /users/u1/teams/t1/drafts']);
    expect(r.text).not.toContain('下書き');
    expect(uploads.map((u) => [u.query.get('channel_id'), u.query.get('filename'), u.type, [...u.bytes]])).toEqual([
      [CH, '図 1.svg', 'application/octet-stream', [...Buffer.from('<svg>日本</svg>', 'utf8')]],
      [CH, 'b.bin', 'application/octet-stream', [0, 1, 255]],
    ]);
    expect(bodies['/posts']).toMatchObject({ channel_id: CH, message: 'm', file_ids: [`f${'0'.repeat(25)}`, `f${'0'.repeat(24)}1`] });
  });

  test('accepts 5 files totalling exactly 128KiB', async () => {
    serve();
    const r = await send([1, 2, 3, 4].map((i) => ({ name: `${i}.txt`, content_text: 'a' })).concat([{ name: '5.txt', content_text: 'a'.repeat(KiB128 - 4) }]));
    expect(r.isError).toBe(false);
    expect(uploads).toHaveLength(5);
  });

  test.each([
    ['no files', []],
    ['6 files', Array.from({ length: 6 }, (_, i) => ({ name: `${i}.txt`, content_text: 'a' }))],
    ['an empty name', [{ name: '', content_text: 'a' }]],
    ['a name of 101 characters', [{ name: 'a'.repeat(101), content_text: 'a' }]],
    ['a name with /', [{ name: 'a/b.txt', content_text: 'a' }]],
    ['a name with \\', [{ name: 'a\\b.txt', content_text: 'a' }]],
    ['a name with a newline', [{ name: 'a\nb.txt', content_text: 'a' }]],
    ['a name with DEL', [{ name: 'a\u007fb.txt', content_text: 'a' }]],
    ['a name with a C1 control', [{ name: 'a\u0085b.txt', content_text: 'a' }]],
    ['both content_text and content_base64', [{ name: 'a.txt', content_text: 'a', content_base64: 'YQ==' }]],
    ['neither content_text nor content_base64', [{ name: 'a.txt' }]],
    ['an empty content_text', [{ name: 'a.txt', content_text: '' }]],
    ['an empty content_base64', [{ name: 'a.txt', content_base64: '' }]],
    ['texts totalling 128KiB + 1 byte', [{ name: 'a.txt', content_text: 'a'.repeat(KiB128 - 1) }, { name: 'b.txt', content_text: 'é' }]],
    ['base64 decoding to 128KiB + 1 byte', [{ name: 'a.bin', content_base64: Buffer.alloc(KiB128 + 1).toString('base64') }]],
  ])('refuses %s without calling Mattermost', async (_, files) => {
    serve();
    const r = await send(files);
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  test('the size limit is told in the refusal', async () => {
    serve();
    const r = await send([{ name: 'a.txt', content_text: 'a'.repeat(KiB128 + 1) }]);
    expect(r.text).toContain('128KiB');
  });

  test.each([
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['base64url characters', 'AA-_'],
    ['a length that is not a multiple of 4', 'AAH'],
    ['a newline inside', 'AAAA\nAAAA'],
    ['padding in the middle', 'AA==AAAA'],
    ['three padding characters', 'A==='],
    ['non-canonical trailing bits', 'AB=='],
  ])('refuses content_base64 with %s without calling Mattermost', async (_, content_base64) => {
    serve();
    const r = await send([{ name: 'a.bin', content_base64 }]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('base64');
    expect(hits).toEqual([]);
  });

  test('refuses a message longer than 16383 characters without calling Mattermost', async () => {
    serve();
    const r = await setup().call('send_message', { channel: CH, message: 'a'.repeat(16384) });
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  test.each([
    [400, 'api.file.upload_file.large_image_detailed.app_error', '画素数が大きすぎる'],
    [413, 'api.file.upload_file.too_large_detailed.app_error', '大きすぎる'],
  ])('an upload refused with %i %s is worded with the file name, and nothing is posted', async (status, id, wording) => {
    serve({ [UPLOAD]: mmError(status, id) });
    const r = await send([{ name: 'huge.png', content_text: 'a' }]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(wording);
    expect(r.text).toContain('huge.png');
    expect(hits).not.toContain('POST /posts');
  });

  test('file contents and names do not appear in the logs', async () => {
    serve();
    await send([{ name: 'secret-name.txt', content_text: 'secret-text' }, { name: 'b.bin', content_base64: Buffer.from('secret-bytes').toString('base64') }]);
    const logged = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('/files');
    for (const s of ['secret-name', 'secret-text', 'secret-bytes', Buffer.from('secret-bytes').toString('base64')]) expect(logged).not.toContain(s);
  });

  test('the tool names both ways to attach and says that a draft with the same message is cleared unless it has files', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'send_message')!;
    expect(t.description).toContain('添付は files（中身を直接渡す）か file_ids（prepare_upload の結果）');
    expect(t.description).toContain('同じ投稿先に本文の同じ下書きがあれば、投稿の後に消す（添付の付いた下書きは消さない）');
  });

  test('files gives its two forms and limits, and sends files on the user\'s PC to prepare_upload only for clients that can run commands there', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'send_message')! as unknown as { inputSchema: { properties: { files: { description: string } } } };
    const d = t.inputSchema.properties.files.description;
    for (const s of ['1〜5 件', '128KiB', 'content_text', 'content_base64', '利用者の PC にあるファイルは、PC でコマンドを実行できるクライアントなら prepare_upload を使う']) expect(d).toContain(s);
  });

  test('files allows content_base64 for a file attached to the chat only when code execution can read it', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'send_message')! as unknown as { inputSchema: { properties: { files: { description: string } } } };
    expect(t.inputSchema.properties.files.description).toContain('チャットに添付されたファイルを content_base64 で送れるのは、コード実行で中身を読めるときだけ');
  });

  test('prepare_upload asks for the user\'s confirmation before curl, and points clients that cannot run commands to save_draft', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'prepare_upload')!;
    expect(t.description).toContain('curl を実行する前に、送るファイルのパスと投稿先を利用者に示して確認を取ること');
    expect(t.description).toContain('save_draft で本文を下書きにし、ファイルは Mattermost の画面から添付するよう案内する');
  });

  test('file_ids of send_message takes files uploaded to the same channel within 24 hours', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'send_message')! as unknown as { inputSchema: { properties: { file_ids: { description: string } } } };
    for (const s of ['同じチャンネル', '24 時間']) expect(t.inputSchema.properties.file_ids.description).toContain(s);
  });

  test('the draft cleanup\'s 5-second deadline reaches the Mattermost requests, and running past it leaves the post a success', async () => {
    const ac = new AbortController();
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => (ms === 5000 ? ac.signal : real(ms)));
    serve({
      'GET /users/u1/teams/t1/drafts': (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason))),
    });
    const sending = setup().call('send_message', { channel: CH, message: 'm' });
    await vi.waitFor(() => expect(hits).toContain('GET /users/u1/teams/t1/drafts'));
    ac.abort(new DOMException('timed out', 'TimeoutError'));
    const r = await sending;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('投稿しました。');
    expect(r.text).toContain('同じ本文の下書きを確かめられなかったか、消せませんでした');
  });
});

describe('a DM not opened yet', () => {
  const CAROL = 'k'.repeat(26);
  const NEW_DM = 'n'.repeat(26);
  const ROOT = 'r'.repeat(26);
  const FILE = 'f'.repeat(26);
  const CREATE = 'POST /channels/direct';
  const PREF = 'GET /users/me/preferences/advanced_settings/name/sync_drafts';
  const serve = () => {
    routes = {
      'GET /users/me/teams': () => [{ id: 't1', name: 'team-a' }],
      'GET /users/username/carol': () => ({ id: CAROL, username: 'carol', delete_at: 0 }),
      [CREATE]: () => ({ id: NEW_DM, name: `${CAROL}__u1`, display_name: '', team_id: '', type: 'D' }),
      [PREF]: mmError(400, 'app.preference.get.app_error'),
      'GET /users/u1/teams/t1/drafts': () => [],
      'POST /drafts': () => ({}),
      [`GET /channels/${NEW_DM}/posts`]: () => ({ order: [], posts: {} }),
      'POST /posts': () => ({ id: POST, channel_id: NEW_DM, root_id: '', user_id: 'u1', message: 'hi', create_at: 1 }),
    };
  };

  test.each([
    ['send_message', { message: 'hi' }, '投稿しました'],
    ['save_draft', { message: 'hi' }, '下書きとして保存しました'],
    ['prepare_upload', {}, 'アップロード用の URL を発行しました'],
  ])('%s creates the DM and writes to it', async (tool, args, done) => {
    serve();
    const r = await setup().call(tool, { channel: '@carol', ...args });
    expect(r.text).toContain(done);
    expect(r.text).toContain(`channel_id: ${NEW_DM}`);
    expect(bodies['/channels/direct']).toEqual(['u1', CAROL]);
  });

  test.each([
    ['send_message', { message: 'hi', root_id: ROOT }],
    ['send_message', { message: 'hi', file_ids: [FILE] }],
    ['save_draft', { message: 'hi', root_id: ROOT }],
  ])('%s with %j does not create the DM, since the DM cannot hold that post or file yet', async (tool, args) => {
    serve();
    const r = await setup().call(tool, { channel: '@carol', ...args });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('@carol との DM はまだありません');
    expect(hits).not.toContain(CREATE);
  });

  test('send_message with files it cannot read does not create the DM', async () => {
    serve();
    const r = await setup().call('send_message', { channel: '@carol', message: 'hi', files: [{ name: 'a.bin', content_base64: 'not base64' }] });
    expect(r.text).toContain('base64 として読めません');
    expect(hits).not.toContain(CREATE);
  });

  test('save_draft with draft sync off neither resolves the channel nor creates the DM', async () => {
    serve();
    routes[PREF] = () => ({ value: 'false' });
    const r = await setup().call('save_draft', { channel: '@carol', message: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('下書きの同期を切っている');
    expect(hits).toEqual([PREF]);
  });
});

describe('a root_id in another channel than the DM or group DM it is sent to', () => {
  const CAROL = 'k'.repeat(26);
  const DM = 'd'.repeat(26);
  const ROOT = 'r'.repeat(26);

  const DAVE = 'v'.repeat(26);
  const GM = 'g'.repeat(26);
  const GM_NAME = createHash('sha1').update([CAROL, DAVE, 'u1'].sort().join('')).digest('hex');

  test.each([
    ['send_message', '@carol', '@carol', DM],
    ['save_draft', '@carol', '@carol', DM],
    ['send_message', '@carol,dave', '@carol, @dave', GM],
    ['save_draft', '@carol,dave', '@carol, @dave', GM],
  ])('%s to %s names the channel by the other users, not by its internal name', async (tool, channel, label, chId) => {
    routes = {
      'GET /users/me/teams': () => [{ id: 't1', name: 'team-a' }],
      'GET /users/username/carol': () => ({ id: CAROL, username: 'carol', delete_at: 0 }),
      'POST /users/usernames': () => [{ id: CAROL, username: 'carol', delete_at: 0 }, { id: DAVE, username: 'dave', delete_at: 0 }],
      [`GET /teams/t1/channels/name/${CAROL}__u1`]: () => ({ id: DM, name: `${CAROL}__u1`, display_name: '', team_id: '', type: 'D' }),
      [`GET /teams/t1/channels/name/${GM_NAME}`]: () => ({ id: GM, name: GM_NAME, display_name: 'carol, dave, me', team_id: '', type: 'G' }),
      'GET /users/me/preferences/advanced_settings/name/sync_drafts': mmError(400, 'app.preference.get.app_error'),
      [`GET /posts/${ROOT}`]: () => ({ id: ROOT, channel_id: 'o'.repeat(26), root_id: '', user_id: 'u2', message: 'root', create_at: 1 }),
    };
    const r = await setup().call(tool, { channel, message: 'hi', root_id: ROOT });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`root_id ${ROOT} の投稿はチャンネル「${label}」（channel_id: ${chId}）にありません。`);
  });
});

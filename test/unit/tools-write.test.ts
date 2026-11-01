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
    if (req.method === 'POST') bodies[path] = await req.clone().json();
    hits.push(`${req.method} ${path}`);
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
const EMOJI_HINT = 'Mattermost の絵文字名で指定してください（例: white_check_mark、+1）';
const REACT_403 = 'この投稿にリアクションできません（見られない投稿、存在しない投稿、アーカイブ済みチャンネルの投稿）';

describe('add_reaction', () => {
  const ok = { 'POST /reactions': () => ({}) };

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


import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zw${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Reaction = { user_id: string; emoji_name: string };

async function mmToken(user: Cred): Promise<string> {
  return /MMAUTHTOKEN=([^;]+)/.exec(await mmLoginCookie(user))![1];
}

async function mmApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${e.mmUrl}/api/v4${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

let req: ReturnType<typeof request>;
let access: string;
let bobMm: string;
let aliceMm: string;
const channels: string[] = [];
let open: { id: string };
let secret: { id: string };

const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
  const r = await req.post('/mcp')
    .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
    .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  expect(r.status).toBe(200);
  return r.body.result;
};
const bobPost = (channelId: string) => mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: channelId, message: `${TAG} post` });
const reactions = async (postId: string) => (await mmApi<Reaction[] | null>(bobMm, 'GET', `/posts/${postId}/reactions`)) ?? [];
const has = (rs: Reaction[], user: string, emoji: string) => rs.some((r) => r.user_id === user && r.emoji_name === emoji);

beforeAll(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const app = intApp();
  req = app.req;
  const mmCookie = await mmLoginCookie(e.users.alice);
  await mmDeauthorize(mmCookie, e.oauth.clientId);
  const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
  const token = await req.post('/mcp/oauth/token').type('form').send({
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
  });
  expect(token.status).toBe(200);
  access = token.body.access_token;
  bobMm = await mmToken(e.users.bob);
  aliceMm = await mmToken(e.users.alice);
  open = await mmApi(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s6-${TAG}`, display_name: `s6 ${TAG}`, type: 'O' });
  channels.push(open.id);
  await mmApi(bobMm, 'POST', `/channels/${open.id}/members`, { user_id: e.users.alice.id });
  secret = await mmApi(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s6p-${TAG}`, display_name: `s6p ${TAG}`, type: 'P' });
  channels.push(secret.id);
});

const drafts: [channelId: string, rootId: string][] = [];
const SYNC = { category: 'advanced_settings', name: 'sync_drafts' };

afterAll(async () => {
  for (const [ch, root] of drafts) await mmApi(aliceMm, 'DELETE', `/users/${e.users.alice.id}/channels/${ch}/drafts${root ? `/${root}` : ''}`);
  await mmApi(aliceMm, 'POST', `/users/${e.users.alice.id}/preferences/delete`, [{ user_id: e.users.alice.id, ...SYNC }]);
  for (const id of channels) await mmApi(bobMm, 'DELETE', `/channels/${id}`);
  vi.restoreAllMocks();
});

describe('add_reaction and remove_reaction against the local Mattermost', () => {
  test('alice adds a reaction to bob\'s post, adding it twice succeeds, and she can remove it', async () => {
    const post = await bobPost(open.id);
    for (let i = 0; i < 2; i++) {
      const r = await call('add_reaction', { post_id: post.id, emoji: ':white_check_mark:' });
      expect(r.isError).toBeFalsy();
    }
    const added = await reactions(post.id);
    expect(added.filter((r) => r.user_id === e.users.alice.id && r.emoji_name === 'white_check_mark')).toHaveLength(1);

    const removed = await call('remove_reaction', { post_id: post.id, emoji: 'white_check_mark' });
    expect(removed.isError).toBeFalsy();
    expect(removed.content[0].text).toContain('付いていれば外しました');
    expect(has(await reactions(post.id), e.users.alice.id, 'white_check_mark')).toBe(false);
  });

  test('removing her own reaction leaves bob\'s reaction with the same emoji in place', async () => {
    const post = await bobPost(open.id);
    await mmApi(bobMm, 'POST', '/reactions', { user_id: e.users.bob.id, post_id: post.id, emoji_name: '+1' });
    expect((await call('add_reaction', { post_id: post.id, emoji: '+1' })).isError).toBeFalsy();
    expect((await call('remove_reaction', { post_id: post.id, emoji: '+1' })).isError).toBeFalsy();
    const rs = await reactions(post.id);
    expect(has(rs, e.users.bob.id, '+1')).toBe(true);
    expect(has(rs, e.users.alice.id, '+1')).toBe(false);
  });

  test('an emoji name Mattermost does not know is answered with how to name an emoji', async () => {
    const post = await bobPost(open.id);
    const r = await call('add_reaction', { post_id: post.id, emoji: `no_such_${TAG}` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`絵文字「no_such_${TAG}」がありません`);
    expect(r.content[0].text).toContain('white_check_mark');
  });

  test('a post in a private channel alice is not in is answered with the cannot-react wording', async () => {
    const post = await bobPost(secret.id);
    const r = await call('add_reaction', { post_id: post.id, emoji: 'smile' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('この投稿にリアクションできません');
    expect(await reactions(post.id)).toEqual([]);
  });
});

describe('edit_message and delete_message against the local Mattermost', () => {
  const post = (token: string, message: string, rootId = '') =>
    mmApi<{ id: string }>(token, 'POST', '/posts', { channel_id: open.id, message: `${TAG} ${message}`, root_id: rootId });
  const getPost = (id: string) => mmApi<{ message: string; is_pinned: boolean }>(bobMm, 'GET', `/posts/${id}`);
  const status = async (id: string) => (await fetch(`${e.mmUrl}/api/v4/posts/${id}`, { headers: { authorization: `Bearer ${bobMm}` } })).status;

  test('alice edits and then deletes her own post sent through this MCP, and the edit keeps the pin', async () => {
    const sent = await call('send_message', { channel: open.id, message: `${TAG} typo` });
    expect(sent.isError).toBeFalsy();
    const id = /post_id: ([A-Za-z0-9]{26})/.exec(sent.content[0].text)![1];
    await mmApi(aliceMm, 'POST', `/posts/${id}/pin`);

    const edited = await call('edit_message', { post_id: id, message: `${TAG} fixed` });
    expect(edited.isError).toBeFalsy();
    expect(await getPost(id)).toMatchObject({ message: `${TAG} fixed`, is_pinned: true });

    const deleted = await call('delete_message', { post_id: id });
    expect(deleted.isError).toBeFalsy();
    expect(await status(id)).toBe(404);
  });

  test('bob\'s post is refused for both edit and delete, and stays as it was', async () => {
    const p = await post(bobMm, 'bob');
    for (const r of [await call('edit_message', { post_id: p.id, message: `${TAG} hijack` }), await call('delete_message', { post_id: p.id })]) {
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('本人の投稿ではありません');
    }
    expect((await getPost(p.id)).message).toBe(`${TAG} bob`);
  });

  test('alice\'s thread root with bob\'s reply is not deleted, and both posts remain', async () => {
    const root = await post(aliceMm, 'root');
    const reply = await post(bobMm, 'reply', root.id);
    const r = await call('delete_message', { post_id: root.id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Mattermost の画面');
    expect(await status(root.id)).toBe(200);
    expect(await status(reply.id)).toBe(200);
  });

  test('alice\'s own reply is deleted although it carries the thread\'s reply_count, and the rest of the thread remains', async () => {
    const root = await post(bobMm, 'root');
    const mine = await post(aliceMm, 'mine', root.id);
    const other = await post(bobMm, 'other', root.id);
    expect((await mmApi<{ reply_count: number }>(aliceMm, 'GET', `/posts/${mine.id}`)).reply_count).toBeGreaterThan(0);
    const r = await call('delete_message', { post_id: mine.id });
    expect(r.isError).toBeFalsy();
    expect(await status(mine.id)).toBe(404);
    expect(await status(root.id)).toBe(200);
    expect(await status(other.id)).toBe(200);
  });
});

describe('save_draft against the local Mattermost', () => {
  type Draft = { channel_id: string; root_id: string; message: string };
  const listed = async () => (await mmApi<Draft[] | null>(aliceMm, 'GET', `/users/${e.users.alice.id}/teams/${e.teams.a.id}/drafts`)) ?? [];
  const find = async (root = '') => (await listed()).find((d) => d.channel_id === open.id && d.root_id === root);

  test('a saved draft shows in alice\'s draft list, a different second one is refused, and overwrite: true replaces it', async () => {
    drafts.push([open.id, '']);
    const first = await call('save_draft', { channel: open.id, message: `${TAG} first` });
    expect(first.isError).toBeFalsy();
    expect((await find())?.message).toBe(`${TAG} first`);

    const second = await call('save_draft', { channel: open.id, message: `${TAG} second` });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(`${TAG} first`);
    expect((await find())?.message).toBe(`${TAG} first`);

    const forced = await call('save_draft', { channel: open.id, message: `${TAG} second`, overwrite: true });
    expect(forced.isError).toBeFalsy();
    expect((await find())?.message).toBe(`${TAG} second`);
  });

  test('a reply\'s post_id as root_id is refused and leaves no draft', async () => {
    const root = await bobPost(open.id);
    const reply = await mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: open.id, message: `${TAG} reply`, root_id: root.id });
    drafts.push([open.id, reply.id]);
    const r = await call('save_draft', { channel: open.id, message: `${TAG} on reply`, root_id: reply.id });
    expect(r.isError).toBe(true);
    expect(await find(reply.id)).toBeUndefined();
  });

  test('a draft with a different message stays after send_message, and stays after the channel\'s own draft is sent', async () => {
    const root = await bobPost(open.id);
    drafts.push([open.id, root.id], [open.id, '']);
    expect((await call('save_draft', { channel: open.id, message: `${TAG} still writing`, root_id: root.id })).isError).toBeFalsy();
    const sent = await call('send_message', { channel: open.id, message: `${TAG} something else`, root_id: root.id });
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0].text).not.toContain('下書き');
    expect((await find(root.id))?.message).toBe(`${TAG} still writing`);

    expect((await call('save_draft', { channel: open.id, message: `${TAG} to send`, overwrite: true })).isError).toBeFalsy();
    const channel = await call('send_message', { channel: open.id, message: `${TAG} to send` });
    expect(channel.content[0].text).toContain('同じ本文の下書きを消しました。そのチャンネルを');
    expect(await find()).toBeUndefined();
    expect((await find(root.id))?.message).toBe(`${TAG} still writing`);
  });

  test('sending a saved DM draft\'s message with send_message removes the draft', async () => {
    const dm = await mmApi<{ id: string }>(aliceMm, 'POST', '/channels/direct', [e.users.alice.id, e.users.bob.id]);
    drafts.push([dm.id, '']);
    expect((await call('save_draft', { channel: dm.id, message: `${TAG} dm to send`, overwrite: true })).isError).toBeFalsy();
    const sent = await call('send_message', { channel: dm.id, message: `${TAG} dm to send` });
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0].text).toContain('同じ本文の下書きを消しました');
    expect(sent.content[0].text).toContain(`投稿先: @${e.users.bob.username}（channel_id: ${dm.id}）`);
    expect((await listed()).find((d) => d.channel_id === dm.id && d.root_id === '')).toBeUndefined();
  });

  test('sending a saved reply draft\'s message with send_message removes the reply draft', async () => {
    const root = await bobPost(open.id);
    drafts.push([open.id, root.id]);
    expect((await call('save_draft', { channel: open.id, message: `${TAG} reply to send`, root_id: root.id })).isError).toBeFalsy();
    const sent = await call('send_message', { channel: open.id, message: `${TAG} reply to send`, root_id: root.id });
    expect(sent.isError).toBeFalsy();
    expect(sent.content[0].text).toContain('同じ本文の下書きを消しました。そのスレッドを');
    expect(await find(root.id)).toBeUndefined();
  });

  test('alice with draft sync turned off is refused and nothing is saved', async () => {
    const root = await bobPost(open.id);
    drafts.push([open.id, root.id]);
    await mmApi(aliceMm, 'PUT', `/users/${e.users.alice.id}/preferences`, [{ user_id: e.users.alice.id, ...SYNC, value: 'false' }]);
    try {
      const r = await call('save_draft', { channel: open.id, message: `${TAG} sync off`, root_id: root.id });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('設定 > 詳細設定');
      expect(await find(root.id)).toBeUndefined();
    } finally {
      await mmApi(aliceMm, 'POST', `/users/${e.users.alice.id}/preferences/delete`, [{ user_id: e.users.alice.id, ...SYNC }]);
    }
  });
});

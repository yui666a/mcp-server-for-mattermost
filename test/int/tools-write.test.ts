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

describe('add_reaction and remove_reaction against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;
  let bobMm: string;
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
    open = await mmApi(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s6-${TAG}`, display_name: `s6 ${TAG}`, type: 'O' });
    channels.push(open.id);
    await mmApi(bobMm, 'POST', `/channels/${open.id}/members`, { user_id: e.users.alice.id });
    secret = await mmApi(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s6p-${TAG}`, display_name: `s6p ${TAG}`, type: 'P' });
    channels.push(secret.id);
  });

  afterAll(async () => {
    for (const id of channels) await mmApi(bobMm, 'DELETE', `/channels/${id}`);
    vi.restoreAllMocks();
  });

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

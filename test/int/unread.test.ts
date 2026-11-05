import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zr${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };

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

const nextCursor = (r: Result) => /next_cursor: (\S+)/.exec(r.content[0].text)?.[1];
const postIds = (r: Result) => [...r.content[0].text.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);
// Not relying on request order alone: paging and the after check compare create_at, and two posts in the same millisecond may be skipped.
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('read_channel from unread and mark_as_read against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let resource: string;
  let access: string;
  let aliceMm: string;
  let bobMm: string;
  const channels: string[] = [];

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };
  const newChannel = async (suffix: string) => {
    const ch = await mmApi<{ id: string }>(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t9-${suffix}-${TAG}`, display_name: `t9 ${suffix} ${TAG}`, type: 'O' });
    channels.push(ch.id);
    await mmApi(aliceMm, 'POST', `/channels/${ch.id}/members`, { user_id: e.users.bob.id });
    return ch.id;
  };
  const say = async (token: string, channel_id: string, message: string, root_id = '') => {
    await tick();
    return (await mmApi<{ id: string }>(token, 'POST', '/posts', { channel_id, message: `${TAG} ${message}`, root_id })).id;
  };
  const unreadOf = (channelId: string) => mmApi<{ msg_count_root: number; mention_count_root: number }>(aliceMm, 'GET', `/users/me/channels/${channelId}/unread`);

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    resource = app.config.resource;
    const mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
    const { clientId, code, verifier } = await mcpAuthorize(req, resource, mmCookie, REDIRECT);
    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource,
    });
    expect(token.status).toBe(200);
    access = token.body.access_token;
    aliceMm = await mmToken(e.users.alice);
    bobMm = await mmToken(e.users.bob);
    const cfg = await mmApi<{ CollapsedThreads: string }>(aliceMm, 'GET', '/config/client?format=old');
    // Failing rather than switching the setting: the server is shared, and a user preference has no effect under always_on.
    if (cfg.CollapsedThreads !== 'always_on') throw new Error(`ServiceSettings.CollapsedThreads must be always_on on the local Mattermost (got ${cfg.CollapsedThreads}).`);
  });

  afterAll(async () => {
    await Promise.allSettled(channels.map((id) => mmApi(e.adminToken, 'DELETE', `/channels/${id}`)));
    vi.restoreAllMocks();
  });

  test('read_channel from unread pages from the first unread root post, oldest first, leaving out replies and marking nothing read', async () => {
    const ch = await newChannel('read');
    await say(aliceMm, ch, 'already read');
    const unread = [await say(bobMm, ch, 'u1'), await say(bobMm, ch, 'u2')];
    // Replying to bob's post rather than alice's: a reply to her own post would leave her an unread thread in an archived channel.
    await say(bobMm, ch, 'reply', unread[0]);
    unread.push(await say(bobMm, ch, 'u3'), await say(bobMm, ch, 'u4'), await say(bobMm, ch, 'u5'));

    const seen: string[] = [];
    let r = await call('read_channel', { channel: ch, from: 'unread', limit: 2 });
    expect(r.content[0].text).toContain('未読の先頭から古い順');
    for (let i = 0; ; i++) {
      expect(r.isError, r.content[0].text).toBeFalsy();
      seen.push(...postIds(r));
      const cursor = nextCursor(r);
      if (!cursor || i > 5) break;
      r = await call('read_channel', { channel: ch, cursor });
    }
    expect(seen).toEqual(unread);
    expect((await unreadOf(ch)).msg_count_root).toBe(5);
  });

  test('mark_as_read marks the channel read up to the last post read, and refuses once someone has posted after it', async () => {
    const ch = await newChannel('mark');
    await say(aliceMm, ch, 'start');
    await say(bobMm, ch, 'one');
    const last = await say(bobMm, ch, `two @${e.users.alice.username}`);
    let r = await call('mark_as_read', { channels: [{ channel: ch, last_post_id: last }] });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('既読にしました。');
    expect(await unreadOf(ch)).toMatchObject({ msg_count_root: 0, mention_count_root: 0 });

    await say(bobMm, ch, 'three');
    r = await call('mark_as_read', { channels: [{ channel: ch, last_post_id: last }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('読んでいない投稿があります。既読にしていません。');
    expect((await unreadOf(ch)).msg_count_root).toBe(1);
  });

  test('mark_as_read marks a channel read when the posts after last_post_id were deleted, or the last post was edited afterwards', async () => {
    const ch = await newChannel('gone');
    await say(aliceMm, ch, 'start');
    const kept = await say(bobMm, ch, 'kept');
    const dropped = await say(bobMm, ch, 'dropped');
    await mmApi(bobMm, 'DELETE', `/posts/${dropped}`);
    let r = await call('mark_as_read', { channels: [{ channel: ch, last_post_id: kept }] });
    expect(r.content[0].text, r.content[0].text).toContain('既読にしました。');

    const edited = await say(bobMm, ch, 'before edit');
    await tick();
    await mmApi(bobMm, 'PUT', `/posts/${edited}/patch`, { message: `${TAG} after edit` });
    r = await call('mark_as_read', { channels: [{ channel: ch, last_post_id: edited }] });
    expect(r.content[0].text, r.content[0].text).toContain('既読にしました。');
    expect((await unreadOf(ch)).msg_count_root).toBe(0);
  });

  test('mark_as_read marks a thread read through last_post_id, clearing a mention on it and leaving later replies unread', async () => {
    const ch = await newChannel('thread');
    const root = await say(aliceMm, ch, 'root');
    await say(bobMm, ch, 'r1', root);
    const r2 = await say(bobMm, ch, `r2 @${e.users.alice.username}`, root);
    await say(bobMm, ch, 'r3', root);
    const r = await call('mark_as_read', { threads: [{ post_id: root, last_post_id: r2 }] });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain(`スレッド（親 post_id: ${root}）: 既読にしました。`);
    const state = await mmApi<{ unread_replies: number; unread_mentions: number }>(aliceMm, 'GET', `/users/${e.users.alice.id}/teams/${e.teams.a.id}/threads/${root}`);
    expect(state).toMatchObject({ unread_replies: 1, unread_mentions: 0 });
    await mmApi(aliceMm, 'PUT', `/users/${e.users.alice.id}/teams/${e.teams.a.id}/threads/${root}/read/${Date.now() + 60_000}`);
  });

  test('mark_as_read does not point to follow_thread for a thread in a public channel alice has not joined', async () => {
    const ch = (await mmApi<{ id: string }>(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t9-away-${TAG}`, display_name: `t9 away ${TAG}`, type: 'O' })).id;
    channels.push(ch);
    const root = await say(bobMm, ch, 'root');
    await say(bobMm, ch, 'reply', root);
    const r = await call('mark_as_read', { threads: [{ post_id: root }] });
    expect(r.content[0].text).toContain('このスレッドのチャンネルに参加していません。');
    expect(r.content[0].text).not.toContain('follow_thread');
  });

  describe('a mention on a reply one millisecond after last_post_id', () => {
    type State = { last_viewed_at: number; unread_replies: number; unread_mentions: number };
    const threadState = (root: string) => mmApi<State>(aliceMm, 'GET', `/users/${e.users.alice.id}/teams/${e.teams.a.id}/threads/${root}`);
    // Only an admin's create_at is kept; Mattermost replaces anyone else's with the current time.
    const thread = async (suffix: string) => {
      const ch = await newChannel(suffix);
      const root = await say(aliceMm, ch, 'root');
      const r2 = await say(bobMm, ch, 'r2', root);
      const t = (await mmApi<{ create_at: number }>(aliceMm, 'GET', `/posts/${r2}`)).create_at;
      await mmApi(e.adminToken, 'POST', '/posts', { channel_id: ch, root_id: root, message: `${TAG} r3 @${e.users.alice.username}`, create_at: t + 1 });
      return { root, r2, t };
    };

    test('is cleared along with the reply when mark_as_read moves the position up to it', async () => {
      const { root, r2 } = await thread('ms-move');
      const r = await call('mark_as_read', { threads: [{ post_id: root, last_post_id: r2 }] });
      expect(r.content[0].text).toContain('既読にしました。');
      expect(await threadState(root)).toMatchObject({ unread_replies: 0, unread_mentions: 0 });
    });

    test('is cleared when the position already stands at that reply', async () => {
      const { root, r2, t } = await thread('ms-stuck');
      await mmApi(aliceMm, 'PUT', `/users/${e.users.alice.id}/teams/${e.teams.a.id}/threads/${root}/read/${t + 1}`);
      expect(await threadState(root)).toMatchObject({ unread_replies: 0, unread_mentions: 1 });
      const r = await call('mark_as_read', { threads: [{ post_id: root, last_post_id: r2 }] });
      expect(r.content[0].text).toContain('last_post_id までは既読です（残っていたメンションを消しました）。');
      expect(await threadState(root)).toMatchObject({ last_viewed_at: t + 2, unread_replies: 0, unread_mentions: 0 });
    });
  });
});

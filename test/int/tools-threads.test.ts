import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zt${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type ThreadState = { unread_replies: number; unread_mentions: number };

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

const postIds = (r: Result) => [...r.content[0].text.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);

describe('followed threads against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;
  let aliceMm: string;
  let bobMm: string;
  const channels: string[] = [];
  const roots: string[] = [];
  const team = e.teams.a.id;

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };
  const newChannel = async (suffix: string, withAlice = true) => {
    const ch = await mmApi<{ id: string }>(bobMm, 'POST', '/channels', { team_id: team, name: `t79-${suffix}-${TAG}`, display_name: `t79 ${suffix} ${TAG}`, type: 'O' });
    channels.push(ch.id);
    if (withAlice) await mmApi(bobMm, 'POST', `/channels/${ch.id}/members`, { user_id: e.users.alice.id });
    return ch.id;
  };
  const say = async (token: string, channel_id: string, message: string, root_id = '') => {
    const id = (await mmApi<{ id: string }>(token, 'POST', '/posts', { channel_id, message: `${TAG} ${message}`, root_id })).id;
    if (!root_id) roots.push(id);
    return id;
  };
  // Not paging through alice's whole list: the shared server keeps every thread other runs left her following, and paging them all would hit the per-user rate limit. This run's threads have the newest replies, so they are on the first page if followed; a thread whose replies were all deleted sorts last and is out of reach.
  const followed = async () => {
    const r = await call('list_followed_threads', { limit: 50 });
    expect(r.isError, r.content[0].text).toBeFalsy();
    return postIds(r);
  };
  const stateOf = (root: string) => mmApi<ThreadState>(aliceMm, 'GET', `/users/${e.users.alice.id}/teams/${team}/threads/${root}`);
  const unfollowAll = () => Promise.allSettled(roots.flatMap((root) => [
    mmApi(aliceMm, 'DELETE', `/users/${e.users.alice.id}/teams/${team}/threads/${root}/following`),
    mmApi(bobMm, 'DELETE', `/users/${e.users.bob.id}/teams/${team}/threads/${root}/following`),
  ]));

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    const resource = app.config.resource;
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

  // A safety net only: archived channels' threads stay in the followed list, so the last test unfollows and checks.
  afterAll(async () => {
    await unfollowAll();
    await Promise.allSettled(channels.map((id) => mmApi(e.adminToken, 'DELETE', `/channels/${id}`)));
    vi.restoreAllMocks();
  });

  test('a thread alice replied to is listed; unfollow_thread drops it and follow_thread brings it back', async () => {
    const ch = await newChannel('list');
    const root = await say(bobMm, ch, 'root');
    await say(aliceMm, ch, 'alice reply', root);
    expect(await followed()).toContain(root);

    let r = await call('unfollow_thread', { post_id: root });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(await followed()).not.toContain(root);

    r = await call('follow_thread', { post_id: root });
    expect(r.content[0].text).toContain('をフォローしました');
    expect(await followed()).toContain(root);
  });

  test('a thread in an archived channel is listed with the channel name marked archived', async () => {
    const ch = await newChannel('archived');
    const root = await say(bobMm, ch, 'root');
    await say(aliceMm, ch, 'alice reply', root);
    await mmApi(e.adminToken, 'DELETE', `/channels/${ch}`);
    let r = await call('list_followed_threads', { limit: 50 });
    const pages = [r.content[0].text];
    for (let i = 0; !pages.at(-1)!.includes(root) && /next_cursor: (\S+)/.test(pages.at(-1)!) && i < 20; i++) {
      r = await call('list_followed_threads', { cursor: /next_cursor: (\S+)/.exec(pages.at(-1)!)![1] });
      pages.push(r.content[0].text);
    }
    const page = pages.find((t) => t.includes(root));
    expect(page).toBeDefined();
    expect(page).toMatch(new RegExp(`channel_id: ${ch}、name: t79-archived-${TAG}、表示名: [^\\n|]*（アーカイブ済み） \\| チーム: ${e.teams.a.name}（team_id: ${team}）`));
  });

  test('follow_thread on a followed thread keeps its unread replies and mentions', async () => {
    const ch = await newChannel('keep');
    const root = await say(bobMm, ch, 'root');
    await say(aliceMm, ch, 'alice reply', root);
    await say(bobMm, ch, `bob reply @${e.users.alice.username}`, root);
    const before = await stateOf(root);
    expect(before.unread_replies).toBe(1);
    expect(before.unread_mentions).toBe(1);

    const r = await call('follow_thread', { post_id: root });
    expect(r.content[0].text).toContain('はすでにフォローしています');
    expect(await stateOf(root)).toMatchObject({ unread_replies: 1, unread_mentions: 1 });
  });

  test('follow_thread given a reply follows the thread it belongs to', async () => {
    const ch = await newChannel('reply');
    const root = await say(bobMm, ch, 'root');
    const reply = await say(bobMm, ch, 'bob reply', root);
    expect(await followed()).not.toContain(root);

    const r = await call('follow_thread', { post_id: reply });
    expect(r.content[0].text).toContain(`スレッド（親 post_id: ${root}）をフォローしました`);
    expect(await followed()).toContain(root);
  });

  test('follow_thread on a followed root post without replies says it is already followed', async () => {
    const ch = await newChannel('noreply');
    const root = await say(bobMm, ch, 'root');
    let r = await call('follow_thread', { post_id: root });
    expect(r.content[0].text).toContain('をフォローしました');
    r = await call('follow_thread', { post_id: root });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(r.content[0].text).toContain('はすでにフォローしています');
    expect(r.content[0].text).toContain('最初の返信があるまで');
  });

  test('follow_thread does not say a thread whose replies were all deleted waits for its first reply', async () => {
    const ch = await newChannel('deleted');
    // bob writes both, without mentioning alice: a reply on alice's post or a mention would have her follow the thread already.
    const root = await say(bobMm, ch, 'root');
    const reply = await say(bobMm, ch, 'bob reply', root);
    await mmApi(bobMm, 'DELETE', `/posts/${reply}`);
    const r = await call('follow_thread', { post_id: root });
    expect(r.content[0].text).toContain('をフォローしました');
    expect(r.content[0].text).not.toContain('最初の返信があるまで');
  });

  test('follow_thread refuses a thread in a public channel alice has not joined', async () => {
    const ch = await newChannel('away', false);
    const root = await say(bobMm, ch, 'root');
    await say(bobMm, ch, 'bob reply', root);
    const r = await call('follow_thread', { post_id: root });
    expect(r.isError).toBe(true);
    // A non-member gets 403 from members/me, which a transient failure also gives, so the tool does not say outright that alice has not joined.
    expect(r.content[0].text).toContain('このチャンネルに参加しているかを確かめられませんでした');
    expect(await followed()).not.toContain(root);
  });

  test('in a DM, the other user\'s reply without a mention follows the thread again after unfollow_thread, and the output says so', async () => {
    const name = `t79dm${TAG}`;
    const carol = await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: e.users.alice.password });
    await mmApi(e.adminToken, 'POST', `/teams/${team}/members`, { team_id: team, user_id: carol.id });
    const carolMm = await mmToken({ id: carol.id, username: name, password: e.users.alice.password });
    const dm = await mmApi<{ id: string }>(carolMm, 'POST', '/channels/direct', [carol.id, e.users.alice.id]);
    const root = await say(carolMm, dm.id, 'root');
    await say(aliceMm, dm.id, 'alice reply', root);
    try {
      const r = await call('unfollow_thread', { post_id: root });
      expect(r.content[0].text).toContain('このスレッドの通知は、外しても止まりません。');
      expect(await followed()).not.toContain(root);
      await say(carolMm, dm.id, 'carol reply', root);
      expect(await followed()).toContain(root);
    } finally {
      // Leaving no unread DM behind: other files' get_unreads checks share alice.
      await mmApi(aliceMm, 'POST', `/channels/members/${e.users.alice.id}/mark_read`, [dm.id]);
      await mmApi(e.adminToken, 'DELETE', `/users/${carol.id}`);
    }
  });

  test('after unfollowing every thread this run touched, none is left in alice\'s list', async () => {
    await unfollowAll();
    const left = await followed();
    expect(roots.filter((id) => left.includes(id))).toEqual([]);
  });
});

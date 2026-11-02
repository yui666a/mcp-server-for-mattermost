import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zq${randomBytes(6).toString('hex')}`;

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

// A file of its own rather than more cases in tools-read.test.ts: paging through alice's unreads would use up that file's per-user rate limit.
describe('get_unreads and get_mentions against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let browserUrl: string;
  let resource: string;
  const access: Record<string, string> = {};
  let aliceMm: string;

  const call = async (who: string, name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access[who]}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };

  const authorize = async (user: Cred) => {
    const mmCookie = await mmLoginCookie(user);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
    const { clientId, code, verifier } = await mcpAuthorize(req, resource, mmCookie, REDIRECT);
    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource,
    });
    expect(token.status).toBe(200);
    access[user.username] = token.body.access_token;
  };

  let bobMm: string;
  let ch: { id: string };
  let threadRoot: string;
  let mention: string;
  let bareName: string;
  const unreadOf = () => mmApi<Record<string, number>>(aliceMm, 'GET', `/users/me/channels/${ch.id}/unread`);
  const pageAll = async (who: string, name: string, limit: number) => {
    const texts: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await call(who, name, cursor ? { cursor } : { limit });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect(r.content[0].text).not.toContain('取り直してください');
      texts.push(r.content[0].text);
      cursor = nextCursor(r);
    } while (cursor && texts.length < 100);
    return texts;
  };

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    browserUrl = app.config.mmBrowserUrl;
    resource = app.config.resource;
    await authorize(e.users.alice);
    aliceMm = await mmToken(e.users.alice);
    const cfg = await mmApi<{ CollapsedThreads: string }>(aliceMm, 'GET', '/config/client?format=old');
    // Failing rather than skipping, as requireMm does: these checks count thread replies separately, which needs CRT on for everyone.
    if (cfg.CollapsedThreads !== 'always_on') throw new Error(`ServiceSettings.CollapsedThreads must be always_on on the local Mattermost (got ${cfg.CollapsedThreads}).`);
    bobMm = await mmToken(e.users.bob);
    ch = await mmApi(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t6-${TAG}`, display_name: `t6 ${TAG}`, type: 'O' });
    await mmApi(aliceMm, 'POST', `/channels/${ch.id}/members`, { user_id: e.users.bob.id });
    threadRoot = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: ch.id, message: `${TAG} alice root` })).id;
    await mmApi(aliceMm, 'POST', '/channels/members/me/view', { channel_id: ch.id });
    await mmApi(bobMm, 'POST', '/posts', { channel_id: ch.id, message: `${TAG} plain` });
    mention = (await mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: ch.id, message: `${TAG} hi @${e.users.alice.username}` })).id;
    bareName = (await mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: ch.id, message: `${TAG} ask ${e.users.alice.username} later` })).id;
    await mmApi(bobMm, 'POST', '/posts', { channel_id: ch.id, root_id: threadRoot, message: `${TAG} reply` });
  });

  afterAll(async () => {
    await mmApi(e.adminToken, 'DELETE', `/channels/${ch.id}`);
    vi.restoreAllMocks();
  });

  test('get_unreads shows the unread root posts and mention of the channel, and the thread with its unread reply, without marking anything read', async () => {
    const before = await unreadOf();
    const text = (await pageAll('alice', 'get_unreads', 100)).join('\n');
    expect(text.split('\n')[0]).toBe('スレッドの折りたたみ（CRT）: 有効（サーバー設定: always_on）');
    const line = text.split('\n').find((l) => l.startsWith('- ') && l.includes(`channel_id: ${ch.id}`));
    expect(line).toContain(`${e.teams.a.name}/t6-${TAG}`);
    expect(line).toContain('未読: 3、メンション: 1、');
    const thread = text.split('\n--- post_id: ').find((b) => b.startsWith(threadRoot));
    expect(thread).toContain('未読の返信: 1、未読のメンション: 0、');
    expect(thread).toContain(`${browserUrl}/${e.teams.a.name}/pl/${threadRoot}`);
    expect(await unreadOf()).toEqual(before);
  });

  test('get_unreads leaves out an unread thread whose channel has been archived', async () => {
    const gone = await mmApi<{ id: string }>(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t6a-${TAG}`, display_name: `t6a ${TAG}`, type: 'O' });
    await mmApi(aliceMm, 'POST', `/channels/${gone.id}/members`, { user_id: e.users.bob.id });
    const root = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: gone.id, message: `${TAG} archived root` })).id;
    await mmApi(aliceMm, 'POST', '/channels/members/me/view', { channel_id: gone.id });
    await mmApi(bobMm, 'POST', '/posts', { channel_id: gone.id, root_id: root, message: `${TAG} archived reply` });
    const thread = await mmApi<{ unread_replies: number }>(aliceMm, 'GET', `/users/me/teams/${e.teams.a.id}/threads/${root}`);
    expect(thread.unread_replies).toBe(1);
    await mmApi(e.adminToken, 'DELETE', `/channels/${gone.id}`);
    const text = (await pageAll('alice', 'get_unreads', 100)).join('\n');
    expect(text).toContain(`channel_id: ${ch.id}`);
    expect(text).not.toContain(root);
    expect(text).not.toContain(gone.id);
  });

  test('get_mentions returns the post with @alice but not the one with a bare "alice"', async () => {
    const r = await call('alice', 'get_mentions', { limit: 50 });
    expect(r.isError).toBeFalsy();
    expect(postIds(r)).toContain(mention);
    expect(postIds(r)).not.toContain(bareName);
  });

  test('get_mentions pages back across days past the 100-hit search cap, with every mention once and in order', async () => {
    const name = `u6${TAG}`;
    const cred = { id: '', username: name, password: 'Passw0rd!dev123' };
    cred.id = (await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: cred.password })).id;
    await mmApi(e.adminToken, 'POST', `/teams/${e.teams.a.id}/members`, { team_id: e.teams.a.id, user_id: cred.id });
    const room = await mmApi<{ id: string }>(e.adminToken, 'POST', '/channels', { team_id: e.teams.a.id, name: `t6d-${TAG}`, display_name: `t6d ${TAG}`, type: 'O' });
    await mmApi(e.adminToken, 'POST', `/channels/${room.id}/members`, { user_id: cred.id });
    const expected: { id: string; create_at: number }[] = [];
    for (const [day, count] of [[20, 50], [21, 60]] as const) {
      for (let i = 0; i < count; i++) {
        const create_at = Date.parse(`2026-10-${day}T03:00:00Z`) + i * 1000;
        const p = await mmApi<{ id: string; create_at: number }>(e.adminToken, 'POST', '/posts', { channel_id: room.id, message: `@${name} ${i}`, create_at });
        expect(p.create_at).toBe(create_at);
        expected.push(p);
        if (i % 10 === 0) await mmApi(e.adminToken, 'POST', '/posts', { channel_id: room.id, message: `${name} without the at sign`, create_at: create_at + 1 });
      }
    }
    await authorize(cred);
    try {
      const seen = (await pageAll(name, 'get_mentions', 50)).flatMap((t) => [...t.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]));
      expect(seen).toEqual(expected.sort((a, b) => b.create_at - a.create_at).map((p) => p.id));
    } finally {
      await mmApi(e.adminToken, 'DELETE', `/channels/${room.id}`);
      await mmApi(e.adminToken, 'DELETE', `/users/${cred.id}`);
    }
  });
});

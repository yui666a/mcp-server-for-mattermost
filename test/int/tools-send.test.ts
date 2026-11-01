import { randomBytes } from 'node:crypto';
import { sha256 } from '../../src/crypto.ts';
import type { Store } from '../../src/store.ts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zs${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Post = { id: string; root_id: string; message: string; user_id: string };

async function mmApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${e.mmUrl}/api/v4${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

describe('send_message against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;
  let aliceMm: string;
  let channel: { id: string; name: string };
  let store: Store;
  let skew = 0;

  const call = async (args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };
  const messages = async (text: string) =>
    Object.values((await mmApi<{ posts: Record<string, Post> }>(aliceMm, 'GET', `/channels/${channel.id}/posts?per_page=200`)).posts)
      .filter((p) => p.message === text);

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp({}, () => Date.now() + skew);
    req = app.req;
    store = app.store;
    const mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
    const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
    });
    expect(token.status).toBe(200);
    access = token.body.access_token;
    aliceMm = /MMAUTHTOKEN=([^;]+)/.exec(await mmLoginCookie(e.users.alice))![1];
    channel = await mmApi(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t9-${TAG}`, display_name: `t9 ${TAG}`, type: 'O' });
  });

  afterAll(() => vi.restoreAllMocks());

  test('posts to a thread and returns permalink', async () => {
    const root = await mmApi<Post>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} root` });
    const r = await call({ channel: `team-a/${channel.name}`, message: `${TAG} reply`, root_id: root.id });
    expect(r.isError).toBeFalsy();
    const [posted] = await messages(`${TAG} reply`);
    expect(posted.root_id).toBe(root.id);
    expect(posted.user_id).toBe(e.users.alice.id);
    expect(r.content[0].text).toContain(`${new URL(e.mmUrl).origin}/team-a/pl/${posted.id}`);
  });

  test('same body twice within 10 minutes posts once', async () => {
    const message = `${TAG} twice`;
    const first = await call({ channel: channel.id, message });
    const second = await call({ channel: `team-a/${channel.name}`, message });
    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    const found = await messages(message);
    expect(found).toHaveLength(1);
    expect(second.content[0].text).toContain(found[0].id);
    expect(second.content[0].text).toContain('投稿していません');
  });

  const lostFirstAttempt = async (message: string, rootId?: string) => {
    skew = -60_000;
    try {
      store.claimPost({ mmUserId: e.users.alice.id, channelId: channel.id, rootId, bodyHash: sha256(message) });
    } finally {
      skew = 0;
    }
    return mmApi<Post>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message, ...(rootId ? { root_id: rootId } : {}) });
  };

  test('a retry after a lost response returns the post that already exists', async () => {
    const message = `${TAG} lost`;
    const prev = await lostFirstAttempt(message);
    const r = await call({ channel: channel.id, message });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(`post_id: ${prev.id}`);
    expect(r.content[0].text).toContain('既にあったため');
    expect(await messages(message)).toHaveLength(1);
  });

  test('a retried thread reply after a lost response returns the reply that already exists', async () => {
    const root = await mmApi<Post>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} lost root` });
    const message = `${TAG} lost reply`;
    const prev = await lostFirstAttempt(message, root.id);
    const r = await call({ channel: channel.id, message, root_id: root.id });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(`post_id: ${prev.id}`);
    expect(r.content[0].text).toContain('既にあったため');
    const found = await messages(message);
    expect(found).toHaveLength(1);
    expect(found[0].root_id).toBe(root.id);
  });

  test('ambiguous channel name is rejected without posting', async () => {
    const r = await call({ channel: 'general-dup', message: `${TAG} ambiguous` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(e.teams.a.dupChannelId);
    expect(r.content[0].text).toContain(e.teams.b.dupChannelId);
  });
});

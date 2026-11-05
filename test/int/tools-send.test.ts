import { createHash, randomBytes } from 'node:crypto';
import { sha256 } from '../../src/crypto.ts';
import type { Store } from '../../src/store.ts';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, withUsers } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zs${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Post = { id: string; root_id: string; message: string; user_id: string; file_ids?: string[]; metadata?: { files?: { name: string; mime_type: string; width?: number; height?: number }[] } };

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

  afterAll(async () => {
    try {
      await mmApi(e.adminToken, 'DELETE', `/channels/${channel.id}`);
    } finally {
      vi.restoreAllMocks();
    }
  });

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

  test('attaches a text file and a small PNG to the post', async () => {
    const message = `${TAG} files`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const r = await call({ channel: channel.id, message, files: [{ name: 'note.md', content_text: '# 見出し' }, { name: 'dot.png', content_base64: png.toString('base64') }] });
    expect(r.isError).toBeFalsy();
    const [posted] = await messages(message);
    expect(r.content[0].text).toContain(`post_id: ${posted.id}`);
    const got = await mmApi<Post>(aliceMm, 'GET', `/posts/${posted.id}`);
    expect(got.file_ids).toHaveLength(2);
    expect(got.metadata?.files?.map((f) => [f.name, f.mime_type, f.width, f.height])).toEqual([
      ['note.md', expect.stringContaining('text/'), undefined, undefined],
      ['dot.png', 'image/png', 1, 1],
    ]);
  });

  test('files over the total size limit are refused before anything is uploaded to Mattermost', async () => {
    const message = `${TAG} too big`;
    const before = vi.mocked(process.stdout.write).mock.calls.length;
    const r = await call({ channel: channel.id, message, files: [{ name: 'big.txt', content_text: 'a'.repeat(128 * 1024 + 1) }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('128KiB');
    const apiPaths = vi.mocked(process.stdout.write).mock.calls.slice(before).map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'mm_api').map((l) => l.path);
    expect(apiPaths).toEqual([]);
    expect(await messages(message)).toHaveLength(0);
  });

  test('creates a group DM given as @a,b, which read_channel then reads but does not create', () => withUsers(async (made) => {
    const names = ['ga', 'gb'].map((p) => `${p}${TAG}`);
    const ids: string[] = [];
    for (const name of names) {
      ids.push((await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: 'Passw0rd!dev123' })).id);
      made.push(ids.at(-1)!);
    }
    const spec = `@${names[1]},${names[0]}`;
    const gmName = createHash('sha1').update([e.users.alice.id, ...ids].sort().join('')).digest('hex');
    const gm = () => fetch(`${e.mmUrl}/api/v4/teams/${e.teams.a.id}/channels/name/${gmName}`, { headers: { authorization: `Bearer ${aliceMm}` } });
    const read = () => req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_channel', arguments: { channel: spec } } }));
    expect((await read()).body.result.content[0].text).toContain(`@${names[0]}, @${names[1]} とのグループ DM はまだありません`);
    expect((await gm()).status).toBe(404);

    const r = await call({ channel: spec, message: `${TAG} first group dm` });
    expect(r.isError).toBeFalsy();
    const created = await (await gm()).json() as { id: string; type: string };
    expect(created.type).toBe('G');
    expect(r.content[0].text).toContain(`投稿先: channel_id: ${created.id}、表示名: @${names[0]}, @${names[1]}`);
    expect((await read()).body.result.content[0].text).toContain(`${TAG} first group dm`);
  }));

  test('ambiguous channel name is rejected without posting', async () => {
    const r = await call({ channel: 'general-dup', message: `${TAG} ambiguous` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(e.teams.a.dupChannelId);
    expect(r.content[0].text).toContain(e.teams.b.dupChannelId);
  });

  test('creates the DM with a user never messaged before, which read_channel does not', () => withUsers(async (made) => {
    const name = `dm${TAG}`;
    const u = await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: 'Passw0rd!dev123' });
    made.push(u.id);
    const dmName = [e.users.alice.id, u.id].sort().join('__');
    const dm = () => fetch(`${e.mmUrl}/api/v4/teams/${e.teams.a.id}/channels/name/${dmName}`, { headers: { authorization: `Bearer ${aliceMm}` } });
    const read = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_channel', arguments: { channel: `@${name}` } } }));
    expect(read.body.result.content[0].text).toContain(`@${name} との DM はまだありません`);
    expect((await dm()).status).toBe(404);

    const r = await call({ channel: `@${name}`, message: `${TAG} first dm` });
    expect(r.isError).toBeFalsy();
    const created = await (await dm()).json() as { id: string };
    expect(r.content[0].text).toContain(`投稿先: channel_id: ${created.id}、表示名: @${name}`);
    const posts = await mmApi<{ posts: Record<string, Post> }>(aliceMm, 'GET', `/channels/${created.id}/posts`);
    expect(Object.values(posts.posts).map((p) => p.message)).toEqual([`${TAG} first dm`]);
  }));

  test('attaches a file uploaded through prepare_upload to a DM that prepare_upload created', async () => {
    const name = `up${TAG}`;
    const u = await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: 'Passw0rd!dev123' });
    await mmApi(e.adminToken, 'POST', `/teams/${e.teams.a.id}/members`, { team_id: e.teams.a.id, user_id: u.id });
    try {
      const tool = (toolName: string, args: Record<string, unknown>) => req.post('/mcp')
        .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
        .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }));
      const prepared: string = (await tool('prepare_upload', { channel: `@${name}` })).body.result.content[0].text;
      const dmId = /channel_id: ([A-Za-z0-9]{26})/.exec(prepared)![1];
      const token = /\/mcp\/upload\/([A-Za-z0-9_-]+)/.exec(prepared)![1];
      const up = await req.post(`/mcp/upload/${token}`).attach('file', Buffer.from(`${TAG} note`), 'note.txt');
      expect(up.status).toBe(200);
      const fileId = /file_id: ([A-Za-z0-9]{26})/.exec(up.text)![1];

      const r = await call({ channel: `@${name}`, message: `${TAG} dm with file`, file_ids: [fileId] });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain(`channel_id: ${dmId}`);
      const posts = await mmApi<{ posts: Record<string, Post> }>(aliceMm, 'GET', `/channels/${dmId}/posts`);
      const [posted] = Object.values(posts.posts);
      expect(posted.message).toBe(`${TAG} dm with file`);
      expect(posted.file_ids).toEqual([fileId]);
    } finally {
      await mmApi(e.adminToken, 'DELETE', `/users/${u.id}`);
    }
  });
});

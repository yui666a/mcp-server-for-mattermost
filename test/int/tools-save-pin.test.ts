import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zp${randomBytes(6).toString('hex')}`;

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

let req: ReturnType<typeof request>;
let access: string;
let bobMm: string;
let aliceMm: string;
const alice = e.users.alice.id;
const channels: string[] = [];
const touched: string[] = [];
let joined: { id: string };
let outside: { id: string };
let secret: { id: string };
let archived: { id: string };
let archivedByTest = false;

const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
  const r = await req.post('/mcp')
    .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
    .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  expect(r.status).toBe(200);
  return r.body.result;
};
const bobPost = async (channelId: string) => {
  const p = await mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: channelId, message: `${TAG} post` });
  touched.push(p.id);
  return p.id;
};
const channel = (name: string, type: 'O' | 'P') => mmApi<{ id: string }>(bobMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `${name}-${TAG}`, display_name: `${name} ${TAG}`, type })
  .then((c) => (channels.push(c.id), c));
const addAlice = (channelId: string) => mmApi(bobMm, 'POST', `/channels/${channelId}/members`, { user_id: alice });
// Read to the last page rather than stopping at the wanted post: "not listed" can only be told after the whole list.
async function saved(): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const r = await call('list_saved_posts', { limit: 50, ...(cursor ? { cursor } : {}) });
    expect(r.isError).toBeFalsy();
    seen.push(...postIds(r));
    cursor = nextCursor(r);
  } while (cursor);
  return seen;
}
async function savedInMattermost(): Promise<string[]> {
  const res = await fetch(`${e.mmUrl}/api/v4/users/${alice}/preferences/flagged_post`, { headers: { authorization: `Bearer ${aliceMm}` } });
  // A 404 rather than an empty list is how Mattermost answers when the user has no saved post at all.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`flagged_post -> ${res.status}`);
  return ((await res.json()) as { name: string }[]).map((p) => p.name);
}
const pinned = async (channelId: string) => {
  const r = await call('get_channel', { channel: channelId, pinned_limit: 50 });
  expect(r.isError).toBeFalsy();
  return postIds(r);
};

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
  joined = await channel('sp-in', 'O');
  await addAlice(joined.id);
  outside = await channel('sp-out', 'O');
  secret = await channel('sp-secret', 'P');
  archived = await channel('sp-arch', 'O');
  await addAlice(archived.id);
});

afterAll(async () => {
  // Not stopping at the first failure: a failed unsave must not leave the channels behind, nor the other way round.
  const done = await Promise.allSettled([
    touched.length ? mmApi(aliceMm, 'POST', `/users/${alice}/preferences/delete`, touched.map((name) => ({ user_id: alice, category: 'flagged_post', name, value: 'true' }))) : undefined,
    // Not archiving the channel the test archived: Mattermost refuses to archive it twice.
    ...channels.filter((x) => !(archivedByTest && x === archived.id)).map((id) => mmApi(bobMm, 'DELETE', `/channels/${id}`)),
  ]);
  vi.restoreAllMocks();
  for (const d of done) if (d.status === 'rejected') throw d.reason;
});

describe('save_post and unsave_post agree with list_saved_posts', () => {
  test('a saved post shows in list_saved_posts, and an unsaved one no longer does', async () => {
    const id = await bobPost(joined.id);
    const r = await call('save_post', { post_id: id });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(`post_id: ${id}`);
    expect(await saved()).toContain(id);
    expect(await savedInMattermost()).toContain(id);

    expect((await call('save_post', { post_id: id })).isError).toBeFalsy();
    expect((await saved()).filter((x) => x === id)).toHaveLength(1);

    expect((await call('unsave_post', { post_id: id })).isError).toBeFalsy();
    expect(await saved()).not.toContain(id);
    expect(await savedInMattermost()).not.toContain(id);
    expect((await call('unsave_post', { post_id: id })).isError).toBeFalsy();
  });

  test('a post of a public channel alice has not joined is refused and saved nowhere', async () => {
    const id = await bobPost(outside.id);
    const r = await call('save_post', { post_id: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('参加していないチャンネルの投稿は保存できません。');
    expect(await saved()).not.toContain(id);
    expect(await savedInMattermost()).not.toContain(id);
  });

  test('a post of a private channel alice cannot see, and a post that does not exist, are refused', async () => {
    const hidden = await call('save_post', { post_id: await bobPost(secret.id) });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toBe('この投稿は見られません（参加していない非公開チャンネルの投稿など）。');
    const missing = await call('save_post', { post_id: 'a'.repeat(26) });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe('投稿が見つかりません（削除されたか、存在しません）。');
  });
});

describe('pin_post and unpin_post agree with get_channel', () => {
  test('a pinned post shows in get_channel, and an unpinned one no longer does', async () => {
    const id = await bobPost(joined.id);
    const r = await call('pin_post', { post_id: id });
    expect(r.content[0].text).toBe(`投稿をピン留めしました。\npost_id: ${id}\nchannel_id: ${joined.id}`);
    expect(await pinned(joined.id)).toContain(id);
    expect((await call('pin_post', { post_id: id })).content[0].text).toContain('投稿は既にピン留めされています。');

    expect((await call('unpin_post', { post_id: id })).content[0].text).toContain('投稿のピン留めを外しました。');
    expect(await pinned(joined.id)).not.toContain(id);
    expect((await call('unpin_post', { post_id: id })).content[0].text).toContain('投稿はピン留めされていません。');
  });

  test('a post of a public channel alice has not joined is not pinned', async () => {
    const id = await bobPost(outside.id);
    const r = await call('pin_post', { post_id: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('参加していないチャンネルの投稿はピン留めできません。');
    const post = await mmApi<{ is_pinned: boolean }>(bobMm, 'GET', `/posts/${id}`);
    expect(post.is_pinned).toBe(false);
  });
});

test('in an archived channel alice belongs to, a post can be saved and listed but not pinned', async () => {
  // Not pinned beforehand: Mattermost answers 200 to pinning an already pinned post even in an archived channel.
  const id = await bobPost(archived.id);
  await mmApi(bobMm, 'DELETE', `/channels/${archived.id}`);
  archivedByTest = true;

  expect((await call('save_post', { post_id: id })).isError).toBeFalsy();
  expect(await saved()).toContain(id);

  const r = await call('pin_post', { post_id: id });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe('アーカイブ済みのチャンネルの投稿のピン留めは変えられません。');
});

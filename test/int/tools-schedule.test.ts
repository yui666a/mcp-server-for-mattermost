import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { MmClient } from '../../src/mattermost/client.ts';
import { tick } from '../../src/scheduler.ts';
import type { Store } from '../../src/store.ts';
import { intApp, mcpAuthorize, mmDeauthorize, mmLoginCookie, requireMm } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zs${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Post = { id: string; message: string; user_id: string; file_ids?: string[] };

async function mmApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${e.mmUrl}/api/v4${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

describe('scheduled messages against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;
  let store: Store;
  let mm: MmClient;
  let aliceMm: string;
  let channel: { id: string; name: string };

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    store = app.store;
    mm = app.mm;
    const mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
    const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
    });
    expect(token.status).toBe(200);
    access = token.body.access_token;
    aliceMm = /MMAUTHTOKEN=([^;]+)/.exec(await mmLoginCookie(e.users.alice))![1];
    channel = await mmApi(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s11-${TAG}`, display_name: `s11 ${TAG}`, type: 'O' });
  });

  const inTwoMinutes = () => new Date(Date.now() + 90_000).toISOString().slice(0, 19) + 'Z';
  const schedule = async (channelId: string, message: string) => {
    const made = await call('schedule_message', { channel: channelId, message, at: inTwoMinutes() });
    expect(made.isError, made.content[0].text).toBeFalsy();
    return /予約 ID: (\S+)/.exec(made.content[0].text)![1];
  };
  const rowOf = async (id: string) => {
    const text = (await call('list_scheduled_messages', {})).content[0].text;
    return text.split('--- ').find((r) => r.startsWith(`予約 ID: ${id}\n`)) ?? '';
  };
  const postsWith = async (channelId: string, message: string) =>
    Object.values((await mmApi<{ posts: Record<string, Post> }>(aliceMm, 'GET', `/channels/${channelId}/posts?per_page=200`)).posts)
      .filter((p) => p.message === message);

  test('when its time comes, a schedule is posted to Mattermost with the user\'s account and listed as posted', async () => {
    const message = `${TAG} scheduled`;
    const id = await schedule(channel.id, message);
    await tick(store, mm, Date.now() + 120_000);
    const [post] = await postsWith(channel.id, message);
    expect(post?.user_id).toBe(e.users.alice.id);
    const row = await rowOf(id);
    expect(row).toContain('状態: 投稿済み');
    expect(row).toContain(`post_id: ${post.id}`);
    expect(row).toContain(`/team-a/pl/${post.id}`);
  });

  test('a schedule to a user never messaged before creates the DM when scheduling and is posted there when its time comes', async () => {
    const name = `sdm${TAG}`;
    const u = await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: name, email: `${name}@example.com`, password: 'Passw0rd!dev123' });
    const message = `${TAG} scheduled dm`;
    const made = await call('schedule_message', { channel: `@${name}`, message, at: inTwoMinutes() });
    expect(made.isError, made.content[0].text).toBeFalsy();
    const dm = await mmApi<{ id: string }>(aliceMm, 'GET', `/teams/${e.teams.a.id}/channels/name/${[e.users.alice.id, u.id].sort().join('__')}`);
    expect(made.content[0].text).toContain(`channel_id: ${dm.id}`);
    await tick(store, mm, Date.now() + 120_000);
    expect((await postsWith(dm.id, message))[0]?.user_id).toBe(e.users.alice.id);
  });

  test('a schedule with a file uploaded beforehand is posted with the file attached, and send_message refuses the file meanwhile', async () => {
    const res = await fetch(`${e.mmUrl}/api/v4/files?${new URLSearchParams({ channel_id: channel.id, filename: `${TAG}.txt` })}`, {
      method: 'POST', headers: { authorization: `Bearer ${aliceMm}`, 'content-type': 'application/octet-stream' }, body: new TextEncoder().encode('report'),
    });
    if (!res.ok) throw new Error(`upload -> ${res.status} ${await res.text()}`);
    const fileId = ((await res.json()) as { file_infos: { id: string }[] }).file_infos[0].id;
    store.recordUploadedFile({ mmUserId: e.users.alice.id, channelId: channel.id }, fileId);
    const message = `${TAG} scheduled with a file`;
    const made = await call('schedule_message', { channel: channel.id, message, at: inTwoMinutes(), file_ids: [fileId] });
    expect(made.isError, made.content[0].text).toBeFalsy();
    const id = /予約 ID: (\S+)/.exec(made.content[0].text)![1];
    const sent = await call('send_message', { channel: channel.id, message: `${TAG} steals the file`, file_ids: [fileId] });
    expect(sent.isError).toBe(true);
    expect(sent.content[0].text).toContain(id);
    await tick(store, mm, Date.now() + 120_000);
    const [post] = await postsWith(channel.id, message);
    expect(post?.file_ids).toEqual([fileId]);
    const row = await rowOf(id);
    expect(row).toContain('状態: 投稿済み');
    expect(row).toContain(`post_id: ${post.id}`);
    expect(row).toContain(`添付: ${fileId}`);
    expect(row).not.toContain('注意');
  });

  test('a cancelled schedule is not posted', async () => {
    const message = `${TAG} cancelled`;
    const id = await schedule(channel.id, message);
    expect((await call('cancel_scheduled_message', { id })).isError).toBeFalsy();
    await tick(store, mm, Date.now() + 120_000);
    expect(await postsWith(channel.id, message)).toEqual([]);
  });

  test('a schedule to a channel archived before its time fails with a reason', async () => {
    const doomed = await mmApi<{ id: string }>(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `s11-gone-${TAG}`, display_name: `s11 gone ${TAG}`, type: 'O' });
    const id = await schedule(doomed.id, `${TAG} to archived`);
    await mmApi(e.adminToken, 'DELETE', `/channels/${doomed.id}`);
    await tick(store, mm, Date.now() + 120_000);
    const row = await rowOf(id);
    expect(row).toContain('状態: 失敗');
    expect(/失敗の理由: (.+)/.exec(row)?.[1]).toContain('アーカイブ');
  });

  test('schedule_message refuses files, which only send_message takes, instead of scheduling without the attachment', async () => {
    const message = `${TAG} with inline files`;
    const r = await call('schedule_message', { channel: channel.id, message, at: inTwoMinutes(), files: [{ name: 'a.txt', content_text: 'hello' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('受けない引数です: files');
    expect(r.content[0].text).toContain('send_message の files を使えます');
    expect(r.content[0].text).toContain('prepare_upload の説明の案内に従ってください');
    expect((await call('list_scheduled_messages', {})).content[0].text).not.toContain(message);
  });

  test('update_scheduled_message refuses file_ids and leaves the schedule as it was', async () => {
    const message = `${TAG} kept as is`;
    const id = await schedule(channel.id, message);
    const r = await call('update_scheduled_message', { id, message: `${TAG} changed`, file_ids: ['a'.repeat(26)] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('受けない引数です: file_ids');
    expect(r.content[0].text).toContain('投稿先と添付は変えられません');
    expect(r.content[0].text).toContain('cancel_scheduled_message');
    expect(await rowOf(id)).toContain(message);
    expect((await call('cancel_scheduled_message', { id })).isError).toBeFalsy();
  });

  afterAll(() => vi.restoreAllMocks());

  test('a schedule is listed as pending and can be cancelled', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString().slice(0, 16) + 'Z';
    const made = await call('schedule_message', { channel: 'team-a/town-square', message: `${TAG} later`, at });
    expect(made.isError, made.content[0].text).toBeFalsy();
    const id = /予約 ID: (\S+)/.exec(made.content[0].text)![1];

    const listed = await call('list_scheduled_messages', { status: 'pending' });
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain(`予約 ID: ${id}\n状態: 待機中`);
    expect(listed.content[0].text).toContain(`${TAG} later`);

    const cancelled = await call('cancel_scheduled_message', { id });
    expect(cancelled.isError).toBeFalsy();
    expect((await call('list_scheduled_messages', {})).content[0].text).not.toContain(id);
  });
});

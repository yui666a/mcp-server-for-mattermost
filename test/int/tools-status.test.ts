import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `st${randomBytes(6).toString('hex')}`;
// Not alice: her automatic offline status cannot be restored through the API, and other test files read her status.
const USER: Cred = { id: '', username: 'statusint', password: e.users.alice.password };
// A 1x1 PNG: Mattermost reads the image header before it accepts a custom emoji.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

type Result = { isError?: boolean; content: { type: string; text: string }[] };
type Status = { status: string; manual: boolean; dnd_end_time: number };

async function mmApi<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${e.mmUrl}/api/v4${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

let req: ReturnType<typeof request>;
let access: string;
let userMm: string;
const emojiIds: string[] = [];

const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
  const r = await req.post('/mcp')
    .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
    .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
  expect(r.status).toBe(200);
  return r.body.result;
};
const status = () => mmApi<Status>(userMm, 'GET', `/users/${USER.id}/status`);
const customStatus = async () => (await mmApi<{ props?: { customStatus?: string } }>(userMm, 'GET', `/users/${USER.id}`)).props?.customStatus ?? '';

beforeAll(async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const found = await fetch(`${e.mmUrl}/api/v4/users/username/${USER.username}`, { headers: { authorization: `Bearer ${e.adminToken}` } });
  USER.id = found.ok
    ? ((await found.json()) as { id: string }).id
    : (await mmApi<{ id: string }>(e.adminToken, 'POST', '/users', { username: USER.username, email: `${USER.username}@example.com`, password: USER.password })).id;
  const app = intApp();
  req = app.req;
  const mmCookie = await mmLoginCookie(USER);
  userMm = /MMAUTHTOKEN=([^;]+)/.exec(mmCookie)![1];
  await mmDeauthorize(mmCookie, e.oauth.clientId);
  const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
  const token = await req.post('/mcp/oauth/token').type('form').send({
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
  });
  expect(token.status).toBe(200);
  access = token.body.access_token;
});

afterAll(async () => {
  const done = await Promise.allSettled([
    mmApi(userMm, 'DELETE', `/users/${USER.id}/status/custom`),
    mmApi(userMm, 'PUT', `/users/${USER.id}/status`, { user_id: USER.id, status: 'online' }),
    ...emojiIds.map((id) => mmApi(userMm, 'DELETE', `/emoji/${id}`)),
  ]);
  vi.restoreAllMocks();
  for (const d of done) if (d.status === 'rejected') throw d.reason;
});

describe('set_status against the local Mattermost', () => {
  test('dnd with an end time is stored with the end floored to the minute', async () => {
    const end = new Date(Date.now() + 2 * 3600_000);
    end.setUTCSeconds(30, 0);
    const r = await call('set_status', { status: 'dnd', dnd_until: end.toISOString().replace(/\.\d{3}Z$/, 'Z') });
    expect(r.isError).toBeFalsy();
    const s = await status();
    expect(s).toMatchObject({ status: 'dnd', manual: true, dnd_end_time: Math.floor(end.getTime() / 60_000) * 60 });
    expect(r.content[0].text).toContain('「取り込み中」（終了:');
  });

  test('away is manual, and online goes back to automatic', async () => {
    expect((await call('set_status', { status: 'away' })).isError).toBeFalsy();
    expect(await status()).toMatchObject({ status: 'away', manual: true });
    expect((await call('set_status', { status: 'online' })).isError).toBeFalsy();
    expect(await status()).toMatchObject({ status: 'online', manual: false });
  });
});

describe('set_custom_status and clear_custom_status against the local Mattermost', () => {
  test('sets an emoji, text and expiry, then clears them', async () => {
    const until = new Date(Date.now() + 3600_000);
    until.setUTCSeconds(0, 0);
    const r = await call('set_custom_status', { emoji: ':calendar:', text: `会議中 ${TAG}`, until: until.toISOString().replace(/\.\d{3}Z$/, 'Z') });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(await customStatus())).toEqual({ emoji: 'calendar', text: `会議中 ${TAG}`, duration: 'date_and_time', expires_at: until.toISOString().replace('.000Z', 'Z') });

    expect((await call('clear_custom_status', {})).isError).toBeFalsy();
    expect(await customStatus()).toBe('');
  });

  test('an unknown emoji is refused by Mattermost and reported as a missing emoji', async () => {
    const r = await call('set_custom_status', { emoji: `no_such_${TAG}` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`絵文字「no_such_${TAG}」がありません`);
  });
});

describe('search_emoji against the local Mattermost', () => {
  const name = `party_${TAG}`;

  beforeAll(async () => {
    const fd = new FormData();
    fd.set('image', new Blob([PNG], { type: 'image/png' }), 'e.png');
    fd.set('emoji', JSON.stringify({ name, creator_id: USER.id }));
    const res = await fetch(`${e.mmUrl}/api/v4/emoji`, { method: 'POST', headers: { authorization: `Bearer ${userMm}` }, body: fd });
    expect(res.status).toBe(200);
    emojiIds.push(((await res.json()) as { id: string }).id);
  });

  test('finds a custom emoji by part of its name', async () => {
    const r = await call('search_emoji', { name: TAG });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text.split('\n')).toEqual([`:${name}:`]);
  });

  test('a custom emoji found by name can be set as the custom status emoji', async () => {
    expect((await call('set_custom_status', { emoji: `:${name}:` })).isError).toBeFalsy();
    expect(JSON.parse(await customStatus())).toMatchObject({ emoji: name });
  });

  test('the standard emoji calendar is not among the results', async () => {
    const r = await call('search_emoji', { name: 'calendar' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text.split('\n')).not.toContain(':calendar:');
  });
});

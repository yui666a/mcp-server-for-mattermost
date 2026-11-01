import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Limiter } from '../../src/mattermost/limiter.ts';
import { env, intApp, mcpAuthorize, mmAvailable, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const up = await mmAvailable();
const e = up ? env() : (undefined as never);

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

describe.skipIf(!up)('read tools against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let limiter: Limiter;
  const access: Record<'alice' | 'bob', string> = { alice: '', bob: '' };
  let aliceMm: string;
  let channel: { id: string; name: string };
  let root: string;
  let replies: string[];

  const call = async (who: 'alice' | 'bob', name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access[who]}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    limiter = app.limiter;
    for (const who of ['alice', 'bob'] as const) {
      const mmCookie = await mmLoginCookie(e.users[who]);
      await mmDeauthorize(mmCookie, e.oauth.clientId);
      const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
      const token = await req.post('/mcp/oauth/token').type('form').send({
        grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
      });
      expect(token.status).toBe(200);
      access[who] = token.body.access_token;
    }

    aliceMm = await mmToken(e.users.alice);
    channel = await mmApi(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t8-${TAG}`, display_name: `t8 ${TAG}`, type: 'O' });
    for (let i = 1; i <= 7; i++) await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} channel ${i}` });
    root = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} root` })).id;
    replies = [];
    for (let i = 1; i <= 5; i++) {
      replies.push((await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: channel.id, root_id: root, message: `${TAG} reply ${i}` })).id);
    }
  });

  afterAll(() => vi.restoreAllMocks());

  test('read_channel paginates without gaps or duplicates', async () => {
    const all = await mmApi<{ order: string[] }>(aliceMm, 'GET', `/channels/${channel.id}/posts?per_page=200`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call('alice', 'read_channel', { channel: `team-a/${channel.name}`, limit: 4, ...(cursor ? { cursor } : {}) });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain(channel.id);
      expect(r.content[0].text).toContain(e.teams.a.id);
      seen.push(...postIds(r));
      cursor = nextCursor(r);
      if (pages++ === 0) await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} posted while paging` });
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(all.order);
  });

  test('read_thread returns parent only on first page, ascending', async () => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const r = await call('alice', 'read_thread', { post_id: replies[2], limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain(channel.id);
      pages.push(postIds(r));
      cursor = nextCursor(r);
    } while (cursor);
    expect(pages).toEqual([[root, replies[0], replies[1]], [replies[2], replies[3]], [replies[4]]]);
  });

  test('private channel of alice is invisible to bob', async () => {
    const priv = e.teams.a.privateChannelId!;
    expect((await call('alice', 'read_channel', { channel: priv })).isError).toBeFalsy();
    for (const channelSpec of [priv, 'team-a/alice-private', 'alice-private']) {
      const r = await call('bob', 'read_channel', { channel: channelSpec });
      expect(r.isError, channelSpec).toBe(true);
    }
    const found = await call('bob', 'search_channels', { query: 'alice-private' });
    expect(found.isError).toBeFalsy();
    expect(found.content[0].text).not.toContain(priv);
    const own = await call('alice', 'search_channels', { query: 'alice-private' });
    expect(own.content[0].text).toContain(priv);
  });

  test('search_posts spans both teams', async () => {
    const term = `${TAG}x`;
    for (const t of [e.teams.a, e.teams.b]) await mmApi(aliceMm, 'POST', '/posts', { channel_id: t.dupChannelId, message: `${term} in ${t.name}` });
    const r = await call('alice', 'search_posts', { terms: term });
    expect(r.isError).toBeFalsy();
    for (const t of [e.teams.a, e.teams.b]) {
      expect(r.content[0].text).toContain(t.dupChannelId);
      expect(r.content[0].text).toContain(`${t.name}/pl/`);
    }

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call('alice', 'search_posts', { terms: TAG, limit: 5, ...(cursor ? { cursor } : {}) });
      ids.push(...postIds(p));
      cursor = nextCursor(p);
    } while (cursor);
    const all = await mmApi<{ order: string[] }>(aliceMm, 'POST', '/posts/search', { terms: TAG, page: 0, per_page: 100 });
    expect(ids).toEqual(all.order);
  });

  test('search_posts interprets on: dates in JST', async () => {
    const term = `${TAG}tz`;
    await mmApi(e.adminToken, 'POST', '/posts', { channel_id: e.teams.a.dupChannelId, message: term, create_at: Date.UTC(2026, 9, 14, 20, 0, 0) });
    expect(postIds(await call('alice', 'search_posts', { terms: `${term} on:2026-10-15` }))).toHaveLength(1);
    expect(postIds(await call('alice', 'search_posts', { terms: `${term} on:2026-10-14` }))).toHaveLength(0);
  });

  test('Mattermost API calls per tool are counted by the limiter', async () => {
    const acquire = vi.spyOn(limiter, 'acquire');
    const charge = vi.spyOn(limiter, 'charge');
    const write = vi.mocked(process.stdout.write);
    const before = write.mock.calls.length;
    const r = await call('alice', 'search_channels', { query: 'general' });
    expect(r.isError).toBeFalsy();
    const apiCalls = write.mock.calls.slice(before).filter((c) => String(c[0]).includes('"event":"mm_api"')).length;
    expect(apiCalls).toBeGreaterThan(2);
    expect(acquire.mock.calls.length + charge.mock.calls.length).toBe(apiCalls);
  });
});

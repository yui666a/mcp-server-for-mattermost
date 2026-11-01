import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Limiter } from '../../src/mattermost/limiter.ts';
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

describe('read tools against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let limiter: Limiter;
  let browserUrl: string;
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
    browserUrl = app.config.mmBrowserUrl;
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

  test('get_post reads a post alice can see, both from its permalink and from its post_id', async () => {
    const id = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} get_post` })).id;
    for (const post of [`${browserUrl}/${e.teams.a.name}/pl/${id}`, id]) {
      const r = await call('alice', 'get_post', { post });
      expect(r.isError, post).toBeFalsy();
      expect(postIds(r)).toEqual([id]);
      expect(r.content[0].text).toContain(`${TAG} get_post`);
      expect(r.content[0].text).toContain(channel.id);
      expect(r.content[0].text).toContain(e.teams.a.id);
    }
  });

  test('get_post refuses a post in a private channel the caller has not joined', async () => {
    const id = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: e.teams.a.privateChannelId!, message: `${TAG} private` })).id;
    const r = await call('bob', 'get_post', { post: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('この投稿を見る権限がありません（参加していない非公開チャンネルなど）');
  });

  test('get_post reports a deleted post as not found', async () => {
    const id = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} deleted` })).id;
    await mmApi(aliceMm, 'DELETE', `/posts/${id}`);
    const r = await call('alice', 'get_post', { post: id });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('投稿が見つかりません（削除されたか、存在しません）');
  });

  test('get_post on a reply gives the parent post_id', async () => {
    const r = await call('alice', 'get_post', { post: replies[1] });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(`親 post_id: ${root}`);
    expect(r.content[0].text).toContain('read_thread');
  });

  test('get_post on a root post with replies points to read_thread', async () => {
    const r = await call('alice', 'get_post', { post: root });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain(`返信数: ${replies.length}`);
    expect(r.content[0].text).toContain(`read_thread に post_id: ${root}`);
  });

  describe('list_my_channels', () => {
    const ids = (r: Result) => [...r.content[0].text.matchAll(/channel_id: ([a-z0-9]{26})/g)].map((m) => m[1]);
    const lineOf = (text: string, id: string) => text.split('\n').find((l) => l.includes(`channel_id: ${id}`));
    const listAll = async (args: Record<string, unknown>) => {
      let text = '';
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await call('alice', 'list_my_channels', { ...args, ...(cursor ? { cursor } : {}) });
        expect(r.isError).toBeFalsy();
        expect(r.content[0].text).not.toContain('取り直してください');
        text += `${r.content[0].text}\n`;
        seen.push(...ids(r));
        cursor = nextCursor(r);
        pages++;
      } while (cursor);
      return { text, seen, pages };
    };
    const created: string[] = [];
    let pub: { id: string };
    let priv: { id: string };
    let dm: { id: string };
    let gm: { id: string };
    let archived: { id: string };

    beforeAll(async () => {
      const admin = await mmApi<{ id: string }>(e.adminToken, 'GET', '/users/me');
      const mk = async (name: string, type: 'O' | 'P') => {
        const c = await mmApi<{ id: string }>(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `${name}-${TAG}`, display_name: `${name} ${TAG}`, type });
        created.push(c.id);
        return c;
      };
      pub = await mk('t7-pub', 'O');
      priv = await mk('t7-priv', 'P');
      archived = await mk('t7-arch', 'O');
      await mmApi(e.adminToken, 'DELETE', `/channels/${archived.id}`);
      dm = await mmApi(aliceMm, 'POST', '/channels/direct', [e.users.alice.id, e.users.bob.id]);
      gm = await mmApi(aliceMm, 'POST', '/channels/group', [e.users.alice.id, e.users.bob.id, admin.id]);
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: pub.id, message: `${TAG} list_my_channels` });
    });

    afterAll(async () => {
      for (const id of created.filter((x) => x !== archived.id)) await mmApi(e.adminToken, 'DELETE', `/channels/${id}`);
    });

    test('lists alice\'s public, private, DM and group DM channels, but not an archived one', async () => {
      const { text } = await listAll({ limit: 200 });
      expect(lineOf(text, pub.id)).toContain(`${e.teams.a.name}/t7-pub-${TAG}（表示名: t7-pub ${TAG}、種類: 公開`);
      expect(lineOf(text, priv.id)).toContain('種類: 非公開');
      expect(lineOf(text, dm.id)).toContain(`@${e.users.bob.username}（表示名: @${e.users.bob.username}、種類: DM`);
      expect(lineOf(text, gm.id)).toContain('種類: グループ DM');
      expect(text).not.toContain(archived.id);
    });

    test('filters by types', async () => {
      const { text, seen } = await listAll({ types: ['dm', 'group_dm'], limit: 200 });
      expect(seen).toContain(dm.id);
      expect(seen).toContain(gm.id);
      expect(seen).not.toContain(pub.id);
      expect(seen).not.toContain(priv.id);
      expect(text).not.toMatch(/種類: (公開|非公開)、/);
    });

    test('paging to the end yields exactly the channels of GET /users/me/channels', async () => {
      const all = await mmApi<{ id: string }[]>(aliceMm, 'GET', '/users/me/channels');
      const { seen, pages } = await listAll({ limit: Math.min(200, Math.ceil(all.length / 2)) });
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen)).toEqual(new Set(all.map((c) => c.id)));
    });
  });

  describe('get_channel', () => {
    let ch: { id: string; name: string };
    let pins: string[];

    beforeAll(async () => {
      ch = await mmApi(aliceMm, 'POST', '/channels', {
        team_id: e.teams.a.id, name: `t9-${TAG}`, display_name: `t9 ${TAG}`, type: 'O', purpose: `${TAG} purpose`, header: `${TAG} header`,
      });
      pins = [];
      for (let i = 1; i <= 3; i++) {
        const p = await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', { channel_id: ch.id, message: `${TAG} pinned ${i}` });
        await mmApi(aliceMm, 'POST', `/posts/${p.id}/pin`);
        pins.unshift(p.id);
      }
    });

    afterAll(async () => {
      await mmApi(e.adminToken, 'DELETE', `/channels/${ch.id}`);
    });

    test('for a channel alice is in, shows the purpose, header, member count and pinned posts', async () => {
      const r = await call('alice', 'get_channel', { channel: `${e.teams.a.name}/${ch.name}` });
      expect(r.isError).toBeFalsy();
      const t = r.content[0].text;
      expect(t).toContain(`channel_id: ${ch.id}`);
      expect(t).toContain(`team_id: ${e.teams.a.id}`);
      expect(t).toContain('種類: 公開');
      expect(t).toContain(`目的: ${TAG} purpose`);
      expect(t).toContain(`ヘッダー: ${TAG} header`);
      expect(t).toContain('メンバー数: 1');
      expect(t).toContain('ピン留め: 3 件');
      expect(postIds(r)).toEqual(pins);
    });

    test('for a public channel bob has not joined, says the member count is unavailable', async () => {
      const r = await call('bob', 'get_channel', { channel: ch.id });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('メンバー数: 参加していないため取得できません');
      expect(r.content[0].text).toContain(`目的: ${TAG} purpose`);
      expect(postIds(r)).toEqual(pins);
    });

    test('for the id of a private channel bob has not joined, says he has no permission', async () => {
      const r = await call('bob', 'get_channel', { channel: e.teams.a.privateChannelId! });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）');
    });

    test('pages through 3 pinned posts with pinned_limit 2', async () => {
      const first = await call('alice', 'get_channel', { channel: ch.id, pinned_limit: 2 });
      expect(postIds(first)).toEqual(pins.slice(0, 2));
      const second = await call('alice', 'get_channel', { channel: ch.id, cursor: nextCursor(first) });
      expect(second.isError).toBeFalsy();
      expect(postIds(second)).toEqual(pins.slice(2));
      expect(nextCursor(second)).toBeUndefined();
    });
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

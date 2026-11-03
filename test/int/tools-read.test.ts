import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Limiter } from '../../src/mattermost/limiter.ts';
import { LAG_MS } from '../../src/mcp/paging.ts';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie, type Cred } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zq${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string; data?: string; mimeType?: string }[] };

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

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x7f);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function upload(token: string, channelId: string, filename: string, body: Buffer): Promise<string> {
  const res = await fetch(`${e.mmUrl}/api/v4/files?${new URLSearchParams({ channel_id: channelId, filename })}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(body),
  });
  if (!res.ok) throw new Error(`upload ${filename} -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { file_infos: { id: string }[] }).file_infos[0].id;
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
      const all = await mmApi<{ id: string; last_post_at: number }[]>(aliceMm, 'GET', '/users/me/channels');
      // Without the wait, channels this file just posted to fall inside the lag window and are re-reported as updated on every page.
      await new Promise((r) => setTimeout(r, Math.max(0, Math.max(...all.map((c) => c.last_post_at)) + LAG_MS + 1000 - Date.now())));
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

  describe('get_user with time zone and presence', () => {
    type Status = { status: string; dnd_end_time: number };
    let bobMm: string;
    let original: { timezone: Record<string, string>; status: Status };

    beforeAll(async () => {
      bobMm = await mmToken(e.users.bob);
      original = {
        timezone: (await mmApi<{ timezone: Record<string, string> }>(bobMm, 'GET', '/users/me')).timezone,
        status: await mmApi<Status>(bobMm, 'GET', `/users/${e.users.bob.id}/status`),
      };
    });

    afterAll(async () => {
      await mmApi(bobMm, 'PUT', `/users/${e.users.bob.id}/patch`, { timezone: original.timezone });
      await mmApi(bobMm, 'PUT', `/users/${e.users.bob.id}/status`, { user_id: e.users.bob.id, status: original.status.status === 'dnd' ? 'online' : original.status.status });
    });

    test('shows the manual time zone bob set and the local time there to alice', async () => {
      await mmApi(bobMm, 'PUT', `/users/${e.users.bob.id}/patch`, {
        timezone: { useAutomaticTimezone: 'false', automaticTimezone: 'Asia/Tokyo', manualTimezone: 'Asia/Kolkata' },
      });
      const r = await call('alice', 'get_user', { user: '@bob' });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('タイムゾーン: Asia/Kolkata（手動）');
      expect(r.content[0].text).toMatch(/現地時刻: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+05:30/);
    });

    test('shows do-not-disturb and its end time when bob turns it on', async () => {
      const end = Math.floor(Date.now() / 1000) + 3600;
      await mmApi(bobMm, 'PUT', `/users/${e.users.bob.id}/status`, { user_id: e.users.bob.id, status: 'dnd', dnd_end_time: end });
      const r = await call('alice', 'get_user', { user: '@bob' });
      expect(r.isError).toBeFalsy();
      const minute = new Date(Math.floor(end / 60) * 60_000).toISOString().slice(0, 19);
      expect(r.content[0].text).toContain(`在席: 取り込み中（終了: ${minute}Z | `);
    });
  });

  describe('attachments and get_file', () => {
    test('read_channel lists a PNG attached to a post, and get_file returns its preview as a PNG image', async () => {
      const fileId = await upload(aliceMm, channel.id, `${TAG}.png`, png(40, 30));
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} with png`, file_ids: [fileId] });
      const list = await call('bob', 'read_channel', { channel: channel.id, limit: 1 });
      expect(list.isError).toBeFalsy();
      const line = list.content[0].text.split('\n').find((l) => l.includes(fileId));
      expect(line).toContain(`${TAG}.png`);
      expect(line).toContain('image/png');
      expect(line).toContain('40x30');

      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBeFalsy();
      const img = r.content.find((c) => c.type === 'image');
      expect(img?.mimeType).toBe('image/png');
      expect(Buffer.from(img!.data!, 'base64').subarray(0, 8)).toEqual(png(1, 1).subarray(0, 8));
      expect(r.content.find((c) => c.type === 'text')?.text).toContain(`${TAG}.png`);
    });

    test('get_file returns only the information of a PDF', async () => {
      const fileId = await upload(aliceMm, channel.id, `${TAG}.pdf`, Buffer.from('%PDF-1.4\n%%EOF\n'));
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} with pdf`, file_ids: [fileId] });
      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBeFalsy();
      expect(r.content.map((c) => c.type)).toEqual(['text']);
      expect(r.content[0].text).toContain(`${TAG}.pdf`);
      expect(r.content[0].text).toContain('application/pdf');
    });

    test('get_file returns the content of a UTF-8 Markdown file as text', async () => {
      const md = `# ${TAG}\n\n在庫の棚卸しは月末に行う。\n`;
      const fileId = await upload(aliceMm, channel.id, `${TAG}.md`, Buffer.from(md));
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} with md`, file_ids: [fileId] });
      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBeFalsy();
      expect(r.content.map((c) => c.type)).toEqual(['text', 'text']);
      expect(r.content[0].text).toContain(`${TAG}.md`);
      expect(r.content[0].text).toContain('文字コード: UTF-8');
      expect(r.content[1].text).toBe(md);
    });

    test('get_file reads a Shift_JIS CSV, which Mattermost labels utf-8', async () => {
      const sjis = Buffer.from([0x95, 0x69, 0x96, 0xbc, 0x2c, 0x90, 0x94, 0x0a, 0x82, 0xe8, 0x82, 0xf1, 0x82, 0xb2, 0x2c, 0x33, 0x0a]);
      const fileId = await upload(aliceMm, channel.id, `${TAG}.csv`, sjis);
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} with csv`, file_ids: [fileId] });
      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain('charset=utf-8');
      expect(r.content[0].text).toContain('文字コード: Shift_JIS');
      expect(r.content[1].text).toBe('品名,数\nりんご,3\n');
    });

    test('get_file cuts a large text file to its first 10,000 characters and says so', async () => {
      const fileId = await upload(aliceMm, channel.id, `${TAG}-big.log`, Buffer.alloc(100_000, 'x'));
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: channel.id, message: `${TAG} with log`, file_ids: [fileId] });
      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBeFalsy();
      expect(r.content[1].text).toBe('x'.repeat(10_000));
      expect(r.content[0].text).toContain('先頭の 10000 文字だけを返しました（ファイル全体は 100000 バイト）');
    });

    test('get_file refuses a file in a private channel the caller has not joined', async () => {
      const priv = e.teams.a.privateChannelId!;
      const fileId = await upload(aliceMm, priv, `${TAG}-private.png`, png(4, 4));
      await mmApi(aliceMm, 'POST', '/posts', { channel_id: priv, message: `${TAG} private png`, file_ids: [fileId] });
      const r = await call('bob', 'get_file', { file_id: fileId });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe('このファイルを見る権限がありません');
    });
  });

  describe('message attachments, reactions, edits and system messages', () => {
    let ch: { id: string };
    let bot: string;
    let reply: string;

    beforeAll(async () => {
      ch = await mmApi(aliceMm, 'POST', '/channels', { team_id: e.teams.a.id, name: `t8-fmt-${TAG}`, display_name: `t8 fmt ${TAG}`, type: 'O' });
      await mmApi(aliceMm, 'POST', `/channels/${ch.id}/members`, { user_id: e.users.bob.id });
      const bobMm = await mmToken(e.users.bob);
      bot = (await mmApi<{ id: string }>(aliceMm, 'POST', '/posts', {
        channel_id: ch.id, message: '',
        props: { attachments: [{ fallback: 'fb', pretext: `${TAG} pre`, title: 'Build failed', title_link: 'https://ci.example/1', text: 'line 1\nline 2', fields: [{ title: 'Branch', value: 'main', short: true }], actions: [{ id: 'retry', name: 'Retry', integration: { url: 'https://ci.example/hook' } }] }] },
      })).id;
      reply = (await mmApi<{ id: string }>(bobMm, 'POST', '/posts', { channel_id: ch.id, root_id: bot, message: `${TAG} looking` })).id;
      await mmApi(aliceMm, 'POST', '/reactions', { user_id: e.users.alice.id, post_id: bot, emoji_name: 'eyes' });
      await mmApi(bobMm, 'POST', '/reactions', { user_id: e.users.bob.id, post_id: bot, emoji_name: 'eyes' });
      await mmApi(bobMm, 'PUT', `/posts/${reply}/patch`, { message: `${TAG} looking (edited)` });
    });

    afterAll(async () => {
      await mmApi(e.adminToken, 'DELETE', `/channels/${ch.id}`);
    });

    const attachment = [
      'メッセージ添付（Bot などの整形表示）1/1:',
      `  前置き: ${TAG} pre`,
      '  タイトル: Build failed（https://ci.example/1）',
      '  本文: line 1',
      '    line 2',
      '  項目: Branch: main',
      '  ボタンやメニュー: Retry（MCP からは操作できません）',
    ].join('\n');
    const reactions = `リアクション: :eyes: 2（@${e.users.alice.username}、@${e.users.bob.username}）`;
    const section = (text: string, id: string) => {
      const at = text.indexOf(`--- post_id: ${id}`);
      if (at < 0) throw new Error(`post ${id} is not in the output`);
      return text.slice(at).split(/\n(?=--- post_id: )/)[0];
    };

    test('get_post shows the message attachment and who reacted', async () => {
      const r = await call('bob', 'get_post', { post: bot });
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain(attachment);
      expect(r.content[0].text).toContain(reactions);
    });

    test('read_thread shows the attachment and reactions of the root and that the reply was edited', async () => {
      const text = (await call('alice', 'read_thread', { post_id: reply })).content[0].text;
      expect(section(text, bot)).toContain(attachment);
      expect(section(text, bot)).toContain(reactions);
      expect(section(text, reply).split('\n')[2]).toMatch(/^編集済み: \S+Z \| \S+\+09:00$/);
      expect(section(text, bot)).not.toContain('編集済み');
    });

    test('read_channel marks the system messages of the channel', async () => {
      const text = (await call('alice', 'read_channel', { channel: ch.id, limit: 20 })).content[0].text;
      expect(text).toContain(attachment);
      const system = text.split(/\n(?=--- post_id: )/).filter((x) => x.includes('\nシステムメッセージ（system_'));
      expect(system.some((x) => /joined the channel|added to the channel/.test(x))).toBe(true);
      expect(section(text, reply)).not.toContain('システムメッセージ');
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

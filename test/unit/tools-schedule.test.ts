import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_PENDING_SCHEDULED } from '../../src/store.ts';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let hits: string[];

const NOW = Date.UTC(2026, 10, 2, 0, 0); // 2026-11-02T09:00 JST
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CH = 'c'.repeat(26);
const CH2 = 'd'.repeat(26);
const TEAM = 't'.repeat(26);
const ROOT = 'r'.repeat(26);
const POSTED = 'p'.repeat(26);
const NOT_CHANGEABLE = '予約が見つかりません。または、投稿中か、投稿を試みた後で結果を確かめている途中か、終了済みのため変えられません。';

let writes: string[];
beforeEach(() => {
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  hits = [];
  routes = {
    [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: TEAM, type: 'O' }),
    [`GET /channels/${CH2}`]: () => ({ id: CH2, name: 'other', display_name: 'Other', team_id: TEAM, type: 'O' }),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    [`GET /posts/${ROOT}`]: () => ({ id: ROOT, channel_id: CH, root_id: '', user_id: 'u9', message: 'root', create_at: 1 }),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Rpc = { isError: boolean; text: string };

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    hits.push(`${req.method} ${path}`);
    const r = routes[`${req.method} ${path}`];
    if (!r) return Response.json({ id: 'not_found' }, { status: 404 });
    const out = r(req);
    return out instanceof Response ? out : Response.json(out);
  });
  const code = ctx.store.createCode({
    mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: ctx.config.resource, scope: 'mattermost',
  });
  const rec = ctx.store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const { accessToken } = ctx.store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: ctx.config.resource, fromCodeHash: rec.codeHash });
  ctx.store.putMmCred('u1', 'mm-access', 'mm-refresh');
  const rpc = async (method: string, params: object) => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    return r.body;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<{ name: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  const db = (ctx.store as unknown as { db: DatabaseSync }).db;
  const setRow = (id: string, sql: string, ...p: (string | number)[]) => db.prepare(`UPDATE scheduled_posts SET ${sql} WHERE id = ?`).run(...p, id);
  const schedule = async (args: Record<string, unknown>) => {
    const r = await call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', ...args });
    if (r.isError) throw new Error(r.text);
    return /予約 ID: (\S+)/.exec(r.text)![1];
  };
  return { call, rpc, tools, store: ctx.store, db, setRow, schedule };
}

describe('schedule_message', () => {
  test('file_ids takes files uploaded to the same channel within 24 hours', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'schedule_message')! as unknown as { inputSchema: { properties: { file_ids: { description: string } } } };
    for (const s of ['同じチャンネル', '24 時間']) expect(t.inputSchema.properties.file_ids.description).toContain(s);
  });

  test('the schema has no files, so file_ids is the only way to attach', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'schedule_message')! as unknown as { inputSchema: { properties: Record<string, unknown> } };
    expect(t.inputSchema.properties.files).toBeUndefined();
  });

  test('the tool says file_ids is the only way to attach', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'schedule_message')!;
    expect((t as unknown as { description: string }).description).toContain('添付は file_ids（prepare_upload の結果）だけ');
  });

  describe('to a DM not opened yet', () => {
    const CAROL = 'k'.repeat(26);
    const NEW_DM = 'n'.repeat(26);
    beforeEach(() => {
      routes['GET /users/me/teams'] = () => [{ id: TEAM, name: 'team-a' }];
      routes['GET /users/username/carol'] = () => ({ id: CAROL, username: 'carol', delete_at: 0 });
      routes['POST /channels/direct'] = () => ({ id: NEW_DM, name: `${CAROL}__u1`, display_name: '', team_id: '', type: 'D' });
    });

    test('creates the DM when scheduling, so the destination is fixed to its channel_id', async () => {
      const r = await setup().call('schedule_message', { channel: '@carol', message: 'hello', at: '2026-11-03T10:00' });
      expect(r.isError).toBe(false);
      expect(r.text).toContain(`チャンネル: @carol（channel_id: ${NEW_DM}）`);
      expect(hits).toContain('POST /channels/direct');
    });

    test('does not create the DM when root_id is given, since the DM cannot hold it yet', async () => {
      const r = await setup().call('schedule_message', { channel: '@carol', message: 'hello', at: '2026-11-03T10:00', root_id: ROOT });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('@carol との DM はまだありません');
      expect(hits).not.toContain('POST /channels/direct');
    });

    test('with file_ids uploaded for another channel, reports the file mistake rather than the missing DM, and does not create the DM', async () => {
      const s = setup();
      const f = 'f'.repeat(26);
      s.store.recordUploadedFile({ mmUserId: 'u1', channelId: CH }, f);
      const r = await s.call('schedule_message', { channel: '@carol', message: 'hello', at: '2026-11-03T10:00', file_ids: [f] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`別のチャンネル（channel_id: ${CH}）`);
      expect(hits).not.toContain('POST /channels/direct');
    });

    test('with the pending schedules at the limit, refuses before resolving the channel, so no DM is created', async () => {
      const s = setup();
      for (let i = 0; i < MAX_PENDING_SCHEDULED; i++) s.store.createScheduled({ mmUserId: 'u1', channelId: CH, message: `m${i}`, scheduledAt: NOW + DAY }, NOW);
      const r = await s.call('schedule_message', { channel: '@carol', message: 'hello', at: '2026-11-03T10:00' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`待機中の予約が上限の ${MAX_PENDING_SCHEDULED} 件に達しています`);
      expect(hits).toEqual([]);
    });

    test('does not create the DM when the time is out of range', async () => {
      const r = await setup().call('schedule_message', { channel: '@carol', message: 'hello', at: '2026-11-02T09:00' });
      expect(r.text).toContain('今から 1 分後から 30 日後まで');
      expect(hits).not.toContain('POST /channels/direct');
    });
  });

  test('saves the schedule without posting and reports its id, the destination, the time in UTC and JST, and where to check the result', async () => {
    const s = setup();
    const r = await s.call('schedule_message', { channel: CH, message: 'hello', root_id: ROOT, at: '2026-11-03T10:00' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/予約 ID: [A-Za-z0-9_-]{43}/);
    expect(r.text).toContain(`チャンネル: Town（channel_id: ${CH}）、返信先 post_id: ${ROOT}`);
    expect(r.text).toContain('2026-11-03T01:00:00Z | 2026-11-03T10:00:00+09:00');
    expect(r.text).toContain('list_scheduled_messages で確かめられます');
    expect(hits.filter((h) => h.startsWith('POST'))).toEqual([]);
  });

  test('takes a time with a zone in that zone', async () => {
    const r = await setup().call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00-05:00' });
    expect(r.text).toContain('2026-11-03T15:00:00Z | 2026-11-04T00:00:00+09:00');
  });

  test.each([
    ['a root in another channel', { channel_id: CH2, root_id: '' }, `root_id ${ROOT} の投稿はチャンネル「Town」（channel_id: ${CH}）にありません。`],
    ['a reply', { channel_id: CH, root_id: 'x'.repeat(26) }, `root_id ${ROOT} は返信です。スレッドの親投稿の post_id を指定してください。`],
  ])('refuses %s as root_id and saves nothing', async (_, root, msg) => {
    routes[`GET /posts/${ROOT}`] = () => ({ id: ROOT, user_id: 'u9', message: 'm', create_at: 1, ...root });
    const s = setup();
    const r = await s.call('schedule_message', { channel: CH, message: 'hello', root_id: ROOT, at: '2026-11-03T10:00' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(msg);
    expect((await s.call('list_scheduled_messages', {})).text).toBe('予約はありません。');
  });

  test.each([
    ['an empty message', { message: '' }],
    ['a message over 16383 characters', { message: 'a'.repeat(16384) }],
    ['a date without a time', { at: '2026-11-03' }],
    ['a date that is not on the calendar', { at: '2026-02-30T10:00' }],
    ['24:00', { at: '2026-11-03T24:00' }],
    ['a root_id that is not a post_id', { root_id: '../x' }],
  ])('refuses %s without calling Mattermost', async (_, args) => {
    const r = await setup().call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', ...args });
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  test('accepts a message of exactly 16383 characters', async () => {
    expect((await setup().call('schedule_message', { channel: CH, message: 'a'.repeat(16383), at: '2026-11-03T10:00' })).isError).toBe(false);
  });

  test.each([
    ['59 seconds from now', '2026-11-02T00:00:59Z', false],
    ['exactly 1 minute from now', '2026-11-02T00:01:00Z', true],
    ['exactly 30 days from now', '2026-12-02T00:00:00Z', true],
    ['30 days and 1 second from now', '2026-12-02T00:00:01Z', false],
    ['in the past', '2026-11-01T10:00', false],
  ])('a time %s is %s', async (_, at, ok) => {
    const r = await setup().call('schedule_message', { channel: CH, message: 'hello', at });
    expect(r.isError).toBe(!ok);
    if (!ok) {
      expect(r.text).toContain('予約できるのは、今から 1 分後から 30 日後までです。');
      expect(hits).toEqual([]);
    }
  });

  test('refuses the 21st pending schedule of the user', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) await s.schedule({ message: `m${i}` });
    const r = await s.call('schedule_message', { channel: CH, message: 'one more', at: '2026-11-03T10:00' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('待機中の予約が上限の 20 件に達しています');
  });

  test('neither the message nor the time goes to the log', async () => {
    const s = setup();
    const id = await s.schedule({ message: 'secret plan' });
    await s.call('update_scheduled_message', { id, message: 'other secret' });
    await s.call('list_scheduled_messages', {});
    await s.call('cancel_scheduled_message', { id });
    expect(writes.join('')).toContain('schedule_message');
    expect(writes.join('')).not.toMatch(/secret|2026-11-03T10/);
  });

  test('tool annotations say which tools change state', async () => {
    const t = Object.fromEntries((await setup().tools()).map((x) => [x.name, x.annotations]));
    expect(t.schedule_message).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(t.list_scheduled_messages).toMatchObject({ readOnlyHint: true });
    expect(t.update_scheduled_message).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(t.cancel_scheduled_message).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('schedule_message with file_ids', () => {
  const F1 = 'a'.repeat(26);
  const F2 = 'b'.repeat(26);
  const uploaded = (s: ReturnType<typeof setup>, ids = [F1, F2], channelId = CH) => {
    for (const i of ids) s.store.recordUploadedFile({ mmUserId: 'u1', channelId }, i);
  };
  const refused = async (s: ReturnType<typeof setup>, args: Record<string, unknown>) => {
    const r = await s.call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', ...args });
    expect(r.isError).toBe(true);
    return r.text;
  };

  test('keeps the file_ids with the schedule and lists them in its output', async () => {
    const s = setup();
    uploaded(s);
    const r = await s.call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', file_ids: [F1, F2] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`添付: ${F1}, ${F2}`);
    expect(s.store.listScheduled('u1', { limit: 1 })[0].fileIds).toEqual([F1, F2]);
  });

  test('refuses files the way send_message does: not uploaded by the user, uploaded to another channel, repeated, or already posted', async () => {
    const s = setup();
    uploaded(s, [F1]);
    uploaded(s, [F2], CH2);
    expect(await refused(s, { file_ids: ['z'.repeat(26)] })).toContain('24 時間以内にアップロードしたファイルではありません');
    expect(await refused(s, { file_ids: [F2] })).toContain('別のチャンネル');
    expect(await refused(s, { file_ids: [F1, F1] })).toContain('重なっています');
    s.store.markFilesPosted('u1', [F1], POSTED);
    expect(await refused(s, { file_ids: [F1] })).toContain('既に投稿');
    expect(s.store.listScheduled('u1', { limit: 10 })).toHaveLength(0);
  });

  test('takes 1 to 5 file_ids', async () => {
    const s = setup();
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => c.repeat(26));
    uploaded(s, six);
    for (const file_ids of [six, []]) {
      const r = await s.call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', file_ids });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('file_ids');
    }
    await s.schedule({ file_ids: six.slice(0, 5) });
  });

  test('refuses a file another schedule holds, naming that schedule, also after it failed once attempted', async () => {
    const s = setup();
    uploaded(s);
    const first = await s.schedule({ file_ids: [F1] });
    expect(await refused(s, { file_ids: [F2, F1] })).toContain(`予約（予約 ID: ${first}）の添付に使われています`);
    s.setRow(first, "status = 'failed', first_attempt_at = ?", NOW);
    expect(await refused(s, { file_ids: [F1] })).toContain(first);
  });

  test('a schedule that takes the file between the check and the save is refused with the same reason', async () => {
    const s = setup();
    uploaded(s);
    const first = await s.schedule({ file_ids: [F1] });
    vi.spyOn(s.store, 'heldScheduledFiles').mockReturnValueOnce([]);
    expect(await refused(s, { file_ids: [F1] })).toContain(`予約（予約 ID: ${first}）の添付に使われています`);
  });

  test('takes a file again once the schedule holding it failed before any attempt or was cancelled', async () => {
    const s = setup();
    uploaded(s);
    s.setRow(await s.schedule({ file_ids: [F1] }), "status = 'failed'");
    await s.schedule({ file_ids: [F1] });
    expect((await s.call('cancel_scheduled_message', { id: await s.schedule({ message: 'b', file_ids: [F2] }) })).isError).toBe(false);
    await s.schedule({ file_ids: [F2] });
  });

  test('the list shows the files, only the kept ones and a note naming the dropped ones on a posted schedule, and how to send the files again on a failed one', async () => {
    const s = setup();
    uploaded(s);
    const posted = await s.schedule({ file_ids: [F1], at: '2026-11-03T10:00' });
    s.setRow(posted, "status = 'posted', post_id = ?, file_ids = '[]', error = ?", POSTED, `添付した 1 件のうち 1 件（${F1}）を Mattermost が外したため、投稿に付いていません。`);
    const failed = await s.schedule({ file_ids: [F2], at: '2026-11-04T10:00' });
    s.setRow(failed, "status = 'failed', error = ?", 'nope');
    const plain = await s.schedule({ message: 'plain', at: '2026-11-05T10:00' });
    s.setRow(plain, "status = 'failed', error = ?", 'nope');
    const r = await s.call('list_scheduled_messages', {});
    const [p, f, n] = r.text.split('--- ').slice(1);
    expect(p).not.toContain('添付: ');
    expect(p).toContain(`注意: 添付した 1 件のうち 1 件（${F1}）を Mattermost が外したため`);
    expect(p).not.toContain('失敗の理由');
    expect(f).toContain(`添付: ${F2}`);
    expect(f).toContain('失敗の理由: nope ファイルを付けて送り直すときは、prepare_upload からアップロードし直してください。');
    expect(n).not.toContain('添付');
    expect(n).toContain('失敗の理由: nope\n');
  });
});

describe('list_scheduled_messages', () => {
  const rows = (text: string) => [...text.matchAll(/予約 ID: (\S+)/g)].map((m) => m[1]);

  test('lists the caller\'s schedules earliest first with status, destination, time and the first 200 characters of the message', async () => {
    const s = setup();
    const late = await s.schedule({ at: '2026-11-05T10:00', message: 'late' });
    const early = await s.schedule({ at: '2026-11-03T10:00', message: 'あ'.repeat(250), root_id: ROOT });
    s.store.createScheduled({ mmUserId: 'u2', channelId: CH, message: 'not mine', scheduledAt: NOW + DAY }, NOW);
    hits = [];
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError).toBe(false);
    expect(rows(r.text)).toEqual([early, late]);
    expect(r.text).toContain('状態: 待機中');
    expect(r.text).toContain(`投稿先: Town（channel_id: ${CH}）、返信先 post_id: ${ROOT}`);
    expect(r.text).toContain('予定時刻: 2026-11-03T01:00:00Z | 2026-11-03T10:00:00+09:00');
    expect(r.text).toContain(`本文（先頭 200 文字）: ${'あ'.repeat(200)}\n`);
    expect(r.text).not.toContain('not mine');
    expect(hits).toEqual([`GET /channels/${CH}`]);
  });

  test('names the destination of every row, looking up each channel once, a DM by the other user, and falls back to the id alone', async () => {
    const DM = 'm'.repeat(26);
    const GONE = 'g'.repeat(26);
    routes[`GET /channels/${DM}`] = () => ({ id: DM, name: 'u1__u5', display_name: '', team_id: '', type: 'D' });
    routes['GET /users/u5'] = () => ({ id: 'u5', username: 'bob' });
    const s = setup();
    let n = 0;
    for (const channelId of [CH, CH2, CH, DM, GONE]) s.store.createScheduled({ mmUserId: 'u1', channelId, message: 'x', scheduledAt: NOW + DAY + n++ * MIN }, NOW);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError).toBe(false);
    expect(r.text.match(/投稿先: .*/g)).toEqual([
      `投稿先: Town（channel_id: ${CH}）`,
      `投稿先: Other（channel_id: ${CH2}）`,
      `投稿先: Town（channel_id: ${CH}）`,
      `投稿先: @bob（channel_id: ${DM}）`,
      `投稿先: channel_id: ${GONE}`,
    ]);
    expect(hits).toEqual([`GET /channels/${CH}`, `GET /channels/${CH2}`, `GET /channels/${DM}`, 'GET /users/u5', `GET /channels/${GONE}`]);
  });

  test('names a group DM by the other members as schedule_message does, looking it up once, and by its display_name when the members cannot be listed', async () => {
    const GM = 'n'.repeat(26);
    const GM2 = 'o'.repeat(26);
    const LONE = 'q'.repeat(26);
    routes[`GET /channels/${GM}`] = () => ({ id: GM, name: 'h'.repeat(40), display_name: 'alice, carol, bob', team_id: '', type: 'G' });
    routes[`GET /channels/${GM2}`] = () => ({ id: GM2, name: 'i'.repeat(40), display_name: 'alice, dave, erin', team_id: '', type: 'G' });
    routes[`GET /channels/${LONE}`] = () => ({ id: LONE, name: 'j'.repeat(40), display_name: 'alice, frank, gina', team_id: '', type: 'G' });
    const members: Record<string, unknown> = {
      [GM]: [{ id: 'u7', username: 'carol' }, { id: 'u1', username: 'alice' }, { id: 'u5', username: 'bob' }],
      [GM2]: Response.json({ id: 'api.context.permissions.app_error', message: 'm', status_code: 403 }, { status: 403 }),
      [LONE]: [{ id: 'u1', username: 'alice' }],
    };
    routes['GET /users'] = (req) => members[new URL(req.url).searchParams.get('in_channel')!];
    const s = setup();
    let n = 0;
    for (const channelId of [GM, GM, GM2, LONE]) s.store.createScheduled({ mmUserId: 'u1', channelId, message: 'x', scheduledAt: NOW + DAY + n++ * MIN }, NOW);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError, r.text).toBe(false);
    expect(r.text.match(/投稿先: .*/g)).toEqual([
      `投稿先: @bob, @carol（channel_id: ${GM}）`,
      `投稿先: @bob, @carol（channel_id: ${GM}）`,
      `投稿先: alice, dave, erin（channel_id: ${GM2}）`,
      `投稿先: alice, frank, gina（channel_id: ${LONE}）`,
    ]);
    expect(hits.filter((h) => h === 'GET /users')).toHaveLength(3);
  });

  test.each([
    [403, 'api.context.permissions.app_error'],
    [429, 'rate_limited'],
  ])('a posted row whose team lookup fails with %i is listed without a permalink, and the list still returns', async (status, id) => {
    routes[`GET /teams/${TEAM}`] = () => Response.json({ id, message: 'm', status_code: status }, { status });
    const s = setup();
    s.setRow(s.store.createScheduled({ mmUserId: 'u1', channelId: CH, message: 'p', scheduledAt: NOW + DAY }, NOW)!, "status = 'posted', post_id = ?", POSTED);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain(`post_id: ${POSTED}`);
    expect(r.text).not.toContain('/pl/');
  });

  test('a posted DM row gets no permalink when the user has no team to put in it', async () => {
    const DM = 'm'.repeat(26);
    routes[`GET /channels/${DM}`] = () => ({ id: DM, name: 'u1__u5', display_name: '', team_id: '', type: 'D' });
    routes['GET /users/u5'] = () => ({ id: 'u5', username: 'bob' });
    routes['GET /users/me/teams'] = () => [];
    const s = setup();
    const id = s.store.createScheduled({ mmUserId: 'u1', channelId: DM, message: 'x', scheduledAt: NOW + DAY }, NOW)!;
    s.setRow(id, "status = 'posted', post_id = ?", POSTED);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`post_id: ${POSTED}`);
    expect(r.text).not.toContain('/pl/');
  });

  test('a failed schedule shows the reason, and a posted one its post_id and permalink', async () => {
    const s = setup();
    const failed = await s.schedule({ message: 'f' });
    const posted = await s.schedule({ message: 'p' });
    s.setRow(failed, "status = 'failed', error = 'Mattermost への再ログインが必要'");
    s.setRow(posted, "status = 'posted', post_id = ?", POSTED);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.text).toContain('状態: 失敗\n');
    expect(r.text).toContain('失敗の理由: Mattermost への再ログインが必要');
    expect(r.text).toContain('状態: 投稿済み');
    expect(r.text).toContain(`post_id: ${POSTED}\nhttps://mm.example/team-a/pl/${POSTED}`);
  });

  test('looks up the team of a channel once for all posted rows in it', async () => {
    const s = setup();
    for (const m of ['a', 'b', 'c']) s.setRow(await s.schedule({ message: m }), "status = 'posted', post_id = ?", POSTED);
    hits = [];
    await s.call('list_scheduled_messages', {});
    expect(hits).toEqual([`GET /channels/${CH}`, `GET /teams/${TEAM}`]);
  });

  test('a posted row whose channel can no longer be read is listed with its post_id but no permalink, and the list still returns', async () => {
    routes[`GET /channels/${CH}`] = () => Response.json({ id: 'api.context.permissions.app_error', message: 'm', status_code: 403 }, { status: 403 });
    const s = setup();
    const posted = await s.schedule({ channel: CH2, message: 'p' });
    const pending = await s.schedule({ channel: CH2, message: 'q', at: '2026-11-04T10:00' });
    s.db.prepare('UPDATE scheduled_posts SET channel_id = ?').run(CH);
    s.setRow(posted, "status = 'posted', post_id = ?", POSTED);
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError).toBe(false);
    expect(rows(r.text)).toEqual([posted, pending]);
    expect(r.text).toContain(`post_id: ${POSTED}`);
    expect(r.text).not.toContain('/pl/');
  });

  test('a message that cannot be decrypted is listed as such rather than failing the list', async () => {
    const s = setup();
    const id = await s.schedule({});
    s.setRow(id, "message_sealed = 'broken'");
    const r = await s.call('list_scheduled_messages', {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain('本文: （復号できません）');
  });

  test('filters by status', async () => {
    const s = setup();
    const a = await s.schedule({ message: 'a' });
    const b = await s.schedule({ message: 'b' });
    s.setRow(a, "status = 'failed', error = 'e'");
    expect(rows((await s.call('list_scheduled_messages', { status: 'pending' })).text)).toEqual([b]);
    expect(rows((await s.call('list_scheduled_messages', { status: 'failed' })).text)).toEqual([a]);
  });

  test('pages with next_cursor, keeping the status filter, and rejects a broken cursor', async () => {
    const s = setup();
    const ids = [];
    for (let i = 1; i <= 5; i++) ids.push(await s.schedule({ message: `m${i}`, at: `2026-11-0${i + 2}T10:00` }));
    s.setRow(ids[1], "status = 'failed', error = 'e'");
    const first = await s.call('list_scheduled_messages', { status: 'pending', limit: 2 });
    expect(rows(first.text)).toEqual([ids[0], ids[2]]);
    const cursor = /next_cursor: (\S+)/.exec(first.text)![1];
    const second = await s.call('list_scheduled_messages', { cursor });
    expect(rows(second.text)).toEqual([ids[3], ids[4]]);
    expect(second.text).toContain('（続きはありません）');
    const bad = await s.call('list_scheduled_messages', { cursor: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('cursor が不正です');
  });
});

describe('update_scheduled_message', () => {
  test('changes the message and the time of a pending schedule and reports the new time', async () => {
    const s = setup();
    const id = await s.schedule({});
    const r = await s.call('update_scheduled_message', { id, message: 'changed', at: '2026-11-04T08:30' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`予約 ID: ${id}`);
    expect(r.text).toContain('2026-11-03T23:30:00Z | 2026-11-04T08:30:00+09:00');
    const list = (await s.call('list_scheduled_messages', {})).text;
    expect(list).toContain('本文（先頭 200 文字）: changed');
    expect(list).toContain('2026-11-04T08:30:00+09:00');
  });

  test('changes only the message, keeping the time', async () => {
    const s = setup();
    const id = await s.schedule({});
    const r = await s.call('update_scheduled_message', { id, message: 'changed' });
    expect(r.text).toContain('2026-11-03T10:00:00+09:00');
  });

  test.each([
    ['earlier than 1 minute from now', '2026-11-02T09:00:30'],
    ['later than 30 days from now', '2026-12-03T09:00'],
  ])('checks the time range again: refuses a time %s', async (_, at) => {
    const s = setup();
    const id = await s.schedule({});
    const r = await s.call('update_scheduled_message', { id, at });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('予約できるのは、今から 1 分後から 30 日後までです。');
    expect((await s.call('list_scheduled_messages', {})).text).toContain('2026-11-03T10:00:00+09:00');
  });

  test('the time range is measured from the time of the change, not of the schedule', async () => {
    const s = setup();
    const id = await s.schedule({});
    vi.setSystemTime(NOW + 50 * MIN);
    expect((await s.call('update_scheduled_message', { id, at: '2026-12-02T00:30Z' })).isError).toBe(false);
  });

  test('asks for a message or a time when neither is given', async () => {
    const s = setup();
    const r = await s.call('update_scheduled_message', { id: await s.schedule({}) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('message か at のどちらかを指定してください。');
  });

  test.each([
    ["status = 'sending'"],
    ["status = 'posted', post_id = 'p'"],
    ["status = 'failed', error = 'e'"],
    ['first_attempt_at = 1'],
  ])('refuses a schedule with %s', async (sql) => {
    const s = setup();
    const id = await s.schedule({});
    s.setRow(id, sql);
    const r = await s.call('update_scheduled_message', { id, message: 'changed' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(NOT_CHANGEABLE);
  });

  test('another user\'s schedule reads as not found', async () => {
    const s = setup();
    const id = s.store.createScheduled({ mmUserId: 'u2', channelId: CH, message: 'theirs', scheduledAt: NOW + DAY }, NOW)!;
    const r = await s.call('update_scheduled_message', { id, message: 'mine now' });
    expect(r.text).toBe(NOT_CHANGEABLE);
    expect(s.store.listScheduled('u2', { limit: 1 })[0].message).toBe('theirs');
  });
});

describe('cancel_scheduled_message', () => {
  test('removes a pending schedule from the list', async () => {
    const s = setup();
    const id = await s.schedule({});
    const r = await s.call('cancel_scheduled_message', { id });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`予約を取り消しました。\n予約 ID: ${id}`);
    expect((await s.call('list_scheduled_messages', {})).text).toBe('予約はありません。');
    expect((await s.call('cancel_scheduled_message', { id })).text).toBe(NOT_CHANGEABLE);
  });

  test.each([
    ["status = 'sending'"],
    ['first_attempt_at = 1'],
  ])('refuses a schedule with %s', async (sql) => {
    const s = setup();
    const id = await s.schedule({});
    s.setRow(id, sql);
    const r = await s.call('cancel_scheduled_message', { id });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(NOT_CHANGEABLE);
  });

  test('another user\'s schedule reads as not found and stays', async () => {
    const s = setup();
    const id = s.store.createScheduled({ mmUserId: 'u2', channelId: CH, message: 'theirs', scheduledAt: NOW + DAY }, NOW)!;
    expect((await s.call('cancel_scheduled_message', { id })).text).toBe(NOT_CHANGEABLE);
    expect(s.store.listScheduled('u2', { limit: 1 })).toHaveLength(1);
  });
});

describe('arguments a tool does not take', () => {
  const GENERAL = '受けない引数です: ';

  test('every tool declares that it takes no other arguments', async () => {
    const all = (await setup().tools()) as unknown as { name: string; inputSchema: { additionalProperties?: boolean } }[];
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((t) => t.inputSchema.additionalProperties !== false).map((t) => t.name)).toEqual([]);
  });

  test('send_message refuses a misspelled file_ids instead of posting without the file', async () => {
    const r = await setup().call('send_message', { channel: CH, message: 'hello', file_id: 'f'.repeat(26) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${GENERAL}file_id。`);
    expect(hits.filter((h) => h.startsWith('POST'))).toEqual([]);
  });

  test('schedule_message points files to send_message and prepare_upload, and gives no attachment hint for other keys', async () => {
    const s = setup();
    const files = await s.call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', files: [] });
    expect(files.isError).toBe(true);
    expect(files.text).toContain(`${GENERAL}files。`);
    expect(files.text).toContain('今すぐ送るなら send_message の files を、予約するなら prepare_upload');
    const time = await s.call('schedule_message', { channel: CH, message: 'hello', at: '2026-11-03T10:00', time: '10:00' });
    expect(time.isError).toBe(true);
    expect(time.text).toContain(`${GENERAL}time。`);
    expect(time.text).not.toContain('prepare_upload');
    expect(s.store.listScheduled('u1', { limit: 10 })).toEqual([]);
  });

  test('an unknown key and an invalid value are both reported, the value with its place', async () => {
    const r = await setup().call('schedule_message', { channel: CH, message: '', at: '2026-11-03T10:00', time: '10:00' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${GENERAL}time。`);
    expect(r.text.split('\n').some((l) => !l.includes(GENERAL) && l.endsWith(' at message'))).toBe(true);
  });

  test('update_scheduled_message gives the cancel hint once for several keys it cannot change, and changes nothing', async () => {
    const s = setup();
    const id = await s.schedule({});
    const r = await s.call('update_scheduled_message', { id, message: 'changed', channel: CH2, file_ids: ['f'.repeat(26)] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${GENERAL}channel, file_ids。`);
    expect(r.text.split('投稿先と添付は変えられません').length - 1).toBe(1);
    expect(s.store.listScheduled('u1', { limit: 1 })[0].message).toBe('hello');
  });

  test.each(['channel', 'root_id', 'files', 'file_ids'])('update_scheduled_message gives the cancel hint for %s alone', async (key) => {
    const r = await setup().call('update_scheduled_message', { id: 'x', message: 'changed', [key]: 'v' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${GENERAL}${key}。`);
    expect(r.text).toContain('投稿先と添付は変えられません');
  });

  test('a key named like an Object method gets the general wording only', async () => {
    const r = await setup().call('update_scheduled_message', { id: 'x', message: 'changed', constructor: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${GENERAL}constructor。ツールの引数（inputSchema）にあるものだけを渡してください。`);
    expect(r.text).not.toContain('function');
    expect(r.text).not.toContain('cancel_scheduled_message');
  });

  test('_meta on the request is not taken as an argument', async () => {
    const s = setup();
    const body = await s.rpc('tools/call', { name: 'list_scheduled_messages', arguments: {}, _meta: { progressToken: 1 } });
    expect(body.result.isError ?? false).toBe(false);
    expect(body.result.content[0].text).toContain('予約はありません');
  });
});

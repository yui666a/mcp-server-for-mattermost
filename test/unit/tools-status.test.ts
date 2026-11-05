import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];

// 2026-11-04T10:00 JST
const NOW = Date.parse('2026-11-04T01:00:00Z');

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  routes = {};
  bodies = {};
  hits = [];
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
    if (req.method === 'PUT') bodies[path] = await req.clone().json();
    hits.push(`${req.method} ${path}`);
    const r = routes[`${req.method} ${path}`];
    if (!r) return Response.json({ id: 'not_found' }, { status: 404 });
    const out = await r(req);
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
  // Argument validation failures come back either as an error result or as a JSON-RPC error, depending on the SDK version.
  const call = async (name: string, args: Record<string, unknown>): Promise<Rpc> => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<{ name: string; annotations: Record<string, boolean> }[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const mmError = (status: number, id: string) => () => Response.json({ id, message: 'm', status_code: status }, { status });
const STATUS = '/users/u1/status';
const CUSTOM = '/users/u1/status/custom';
const echo = (dndEnd = (b: { dnd_end_time: number }) => b.dnd_end_time) => async (req: Request) => {
  const b = await req.json();
  return { user_id: 'u1', status: b.status, manual: b.status !== 'online', last_activity_at: 0, dnd_end_time: dndEnd(b) };
};

describe('set_status', () => {
  test.each(['online', 'away', 'offline'])('sets the caller\'s status to %s with no DND end time', async (status) => {
    routes = { [`PUT ${STATUS}`]: echo() };
    const r = await setup().call('set_status', { status });
    expect(r.isError).toBe(false);
    expect(bodies[STATUS]).toEqual({ user_id: 'u1', status, dnd_end_time: 0 });
  });

  test('online says the status is back to automatic', async () => {
    routes = { [`PUT ${STATUS}`]: echo() };
    const r = await setup().call('set_status', { status: 'online' });
    expect(r.text).toContain('「オンライン」');
    expect(r.text).toContain('自動の判定に戻りました');
  });

  test('away does not claim the status is automatic', async () => {
    routes = { [`PUT ${STATUS}`]: echo() };
    const r = await setup().call('set_status', { status: 'away' });
    expect(r.text).toContain('「離席」');
    expect(r.text).not.toContain('自動');
  });

  test('dnd_until is read as JST and sent in Unix seconds, and the reply shows the end Mattermost kept, floored to the minute', async () => {
    routes = { [`PUT ${STATUS}`]: echo((b) => b.dnd_end_time - (b.dnd_end_time % 60)) };
    const r = await setup().call('set_status', { status: 'dnd', dnd_until: '2026-11-04T11:00:30' });
    expect(r.isError).toBe(false);
    expect(bodies[STATUS]).toEqual({ user_id: 'u1', status: 'dnd', dnd_end_time: Date.parse('2026-11-04T02:00:30Z') / 1000 });
    expect(r.text).toContain('「取り込み中」（終了: 2026-11-04T02:00:00Z | 2026-11-04T11:00:00+09:00）');
  });

  test('dnd without dnd_until says it has no end time', async () => {
    routes = { [`PUT ${STATUS}`]: echo() };
    const r = await setup().call('set_status', { status: 'dnd' });
    expect(bodies[STATUS]).toEqual({ user_id: 'u1', status: 'dnd', dnd_end_time: 0 });
    expect(r.text).toContain('（終了時刻なし）');
  });

  test.each(['online', 'away', 'offline'])('dnd_until with %s is rejected without calling Mattermost', async (status) => {
    const r = await setup().call('set_status', { status, dnd_until: '2026-11-04T11:00' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('dnd_until は status が dnd のときだけ');
    expect(hits).toEqual([]);
  });

  test.each([
    ['2026-11-04T10:00:59', '1 分後以降'],
    ['2026-11-04T09:00', '1 分後以降'],
    ['2026-11-04 11:00', 'dnd_until「2026-11-04 11:00」を日時として読めません'],
  ])('dnd_until %j is rejected without calling Mattermost', async (dnd_until, message) => {
    const r = await setup().call('set_status', { status: 'dnd', dnd_until });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
    expect(hits).toEqual([]);
  });

  test('dnd_until exactly one minute ahead is accepted', async () => {
    routes = { [`PUT ${STATUS}`]: echo() };
    expect((await setup().call('set_status', { status: 'dnd', dnd_until: '2026-11-04T10:01' })).isError).toBe(false);
  });

  test('a server with user statuses disabled says so', async () => {
    routes = { [`PUT ${STATUS}`]: mmError(404, 'api.status.user_not_found.app_error') };
    const r = await setup().call('set_status', { status: 'dnd' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('在席状況の機能が無効');
  });

  test.each(['ooo', 'busy'])('status %j is rejected by the schema', async (status) => {
    const r = await setup().call('set_status', { status });
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });
});

describe('set_custom_status', () => {
  const ok = { [`PUT ${CUSTOM}`]: () => ({ status: 'OK' }) };

  test('sends the emoji, text and expiry, read as JST, and reports them', async () => {
    routes = ok;
    const r = await setup().call('set_custom_status', { emoji: ':calendar:', text: ' 会議中 ', until: '2026-11-04T11:00' });
    expect(r.isError).toBe(false);
    expect(bodies[CUSTOM]).toEqual({ emoji: 'calendar', text: '会議中', duration: 'date_and_time', expires_at: '2026-11-04T02:00:00.000Z' });
    expect(r.text).toContain('絵文字: :calendar:');
    expect(r.text).toContain('文言: 会議中');
    expect(r.text).toContain('期限: 2026-11-04T02:00:00Z | 2026-11-04T11:00:00+09:00');
  });

  test('without until it sends no expiry and reports no expiry', async () => {
    routes = ok;
    const r = await setup().call('set_custom_status', { text: '在宅' });
    expect(bodies[CUSTOM]).toEqual({ emoji: '', text: '在宅', duration: '' });
    expect(r.text).toContain('絵文字: なし');
    expect(r.text).toContain('期限: 期限なし');
  });

  test('spaces inside the colons of the emoji are dropped', async () => {
    routes = ok;
    await setup().call('set_custom_status', { emoji: ': palm_tree :' });
    expect(bodies[CUSTOM]).toMatchObject({ emoji: 'palm_tree' });
  });

  test('an emoji alone is enough', async () => {
    routes = ok;
    const r = await setup().call('set_custom_status', { emoji: ' palm_tree ' });
    expect(bodies[CUSTOM]).toEqual({ emoji: 'palm_tree', text: '', duration: '' });
    expect(r.text).toContain('文言: なし');
  });

  test.each([[{}], [{ emoji: '::' }], [{ text: '   ' }]])('with neither an emoji nor a text (%j) it is rejected without calling Mattermost', async (args) => {
    const r = await setup().call('set_custom_status', args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('emoji か text のどちらかを指定してください');
    expect(hits).toEqual([]);
  });

  test('a text of 101 characters is rejected by the schema, 100 is accepted', async () => {
    routes = ok;
    const over = await setup().call('set_custom_status', { text: 'あ'.repeat(101) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('<=100 characters at text');
    expect(hits).toEqual([]);
    expect((await setup().call('set_custom_status', { text: 'あ'.repeat(100) })).isError).toBe(false);
  });

  test('the 100 characters of a text count an emoji outside the BMP as one, as Mattermost counts runes', async () => {
    routes = ok;
    const over = await setup().call('set_custom_status', { text: '😀'.repeat(101) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('<=100 characters at text');
    expect(hits).toEqual([]);
    expect((await setup().call('set_custom_status', { text: '😀'.repeat(100) })).isError).toBe(false);
  });

  test.each([
    ['2026-11-04T10:00:30', '1 分後以降'],
    ['2026-11-03T11:00', '1 分後以降'],
    ['tomorrow', 'until「tomorrow」を日時として読めません'],
  ])('until %j is rejected without calling Mattermost', async (until, message) => {
    const r = await setup().call('set_custom_status', { text: 'x', until });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(message);
    expect(hits).toEqual([]);
  });

  test('an unknown emoji says so and points to search_emoji', async () => {
    routes = { [`PUT ${CUSTOM}`]: mmError(400, 'api.custom_status.set_custom_statuses.emoji_not_found') };
    const r = await setup().call('set_custom_status', { emoji: 'no_such' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('絵文字「no_such」がありません');
    expect(r.text).toContain('search_emoji');
  });

  test('a server with custom statuses disabled says so', async () => {
    routes = { [`PUT ${CUSTOM}`]: mmError(501, 'api.custom_status.disabled') };
    const r = await setup().call('set_custom_status', { text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('カスタムステータスが無効です');
  });
});

describe('clear_custom_status', () => {
  test('deletes the caller\'s custom status', async () => {
    routes = { [`DELETE ${CUSTOM}`]: () => ({ status: 'OK' }) };
    const r = await setup().call('clear_custom_status', {});
    expect(r.isError).toBe(false);
    expect(hits).toEqual([`DELETE ${CUSTOM}`]);
    expect(r.text).toContain('カスタムステータスを消しました');
  });

  test('a server with custom statuses disabled says so', async () => {
    routes = { [`DELETE ${CUSTOM}`]: mmError(501, 'api.custom_status.disabled') };
    const r = await setup().call('clear_custom_status', {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('カスタムステータスが無効です');
  });
});

test('tool annotations: set_status is destructive and not idempotent, the custom status tools replace what was there', async () => {
  const by = Object.fromEntries((await setup().tools()).map((t) => [t.name, t.annotations]));
  expect(by.set_status).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  expect(by.set_custom_status).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  expect(by.clear_custom_status).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
});

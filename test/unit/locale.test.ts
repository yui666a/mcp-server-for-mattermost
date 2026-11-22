import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLocale } from '../../src/i18n/index.ts';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
type Tool = { name: string; description: string; inputSchema: unknown };
let routes: Record<string, Route>;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  routes = {};
});
afterEach(() => {
  vi.restoreAllMocks();
  setLocale('en');
});

const CH = 'c'.repeat(26);
const TEAM = 't'.repeat(26);

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
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
  const call = async (name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
    const body = await rpc('tools/call', { name, arguments: args });
    if (body.error) return { isError: true, text: body.error.message };
    return { isError: body.result.isError ?? false, text: body.result.content[0].text };
  };
  const tools = async (): Promise<Tool[]> => (await rpc('tools/list', {})).result.tools;
  return { call, tools };
}

const JAPANESE = /[぀-ヿ一-鿿]/;
// The one Japanese example the English text keeps on purpose: it shows the form of a date that search_files matches.
const EXAMPLE = '2026年10月*';

function descriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((x) => descriptions(x, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else descriptions(v, out);
    }
  }
  return out;
}

test('no Japanese in tool descriptions under en', async () => {
  const list = await setup().tools();
  expect(list.length).toBeGreaterThan(30);
  for (const t of list) {
    for (const d of descriptions(t)) expect(d.replaceAll(EXAMPLE, ''), t.name).not.toMatch(JAPANESE);
  }
});

test('every tool description is Japanese under ja', async () => {
  const en = new Map((await setup().tools()).map((t) => [t.name, t.description]));
  setLocale('ja');
  const ja = await setup().tools();
  expect(ja.map((t) => t.name).sort()).toEqual([...en.keys()].sort());
  for (const t of ja) {
    expect(t.description, t.name).not.toBe(en.get(t.name));
    expect(t.description, t.name).toMatch(JAPANESE);
  }
});

test('field names the descriptions refer to stay the same in both languages', async () => {
  const id = (n: number) => `p${String(n).padStart(25, '0')}`;
  const order = Array.from({ length: 30 }, (_, i) => id(i));
  routes = {
    'POST /posts/search': () => ({ order, posts: Object.fromEntries(order.map((p) => [p, { id: p, user_id: 'u1', channel_id: CH, root_id: '', message: 'm', create_at: 0 }])) }),
    'GET /users/me/channels': () => [],
    'GET /users/me/teams': () => [{ id: TEAM, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  for (const l of ['en', 'ja'] as const) {
    setLocale(l);
    const { text } = await setup().call('search_posts', { terms: 'x', limit: 20 });
    expect(text, l).toContain('next_cursor:');
    expect(text, l).toContain(`post_id: ${id(0)}`);
  }
});

test('edit_message quotes the cut note get_post writes, in both languages', async () => {
  const POST = 'r'.repeat(26);
  routes = {
    [`GET /posts/${POST}`]: () => ({ id: POST, user_id: 'u1', channel_id: CH, root_id: '', message: 'x'.repeat(4001), create_at: 0, reply_count: 0 }),
    [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: TEAM, type: 'O' }),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  for (const [l, note] of [['en', /The body was cut at \d+ characters/], ['ja', /本文を \d+ 文字で切りました/]] as const) {
    setLocale(l);
    const s = setup();
    const out = (await s.call('get_post', { post: POST })).text;
    const cut = note.exec(out)?.[0];
    expect(cut, l).toBeDefined();
    const edit = (await s.tools()).find((t) => t.name === 'edit_message')!;
    const d = (edit.inputSchema as { properties: { message: { description: string } } }).properties.message.description;
    expect([`"${cut}"`, `「${cut}」`].some((q) => d.includes(q)), `${l}: ${d}`).toBe(true);
  }
});

test('a module-level string does not stay English under ja', async () => {
  setLocale('ja');
  const s = setup();
  routes = { 'GET /users/me/teams': () => [{ id: TEAM, name: 'team-a' }] };
  const missing = await s.call('read_channel', { channel: 'nowhere' });
  expect(missing.isError).toBe(true);
  expect(missing.text).toMatch(JAPANESE);
  expect(missing.text).not.toContain('was not found');

  const outOfRange = await s.call('schedule_message', { channel: '@carol', message: 'hello', at: '2020-01-01T00:00' });
  expect(outOfRange.isError).toBe(true);
  expect(outOfRange.text).toMatch(JAPANESE);
  expect(outOfRange.text).not.toContain('from 1 minute');

  routes = {
    'GET /users/me/teams': () => [{ id: TEAM, name: 'team-a' }],
    [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: TEAM, type: 'O' }),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    'POST /posts': () => ({ id: 'p'.repeat(26), user_id: 'u1', channel_id: CH, root_id: '', message: 'hello', create_at: 1 }),
  };
  expect((await s.call('send_message', { channel: CH, message: 'hello' })).isError).toBe(false);
  const again = await s.call('send_message', { channel: CH, message: 'hello' });
  expect(again.text).toMatch(JAPANESE);
  expect(again.text).not.toContain('The same body');
});

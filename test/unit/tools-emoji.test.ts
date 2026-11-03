import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  routes = {};
  bodies = {};
  hits = [];
});
afterEach(() => vi.restoreAllMocks());

type Rpc = { isError: boolean; text: string };

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST') bodies[path] = await req.clone().json();
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
const SEARCH = 'POST /emoji/search';
const found = (...names: string[]) => () => names.map((name) => ({ id: name, name, creator_id: 'u2', create_at: 0, update_at: 0, delete_at: 0 }));

describe('search_emoji', () => {
  test('searches custom emoji by part of the name and lists the names Mattermost returned, in its order', async () => {
    routes = { [SEARCH]: found('party_parrot', 'office_party') };
    const r = await setup().call('search_emoji', { name: 'party' });
    expect(r.isError).toBe(false);
    expect(bodies['/emoji/search']).toEqual({ term: 'party', prefix_only: false });
    expect(r.text).toBe(':party_parrot:\n:office_party:');
  });

  test.each([
    [' :party: ', 'party'],
    ['Party', 'Party'],
    ['a'.repeat(64), 'a'.repeat(64)],
    [`:${'a'.repeat(64)}:`, 'a'.repeat(64)],
  ])('sends %j as the term %j', async (name, term) => {
    routes = { [SEARCH]: found('x') };
    expect((await setup().call('search_emoji', { name })).isError).toBe(false);
    expect(bodies['/emoji/search']).toMatchObject({ term });
  });

  test.each(['::', '   ', 'a'.repeat(65)])('rejects %j without calling Mattermost', async (name) => {
    const r = await setup().call('search_emoji', { name });
    expect(r.isError).toBe(true);
    expect(hits).toEqual([]);
  });

  test('no match says so and that standard emoji are not searched', async () => {
    routes = { [SEARCH]: found() };
    const r = await setup().call('search_emoji', { name: 'calendar' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('「calendar」を名前に含むカスタム絵文字はありません');
    expect(r.text).toContain('標準の絵文字は対象外');
  });

  test('a full page of 200 says the list was cut at 200; 199 does not', async () => {
    routes = { [SEARCH]: found(...Array.from({ length: 200 }, (_, i) => `e${i}`)) };
    expect((await setup().call('search_emoji', { name: 'e' })).text).toContain('200 件までを出しました');
    routes = { [SEARCH]: found(...Array.from({ length: 199 }, (_, i) => `e${i}`)) };
    expect((await setup().call('search_emoji', { name: 'e' })).text).not.toContain('件までを出しました');
  });

  test('a server with custom emoji disabled says so', async () => {
    routes = { [SEARCH]: mmError(403, 'api.emoji.disabled.app_error') };
    const r = await setup().call('search_emoji', { name: 'party' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('カスタム絵文字が無効です');
  });

  test('is annotated read-only', async () => {
    const t = (await setup().tools()).find((x) => x.name === 'search_emoji');
    expect(t?.annotations).toEqual({ readOnlyHint: true });
  });
});

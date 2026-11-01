import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  bodies = {};
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST') bodies[path] = await req.clone().json();
    const r = routes[`${req.method} ${path}`];
    return r ? Response.json(r(req)) : Response.json({ id: 'not_found' }, { status: 404 });
  });
  const code = ctx.store.createCode({
    mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: ctx.config.resource, scope: 'mattermost',
  });
  const rec = ctx.store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const { accessToken } = ctx.store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: ctx.config.resource, fromCodeHash: rec.codeHash });
  ctx.store.putMmCred('u1', 'mm-access', 'mm-refresh');
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.body.result.isError).toBeFalsy();
    return r.body.result.content[0].text;
  };
}

const id = (n: number) => `p${String(n).padStart(25, '0')}`;
const posts = (n: number) => {
  const order = Array.from({ length: n }, (_, i) => id(i));
  return { order, posts: Object.fromEntries(order.map((p, i) => [p, { id: p, user_id: 'u1', channel_id: 'c'.repeat(26), root_id: '', message: `m${i}`, create_at: 0 }])) };
};

test('search_posts sends the JST offset, shows the channel and team names, and notes the 100-result cap', async () => {
  routes = {
    'POST /posts/search': () => posts(100),
    'GET /users/me/channels': () => [{ id: 'c'.repeat(26), name: 'general-dup', display_name: 'General', team_id: 't'.repeat(26), type: 'O' }],
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  const call = setup();
  const out = await call('search_posts', { terms: 'x on:2026-10-15', limit: 50 });
  expect(bodies['/posts/search']).toMatchObject({ terms: 'x on:2026-10-15', time_zone_offset: 32400 });
  expect(out).toContain('name: general-dup');
  expect(out).toContain('team-a');
  expect(out).toContain('これより古い一致');
  routes['POST /posts/search'] = () => posts(99);
  expect(await call('search_posts', { terms: 'x' })).not.toContain('100 件まで');
});

test('search_users notes the 100-result cap', async () => {
  routes = { 'POST /users/search': () => Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, username: `user${i}` })) };
  const call = setup();
  expect(await call('search_users', { query: 'user' })).toContain('100 件まで');
});

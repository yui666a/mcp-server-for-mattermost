import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BODY_CUT_NOTE } from '../../src/mcp/format.ts';
import { makeApp } from './helpers.ts';

type Route = (req: Request) => unknown;
let routes: Record<string, Route>;
let bodies: Record<string, unknown>;
let hits: string[];
let urls: string[];
let last: { content: { type: string; text?: string; data?: string; mimeType?: string }[] };

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  bodies = {};
  hits = [];
  urls = [];
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const ctx = makeApp({}, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST') bodies[path] = await req.clone().json();
    hits.push(`${req.method} ${path}`);
    urls.push(`${req.method} ${path}${new URL(req.url).search}`);
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
  return async (name: string, args: Record<string, unknown>, isError = false): Promise<string> => {
    const r = await ctx.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.body.result.isError ?? false).toBe(isError);
    last = r.body.result;
    return r.body.result.content[0].text;
  };
}

const id = (n: number) => `p${String(n).padStart(25, '0')}`;
const posts = (n: number) => {
  const order = Array.from({ length: n }, (_, i) => id(i));
  return { order, posts: Object.fromEntries(order.map((p, i) => [p, { id: p, user_id: 'u1', channel_id: 'c'.repeat(26), root_id: '', message: `m${i}`, create_at: 0 }])) };
};

test('search_posts looks up more than 1,000 users in calls of at most 1,000 ids, and names the users of every call', async () => {
  // 50 posts by 50 authors, each with 2 emoji of 10 users: 1,050 users, all short enough to be named on the reactions lines.
  const order = Array.from({ length: 50 }, (_, i) => id(i));
  const user = (i: number, j: number) => `r${String(i * 20 + j).padStart(4, '0')}`;
  const found = { order, posts: Object.fromEntries(order.map((p, i) => [p, {
    id: p, user_id: `a${i}`, channel_id: 'c'.repeat(26), root_id: '', message: `m${i}`, create_at: 0,
    metadata: { reactions: Array.from({ length: 20 }, (_, j) => ({ user_id: user(i, j), emoji_name: j < 10 ? 'x' : 'y', create_at: j })) },
  }])) };
  const asked: string[][] = [];
  routes = {
    'POST /posts/search': () => found,
    'GET /users/me/channels': () => [{ id: 'c'.repeat(26), name: 'town', display_name: 'Town', team_id: 't'.repeat(26), type: 'O' }],
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    'POST /users/ids': () => { const ids = bodies['/users/ids'] as string[]; asked.push(ids); return ids.map((x) => ({ id: x, username: `n${x}` })); },
  };
  const out = await setup()('search_posts', { terms: 'm', limit: 50 });
  expect(asked.map((x) => x.length)).toEqual([1000, 50]);
  const all = [...order.keys()].flatMap((i) => [`a${i}`, ...Array.from({ length: 20 }, (_, j) => user(i, j))]);
  expect(asked.flat().sort()).toEqual(all.sort());
  for (const x of asked[1]) expect(out).toContain(`@n${x}`);
  expect(out).not.toContain('user_id: ');
});

test('search_posts looks up a channel archived after the search, which the listing lacks, for its line and the team of its permalink', async () => {
  const ARCH = 'a'.repeat(26);
  routes = {
    'POST /posts/search': () => ({ order: [id(0)], posts: { [id(0)]: { id: id(0), user_id: 'u1', channel_id: ARCH, root_id: '', message: 'm', create_at: 0 } } }),
    'GET /users/me/channels': () => [],
    [`GET /channels/${ARCH}`]: () => ({ id: ARCH, name: 'old', display_name: 'Old', team_id: 's'.repeat(26), type: 'O', delete_at: 5 }),
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }, { id: 's'.repeat(26), name: 'team-b' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  const out = await setup()('search_posts', { terms: 'x' });
  expect(out).toContain('Old（アーカイブ済み）');
  expect(out).toContain(`https://mm.example/team-b/pl/${id(0)}`);
});

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
  expect(urls).toContain('GET /users/me/channels');
  expect(urls).not.toContain('GET /users/me/channels?include_deleted=true');
  expect(hits.some((h) => h.startsWith('GET /channels/'))).toBe(false);
  expect(out).toContain('name: general-dup');
  expect(out).toContain('team-a');
  expect(out).toContain('これより古い一致');
  routes['POST /posts/search'] = () => posts(99);
  expect(await call('search_posts', { terms: 'x' })).not.toContain('100 件まで');
});

test('search_posts pages with its own next_cursor and rejects a search_files cursor', async () => {
  routes = {
    'POST /posts/search': () => posts(30),
    'GET /users/me/channels': () => [],
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };
  const call = setup();
  const first = await call('search_posts', { terms: 'x', limit: 20 });
  const cursor = /next_cursor: (\S+)/.exec(first)![1];
  const second = await call('search_posts', { terms: 'x', cursor });
  expect(second).toContain(`post_id: ${id(20)}`);
  expect(second).not.toContain(`post_id: ${id(19)}`);
  const files = Buffer.from(JSON.stringify({ page: 1, per_page: 20, files: true })).toString('base64url');
  expect(await call('search_posts', { terms: 'x', cursor: files }, true)).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
});

describe('search_posts in: filters', () => {
  const pad = (s: string) => s.padEnd(26, '0');
  const T1 = pad('ta'), T2 = pad('tb');
  const CA = pad('ca'), CB = pad('cb'), CX = pad('cx'), PV = pad('pv');
  const BOB = pad('bob');
  const DM_NAME = [BOB, 'u1'].sort().join('__');
  const DM = pad('dm');
  const ch = (id: string, name: string, team_id: string, type = 'O') => ({ id, name, display_name: name, team_id, type, purpose: '', header: '' });
  const base = (): Record<string, Route> => ({
    'POST /posts/search': () => posts(0),
    'GET /users/me/teams': () => [{ id: T1, name: 'team-a' }, { id: T2, name: 'team-b' }],
    [`GET /teams/${T1}`]: () => ({ id: T1, name: 'team-a' }),
    [`GET /teams/${T2}`]: () => ({ id: T2, name: 'team-b' }),
    [`GET /teams/${T1}/channels/name/town`]: () => ch(CA, 'town', T1),
    [`GET /teams/${T2}/channels/name/town`]: () => ch(CB, 'town', T2),
    [`GET /teams/${T1}/channels/name/only-a`]: () => ch(CX, 'only-a', T1),
    'GET /teams/name/team-a/channels/name/only-a': () => ch(CX, 'only-a', T1),
    [`GET /channels/${CX}`]: () => ch(CX, 'only-a', T1),
    [`GET /channels/${CB}`]: () => ch(CB, 'town', T2),
    'GET /users/username/bob': () => ({ id: BOB, username: 'bob' }),
    [`GET /channels/${PV}`]: () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }),
    'GET /teams/name/team-a/channels/name/private': () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }),
  });
  const withDm = () => ({
    ...base(),
    [`GET /teams/${T1}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D'),
    [`GET /teams/${T2}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D'),
  });
  const sent = () => (bodies['/posts/search'] as { terms: string } | undefined)?.terms;

  test.each([
    ['x in:only-a', `x in:${CX}`],
    ['x -in:only-a', `x -in:${CX}`],
    ['x channel:only-a', `x in:${CX}`],
    ['x IN:only-a', `x in:${CX}`],
    ['x in: only-a', `x in:${CX}`],
    ['x in:~only-a', `x in:${CX}`],
    ['x in:team-a/only-a', `x in:${CX}`],
    [`x in:${CX}`, `x in:${CX}`],
    ['x　in:only-a', `x in:${CX}`],
    ['foo "bar in:only-a', `foo "bar in:${CX}`],
    [`x in:only-a in:${CB}`, `x in:${CX} in:${CB}`],
    ['x -channel:only-a', `x -in:${CX}`],
    ['"a  b" in:only-a', `"a  b" in:${CX}`],
    ['x -"in:town" in:only-a', `x -"in:town" in:${CX}`],
    ['abc"in:town" in:only-a', `abc "in:town" in:${CX}`],
  ])('sends %j to Mattermost as %j', async (terms, expected) => {
    routes = base();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(expected);
  });

  test('in:@ with the caller\'s own name uses the DM with oneself, without creating one', async () => {
    const SELF = 'u1__u1';
    routes = { ...base(), 'GET /users/username/me': () => ({ id: 'u1', username: 'me' }), [`GET /teams/${T1}/channels/name/${SELF}`]: () => ch(pad('self'), SELF, '', 'D') };
    await setup()('search_posts', { terms: 'x in:@me' });
    expect(sent()).toBe(`x in:${pad('self')}`);
    expect(hits).not.toContain('POST /channels/direct');
  });

  test.each([
    ['x in:~@bob', `x in:${DM}`],
    ['x -channel:~@bob', `x -in:${DM}`],
  ])('reads %j, with a leading ~ before @user, as the DM', async (terms, expected) => {
    routes = withDm();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(expected);
  });

  test.each([
    ['no-break space', '\u00a0'],
    ['em space', '\u2003'],
    ['next line', '\u0085'],
    ['line separator', '\u2028'],
  ])('splits words on a %s as Go\'s unicode.IsSpace does', async (_name, space) => {
    routes = base();
    await setup()('search_posts', { terms: `x${space}in:only-a` });
    expect(sent()).toBe(`x in:${CX}`);
  });

  test.each([
    ['U+FEFF', '\ufeff'],
    ['U+200B', '\u200b'],
  ])('does not split words on %s, which Go\'s unicode.IsSpace does not count as a space', async (_name, c) => {
    routes = base();
    await setup()('search_posts', { terms: `x${c}in:only-a` });
    expect(sent()).toBe(`x${c}in:only-a`);
    expect(hits).toEqual(['POST /posts/search']);
  });

  test('a channel ID is looked up to check it is visible before it is sent', async () => {
    routes = base();
    await setup()('search_posts', { terms: `x in:${CX}` });
    expect(hits).toContain(`GET /channels/${CX}`);
  });

  test.each([
    ['a  "b in:only-a" c'],
    ['from: in:only-a x'],
    ['x in:'],
    ['  a  b '],
  ])('passes %j through unchanged', async (terms) => {
    routes = base();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(terms);
    expect(hits).toEqual(['POST /posts/search']);
  });

  test('searches every team for a name that several teams have, notes it, and keeps the original terms in the header', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: 'x in:town' });
    expect(sent()).toBe(`x in:${CA} in:${CB}`);
    expect(out.split('\n')[0]).toBe('検索: x in:town');
    expect(out).toContain('in:town は複数のチームにあるため、すべてで探しました（team-a、team-b）。');
  });

  test.each([
    ['x channel:~town', 'channel:~town'],
    ['x IN: town', 'IN: town'],
  ])('the note for %j names the flag as written', async (terms, written) => {
    routes = base();
    expect(await setup()('search_posts', { terms })).toContain(`${written} は複数のチームにあるため、すべてで探しました（team-a、team-b）。`);
  });

  test.each([
    ['x in:@bob \ufeff', `x in:${DM} \ufeff`],
    ['x in:@bob \ufeff y', `x in:${DM} \ufeff y`],
  ])('a word of format characters only after in:@user, with nothing or a search word next, is searched as it is: %j', async (terms, expected) => {
    routes = withDm();
    await setup()('search_posts', { terms });
    expect(sent()).toBe(expected);
  });

  test('a U+FEFF before or after the value does not change which channel is searched', async () => {
    routes = base();
    await setup()('search_posts', { terms: 'x in:\ufeff~only-a\ufeff' });
    expect(sent()).toBe(`x in:${CX}`);
    await setup()('search_posts', { terms: 'x in:only-a\u200b' });
    expect(sent()).toBe(`x in:${CX}`);
    expect(await setup()('search_posts', { terms: 'x in:\ufeff@bob ,carol' }, true)).toContain('の後の「,carol」');
  });

  test.each([
    ['x in:~\ufeff@bob ,carol', '「,carol」', false],
    ['x in:~\u200b@bob ,carol', '「,carol」', false],
    ['x in:@bob \ufeff ,carol', '「,carol」', false],
    ['x in:@bob \ufeff \u200b ,carol', '「,carol」', false],
    ['x in:@bob \u200b ，carol', '「，carol」', true],
    ['x in:\u200c~@bob ,carol', '「,carol」', false],
    ['x in:~\u200d\u200e@bob ,carol', '「,carol」', false],
    ['x in:@bob \u2060，carol', '「\u2060，carol」', true],
    ['x in:@bob \ufeff，carol', '「\ufeff，carol」', true],
  ])('a format character after ~ or before the next word does not hide a misplaced comma in %j', async (terms, word, fullWidth) => {
    routes = base();
    const out = await setup()('search_posts', { terms }, true);
    expect(out).toContain(`の後の${word}`);
    expect(out.includes('区切りは半角のカンマ（,）で書いてください。')).toBe(fullWidth);
    expect(hits).not.toContain('POST /posts/search');
  });

  test('excludes every channel of a name that several teams have', async () => {
    routes = base();
    await setup()('search_posts', { terms: 'x -in:town' });
    expect(sent()).toBe(`x -in:${CA} -in:${CB}`);
  });

  test('a DM name found through every team counts as one channel, without the note', async () => {
    routes = withDm();
    const out = await setup()('search_posts', { terms: `x in:${DM_NAME}` });
    expect(sent()).toBe(`x in:${DM}`);
    expect(out).not.toContain('複数のチーム');
  });

  test('in:@user uses the existing DM without creating one', async () => {
    routes = withDm();
    await setup()('search_posts', { terms: 'x in:@bob' });
    expect(sent()).toBe(`x in:${DM}`);
    expect(hits).not.toContain('POST /channels/direct');
  });

  test('in:@user without a DM is an error, and neither creates the DM nor searches', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: 'x in:@bob' }, true);
    expect(out).toContain('@bob との DM はまだありません。');
    expect(hits).not.toContain('POST /channels/direct');
    expect(hits).not.toContain('POST /posts/search');
  });

  test('-in:@user with a DM excludes that DM', async () => {
    routes = withDm();
    await setup()('search_posts', { terms: 'x -in:@bob' });
    expect(sent()).toBe(`x -in:${DM}`);
  });

  test('-in:@user without a DM drops the condition', async () => {
    routes = base();
    await setup()('search_posts', { terms: 'x -in:@bob' });
    expect(sent()).toBe('x');
    await setup()('search_posts', { terms: 'x -in: @bob y' });
    expect(sent()).toBe('x y');
    expect(hits).not.toContain('POST /channels/direct');
  });

  test('dropping the only condition leaves nothing to search, which is an error', async () => {
    routes = base();
    const out = await setup()('search_posts', { terms: '-in:@bob' }, true);
    expect(out).toContain('検索語か条件を 1 つ以上指定してください。');
    expect(hits).not.toContain('POST /posts/search');
  });

  describe('a group DM given as @a,b', () => {
    const CAROL = pad('carol');
    const GM = pad('gm');
    const GM_NAME = createHash('sha1').update(['u1', BOB, CAROL].sort().join('')).digest('hex');
    const users = { me: { id: 'u1', username: 'me' }, bob: { id: BOB, username: 'bob' }, carol: { id: CAROL, username: 'carol' } };
    const known = (): Record<string, Route> => ({
      ...base(),
      'POST /users/usernames': () => (bodies['/users/usernames'] as string[]).flatMap((n) => (n in users ? [users[n as keyof typeof users]] : [])),
    });
    const withGroup = () => ({ ...known(), [`GET /teams/${T1}/channels/name/${GM_NAME}`]: () => ch(GM, GM_NAME, '', 'G') });

    test.each([
      ['x in:@bob,carol', `x in:${GM}`],
      ['x in:@Carol,@bob,me', `x in:${GM}`],
      ['x in: @bob,carol', `x in:${GM}`],
      ['x -in:@bob,carol', `x -in:${GM}`],
      ['x channel:~@bob,carol', `x in:${GM}`],
    ])('sends %j to Mattermost as %j, without creating the group DM', async (terms, expected) => {
      routes = withGroup();
      await setup()('search_posts', { terms });
      expect(sent()).toBe(expected);
      expect(hits).not.toContain('POST /channels/group');
    });

    test('without the group DM, in: is an error without searching, and -in: drops the condition; neither creates it', async () => {
      routes = known();
      const call = setup();
      expect(await call('search_posts', { terms: 'x in:@bob,carol' }, true)).toContain('@bob, @carol とのグループ DM はまだありません。');
      expect(hits).not.toContain('POST /posts/search');
      await call('search_posts', { terms: 'x -in:@bob,carol' });
      expect(sent()).toBe('x');
      expect(hits).not.toContain('POST /channels/group');
    });

    test.each([
      ['x in:@bob,ghost', 'ユーザーが見つかりません: @ghost。'],
      ['x -in:@bob,ghost', 'ユーザーが見つかりません: @ghost。'],
      ['x in:@bob,me', 'グループ DM には、自分以外に 2 人以上を指定してください。'],
      ['x in:@bob, carol', 'カンマの前後に空白を入れない'],
      ['x in:@bob ,carol', 'in:@bob の後の「,carol」: 検索の条件では @a,b のようにカンマの前後に空白を入れずに書いてください。'],
      ['x in:@bob , carol', 'in:@bob の後の「,」'],
      ['x in: @bob ,carol', 'in: @bob の後の「,carol」'],
      ['x channel:~@bob ,carol', 'channel:~@bob の後の「,carol」'],
    ])('%j is an input error without searching', async (terms, message) => {
      routes = withGroup();
      const out = await setup()('search_posts', { terms }, true);
      expect(out).toContain(message);
      expect(hits).not.toContain('POST /posts/search');
    });

    test.each([
      ['x in:@bob 、carol', 'in:@bob の後の「、carol」'],
      ['x in:@bob 、@carol', 'in:@bob の後の「、@carol」'],
      ['x in:@bob 、carol、dave', 'in:@bob の後の「、carol、dave」'],
      ['x in:@bob 、', 'in:@bob の後の「、」'],
      ['x in:@bob ，carol', 'in:@bob の後の「，carol」'],
      ['x in:@bob ，', 'in:@bob の後の「，」'],
      ['x channel:~@bob 、carol', 'channel:~@bob の後の「、carol」'],
      ['x in:@bob 、carol，dave', 'in:@bob の後の「、carol，dave」'],
    ])('%j is a separator error that asks for a half-width comma', async (terms, message) => {
      routes = withGroup();
      const out = await setup()('search_posts', { terms }, true);
      expect(out).toContain(message);
      expect(out).toContain('区切りは半角のカンマ（,）で書いてください。');
      expect(hits).not.toContain('POST /posts/search');
    });

    test('a search word after the DM that starts with 、 is kept as a search word', async () => {
      routes = { ...withGroup(), [`GET /teams/${T1}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D') };
      await setup()('search_posts', { terms: 'x in:@bob 、議事録' });
      expect(sent()).toBe(`x in:${DM} 、議事録`);
    });

    test('a search word after the DM that starts with ， is kept as a search word', async () => {
      routes = { ...withGroup(), [`GET /teams/${T1}/channels/name/${DM_NAME}`]: () => ch(DM, DM_NAME, '', 'D') };
      await setup()('search_posts', { terms: 'x in:@bob ，議事録' });
      expect(sent()).toBe(`x in:${DM} ，議事録`);
    });

    test('in:@bob、 is refused for its separator', async () => {
      routes = withGroup();
      expect(await setup()('search_posts', { terms: 'x in:@bob、' }, true)).toContain('@a,b の区切りは半角のカンマ（,）で書いてください。');
    });

    test('in:@bob、carol is refused for its separator', async () => {
      routes = withGroup();
      expect(await setup()('search_posts', { terms: 'x in:@bob、carol' }, true)).toContain('@a,b の区切りは半角のカンマ（,）で書いてください。');
    });

    test('the space check runs before any lookup', async () => {
      routes = withGroup();
      await setup()('search_posts', { terms: 'x in:only-a in:@bob ,carol' }, true);
      expect(hits).toEqual([]);
    });
  });

  test('a 404 while resolving a group DM is not reported as a user named after the whole spec', async () => {
    routes = { ...base(), 'POST /users/usernames': () => Response.json({ id: 'x' }, { status: 404 }) };
    expect(await setup()('search_posts', { terms: 'x in:@bob,carol' }, true)).not.toContain('ユーザー「@bob,carol」');
  });

  test('in:@user answered 403 by the user lookup, as with restricted user visibility, is a user not found', async () => {
    routes = { ...base(), 'GET /users/username/bob': () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }) };
    expect(await setup()('search_posts', { terms: 'x in:@bob' }, true)).toContain('ユーザー「@bob」が見つかりません。');
    expect(hits).not.toContain('POST /posts/search');
  });

  test('a 403 from the teams lookup for in:@user is not reported as a missing user', async () => {
    routes = { ...base(), 'GET /users/me/teams': () => Response.json({ id: 'api.context.permissions.app_error' }, { status: 403 }) };
    expect(await setup()('search_posts', { terms: 'x in:@bob' }, true)).not.toContain('ユーザー「@bob」が見つかりません。');
  });

  describe('within one search', () => {
    const count = (h: string) => hits.filter((x) => x === h).length;

    test('each GET is sent once, however many flags need it', async () => {
      const CY = pad('cy');
      routes = { ...withDm(), [`GET /channels/${CY}`]: () => ch(CY, 'other-a', T1) };
      await setup()('search_posts', { terms: `x in:only-a -in:town in:@bob in:${CX} in:${CY} in:only-a` });
      expect(count('GET /users/me/teams')).toBe(1);
      expect(count(`GET /channels/${CX}`)).toBe(1);
      expect(count(`GET /channels/${CY}`)).toBe(1);
      expect(count(`GET /teams/${T1}/channels/name/only-a`)).toBe(1);
      expect(count(`GET /teams/${T2}/channels/name/only-a`)).toBe(1);
    });

    test('a channel or group DM given by its ID looks up neither its team nor the other users, as only its ID is used', async () => {
      const GM = pad('gm');
      routes = { ...base(), [`GET /channels/${GM}`]: () => ch(GM, 'f'.repeat(40), '', 'G'), 'GET /users': () => [{ id: 'u1', username: 'me' }, { id: BOB, username: 'bob' }] };
      await setup()('search_posts', { terms: `x in:${GM} in:${CX}` });
      expect(sent()).toBe(`x in:${GM} in:${CX}`);
      expect(hits.filter((h) => (h.startsWith('GET /users') && h !== 'GET /users/me/teams') || h.startsWith('GET /teams/'))).toEqual([]);
    });

    test('a lookup that failed is not sent again either', async () => {
      routes = base();
      await setup()('search_posts', { terms: 'x in:only-a in:only-a' });
      expect(count(`GET /teams/${T2}/channels/name/only-a`)).toBe(1);
    });

    test('a POST is sent each time', async () => {
      const CAROL = pad('carol');
      const name = createHash('sha1').update(['u1', BOB, CAROL].sort().join('')).digest('hex');
      routes = {
        ...base(),
        'POST /users/usernames': () => [{ id: BOB, username: 'bob' }, { id: CAROL, username: 'carol' }],
        [`GET /teams/${T1}/channels/name/${name}`]: () => ch(pad('gm'), name, '', 'G'),
      };
      await setup()('search_posts', { terms: 'x -in:@bob,carol -in:@bob,carol' });
      expect(count('POST /users/usernames')).toBe(2);
    });

    test('nothing is kept for the next search', async () => {
      routes = base();
      const call = setup();
      await call('search_posts', { terms: 'x in:only-a' });
      await call('search_posts', { terms: 'y in:only-a' });
      expect(count('GET /users/me/teams')).toBe(2);
    });
  });

  test('takes up to 20 in: and channel: flags, and refuses 21 before looking anything up', async () => {
    routes = base();
    const call = setup();
    const twenty = [...Array(10).fill('in:only-a'), ...Array(9).fill('-in:town'), '-in: town'].join(' ');
    await call('search_posts', { terms: `x ${twenty}` });
    hits = [];
    expect(await call('search_posts', { terms: `x ${twenty} in:@bob ,carol` }, true)).toContain('in: と channel: は、-in: などの除外も含めて 1 回の検索で 20 個まで指定できます。in: が多いときは検索を分け、除外が多いときは数を減らしてください（除外は検索を分けると効きません）。');
    expect(hits).toEqual([]);
  });

  test('in:@ with no name says the user name is empty', async () => {
    routes = base();
    expect(await setup()('search_posts', { terms: 'x in:@' }, true)).toContain('ユーザー名が空です。');
  });

  test.each([
    ['x in:nowhere', 'チャンネル「nowhere」が見つかりません。'],
    ['x -in:nowhere', 'チャンネル「nowhere」が見つかりません。'],
    [`x in:${pad('zz')}`, `チャンネル「${pad('zz')}」が見つかりません。`],
    ['x in:team-a/nowhere', 'チャンネル「team-a/nowhere」が見つかりません。'],
    [`x in:${PV}`, `チャンネル「${PV}」が見つかりません。`],
    ['x in:team-a/private', 'チャンネル「team-a/private」が見つかりません。'],
    ['x in:@ghost', 'ユーザー「@ghost」が見つかりません。'],
    ['x -in:@ghost', 'ユーザー「@ghost」が見つかりません。'],
  ])('%j is an input error without searching', async (terms, message) => {
    routes = base();
    const out = await setup()('search_posts', { terms }, true);
    expect(out).toContain(message);
    expect(hits).not.toContain('POST /posts/search');
  });
});

test('search_posts looks up the names of the users who reacted, and notes a post whose message attachments were cut', async () => {
  const P = id(0);
  routes = {
    'POST /posts/search': () => ({ order: [P], posts: { [P]: {
      id: P, user_id: 'u1', channel_id: 'c'.repeat(26), root_id: '', message: '', create_at: 0,
      props: { attachments: [{ text: 'x'.repeat(4001) }] }, metadata: { reactions: [{ user_id: 'u2', emoji_name: '+1', create_at: 1 }] },
    } } }),
    'GET /users/me/channels': () => [{ id: 'c'.repeat(26), name: 'alerts', display_name: 'Alerts', team_id: 't'.repeat(26), type: 'O' }],
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
  };
  const out = await setup()('search_posts', { terms: 'x' });
  expect(bodies['/users/ids']).toEqual(['u1', 'u2']);
  expect(out).toContain('リアクション: :+1: 1（@bob）');
  expect(out).toContain('（本文かメッセージ添付を 4000 文字で切った投稿があります）');
});

test('search_users keeps a name and nickname with a line break on one line', async () => {
  routes = { 'POST /users/search': () => [{ id: 'u1', username: 'bob', first_name: 'Bo\nb', nickname: 'x\u2028y' }] };
  expect(await setup()('search_users', { query: 'bob' })).toContain('- @bob（名前: Bo b、ニックネーム: x y、user_id: u1）');
});

test('search_channels keeps a display name with a line break on one line, in the place of a group DM too', async () => {
  const T = 't'.repeat(26);
  routes = {
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    [`POST /teams/${T}/channels/search`]: () => [{ id: 'a'.repeat(26), type: 'O', name: 'town', display_name: 'To\nwn', team_id: T }],
    'GET /users/me/channels': () => [{ id: 'g'.repeat(26), type: 'G', name: 'gm', display_name: 'to\u2028wn', team_id: '' }],
  };
  const out = await setup()('search_channels', { query: 'to' });
  expect(out).toContain('- team-a/town（表示名: To wn、');
  expect(out).toContain('- to wn（表示名: to wn、');
});

test('search_channels looks up the partners of more than 1,000 DMs in calls of at most 1,000 ids, and matches a DM of either call', async () => {
  const partner = (i: number) => `p${String(i).padStart(25, '0')}`;
  const dms = Array.from({ length: 1001 }, (_, i) => ({ id: `d${String(i).padStart(25, '0')}`, type: 'D', name: `u1__${partner(i)}`, display_name: '', team_id: '' }));
  const asked: string[][] = [];
  routes = {
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    [`POST /teams/${'t'.repeat(26)}/channels/search`]: () => [],
    'GET /users/me/channels': () => dms,
    'POST /users/ids': () => { const ids = bodies['/users/ids'] as string[]; asked.push(ids); return ids.map((x) => ({ id: x, username: `name-${x}` })); },
  };
  const out = await setup()('search_channels', { query: `name-${partner(1000)}` });
  expect(asked.map((x) => x.length)).toEqual([1000, 1]);
  expect(out).toContain(`@name-${partner(1000)}`);
});

test('search_channels fails rather than leaving the DMs out when their partners cannot be read', async () => {
  routes = {
    'GET /users/me/teams': () => [{ id: 't'.repeat(26), name: 'team-a' }],
    [`POST /teams/${'t'.repeat(26)}/channels/search`]: () => [],
    'GET /users/me/channels': () => [{ id: 'd'.repeat(26), type: 'D', name: 'u1__u2', display_name: '', team_id: '' }],
    'POST /users/ids': () => new Response('oops', { status: 503 }),
  };
  expect(await setup()('search_channels', { query: 'bob' }, true)).toContain('Mattermost に一時的に接続できません');
});

test('search_users notes the 100-result cap', async () => {
  routes = { 'POST /users/search': () => Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, username: `user${i}` })) };
  const call = setup();
  expect(await call('search_users', { query: 'user' })).toContain('100 件まで');
});

describe('get_post', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const ROOT = 'r'.repeat(26);
  const REPLY = 'q'.repeat(26);
  const mmError = (status: number) => () => Response.json({ id: 'x', message: 'm', status_code: status }, { status });
  const post = (o: Record<string, unknown>) => ({ user_id: 'u1', channel_id: C, root_id: '', message: 'hello', create_at: 0, reply_count: 0, ...o });
  const base = {
    [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O' }),
    [`GET /teams/${T}`]: () => ({ id: T, name: 'team-b' }),
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  };

  test('reads a post from its permalink, with the channel and team, and builds the permalink from the post\'s own team', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, reply_count: 0 }) };
    const out = await setup()('get_post', { post: `https://mm.example/team-a/pl/${ROOT}` });
    expect(hits).toContain(`GET /posts/${ROOT}`);
    expect(out).toContain(`channel_id: ${C}`);
    expect(out).toContain(`team_id: ${T}`);
    expect(out).toContain('@alice');
    expect(out).toContain('hello');
    expect(out).toContain(`https://mm.example/team-b/pl/${ROOT}`);
    expect(out).toContain('返信数: 0');
    expect(out).not.toContain('read_thread');
  });

  test('notes at the end that the message was cut', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, message: 'x'.repeat(4001) }) };
    expect((await setup()('get_post', { post: ROOT })).split('\n').at(-1)).toBe(`（${BODY_CUT_NOTE}）`);
    expect(BODY_CUT_NOTE).toBe('本文を 4000 文字で切りました');
  });

  test('notes cut message attachments only where they were cut, not again at the end', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, message: '', props: { attachments: [{ text: 'x'.repeat(4001) }] } }) };
    const out = await setup()('get_post', { post: ROOT });
    expect(out.match(/切りました/g)).toHaveLength(1);
    expect(out).toContain('\n（メッセージ添付をここで切りました。続きは Mattermost の画面で確認してください）\n');
  });

  test('looks up exactly 1,000 users (the author and 999 reacting users) in one call to /users/ids', async () => {
    const reactions = Array.from({ length: 999 }, (_, i) => ({ user_id: `r${String(i).padStart(4, '0')}`, emoji_name: `e${String(Math.floor(i / 10)).padStart(2, '0')}`.slice(-2), create_at: i }));
    const asked: string[][] = [];
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, metadata: { reactions } }),
      'POST /users/ids': () => { const ids = bodies['/users/ids'] as string[]; asked.push(ids); return ids.map((x) => ({ id: x, username: `n${x}` })); } };
    await setup()('get_post', { post: ROOT });
    expect(asked.map((x) => x.length)).toEqual([1000]);
  });

  test('accepts a bare post_id', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT }) };
    expect(await setup()('get_post', { post: ROOT })).toContain(`post_id: ${ROOT}`);
  });

  test('for a reply, gives the parent post_id and points to read_thread', async () => {
    routes = { ...base, [`GET /posts/${REPLY}`]: () => post({ id: REPLY, root_id: ROOT, reply_count: 3 }) };
    const out = await setup()('get_post', { post: REPLY });
    expect(out).toContain(`親 post_id: ${ROOT}`);
    expect(out).toContain('read_thread');
  });

  test('for a root post with replies, gives the reply count and points to read_thread', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT, reply_count: 2 }) };
    const out = await setup()('get_post', { post: ROOT });
    expect(out).toContain('返信数: 2');
    expect(out).toContain('read_thread');
  });

  test('rejects a URL on another host without calling Mattermost', async () => {
    routes = { ...base };
    const out = await setup()('get_post', { post: `https://evil.example/team-a/pl/${ROOT}` }, true);
    expect(out).toContain('https://mm.example');
    expect(hits).toEqual([]);
  });

  test('turns 403 from GET /posts/{id} into a permission message', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: mmError(403) };
    expect(await setup()('get_post', { post: ROOT }, true)).toBe('この投稿を見る権限がありません（参加していない非公開チャンネルなど）。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。');
  });

  test('turns 404 from GET /posts/{id} into a not-found message', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: mmError(404) };
    expect(await setup()('get_post', { post: ROOT }, true)).toBe('投稿が見つかりません（削除されたか、存在しません）');
  });

  test('leaves a 403 from a later API call as the generic Mattermost error', async () => {
    routes = { ...base, [`GET /posts/${ROOT}`]: () => post({ id: ROOT }), [`GET /channels/${C}`]: mmError(403) };
    const out = await setup()('get_post', { post: ROOT }, true);
    expect(out).toContain('Mattermost がエラーを返しました（403）');
  });
});

describe('list_my_channels', () => {
  const T = 't'.repeat(26);
  const GONE = 'x'.repeat(26);
  const PUB = 'a'.repeat(26);
  const PRIV = 'b'.repeat(26);
  const TIE = 'c'.repeat(26);
  const DM = 'd'.repeat(26);
  const GM = 'g'.repeat(26);
  const ORPHAN = 'o'.repeat(26);
  const channels = () => [
    { id: GM, type: 'G', name: 'gm-name', display_name: 'alice, bob, carol', team_id: '', last_post_at: 0 },
    { id: ORPHAN, type: 'O', name: 'lost', display_name: 'Lost', team_id: GONE, last_post_at: 1000 },
    { id: TIE, type: 'O', name: 'tie', display_name: 'Tie', team_id: T, last_post_at: 2000 },
    { id: PRIV, type: 'P', name: 'secret', display_name: 'Secret', team_id: T, last_post_at: 2000 },
    { id: DM, type: 'D', name: 'u1__u2', display_name: '', team_id: '', last_post_at: 2500 },
    { id: PUB, type: 'O', name: 'town', display_name: 'Town', team_id: T, last_post_at: Date.UTC(2026, 9, 1, 20, 4, 5) },
  ];
  const base = () => ({
    'GET /users/me/channels': () => channels(),
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const order = (out: string) => [...out.matchAll(/channel_id: ([a-z]{26})/g)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('keeps a display name with a line break on one line, in the place of a group DM too', async () => {
    routes = { ...base(), 'GET /users/me/channels': () => [
      { id: PUB, type: 'O', name: 'town', display_name: 'To\nwn', team_id: T, last_post_at: 1 },
      { id: GM, type: 'G', name: 'gm-name', display_name: 'alice,\u2028bob', team_id: '', last_post_at: 0 },
    ] };
    const out = await setup()('list_my_channels', {});
    expect(out).toContain('- team-a/town（表示名: To wn、');
    expect(out).toContain('- alice, bob（表示名: alice, bob、');
  });

  test('still lists the channels, a DM by its partner\'s user_id, when the partners\' names cannot be read', async () => {
    routes = { ...base(), 'POST /users/ids': () => new Response('oops', { status: 503 }) };
    const out = await setup()('list_my_channels', {});
    expect(out).toContain(`channel_id: ${DM}`);
    expect(out).toContain('@u2');
    expect(out).toContain('- team-a/town');
  });

  test('lists every channel the user is in, newest post first (ties by channel_id), with team, name, kind, ids and the last post time', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(order(out)).toEqual([PUB, DM, PRIV, TIE, ORPHAN, GM]);
    expect(out).toContain(`- team-a/town（表示名: Town、種類: 公開、channel_id: ${PUB}、team_id: ${T}、最終投稿: 2026-10-01T20:04:05Z | 2026-10-02T05:04:05+09:00）`);
    expect(out).toContain(`- team-a/secret（表示名: Secret、種類: 非公開、channel_id: ${PRIV}`);
    expect(out).toContain('（続きはありません）');
    expect(urls).toContain('GET /users/me/channels');
  });

  test('names a DM by the other user and a group DM by its display name, without a team', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(bodies['/users/ids']).toEqual(['u2']);
    expect(out).toContain(`- @bob（表示名: @bob、種類: DM、channel_id: ${DM}、最終投稿:`);
    expect(out).toContain(`- alice, bob, carol（表示名: alice, bob, carol、種類: グループ DM、channel_id: ${GM}、最終投稿: 投稿なし）`);
  });

  test('shows only the team_id when the team name cannot be looked up', async () => {
    routes = base();
    const out = await setup()('list_my_channels', {});
    expect(out).toContain(`- lost（表示名: Lost、種類: 公開、channel_id: ${ORPHAN}、team_id: ${GONE}、最終投稿:`);
  });

  test('filters by types', async () => {
    routes = base();
    const call = setup();
    expect(order(await call('list_my_channels', { types: ['private'] }))).toEqual([PRIV]);
    expect(order(await call('list_my_channels', { types: ['dm', 'group_dm'] }))).toEqual([DM, GM]);
    expect(hits.filter((h) => h === 'POST /users/ids')).toHaveLength(1);
  });

  test('a cursor keeps the types and the page size of the first call, ignoring the arguments', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { types: ['public'], limit: 1 });
    expect(order(first)).toEqual([PUB]);
    const second = await call('list_my_channels', { types: ['dm'], limit: 50, cursor: cursorIn(first) });
    expect(order(second)).toEqual([TIE]);
    const third = await call('list_my_channels', { cursor: cursorIn(second) });
    expect(order(third)).toEqual([ORPHAN]);
    expect(cursorIn(third)).toBeUndefined();
  });

  test('a later page first lists the channels updated since the previous page', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { limit: 2 });
    const now = Date.now();
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === TIE ? { ...c, last_post_at: now } : c));
    const second = await call('list_my_channels', { cursor: cursorIn(first) });
    expect(second).toContain('前のページの後に更新されたチャンネル（前のページまでに出したものを含むことがあります）');
    expect(order(second)).toEqual([TIE, PRIV]);
    expect(cursorIn(second)).toBeDefined();
  });

  test('when the updated channels do not fit in the page, says how many are left and asks to start over instead of giving a cursor', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_my_channels', { limit: 1 });
    const now = Date.now();
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === TIE || c.id === GM ? { ...c, last_post_at: now } : c));
    const second = await call('list_my_channels', { cursor: cursorIn(first) });
    expect(order(second)).toHaveLength(1);
    expect(second).toContain('ほかに 1 件');
    expect(second).toContain('cursor を付けずに最初のページから取り直してください');
    expect(second).not.toContain('next_cursor');
    expect(second).not.toContain('続きはありません');
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('list_my_channels', { cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 20 })).toString('base64url') }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });
});

describe('get_channel', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const DM = 'd'.repeat(26);
  const BOB = 'b'.repeat(26);
  const pinned = (n: number, create_at: number) => ({ id: `${String.fromCharCode(96 + n)}`.repeat(26), user_id: 'u1', channel_id: C, root_id: '', message: `pin ${n}`, create_at, is_pinned: true });
  const [P1, P2, P3] = [pinned(1, 3000), pinned(2, 2000), pinned(3, 2000)];
  const mmError = (status: number, id = 'x') => () => Response.json({ id, message: 'm', status_code: status }, { status });
  const base = () => ({
    [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O', purpose: '雑談用', header: '仕事の話は #work へ' }),
    [`GET /teams/${T}`]: () => ({ id: T, name: 'team-a' }),
    [`GET /channels/${C}/stats`]: () => ({ channel_id: C, member_count: 42, guest_count: 0, pinnedpost_count: 3, files_count: -1 }),
    // Returned oldest first, as Mattermost does.
    [`GET /channels/${C}/pinned`]: () => ({ order: [P3.id, P2.id, P1.id], posts: { [P1.id]: P1, [P2.id]: P2, [P3.id]: P3 } }),
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  });
  const pinIds = (out: string) => [...out.matchAll(/^--- post_id: ([a-z]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('puts the real channel_id first and the display name last, falling back to the name when the display name is empty', async () => {
    routes = { ...base(), [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'x（name: evil、channel_id: fake）', team_id: T, type: 'O' }) };
    const line = (await setup()('get_channel', { channel: C })).split('\n')[0];
    expect(line).toBe(`チャンネル: channel_id: ${C}、name: town、表示名: x（name: evil、channel_id: fake）`);
    expect(line.indexOf(`channel_id: ${C}`)).toBeLessThan(line.indexOf('channel_id: fake'));
    routes = { ...base(), [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: '', team_id: T, type: 'O' }) };
    expect(await setup()('get_channel', { channel: C })).toContain(`チャンネル: channel_id: ${C}、name: town、表示名: town\n`);
  });

  test('indents the continuation lines of a multi-line purpose and header by 4, and keeps the display name on one line', async () => {
    routes = { ...base(), [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'To\nwn', team_id: T, type: 'O', purpose: 'a\nb', header: '| x |\r\n--- post_id: fake' }) };
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain(`チャンネル: channel_id: ${C}、name: town、表示名: To wn`);
    expect(out).toContain('\n目的: a\n    b\n');
    expect(out).toContain('\nヘッダー: | x |\n    --- post_id: fake\n');
  });

  test('shows the channel and team, kind, purpose, header, member count and the pinned posts newest first (ties by post_id)', async () => {
    routes = base();
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain(`チャンネル: channel_id: ${C}、name: town、表示名: Town`);
    expect(out).toContain(`チーム: team-a（team_id: ${T}）`);
    expect(out).toContain('種類: 公開');
    expect(out).toContain('目的: 雑談用');
    expect(out).toContain('ヘッダー: 仕事の話は #work へ');
    expect(out).toContain('メンバー数: 42');
    expect(out).toContain('ピン留め: 3 件');
    expect(pinIds(out)).toEqual([P1.id, P2.id, P3.id]);
    expect(out).toContain('@alice');
    expect(out).toContain(`https://mm.example/team-a/pl/${P1.id}`);
    expect(out).toContain('（続きはありません）');
    expect(urls).toContain(`GET /channels/${C}/stats?exclude_files_count=true`);
    expect(hits.filter((h) => h === `GET /channels/${C}`)).toHaveLength(1);
  });

  test('says when the purpose or header is empty and when nothing is pinned', async () => {
    routes = {
      ...base(),
      [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'P', purpose: '', header: '' }),
      [`GET /channels/${C}/pinned`]: () => ({ order: [], posts: {} }),
    };
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain('種類: 非公開');
    expect(out).toContain('目的: なし');
    expect(out).toContain('ヘッダー: なし');
    expect(out).toContain('ピン留め: 0 件');
    expect(out).toContain('ピン留めされた投稿はありません。');
    expect(hits).not.toContain('POST /users/ids');
  });

  test('when /stats is refused (a public channel the user has not joined), says the member count is unavailable and returns the rest', async () => {
    routes = { ...base(), [`GET /channels/${C}/stats`]: mmError(403) };
    const out = await setup()('get_channel', { channel: C });
    expect(out).toContain('メンバー数: 取得できません（参加していないか、一時的な障害か、権限の設定）');
    expect(out).toContain('目的: 雑談用');
    expect(pinIds(out)).toEqual([P1.id, P2.id, P3.id]);
  });

  test('pages through the pinned posts with pinned_limit; a cursor gives only the rest of the pinned posts', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_channel', { channel: C, pinned_limit: 2 });
    expect(pinIds(first)).toEqual([P1.id, P2.id]);
    expect(first).toContain('ピン留め: 3 件');
    hits = [];
    const second = await call('get_channel', { channel: C, pinned_limit: 50, cursor: cursorIn(first) });
    expect(pinIds(second)).toEqual([P3.id]);
    expect(second).toContain(`channel_id: ${C}`);
    expect(second).not.toContain('目的');
    expect(second).not.toContain('メンバー数');
    expect(second).toContain('（続きはありません）');
    expect(hits).not.toContain(`GET /channels/${C}/stats`);
  });

  test('rejects a cursor issued for another channel', async () => {
    routes = { ...base(), [`GET /channels/${OTHER}`]: () => ({ id: OTHER, name: 'other', display_name: 'Other', team_id: T, type: 'O', purpose: '', header: '' }) };
    const call = setup();
    const first = await call('get_channel', { channel: C, pinned_limit: 1 });
    const out = await call('get_channel', { channel: OTHER, cursor: cursorIn(first) }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });

  test('shows a DM given as @username with its kind', async () => {
    const name = [BOB, 'u1'].sort().join('__');
    routes = {
      ...base(),
      'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
      'GET /users/username/bob': () => ({ id: BOB, username: 'bob' }),
      [`GET /teams/${T}/channels/name/${name}`]: () => ({ id: DM, name, display_name: '', team_id: '', type: 'D', purpose: '', header: '' }),
      [`GET /channels/${DM}/stats`]: () => ({ channel_id: DM, member_count: 2 }),
      [`GET /channels/${DM}/pinned`]: () => ({ order: [], posts: {} }),
    };
    const out = await setup()('get_channel', { channel: '@bob' });
    expect(out).toContain(`チャンネル: channel_id: ${DM}、name: ${name}、表示名: @bob`);
    expect(out).toContain('種類: DM');
    expect(out).toContain('メンバー数: 2');
    expect(hits).not.toContain(`GET /channels/${DM}`);
  });

  test('turns 403 from fetching the channel into a permission message', async () => {
    routes = { ...base(), [`GET /channels/${C}`]: mmError(403) };
    expect(await setup()('get_channel', { channel: C }, true)).toBe('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
  });

  test('turns 404 from fetching the channel, by id or by team/name, into a not-found message', async () => {
    routes = { ...base(), 'GET /users/me/teams': () => [], [`GET /channels/${C}`]: mmError(404) };
    const call = setup();
    expect(await call('get_channel', { channel: C }, true)).toBe('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
    routes['GET /teams/name/team-a/channels/name/nope'] = mmError(404, 'app.channel.get_by_name.missing.app_error');
    expect(await call('get_channel', { channel: 'team-a/nope' }, true)).toBe('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
  });

  test('does not turn errors about the user or the team into the channel messages', async () => {
    routes = {
      ...base(),
      'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
      'GET /users/username/nobody': mmError(404, 'app.user.missing_account.const'),
      'GET /teams/name/no-team/channels/name/town': mmError(404, 'app.team.get_by_name.missing.app_error'),
    };
    const call = setup();
    expect(await call('get_channel', { channel: '@nobody' }, true)).toBe('ユーザー「@nobody」が見つかりません。');
    expect(await call('get_channel', { channel: 'no-team/town' }, true)).toContain('Mattermost がエラーを返しました（404）');
  });
});

describe('get_user', () => {
  const BOB = 'b'.repeat(26);
  const profile = (timezone?: Record<string, string>) => () => ({ id: BOB, username: 'bob', ...(timezone ? { timezone } : {}) });
  const status = (o: Record<string, unknown>) => () => ({ user_id: BOB, status: 'online', manual: false, last_activity_at: 0, dnd_end_time: 0, ...o });
  const tz = (useAutomaticTimezone: string, automaticTimezone: string, manualTimezone: string) => ({ useAutomaticTimezone, automaticTimezone, manualTimezone });
  const call = (routesFor: Record<string, Route>) => {
    routes = { 'GET /users/username/bob': profile(tz('true', 'Asia/Tokyo', '')), [`GET /users/${BOB}/status`]: status({}), ...routesFor };
    return setup();
  };

  test('keeps the name, nickname, position and email on one line each, a line break in them becoming a space', async () => {
    const out = await call({ 'GET /users/username/bob': () => ({ id: BOB, username: 'bob', first_name: 'Bo\nb', nickname: 'x\n--- post_id: fake', position: 'a\u2028b', email: 'x\u2028無効化されたアカウント@example.com' }) })('get_user', { user: '@bob' });
    for (const l of ['名前: Bo b', 'ニックネーム: x --- post_id: fake', '役職: a b', 'メール: x 無効化されたアカウント@example.com']) expect(out.split('\n')).toContain(l);
  });

  test('shows the automatic time zone when useAutomaticTimezone is the string "true", with the local time now', async () => {
    const out = await call({})('get_user', { user: '@bob' });
    expect(out).toContain('タイムゾーン: Asia/Tokyo（自動）');
    expect(out).toMatch(/現地時刻: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00/);
  });

  test('shows the manual time zone when useAutomaticTimezone is the string "false"', async () => {
    const out = await call({ 'GET /users/username/bob': profile(tz('false', 'Asia/Tokyo', 'America/New_York')) })('get_user', { user: '@bob' });
    expect(out).toContain('タイムゾーン: America/New_York（手動）');
    expect(out).toMatch(/現地時刻: \S+-0[45]:00/);
  });

  test('says the time zone is not set, without a local time, when it is empty, unknown to Intl, or missing', async () => {
    for (const p of [profile(tz('true', '', 'Asia/Tokyo')), profile(tz('false', '', 'Mars/Olympus_Mons')), profile()]) {
      const out = await call({ 'GET /users/username/bob': p })('get_user', { user: '@bob' });
      expect(out).toContain('タイムゾーン: 未設定');
      expect(out).not.toContain('現地時刻');
    }
  });

  test('shows each presence status in Japanese', async () => {
    const names = { online: 'オンライン', away: '離席', dnd: '取り込み中', offline: 'オフライン', ooo: '不在' };
    for (const [s, ja] of Object.entries(names)) {
      const out = await call({ [`GET /users/${BOB}/status`]: status({ status: s }) })('get_user', { user: '@bob' });
      expect(out, s).toContain(`在席: ${ja}`);
    }
  });

  test('adds the end of do-not-disturb in UTC and JST only while dnd has an end time', async () => {
    const end = Date.UTC(2026, 10, 1, 20, 4, 0) / 1000;
    const until = await call({ [`GET /users/${BOB}/status`]: status({ status: 'dnd', manual: true, dnd_end_time: end }) })('get_user', { user: '@bob' });
    expect(until).toContain('在席: 取り込み中（終了: 2026-11-01T20:04:00Z | 2026-11-02T05:04:00+09:00）（手動で設定）');
    const open = await call({ [`GET /users/${BOB}/status`]: status({ status: 'dnd', dnd_end_time: 0 }) })('get_user', { user: '@bob' });
    expect(open).toMatch(/在席: 取り込み中$/m);
    const stale = await call({ [`GET /users/${BOB}/status`]: status({ status: 'away', dnd_end_time: end }) })('get_user', { user: '@bob' });
    expect(stale).toMatch(/在席: 離席$/m);
  });

  test('says when the status was set by hand', async () => {
    const out = await call({ [`GET /users/${BOB}/status`]: status({ status: 'away', manual: true }) })('get_user', { user: '@bob' });
    expect(out).toContain('在席: 離席（手動で設定）');
  });

  test('still returns the profile when the status API answers with a Mattermost error', async () => {
    const out = await call({ [`GET /users/${BOB}/status`]: () => Response.json({ id: 'x', message: 'm' }, { status: 403 }) })('get_user', { user: '@bob' });
    expect(out).toContain('username: @bob');
    expect(out).toContain('在席: 取得できませんでした');
  });

  test('fails the tool when the status API is rate limited, unavailable, or needs re-authorization', async () => {
    const cases: Route[] = [
      () => new Response(null, { status: 429, headers: { 'x-ratelimit-reset': '7' } }),
      () => new Response('oops', { status: 503 }),
      () => Response.json({ id: 'api.context.session_expired.app_error' }, { status: 401 }),
    ];
    for (const r of cases) {
      const out = await call({ [`GET /users/${BOB}/status`]: r })('get_user', { user: '@bob' }, true);
      expect(out).not.toContain('username:');
    }
  });

  test('calls the status API after the profile, with the resolved user id', async () => {
    await call({})('get_user', { user: '@bob' });
    expect(hits).toEqual(['GET /users/username/bob', `GET /users/${BOB}/status`]);
  });
});

describe('get_unreads', () => {
  const T1 = '1'.repeat(26);
  const T2 = '2'.repeat(26);
  const QUIET = 'a'.repeat(26);
  const OLD = 'b'.repeat(26);
  const NEW = 'c'.repeat(26);
  const MENTIONED = 'd'.repeat(26);
  const MUTED = 'e'.repeat(26);
  const MUTED_MENTION = 'f'.repeat(26);
  const DM = 'g'.repeat(26);
  const ARCHIVED = 'h'.repeat(26);
  const TH1 = 'k'.repeat(26);
  const TH2 = 'm'.repeat(26);
  const TH_DM = 'n'.repeat(26);
  const ch = (id: string, name: string, o: Record<string, unknown>) => ({
    id, name, display_name: name.toUpperCase(), team_id: T1, type: 'O', last_post_at: 0, last_root_post_at: 0, total_msg_count: 0, total_msg_count_root: 0, ...o,
  });
  const channels = () => [
    ch(QUIET, 'quiet', { total_msg_count: 5, total_msg_count_root: 5, last_post_at: 9000, last_root_post_at: 9000 }),
    ch(OLD, 'old', { total_msg_count: 10, total_msg_count_root: 6, last_post_at: 8000, last_root_post_at: 1000 }),
    ch(NEW, 'new', { team_id: T2, total_msg_count: 4, total_msg_count_root: 3, last_post_at: 3000, last_root_post_at: 2000 }),
    ch(MENTIONED, 'mentioned', { total_msg_count: 2, total_msg_count_root: 2, last_post_at: 500, last_root_post_at: 500 }),
    ch(MUTED, 'muted', { total_msg_count: 3, total_msg_count_root: 3, last_post_at: 7000, last_root_post_at: 7000 }),
    ch(MUTED_MENTION, 'muted-mention', { total_msg_count: 3, total_msg_count_root: 3, last_post_at: 600, last_root_post_at: 600 }),
    ch(DM, 'u1__u2', { team_id: '', type: 'D', display_name: '', total_msg_count: 1, total_msg_count_root: 1, last_post_at: 400, last_root_post_at: 400 }),
  ];
  const mem = (channel_id: string, o: Record<string, unknown> = {}) => ({
    channel_id, msg_count: 0, msg_count_root: 0, mention_count: 0, mention_count_root: 0, notify_props: { mark_unread: 'all' }, ...o,
  });
  const members = () => [
    mem(QUIET, { msg_count: 5, msg_count_root: 5 }),
    mem(OLD, { msg_count: 7, msg_count_root: 4, mention_count: 1 }),
    mem(NEW, { msg_count: 2, msg_count_root: 1 }),
    mem(MENTIONED, { msg_count: 1, msg_count_root: 1, mention_count: 1, mention_count_root: 1 }),
    mem(MUTED, { notify_props: { mark_unread: 'mention' } }),
    mem(MUTED_MENTION, { msg_count: 2, msg_count_root: 2, mention_count: 1, notify_props: { mark_unread: 'mention' } }),
    mem(DM, { mention_count: 1, mention_count_root: 1 }),
    mem(ARCHIVED, { msg_count: 0, mention_count: 3 }),
  ];
  const thread = (id: string, channel_id: string, last_reply_at: number, o: Record<string, unknown> = {}) => ({
    id, last_reply_at, reply_count: 3, unread_replies: 2, unread_mentions: 0,
    post: { id, user_id: 'u2', channel_id, root_id: '', message: `root ${id[0]}`, create_at: 100 }, ...o,
  });
  const threadPage = (threads: unknown[], total = threads.length) => ({ total: 999, total_unread_threads: total, total_unread_mentions: 0, threads });
  const pref = (value?: string) => () => (value ? { user_id: 'u1', category: 'display_settings', name: 'collapsed_reply_threads', value }
    : Response.json({ id: 'app.preference.get.app_error', message: 'm', status_code: 400 }, { status: 400 }));
  const base = (crt = 'always_on'): Record<string, Route> => ({
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    'GET /users/me/channels': () => channels(),
    'GET /users/me/channel_members': () => members(),
    'GET /users/me/teams': () => [{ id: T1, name: 'team-a' }, { id: T2, name: 'team-b' }],
    [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH1, OLD, 5000, { unread_mentions: 1 }), thread(TH_DM, DM, 4000)]),
    [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([thread(TH2, NEW, 6000), thread(TH_DM, DM, 4000)]),
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const order = (out: string) => [...out.matchAll(/^(?:- .*?channel_id: |--- post_id: )([a-z0-9]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('decides whether collapsed reply threads apply from the server setting and, for default_on/default_off only, the user\'s preference', async () => {
    const cases: [string, string | undefined, string][] = [
      ['always_on', undefined, '有効（サーバー設定: always_on）'],
      ['disabled', undefined, '無効（サーバー設定: disabled）'],
      ['default_on', undefined, '有効（サーバー設定: default_on、利用者の設定: なし）'],
      ['default_off', undefined, '無効（サーバー設定: default_off、利用者の設定: なし）'],
      ['default_on', 'off', '無効（サーバー設定: default_on、利用者の設定: off）'],
      ['default_off', 'on', '有効（サーバー設定: default_off、利用者の設定: on）'],
    ];
    for (const [server, user, expected] of cases) {
      routes = { ...base(server), 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': pref(user) };
      hits = [];
      urls = [];
      const out = await setup()('get_unreads', {});
      expect(out.split('\n')[0], `${server}/${user}`).toBe(`スレッドの折りたたみ（CRT）: ${expected}`);
      expect(hits.includes('GET /users/me/preferences/display_settings/name/collapsed_reply_threads'), server).toBe(server.startsWith('default_'));
      expect(urls).toContain('GET /config/client?format=old');
      expect(hits.some((h) => h.includes('/threads')), server).toBe(expected.startsWith('有効'));
    }
  });

  test('looks up the users of unread threads in calls of at most 1,000 ids, and names the users of every call', async () => {
    const user = (i: number, j: number) => `r${String(i * 20 + j).padStart(4, '0')}`;
    const many = Array.from({ length: 50 }, (_, i) => thread(`t${String(i).padStart(25, '0')}`, OLD, 9000 - i, {
      post: { id: `t${String(i).padStart(25, '0')}`, user_id: `a${i}`, channel_id: OLD, root_id: '', message: `m${i}`, create_at: 100,
        metadata: { reactions: Array.from({ length: 20 }, (_, j) => ({ user_id: user(i, j), emoji_name: j < 10 ? 'x' : 'y', create_at: j })) } },
    }));
    const asked: string[][] = [];
    routes = {
      ...base(),
      [`GET /users/u1/teams/${T1}/threads`]: () => threadPage(many),
      [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]),
      'POST /users/ids': () => { const ids = bodies['/users/ids'] as string[]; asked.push(ids); return ids.map((x) => ({ id: x, username: `n${x}` })); },
    };
    const out = await setup()('get_unreads', { limit: 100 });
    expect(asked.map((x) => x.length)).toEqual([1000, 51]);
    for (const x of asked[1]) expect(out).toContain(`@n${x}`);
  });

  test('keeps a channel\'s display name with a line break on one line', async () => {
    routes = { ...base(), 'GET /users/me/channels': () => channels().map((x) => (x.id === OLD ? { ...x, display_name: 'O\nLD' } : x)) };
    expect(await setup()('get_unreads', {})).toContain(`- team-a/old（表示名: O LD、channel_id: ${OLD}`);
  });

  test('with CRT on, counts root posts only, puts channels with mentions first, then newest root post first, and hides read, archived and mention-only channels without mentions', async () => {
    routes = base();
    const out = await setup()('get_unreads', {});
    expect(order(out).slice(0, 4)).toEqual([MENTIONED, DM, NEW, OLD]);
    expect(out).toContain(`- team-a/mentioned（表示名: MENTIONED、channel_id: ${MENTIONED}、team_id: ${T1}）未読: 1、メンション: 1、最終のルート投稿: ${'1970-01-01T00:00:00Z | 1970-01-01T09:00:00+09:00'}`);
    expect(out).toContain(`- team-a/old（表示名: OLD、channel_id: ${OLD}、team_id: ${T1}）未読: 2、メンション: 0、最終のルート投稿:`);
    expect(out).toContain(`- @bob（表示名: @bob、channel_id: ${DM}）未読: 1、メンション: 1`);
    for (const hidden of [QUIET, MUTED, ARCHIVED]) expect(out).not.toContain(hidden);
    expect(out).not.toContain(`channel_id: ${MUTED_MENTION}`);
  });

  test('a mention-only channel is shown when it has a mention', async () => {
    routes = { ...base('disabled') };
    const out = await setup()('get_unreads', {});
    expect(out).toContain(`channel_id: ${MUTED_MENTION}`);
    expect(out).not.toContain(`channel_id: ${MUTED}`);
  });

  test('with CRT off, counts replies too, orders by the last post, and does not ask for threads', async () => {
    routes = base('disabled');
    const out = await setup()('get_unreads', {});
    expect(order(out)).toEqual([OLD, MUTED_MENTION, MENTIONED, DM, NEW]);
    expect(out).toContain(`channel_id: ${OLD}、team_id: ${T1}）未読: 3、メンション: 1、最終投稿:`);
    expect(out).toContain('- team-b/new');
    expect(hits.some((h) => h.includes('/threads'))).toBe(false);
    expect(out).toContain('未読のあるチャンネル: 5 件');
  });

  test('pages through channel_members 200 at a time until a short page', async () => {
    const many = Array.from({ length: 200 }, (_, i) => mem(`z${String(i).padStart(25, '0')}`));
    routes = { ...base(), 'GET /users/me/channel_members': (req) => (new URL(req.url).searchParams.get('page') === '0' ? many : members()) };
    const out = await setup()('get_unreads', {});
    expect(urls.filter((u) => u.startsWith('GET /users/me/channel_members'))).toEqual([
      'GET /users/me/channel_members?page=0&per_page=200', 'GET /users/me/channel_members?page=1&per_page=200',
    ]);
    expect(out).toContain(`channel_id: ${MENTIONED}`);
  });

  test('lists unread threads newest reply first after the channels, taking DM threads from the first team only and counting a thread once', async () => {
    routes = base();
    const out = await setup()('get_unreads', {});
    expect(urls).toContain(`GET /users/u1/teams/${T1}/threads?unread=true&per_page=50`);
    expect(urls).toContain(`GET /users/u1/teams/${T2}/threads?unread=true&per_page=50&excludeDirect=true`);
    expect(order(out).slice(-3)).toEqual([TH2, TH1, TH_DM]);
    expect(out.match(new RegExp(`post_id: ${TH_DM}`, 'g'))).toHaveLength(1);
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 3 件');
    expect(out).toContain(`--- post_id: ${TH1}\n@bob | `);
    expect(out).toContain(`https://mm.example/team-a/pl/${TH1}`);
    expect(out).toContain(`https://mm.example/team-b/pl/${TH2}`);
    expect(out).toContain('未読の返信: 2、未読のメンション: 1、最終返信: 1970-01-01T00:00:05Z | 1970-01-01T09:00:05+09:00');
    expect(out.indexOf(`post_id: ${TH2}`)).toBeGreaterThan(out.indexOf(`channel_id: ${OLD}`));
  });

  test('leaves out unread threads in channels that /users/me/channels does not list (archived ones) and does not count them', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([thread(TH2, ARCHIVED, 6000), thread(TH_DM, DM, 4000)]) };
    const out = await setup()('get_unreads', {});
    expect(out).not.toContain(TH2);
    expect(out).not.toContain(ARCHIVED);
    expect(order(out).slice(-2)).toEqual([TH1, TH_DM]);
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 2 件');
    expect(out).not.toContain('取り切れませんでした');
  });

  describe('when fewer threads come back than total_unread_threads', () => {
    const h = (k: number) => thread(`h${String(k).padStart(25, '0')}`, OLD, 9000 - k);
    const span = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => h(from + k));
    // Pages in the order given, whatever before= says: each call stands for what Mattermost answered after something changed in between.
    const pages = (...ps: [unknown[], number][]) => {
      let k = 0;
      return () => threadPage(...(ps[k++] ?? [[], 0]));
    };
    const run = async (...ps: [unknown[], number][]) => {
      routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: pages(...ps), [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
      return setup()('get_unreads', { limit: 100 });
    };
    const SHORT = 'の未読スレッドを total_unread_threads:';

    test('a later page with nothing, as when the thread paged from is deleted, says the threads were not all taken, against the largest total', async () => {
      const out = await run([span(0, 50), 60], [[], 59]);
      expect(out).toContain('team-a の未読スレッドを total_unread_threads: 60 に対して取り切れませんでした。');
      // The last total alone would match the 50 taken here: the deleted thread no longer counts.
      expect(await run([span(0, 50), 51], [[], 50])).toContain(SHORT);
    });

    test('counts each thread once, so pages repeating the threads at their edge do not make up the total', async () => {
      const out = await run([span(0, 50), 100], [span(49, 99), 100], [[], 100]);
      expect(out).toContain(SHORT);
    });

    test('a short page that skipped threads, as when a reply of the thread paged from is deleted, says so too', async () => {
      const out = await run([span(0, 50), 70], [span(50, 60), 70]);
      expect(out).toContain(SHORT);
    });

    test('a short first page below total, as when total also counts threads whose root post a retention policy removed, says such threads cannot be taken by calling again', async () => {
      expect(await run([span(0, 10), 11])).toContain('データ保持ポリシーで根の投稿が消えたスレッドは、呼び直しても取得できません）');
    });

    test('says nothing when every thread was taken, also when the 4th page is full', async () => {
      expect(await run([span(0, 50), 80], [span(50, 80), 80])).not.toContain(SHORT);
      const full = await run([span(0, 50), 200], [span(50, 100), 200], [span(100, 150), 200], [span(150, 200), 200]);
      expect(full).not.toContain(SHORT);
      expect(full).not.toContain('打ち切りました');
    });
  });

  test('follows a team\'s unread threads with before= for at most 4 pages, then says it stopped and gives total_unread_threads', async () => {
    let n = 0;
    const full = () => threadPage(Array.from({ length: 50 }, () => thread(`t${String(n++).padStart(25, '0')}`, OLD, 5000)), 321);
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: full, [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
    const out = await setup()('get_unreads', { limit: 100 });
    const t1 = urls.filter((u) => u.includes(`/teams/${T1}/threads`));
    expect(t1).toHaveLength(4);
    expect(t1[1]).toBe(`GET /users/u1/teams/${T1}/threads?unread=true&per_page=50&before=t${String(49).padStart(25, '0')}`);
    expect(out).toContain('team-a の未読スレッドは、50 件ずつ 4 回の取得で打ち切りました。境目と同じ時刻のスレッドは取り直すので、取得した異なるスレッドは 200 件より少ないことがあります（total_unread_threads: 321）');
  });

  test('takes again the threads whose last reply is at the same millisecond as the last thread of a page, so none of them drops out', async () => {
    // Like Mattermost: newest reply first, before= by last_reply_at strictly earlier; ties come in no set order, here by id descending.
    const at = (k: number) => (k < 47 ? 9000 - k : k === 47 ? 5001 : k <= 50 ? 5000 : 4000);
    const all = Array.from({ length: 52 }, (_, k) => thread(`h${String(k).padStart(25, '0')}`, OLD, at(k)))
      .sort((a, b) => b.last_reply_at - a.last_reply_at || (a.id < b.id ? 1 : -1));
    const listed = (req: Request) => {
      const before = new URL(req.url).searchParams.get('before');
      const edge = before ? all.find((x) => x.id === before)!.last_reply_at : Infinity;
      return threadPage(all.filter((x) => x.last_reply_at < edge).slice(0, 50));
    };
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: listed, [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
    const out = await setup()('get_unreads', { limit: 100 });
    const t1 = urls.filter((u) => u.includes(`/teams/${T1}/threads`));
    expect(t1).toHaveLength(2);
    expect(new URLSearchParams(t1[1].split('?')[1]).get('before')).toBe(`h${String(47).padStart(25, '0')}`);
    for (const x of all) expect(out).toContain(x.id);
  });

  test('when the threads API answers 4xx, returns the channel unreads and says the threads could not be fetched', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T2}/threads`]: () => Response.json({ id: 'x', message: 'nope' }, { status: 403 }) };
    const out = await setup()('get_unreads', {});
    expect(out).toContain(`channel_id: ${MENTIONED}`);
    expect(out).not.toContain(`post_id: ${TH1}`);
    expect(out).toContain('未読のスレッドを取得できませんでした');
  });

  test('when the threads API answers 4xx after a team hit the 4-page cap, drops that cap note and says the thread count is unavailable', async () => {
    let n = 0;
    const full = () => threadPage(Array.from({ length: 50 }, () => thread(`t${String(n++).padStart(25, '0')}`, OLD, 5000)), 321);
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: full, [`GET /users/u1/teams/${T2}/threads`]: () => Response.json({ id: 'x', message: 'nope' }, { status: 403 }) };
    const out = await setup()('get_unreads', {});
    // Not matching the note's wording: in this output total_unread_threads appears only in the cap note, the marker the test "...for at most 4 pages..." also checks.
    expect(out).not.toContain('total_unread_threads');
    expect(out).toContain('未読のあるチャンネル: 4 件、未読のスレッド: 取得できませんでした');
    expect(out).toContain('未読のスレッドを取得できませんでした');
  });

  test('when the threads API fails otherwise, the tool fails', async () => {
    routes = { ...base(), [`GET /users/u1/teams/${T1}/threads`]: () => new Response('oops', { status: 503 }) };
    const out = await setup()('get_unreads', {}, true);
    expect(out).not.toContain('channel_id');
  });

  test('names the DM of a DM thread by the other user', async () => {
    routes = {
      ...base(),
      'GET /users/me/channel_members': () => members().filter((m) => m.channel_id !== DM),
      [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH_DM, DM, 4000, { post: { id: TH_DM, user_id: 'u1', channel_id: DM, root_id: '', message: 'mine', create_at: 100 } })]),
      [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]),
      'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }].filter((u) => (bodies['/users/ids'] as string[]).includes(u.id)),
    };
    const out = await setup()('get_unreads', {});
    // The team before the channel on the joined line, so the display name comes last.
    expect(out).toContain(`チーム: なし（DM またはグループ DM） | チャンネル: channel_id: ${DM}、name: u1__u2、表示名: @bob`);
  });

  test('names the users who reacted to a thread root when the threads API gives the reactions', async () => {
    routes = {
      ...base(),
      'GET /users/me/channel_members': () => members().filter((m) => m.channel_id !== DM),
      [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH_DM, DM, 4000, { post: {
        id: TH_DM, user_id: 'u1', channel_id: DM, root_id: '', message: 'mine', create_at: 100, metadata: { reactions: [{ user_id: 'u3', emoji_name: 'eyes', create_at: 1 }] },
      } })]),
      [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]),
      'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }, { id: 'u3', username: 'carol' }],
    };
    const out = await setup()('get_unreads', {});
    expect(bodies['/users/ids']).toContain('u3');
    expect(out).toContain('リアクション: :eyes: 1（@carol）');
  });

  test('says that a thread root has reactions when the threads API gives only has_reactions', async () => {
    routes = {
      ...base(),
      'GET /users/me/channel_members': () => members().filter((m) => m.channel_id !== DM),
      [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([thread(TH_DM, DM, 4000, { post: {
        id: TH_DM, user_id: 'u1', channel_id: DM, root_id: '', message: 'mine', create_at: 100, has_reactions: true,
      } })]),
      [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]),
      'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
    };
    const out = await setup()('get_unreads', {});
    expect([...(bodies['/users/ids'] as string[])].sort()).toEqual(['u1', 'u2']);
    expect(out).toContain('リアクションあり（get_post で確認できます）');
  });

  test('says when there is nothing unread', async () => {
    routes = { ...base(), 'GET /users/me/channel_members': () => [], [`GET /users/u1/teams/${T1}/threads`]: () => threadPage([]), [`GET /users/u1/teams/${T2}/threads`]: () => threadPage([]) };
    const out = await setup()('get_unreads', {});
    expect(out).toContain('未読はありません。');
    expect(out).toContain('（続きはありません）');
  });

  test('pages channels then threads with limit, and a cursor keeps the page size', async () => {
    routes = base();
    const call = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await call('get_unreads', cursor ? { cursor, limit: 50 } : { limit: 2 });
      const rows = order(out);
      expect(rows.length).toBeLessThanOrEqual(2);
      seen.push(...rows);
      cursor = cursorIn(out);
      if (!cursor) break;
    }
    expect(seen).toEqual([MENTIONED, DM, NEW, OLD, TH2, TH1, TH_DM]);
  });

  test('a later page first lists channels and threads updated since the previous page, newest first', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 2 });
    const now = Date.now() + 60_000;
    routes['GET /users/me/channels'] = () => channels().map((c) => (c.id === OLD ? { ...c, last_root_post_at: now } : c));
    routes[`GET /users/u1/teams/${T1}/threads`] = () => threadPage([thread(TH1, OLD, now + 1, { unread_mentions: 1 }), thread(TH_DM, DM, 4000)]);
    const out = await call('get_unreads', { cursor: cursorIn(first) });
    expect(out).toContain('前のページの後に更新されたチャンネルとスレッド（前のページまでに出したものを含むことがあります）:');
    expect(order(out)).toEqual([TH1, OLD]);
  });

  test('when the updated rows do not fit, says how many are left and asks to start over instead of giving a cursor', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 1 });
    const now = Date.now() + 60_000;
    routes['GET /users/me/channels'] = () => channels().map((c) => ({ ...c, last_root_post_at: now }));
    const out = await call('get_unreads', { cursor: cursorIn(first) });
    expect(out).toContain('ほかに 3 件');
    expect(out).toContain('cursor を付けずに最初のページから取り直してください');
    expect(cursorIn(out)).toBeUndefined();
  });

  test('when the CRT decision changes between pages, refuses the cursor and asks to start over', async () => {
    routes = base();
    const call = setup();
    const first = await call('get_unreads', { limit: 1 });
    routes['GET /config/client'] = () => ({ CollapsedThreads: 'disabled' });
    const out = await call('get_unreads', { cursor: cursorIn(first) }, true);
    expect(out).toContain('スレッドの折りたたみ（CRT）の判定がページの合間に変わりました');
    expect(out).toContain('cursor を付けずに最初のページから取り直してください');
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('get_unreads', { cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 5 })).toString('base64url') }, true);
    expect(out).toContain('cursor が不正です');
  });

  test('stays within 2 + 1 + (members pages) + 1 + 4T + 1 Mattermost calls, in that order, and never marks anything read', async () => {
    routes = { ...base('default_on'), 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': pref('on') };
    await setup()('get_unreads', {});
    expect(hits.length).toBeLessThanOrEqual(2 + 1 + 1 + 1 + 4 * 2 + 1);
    expect(hits).toEqual([
      'GET /config/client', 'GET /users/me/preferences/display_settings/name/collapsed_reply_threads', 'GET /users/me/channels',
      'GET /users/me/channel_members', 'GET /users/me/teams', `GET /users/u1/teams/${T1}/threads`, `GET /users/u1/teams/${T2}/threads`, 'POST /users/ids',
    ]);
    expect(hits.some((h) => h.includes('/view'))).toBe(false);
  });
});

describe('get_mentions', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  type P = { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number };
  let corpus: P[];
  let searches: string[];
  let n: number;
  const at = (day: number, i: number) => Date.parse(`2026-10-${day}T03:00:00Z`) + i * 1000;
  const add = (day: number, count: number, message = '@alice hi') => {
    for (let i = 0; i < count; i++) corpus.push({ id: `p${String(n++).padStart(25, '0')}`, user_id: 'u2', channel_id: C, root_id: '', message, create_at: at(day, i) });
  };
  const jstDay = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  // Like Mattermost's database search: up to 100 hits, newest first, "@alice" also hitting a bare "alice", before: excluding that JST day.
  const search = () => {
    const { terms } = bodies['/posts/search'] as { terms: string };
    searches.push(terms);
    const before = /before:(\S+)/.exec(terms)?.[1];
    const after = /after:(\S+)/.exec(terms)?.[1];
    const hits = corpus.filter((p) => /alice/i.test(p.message) && (!before || jstDay(p.create_at) < before) && (!after || jstDay(p.create_at) > after))
      .sort((a, b) => b.create_at - a.create_at).slice(0, 100);
    return { order: hits.map((p) => p.id), posts: Object.fromEntries(hits.map((p) => [p.id, p])) };
  };
  const base = (): Record<string, Route> => ({
    'GET /users/me': () => ({ id: 'u1', username: 'alice', first_name: 'Alice', notify_props: { mention_keys: ' aiso ,,say "hi"', first_name: 'false' } }),
    'POST /posts/search': search,
    'GET /users/me/channels': () => [{ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O' }],
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const ids = (out: string) => [...out.matchAll(/^--- post_id: (\S{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];
  const mentions = () => corpus.filter((p) => p.message.startsWith('@alice')).sort((a, b) => b.create_at - a.create_at).map((p) => p.id);
  const pageAll = async (call: ReturnType<typeof setup>, limit: number, between?: (page: number) => void) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const out = await call('get_mentions', cursor ? { cursor } : { limit });
      seen.push(...ids(out));
      cursor = cursorIn(out);
      if (!cursor) return seen;
      between?.(page);
    }
    throw new Error('did not finish');
  };

  beforeEach(() => {
    corpus = [];
    searches = [];
    n = 0;
  });

  test('searches the user\'s mention terms, each quoted, as an OR search over all teams in JST, asking for 100', async () => {
    add(22, 1);
    routes = base();
    await setup()('get_mentions', {});
    expect(urls).toContain('GET /users/me/channels');
    expect(urls.filter((u) => u.startsWith('GET /users/me/channels')).every((u) => !u.includes('include_deleted'))).toBe(true);
    expect(hits.slice(0, 2)).toEqual(['GET /users/me', 'POST /posts/search']);
    expect(bodies['/posts/search']).toEqual({ terms: '"@alice" "aiso"', is_or_search: true, include_deleted_channels: false, time_zone_offset: 32400, page: 0, per_page: 100 });
  });

  test('keeps only posts the server would count as a mention, newest first, with channel, team and permalink', async () => {
    add(21, 1, '@alice older');
    add(22, 1, 'alice without the at sign');
    add(22, 1, 'mail x@alice.example');
    add(22, 1, '`@alice` in code');
    add(23, 1, '@alice newest');
    routes = base();
    const out = await setup()('get_mentions', {});
    expect(ids(out)).toEqual([corpus[4].id, corpus[0].id]);
    expect(out).toContain(`channel_id: ${C}`);
    expect(out).toContain(`team_id: ${T}`);
    expect(out).toContain(`https://mm.example/team-a/pl/${corpus[4].id}`);
    expect(out).toContain('（続きはありません）');
  });

  test('says when there are no mentions', async () => {
    routes = base();
    const out = await setup()('get_mentions', {});
    expect(out).toContain('メンションはありません。');
    expect(out).toContain('（続きはありません）');
  });

  test('pages within one search with limit, and the cursor keeps the page size', async () => {
    add(22, 5);
    routes = base();
    const call = setup();
    const first = await call('get_mentions', { limit: 2 });
    expect(ids(first)).toHaveLength(2);
    expect(ids(await call('get_mentions', { cursor: cursorIn(first), limit: 50 }))).toHaveLength(2);
    expect(searches.every((t) => !t.includes('before:'))).toBe(true);
  });

  test('when a search hits 100, holds back the oldest day D and continues with before:<D+1>, so every mention comes out once', async () => {
    add(20, 30);
    add(21, 40);
    add(21, 20, 'alice no mention');
    add(22, 60);
    routes = base();
    const seen = await pageAll(setup(), 50);
    expect(seen).toEqual(mentions());
    expect(searches).toContain('"@alice" "aiso" before:2026-10-22');
  });

  test('re-derives D on every page, so mentions pushed out of the 100 by new ones are not skipped', async () => {
    add(20, 20);
    add(21, 50);
    add(22, 30);
    const original = mentions();
    routes = base();
    const seen = await pageAll(setup(), 50, (page) => page === 0 && add(23, 30));
    for (const id of original) expect(seen).toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('when a single day has 100 hits, shows what it can of that day, says the day is not complete, and moves to the day before', async () => {
    add(20, 5);
    add(22, 150);
    routes = base();
    const call = setup();
    const outs: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await call('get_mentions', cursor ? { cursor } : { limit: 50 });
      outs.push(out);
      cursor = cursorIn(out);
      if (!cursor) break;
    }
    const seen = outs.flatMap(ids);
    expect(seen).toEqual([...mentions().slice(0, 100), ...mentions().slice(150)]);
    expect(outs.join('\n')).toContain('2026-10-22 のメンションは 1 日で 100 件を超えるため、新しい 100 件だけを照合しました');
    expect(searches).toContain('"@alice" "aiso" before:2026-10-22');
  });

  test('when no hit is a mention, searches again up to 3 times, then says so and gives a cursor to go further back', async () => {
    for (const day of [22, 21, 20, 19]) add(day, 60, 'alice no mention');
    add(18, 5);
    routes = base();
    const call = setup();
    const first = await call('get_mentions', {});
    expect(searches).toEqual(['"@alice" "aiso"', '"@alice" "aiso" before:2026-10-22', '"@alice" "aiso" before:2026-10-21']);
    expect(ids(first)).toEqual([]);
    expect(first).toContain('この範囲には照合に当たる投稿がありませんでした');
    const second = await call('get_mentions', { cursor: cursorIn(first) });
    expect(searches.at(-1)).toBe('"@alice" "aiso" before:2026-10-20');
    expect(ids(second)).toEqual(mentions());
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('get_mentions', { cursor: Buffer.from(JSON.stringify({ page: 1, per_page: 5 })).toString('base64url') }, true);
    expect(out).toContain('cursor が不正です');
  });

  describe('with unread_only', () => {
    const C2 = 'e'.repeat(26);
    const TH = 'h'.repeat(26);
    const TH2 = 'k'.repeat(26);
    const member = (channel_id: string, last_viewed_at: number, mention_count: number, mention_count_root = mention_count) =>
      ({ channel_id, last_viewed_at, msg_count: 0, msg_count_root: 0, mention_count, mention_count_root });
    const thread = (tid: string, last_viewed_at: number, unread_mentions: number, rootAt = at(20, 0)) =>
      ({ id: tid, last_reply_at: at(23, 0), last_viewed_at, unread_replies: 1, unread_mentions, post: { id: tid, user_id: 'u2', channel_id: C, root_id: '', message: 'root', create_at: rootAt } });
    const put = (o: Partial<P> & { create_at: number }) => {
      const p = { id: `p${String(n++).padStart(25, '0')}`, user_id: 'u2', channel_id: C, root_id: '', message: '@alice hi', ...o };
      corpus.push(p);
      return p.id;
    };
    const unreadBase = (crt: string, members: unknown[], threads: unknown[] = []): Record<string, Route> => ({
      ...base(),
      'GET /config/client': () => ({ CollapsedThreads: crt }),
      'GET /users/me/channel_members': () => members,
      [`GET /users/u1/teams/${T}/threads`]: () => ({ total_unread_threads: threads.length, threads }),
      'GET /users/me/channels': () => [
        { id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O', create_at: at(15, 0) },
        { id: C2, name: 'other', display_name: 'Other', team_id: T, type: 'O', create_at: at(15, 0) },
      ],
    });

    test('with CRT off, shows only mentions after the read position of a channel with mentions, leaving out the user\'s own posts', async () => {
      put({ create_at: at(21, 0) });
      put({ create_at: at(22, 0) });
      const unread = put({ create_at: at(22, 1), root_id: TH });
      put({ create_at: at(22, 2), user_id: 'u1' });
      put({ create_at: at(22, 3), channel_id: C2 });
      routes = unreadBase('disabled', [member(C, at(22, 0), 1, 0), member(C2, 0, 0)]);
      const out = await setup()('get_mentions', { unread_only: true });
      expect(ids(out)).toEqual([unread]);
      expect(out).toContain('自分への未読のメンション（新しい順）');
      expect(out).toContain('未読の判定:');
      expect(hits).not.toContain(`GET /users/u1/teams/${T}/threads`);
    });

    test('keeps the user\'s own webhook posts, whose mentions Mattermost counts', async () => {
      const hook = put({ create_at: at(22, 2), user_id: 'u1', props: { from_webhook: 'true' } } as Partial<P> & { create_at: number });
      put({ create_at: at(22, 1), user_id: 'u1' });
      routes = unreadBase('disabled', [member(C, at(22, 0), 1)]);
      expect(ids(await setup()('get_mentions', { unread_only: true }))).toEqual([hook]);
    });

    test('with CRT on, judges a root post by the channel and a reply by its thread, and leaves out replies in threads without unread mentions', async () => {
      const root = put({ create_at: at(22, 5) });
      put({ create_at: at(22, 1) });
      const reply = put({ create_at: at(22, 3), root_id: TH });
      put({ create_at: at(22, 1), root_id: TH });
      put({ create_at: at(22, 4), root_id: TH2 });
      put({ create_at: at(22, 6), channel_id: C2 });
      routes = unreadBase('always_on', [member(C, at(22, 2), 5, 1), member(C2, 0, 1, 0)], [thread(TH, at(22, 2), 1), thread(TH2, 0, 0)]);
      const out = await setup()('get_mentions', { unread_only: true });
      expect(ids(out)).toEqual([root, reply]);
    });

    test('when no channel or thread has an unread mention, says so without searching', async () => {
      put({ create_at: at(22, 1) });
      routes = unreadBase('always_on', [member(C, 0, 3, 0)], [thread(TH, 0, 0)]);
      const out = await setup()('get_mentions', { unread_only: true });
      expect(out).toContain('未読の判定:');
      expect(out).toContain('未読のメンションはありません。');
      expect(out).toContain('（続きはありません）');
      expect(searches).toEqual([]);
    });

    test.each([
      ['the oldest read position of a channel', [member(C, at(22, 0), 1)], [], ' after:2026-10-21'],
      ['a thread never viewed, by its root post', [member(C, at(22, 0), 1)], [thread(TH, 0, 1, at(20, 0))], ' after:2026-10-19'],
      ['the creation of a channel never viewed', [member(C, 0, 1)], [thread(TH, at(22, 0), 1)], ' after:2026-10-14'],
    ])('searches only from the day of %s', async (_, members, threads, after) => {
      put({ create_at: at(22, 1) });
      routes = unreadBase('always_on', members, threads);
      await setup()('get_mentions', { unread_only: true });
      expect(searches[0]).toBe(`"@alice" "aiso"${after}`);
    });

    test('leaves out archived channels and their threads, which the search does not cover, from the candidates and the floor', async () => {
      const GONE = 'g'.repeat(26);
      put({ create_at: at(22, 1) });
      const gone = thread(TH2, at(10, 0), 1);
      gone.post.channel_id = GONE;
      routes = unreadBase('always_on', [member(C, at(22, 0), 1), member(GONE, at(10, 0), 1)], [gone]);
      await setup()('get_mentions', { unread_only: true });
      expect(searches[0]).toBe('"@alice" "aiso" after:2026-10-21');
    });

    test('ends without a cursor once the search reaches the oldest read position', async () => {
      for (const day of [22, 21, 20, 19]) add(day, 60, 'alice no mention');
      routes = unreadBase('disabled', [member(C, at(21, 0), 1)]);
      const out = await setup()('get_mentions', { unread_only: true });
      expect(searches.every((t) => t.includes(' after:2026-10-20'))).toBe(true);
      expect(cursorIn(out)).toBeUndefined();
    });

    test('the cursor keeps unread_only, and a cursor without it ignores the argument', async () => {
      for (let i = 0; i < 5; i++) put({ create_at: at(22, i) });
      put({ create_at: at(21, 0) });
      routes = unreadBase('disabled', [member(C, at(21, 30), 1)]);
      const call = setup();
      const first = await call('get_mentions', { unread_only: true, limit: 3 });
      const second = await call('get_mentions', { cursor: cursorIn(first) });
      expect([...ids(first), ...ids(second)]).toHaveLength(5);
      expect(second).toContain('未読のメンション');
      const plain = await call('get_mentions', { limit: 3 });
      expect(await call('get_mentions', { cursor: cursorIn(plain), unread_only: true })).not.toContain('未読');
    });

    test('notes when a team\'s unread threads were cut at 4 pages', async () => {
      put({ create_at: at(22, 1) });
      routes = unreadBase('always_on', [member(C, at(22, 0), 0, 1)]);
      routes[`GET /users/u1/teams/${T}/threads`] = () => ({ total_unread_threads: 999, threads: Array.from({ length: 50 }, (_, i) => thread(`t${String(i).padStart(25, '0')}`, 0, 0)) });
      expect(await setup()('get_mentions', { unread_only: true })).toContain('未読スレッドは、50 件ずつ 4 回の取得で打ち切りました。');
    });

    test('notes when a team\'s unread threads were not all taken, as when a full page is followed by nothing', async () => {
      put({ create_at: at(22, 1) });
      routes = unreadBase('always_on', [member(C, at(22, 0), 0, 1)]);
      let k = 0;
      routes[`GET /users/u1/teams/${T}/threads`] = () => ({ total_unread_threads: 60, threads: k++ ? [] : Array.from({ length: 50 }, (_, i) => thread(`t${String(i).padStart(25, '0')}`, 0, 0)) });
      expect(await setup()('get_mentions', { unread_only: true })).toContain('未読スレッドを total_unread_threads: 60 に対して取り切れませんでした。');
    });

    test('when the threads API fails, the tool fails', async () => {
      routes = unreadBase('always_on', [member(C, at(22, 0), 0, 1)]);
      routes[`GET /users/u1/teams/${T}/threads`] = () => Response.json({ id: 'x', message: 'm', status_code: 403 }, { status: 403 });
      await setup()('get_mentions', { unread_only: true }, true);
      expect(searches).toEqual([]);
    });
  });
});

describe('get_file', () => {
  const F = 'f'.repeat(26);
  const INFO = `GET /files/${F}/info`;
  const PREVIEW = `GET /files/${F}/preview`;
  const FILE = `GET /files/${F}`;
  const body = (b: Uint8Array) => () => new Response(b as Uint8Array<ArrayBuffer>, { status: 206 });
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0];
  const GIF = [...Buffer.from('GIF89a')];
  const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];
  const bytes = (head: number[], size = 64) => { const b = new Uint8Array(size); b.set(head); return b; };
  // Mattermost labels every preview image/jpeg, whatever its format.
  const preview = (b: Uint8Array<ArrayBuffer>) => () => new Response(b, { headers: { 'content-type': 'image/jpeg' } });
  const info = (o: Record<string, unknown>) => () => ({ id: F, name: 'shot.png', extension: 'png', mime_type: 'image/png', size: 11393, ...o });
  const image = () => last.content.find((c) => c.type === 'image');
  const mmError = (status: number, id: string) => () => Response.json({ id, message: 'm', status_code: status }, { status });

  test('returns a JPEG preview as an MCP image with the file\'s name, type, size and dimensions as text', async () => {
    const b = bytes(JPEG);
    routes = { [INFO]: info({ name: 'photo.jpg', mime_type: 'image/jpeg', size: 58626, width: 1920, height: 1080, has_preview_image: true }), [PREVIEW]: preview(b) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO, PREVIEW]);
    expect(image()).toEqual({ type: 'image', data: Buffer.from(b).toString('base64'), mimeType: 'image/jpeg' });
    for (const s of [F, 'photo.jpg', 'image/jpeg', '58626 バイト', '1920x1080']) expect(out).toContain(s);
  });

  test.each([['PNG', PNG, 'image/png'], ['GIF', GIF, 'image/gif'], ['WebP', WEBP, 'image/webp']])(
    'tells a %s preview by its first bytes, not by Mattermost\'s image/jpeg header', async (_, head, mime) => {
      routes = { [INFO]: info({ width: 200, height: 100, has_preview_image: true }), [PREVIEW]: preview(bytes(head)) };
      await setup()('get_file', { file_id: F });
      expect(image()?.mimeType).toBe(mime);
    });

  test('fetches the preview of a GIF even though Mattermost reports no preview image for it', async () => {
    routes = { [INFO]: info({ name: 'anim.gif', mime_type: 'image/gif', width: 400, height: 300 }), [PREVIEW]: preview(bytes(JPEG)) };
    await setup()('get_file', { file_id: F });
    expect(hits).toContain(PREVIEW);
    expect(image()?.mimeType).toBe('image/jpeg');
  });

  test('for a file without width and height that is not text (HEIC), returns only its information without fetching a preview', async () => {
    routes = { [INFO]: info({ name: 'IMG.heic', mime_type: 'image/heic', size: 900 }), [FILE]: body(bytes([0, 0, 0, 0x18, ...Buffer.from('ftypheic')])) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO, FILE]);
    expect(last.content).toHaveLength(1);
    for (const s of ['IMG.heic', 'image/heic', '900 バイト', 'テキストとして読めない形式']) expect(out).toContain(s);
  });

  describe('text files', () => {
    const textInfo = (name: string, size: number, mime_type = '') => info({ name, extension: name.split('.').pop(), mime_type, size });
    const content = () => last.content[1]?.text;

    test('returns a UTF-8 file as a second text content, fetching only its head with a Range, whatever its mime_type', async () => {
      const csv = 'name,qty\nりんご,3\n';
      let range: string | null = null;
      routes = { [INFO]: textInfo('stock', Buffer.byteLength(csv)), [FILE]: (req) => { range = req.headers.get('range'); return new Response(csv, { status: 206 }); } };
      const out = await setup()('get_file', { file_id: F });
      expect(hits).toEqual([INFO, FILE]);
      expect(range).toBe('bytes=0-39999');
      expect(last.content.map((c) => c.type)).toEqual(['text', 'text']);
      expect(content()).toBe(csv);
      expect(out).toContain('stock');
      expect(out).toContain('UTF-8');
      expect(out).not.toContain('切');
    });

    test('drops a UTF-8 BOM', async () => {
      routes = { [INFO]: textInfo('a.md', 9), [FILE]: body(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('# hi\n\n')])) };
      await setup()('get_file', { file_id: F });
      expect(content()).toBe('# hi\n\n');
    });

    test('says the content is empty for a file holding only a BOM, and for a file of size 0 without fetching it', async () => {
      routes = { [INFO]: textInfo('a.txt', 3), [FILE]: body(Uint8Array.from([0xef, 0xbb, 0xbf])) };
      expect(await setup()('get_file', { file_id: F })).toContain('中身は空です');
      expect(last.content).toHaveLength(1);
      hits = [];
      routes = { [INFO]: textInfo('a.txt', 0) };
      expect(await setup()('get_file', { file_id: F })).toContain('中身は空です');
      expect(hits).toEqual([INFO]);
    });

    const SJIS = Uint8Array.from([0x95, 0x69, 0x96, 0xbc, 0x2c, 0x90, 0x94, 0x0a, 0x82, 0xe8, 0x82, 0xf1, 0x82, 0xb2, 0x2c, 0x33, 0x0a]);

    test.each(['DATA.CSV', 'a.tsv', 'a.Txt', 'a.log'])('reads a Shift_JIS file named %s, its extension being csv, tsv, txt or log in any case', async (name) => {
      routes = { [INFO]: textInfo(name, SJIS.length, 'text/csv; charset=utf-8'), [FILE]: body(SJIS) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe('品名,数\nりんご,3\n');
      expect(out).toContain('Shift_JIS');
    });

    // 40,000 bytes, the most fetched: a file that fills them may go on, so a character cut at their end is the fetch's, not the file's.
    const FAMILY = '👨‍👩‍👧';
    test('drops a UTF-8 character cut at the end of the fetched bytes without calling it incomplete', async () => {
      const head = `${FAMILY.repeat(2222)}aa`;
      const b = Uint8Array.from([...Buffer.from(head), 0xe3, 0x81]);
      expect(b.length).toBe(40_000);
      routes = { [INFO]: textInfo('a.txt', 1_000_000), [FILE]: body(b) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe(head);
      expect(out).toContain('UTF-8');
      expect(out).toContain('先頭の 2224 文字だけを返しました（ファイル全体は 1000000 バイト）');
      expect(out).not.toContain('末尾に不完全な文字');
    });

    test('drops a Shift_JIS character cut at the end of the fetched bytes without calling it incomplete', async () => {
      const b = Uint8Array.from([0x61, ...Array.from({ length: 19_999 }, () => [0x82, 0xa0]).flat(), 0x82]);
      expect(b.length).toBe(40_000);
      routes = { [INFO]: textInfo('a.csv', 1_000_000), [FILE]: body(b) };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain('文字コード: Shift_JIS');
      expect(out).toContain('先頭の 10000 文字だけを返しました');
      expect(out).not.toContain('末尾に不完全な文字');
    });

    const GUESSED = '文字コードは中身から推定しました。文字化けしているなら、Shift_JIS、EUC-JP、Latin-1 など別の文字コードかもしれません。';
    // EUC-JP bytes written out: Node has no EUC-JP encoder.
    const eucjp = (s: string) => Uint8Array.from(Buffer.from(
      { 'あいう,在庫\n': 'a4a2a4a4a4a62cbadfb8cb0a', '漢字\n': 'b4c1bbfa0a', '漢字': 'b4c1bbfa', '在庫,漢字\n': 'badfb8cb2cb4c1bbfa0a' }[s]!, 'hex'));

    test.each([
      ['EUC-JP that Shift_JIS also reads, as half-width kana', 'あいう,在庫\n', 'EUC-JP'],
      ['EUC-JP that Shift_JIS cannot read', '漢字\n', 'EUC-JP'],
      ['EUC-JP without kana that Shift_JIS cannot read', '在庫,漢字\n', 'EUC-JP'],
      ['EUC-JP without kana that Shift_JIS reads only by dropping its last byte', '漢字', 'EUC-JP'],
    ])('reads %s, noting that the encoding is a guess', async (_, s, encoding) => {
      const b = eucjp(s);
      routes = { [INFO]: textInfo('a.csv', b.length), [FILE]: body(b) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe(s);
      expect(out).toContain(`文字コード: ${encoding}`);
      expect(out).toContain(GUESSED);
      expect(out).not.toContain('末尾に不完全な文字');
    });

    test.each([
      ['half-width kana Shift_JIS', [0xb6, 0xcc, 0xde, 0xbc, 0xb7, 0xb6, 0xde, 0xb2, 0xbc, 0xac], 'Shift_JIS', 'ｶﾌﾞｼｷｶﾞｲｼｬ'],
      // Fixing a known wrong guess: the ･ (0xA5) pairs with the next byte into an EUC-JP katakana.
      ['half-width kana Shift_JIS with ･ in an even place', [0xd4, 0xcf, 0xc0, 0xde, 0xa5, 0xc0, 0xdb, 0xb3], 'EUC-JP', undefined],
      ['Latin-1 °©½', [0xb0, 0xa9, 0xbd], 'Shift_JIS', 'ｰｩｽ'],
      ['odd-length half-width kana Shift_JIS that EUC-JP reads only by dropping its last byte', [0xa4, 0xa2, 0xb1], 'Shift_JIS', '､｢ｱ'],
      ['Latin-1 séance', [...Buffer.from('séance', 'latin1')], 'Shift_JIS', 's饌nce'],
    ])('notes that the encoding is a guess for %s', async (_, b, encoding, shown) => {
      routes = { [INFO]: textInfo('a.txt', b.length), [FILE]: body(Uint8Array.from(b)) };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain(`文字コード: ${encoding}`);
      expect(out).toContain(GUESSED);
      if (shown) expect(content()).toBe(shown);
    });

    test('does not note a guess for UTF-8, and reads Latin-1 für that neither Shift_JIS nor EUC-JP accepts as not text', async () => {
      routes = { [INFO]: textInfo('a.txt', 4), [FILE]: body(new Uint8Array(Buffer.from('abc\n'))) };
      expect(await setup()('get_file', { file_id: F })).not.toContain('推定');
      routes = { [INFO]: textInfo('a.txt', 3), [FILE]: body(Uint8Array.from(Buffer.from('für', 'latin1'))) };
      expect(await setup()('get_file', { file_id: F })).toContain('テキストとして読めない形式');
    });

    const TAIL = 'ファイルの末尾に不完全な文字があったため、その部分を除きました。';
    test.each([
      ['UTF-8', 'a.md', [0x61, 0xe3], 'a'],
      ['Shift_JIS', 'a.txt', [0x82, 0xa0, 0x82], 'あ'],
    ])('drops an incomplete %s character at the end of a whole file and says so', async (encoding, name, b, shown) => {
      routes = { [INFO]: textInfo(name as string, (b as number[]).length), [FILE]: body(Uint8Array.from(b as number[])) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe(shown);
      expect(out).toContain(`文字コード: ${encoding}`);
      expect(out).toContain(TAIL);
      if (encoding === 'Shift_JIS') expect(out).toContain(GUESSED);
      expect(out).not.toContain('先頭の');
    });

    describe('whether the whole file was fetched', () => {
      test.each([[1_000_000, 'larger'], [3, 'smaller']])('takes fewer bytes than the most fetched as the whole file whatever its size says (%i, %s)', async (size) => {
        routes = { [INFO]: textInfo('a.md', size as number), [FILE]: body(Uint8Array.from([0x61, 0x62, 0xe3, 0x81])) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe('ab');
        expect(out).toContain('ファイルの末尾に不完全な文字があったため');
        expect(out).not.toContain('先頭の');
      });

      test('at exactly the most fetched, takes the file as whole only when its size matches, and says "at least" when the size is smaller', async () => {
        const b = new Uint8Array(Buffer.from('a'.repeat(40_000)));
        routes = { [INFO]: textInfo('a.md', 40_000), [FILE]: body(b) };
        expect(await setup()('get_file', { file_id: F })).toContain('先頭の 10000 文字だけを返しました（ファイル全体は 40000 バイト）');
        routes = { [INFO]: textInfo('a.md', 100), [FILE]: body(b) };
        expect(await setup()('get_file', { file_id: F })).toContain('先頭の 10000 文字だけを返しました（ファイル全体は少なくとも 40000 バイト）');
      });

      test('writes the bytes fetched, not the size it says, as the size of a whole file cut to 10,000 characters', async () => {
        routes = { [INFO]: textInfo('a.md', 1_000_000), [FILE]: body(new Uint8Array(Buffer.from('a'.repeat(10_001)))) };
        expect(await setup()('get_file', { file_id: F })).toContain('先頭の 10000 文字だけを返しました（ファイル全体は 10001 バイト）');
      });

      test('keeps UTF-8, with neither note, for ASCII ending in a UTF-8 lead byte when the fetch may have stopped there', async () => {
        const b = Uint8Array.from([...Buffer.from('a'.repeat(39_999)), 0xe3]);
        routes = { [INFO]: textInfo('a.log', 1_000_000), [FILE]: body(b) };
        const out = await setup()('get_file', { file_id: F });
        expect(out).toContain('文字コード: UTF-8');
        expect(out).not.toContain('推定');
        expect(out).not.toContain('末尾に不完全な文字');
      });
    });

    describe('a whole file cut at its last character, otherwise made only of what half-width kana Shift_JIS can pass for in UTF-8 (UTF-8 is only a guess)', () => {
      test.each([
        ['a.txt', [0x61, 0x62, 0x63, 0xc2], 'Shift_JIS', 'abcﾂ', false],
        ['a.txt', [0x61, 0x62, 0x63, 0xe8, 0xa0], 'Shift_JIS', 'abc陟', false],
        ['a.csv', [...Buffer.from('café', 'latin1')], 'UTF-8', 'caf', true],
        ['a.md', [0x61, 0x62, 0x63, 0xc2], 'UTF-8', 'abc', true],
      ])('reads %s %j as %s, noting the guess', async (name, b, encoding, shown, cut) => {
        routes = { [INFO]: textInfo(name as string, (b as number[]).length), [FILE]: body(Uint8Array.from(b as number[])) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe(shown);
        expect(out).toContain(`文字コード: ${encoding}`);
        expect(out).toContain(GUESSED);
        expect(out.includes('末尾に不完全な文字')).toBe(cut);
      });

      test.each([
        ['a.txt', [...Buffer.from('abc,'), 0xc3, 0xbd, 0xc4], 'Shift_JIS', 'abc,ﾃｽﾄ', false],
        // Fixing a known wrong guess: Latin UTF-8 with a cut last character also reads whole as Shift_JIS.
        ['a.txt', [...Buffer.from('naïve caf'), 0xc3], 'Shift_JIS', 'naﾃｯve cafﾃ', false],
        ['a.md', [...Buffer.from('café'), 0xe2], 'UTF-8', 'café', true],
      ])('reads %s %j, whose UTF-8 half-width kana Shift_JIS could also make, as %s with the guess noted', async (name, b, encoding, shown, cut) => {
        routes = { [INFO]: textInfo(name as string, (b as number[]).length), [FILE]: body(Uint8Array.from(b as number[])) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe(shown);
        expect(out).toContain(`文字コード: ${encoding}`);
        expect(out).toContain(GUESSED);
        expect(out.includes('末尾に不完全な文字')).toBe(cut);
      });

      test.each([
        // à is C3 A0: an A0 trail byte half-width kana Shift_JIS never has, so this cannot be it.
        ['a.txt', [...Buffer.from('voilà'), 0xc3], 'voilà'],
        ['a.txt', [...Buffer.from('deploy 🚀 done '), 0xe3, 0x81], 'deploy 🚀 done '],
        ['a.txt', [...Buffer.from('Grüße'), 0xc3], 'Grüße'],
        ['a.md', [...Buffer.from('ship it 🚀'), 0xe3], 'ship it 🚀'],
      ])('keeps UTF-8 without a guess for %s %j, whose characters half-width kana Shift_JIS cannot make', async (name, b, shown) => {
        routes = { [INFO]: textInfo(name as string, (b as number[]).length), [FILE]: body(Uint8Array.from(b as number[])) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe(shown);
        expect(out).toContain('文字コード: UTF-8');
        expect(out).not.toContain('推定');
        expect(out).toContain('末尾に不完全な文字');
      });

      test.each([
        [[0x61, 0x62, 0x63, 0xe3, 0x81], 'abc縺'],
        [[...Buffer.from('résumé'), 0xc3], 'rﾃｩsumﾃｩﾃ'],
        // á is C3 A1, the lowest trail byte half-width kana can make.
        [[...Buffer.from('á'), 0xc3], 'ﾃ｡ﾃ'],
      ])('reads ASCII or half-width kana look-alikes %j cut at the end as Shift_JIS with the guess noted, the price of not ruling out Latin-1', async (b, shown) => {
        routes = { [INFO]: textInfo('a.txt', (b as number[]).length), [FILE]: body(Uint8Array.from(b as number[])) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe(shown);
        expect(out).toContain('文字コード: Shift_JIS');
        expect(out).toContain(GUESSED);
      });

      test('reads a file as not text when Node cannot make a Shift_JIS or EUC-JP decoder, instead of failing', async () => {
        const Real = globalThis.TextDecoder;
        vi.stubGlobal('TextDecoder', class extends Real {
          constructor(label?: string, options?: TextDecoderOptions) {
            if (label === 'shift_jis' || label === 'euc-jp') throw new RangeError(`unsupported: ${label}`);
            super(label, options);
          }
        });
        try {
          routes = { [INFO]: textInfo('a.csv', 3), [FILE]: body(Uint8Array.from([0xb0, 0xa9, 0xbd])) };
          expect(await setup()('get_file', { file_id: F })).toContain('テキストとして読めない形式');
        } finally {
          vi.unstubAllGlobals();
        }
      });

      test.each([['日本語のログ'], ['、'], ['Ａ']])('keeps UTF-8 without a guess when the text has Japanese (%s), as a log cut at its size limit', async (head) => {
        const b = Uint8Array.from([...Buffer.from(head), 0xe3, 0x81]);
        routes = { [INFO]: textInfo('a.txt', b.length), [FILE]: body(b) };
        const out = await setup()('get_file', { file_id: F });
        expect(content()).toBe(head);
        expect(out).toContain('文字コード: UTF-8');
        expect(out).not.toContain('推定');
      });
    });

    test('says the file may be missing or unreadable in the store for a 404 from its reader', async () => {
      routes = { [INFO]: textInfo('a.txt', 5), [FILE]: mmError(404, 'api.file.file_reader.app_error') };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain('中身を取得できませんでした（HTTP 404）。保存先にファイルの実体が無いか、保存先から読めません。');
      expect(last.content).toHaveLength(1);
    });

    test('says nothing readable is left when the whole file is one incomplete character', async () => {
      routes = { [INFO]: textInfo('a.md', 1), [FILE]: body(Uint8Array.from([0xe3])) };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain('ファイルの末尾に不完全な文字があり、それを除くと読める中身がありません。');
      expect(out).not.toContain('中身は空です');
      expect(last.content).toHaveLength(1);
    });

    test('a plain-text 500 while fetching the content (a file missing from S3) returns the information with the reason', async () => {
      routes = { [INFO]: textInfo('a.txt', 5), [FILE]: () => new Response("seeker can't seek\n", { status: 500, headers: { 'content-type': 'text/plain' } }) };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain('a.txt');
      expect(out).toContain('中身を取得できませんでした（HTTP 500）。保存先にファイルの実体が無いか、保存先の一時的な障害です。');
      expect(last.content).toHaveLength(1);
    });

    test.each([
      ['a 500 with a Mattermost JSON error', mmError(500, 'api.file.get_file_info.app_error')],
      ['a 500 with an empty id (hardened mode)', mmError(500, '')],
      ['a 500 in HTML from a proxy', () => new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } })],
      ['a 502', () => new Response('bad gateway', { status: 502 })],
      ['a 503', () => new Response('unavailable', { status: 503 })],
      ['a 504', () => new Response('gateway timeout', { status: 504 })],
    ])('%s while fetching the content stays an error', async (_, route) => {
      routes = { [INFO]: textInfo('a.txt', 5), [FILE]: route };
      expect(await setup()('get_file', { file_id: F }, true)).toContain('再試行');
    });

    test('a plain-text 500 for an image preview stays an error', async () => {
      routes = { [INFO]: info({ width: 200, height: 100 }), [PREVIEW]: () => new Response("seeker can't seek\n", { status: 500, headers: { 'content-type': 'text/plain' } }) };
      expect(await setup()('get_file', { file_id: F }, true)).toContain('再試行');
    });

    test('says an ABAC policy denies the file when its information is refused', async () => {
      routes = { [INFO]: mmError(403, 'api.file.get_file.abac_denied.app_error') };
      expect(await setup()('get_file', { file_id: F }, true)).toBe('Mattermost のアクセス制御の方針（ABAC）により、このファイルを見られません');
    });

    test('does not read the same Shift_JIS bytes under another extension', async () => {
      routes = { [INFO]: textInfo('data.bin', SJIS.length), [FILE]: body(SJIS) };
      expect(await setup()('get_file', { file_id: F })).toContain('テキストとして読めない形式');
      expect(last.content).toHaveLength(1);
    });

    test.each([
      ['a NUL byte', 'notes.txt', Uint8Array.from([...Buffer.from('abc'), 0, ...Buffer.from('def')])],
      ['a PDF with a binary comment line', 'doc.pdf', Uint8Array.from([...Buffer.from('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])],
      ['an all-ASCII PDF', 'doc.pdf', new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'))],
    ])('returns only the information of a file with %s', async (_, name, b) => {
      routes = { [INFO]: textInfo(name, b.length), [FILE]: body(b) };
      expect(await setup()('get_file', { file_id: F })).toContain('テキストとして読めない形式');
      expect(last.content).toHaveLength(1);
    });

    test('returns 10,000 characters whole, and cuts 10,001 characters to 10,000 with a note', async () => {
      const s = 'あ'.repeat(10_000);
      routes = { [INFO]: textInfo('a.txt', Buffer.byteLength(s)), [FILE]: body(new Uint8Array(Buffer.from(s))) };
      expect(await setup()('get_file', { file_id: F })).not.toContain('先頭の');
      expect(content()).toBe(s);
      const t = 'a'.repeat(10_001);
      routes = { [INFO]: textInfo('a.txt', 10_001), [FILE]: body(new Uint8Array(Buffer.from(t))) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe(t.slice(0, 10_000));
      expect(out).toContain('先頭の 10000 文字だけを返しました（ファイル全体は 10001 バイト）');
    });

    test('notes the cut when the file fills the bytes fetched and is larger, counting the characters returned', async () => {
      const head = `${'👨‍👩‍👧'.repeat(2222)}abcd`;
      expect(Buffer.byteLength(head)).toBe(40_000);
      routes = { [INFO]: textInfo('a.log', 1_000_000), [FILE]: body(new Uint8Array(Buffer.from(head))) };
      const out = await setup()('get_file', { file_id: F });
      expect(content()).toBe(head);
      expect(out).toContain('先頭の 2226 文字だけを返しました（ファイル全体は 1000000 バイト）');
    });

    test.each([
      [mmError(403, 'api.file.get_file.rejected_by_plugin'), 'Mattermost が中身のダウンロードを拒否しました（プラグインによる制限）'],
      [mmError(404, 'api.file.file_reader.app_error'), '中身を取得できませんでした（HTTP 404）。保存先にファイルの実体が無いか、保存先から読めません。'],
    ])('when fetching the content fails with a 4xx, still returns the information with the reason', async (route, reason) => {
      routes = { [INFO]: textInfo('a.txt', 5), [FILE]: route };
      const out = await setup()('get_file', { file_id: F });
      expect(out).toContain('a.txt');
      expect(out).toContain(reason);
      expect(last.content).toHaveLength(1);
    });

    test('a 503 while fetching the content is an error', async () => {
      routes = { [INFO]: textInfo('a.txt', 5), [FILE]: () => new Response('down', { status: 503 }) };
      await setup()('get_file', { file_id: F }, true);
    });

    test('does not log the content', async () => {
      routes = { [INFO]: textInfo('a.txt', 12), [FILE]: body(new Uint8Array(Buffer.from('SECRETTEXT!\n'))) };
      await setup()('get_file', { file_id: F });
      const logged = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain('get_file');
      expect(logged).not.toContain('SECRETTEXT');
    });
  });

  test('when Mattermost has no preview for the file (SVG), returns only its information', async () => {
    routes = { [INFO]: info({ name: 'a.svg', mime_type: 'image/svg+xml', width: 300, height: 150 }), [PREVIEW]: mmError(400, 'api.file.get_file_preview.no_preview.app_error') };
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('a.svg');
  });

  test('when the preview bytes are of no known image format, returns only the information', async () => {
    routes = { [INFO]: info({ width: 200, height: 100 }), [PREVIEW]: preview(bytes([1, 2, 3, 4])) };
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('shot.png');
  });

  test('fetches a preview whose longer side is exactly 3000px', async () => {
    routes = { [INFO]: info({ width: 1000, height: 3000 }), [PREVIEW]: preview(bytes(PNG)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
  });

  test.each([[1000, 3001], [4000, 6260]])('does not fetch the preview of a %ix%i image, whose preview would be taller than 3000px', async (width, height) => {
    routes = { [INFO]: info({ width, height }), [PREVIEW]: preview(bytes(PNG)) };
    const out = await setup()('get_file', { file_id: F });
    expect(hits).toEqual([INFO]);
    expect(image()).toBeUndefined();
    expect(out).toContain('縦横が大きすぎるため');
  });

  test('a wide image is scaled to 1920px by Mattermost, so its preview is fetched', async () => {
    routes = { [INFO]: info({ width: 7000, height: 4500 }), [PREVIEW]: preview(bytes(PNG)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
  });

  test('returns a preview of 3.75MB, but not a larger one', async () => {
    routes = { [INFO]: info({ width: 1920, height: 1080 }), [PREVIEW]: preview(bytes(PNG, 3_750_000)) };
    await setup()('get_file', { file_id: F });
    expect(image()?.mimeType).toBe('image/png');
    routes[PREVIEW] = preview(bytes(PNG, 3_750_001));
    const out = await setup()('get_file', { file_id: F });
    expect(image()).toBeUndefined();
    expect(out).toContain('画像が大きすぎるため');
  });

  test('says the caller may not see the file on a 403', async () => {
    routes = { [INFO]: mmError(403, 'api.context.permissions.app_error') };
    expect(await setup()('get_file', { file_id: F }, true)).toBe('このファイルを見る権限がありません');
  });

  test('says the file is not found on a 404', async () => {
    routes = { [INFO]: mmError(404, 'app.file_info.get.app_error') };
    expect(await setup()('get_file', { file_id: F }, true)).toBe('ファイルが見つかりません（投稿が削除されたか、存在しません）');
  });

  test.each(['..', '.', 'a/b', '%2F', '../../posts/x', '%2e%2e', 'f'.repeat(25)])('rejects the file_id %j without calling Mattermost', async (file_id) => {
    routes = {};
    await setup()('get_file', { file_id }, true);
    expect(hits).toEqual([]);
  });

  test('does not log the image', async () => {
    const b = bytes(PNG);
    b.set(Buffer.from('SECRETPIXELS'), 16);
    routes = { [INFO]: info({ width: 200, height: 100 }), [PREVIEW]: preview(b) };
    await setup()('get_file', { file_id: F });
    const logged = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('get_file');
    expect(logged).not.toContain(Buffer.from(b).toString('base64').slice(16, 40));
    expect(logged).not.toContain('SECRETPIXELS');
  });
});

describe('read_channel', () => {
  const CH = 'c'.repeat(26);
  const TEAM = 't'.repeat(26);
  const p = (n: number, o: Record<string, unknown> = {}) => ({ id: id(n), user_id: 'u2', channel_id: CH, root_id: '', message: `m${n}`, create_at: 1000 + n, ...o });
  // Mattermost answers newest first and puts posts outside the page (the thread of the first unread post) in posts only.
  const list = (ns: number[], extra: number[] = []) => ({
    order: [...ns].sort((a, b) => b - a).map(id),
    posts: Object.fromEntries([...ns, ...extra].map((n) => [id(n), p(n)])),
  });
  const base = (crt = 'always_on', lastViewedAt = 1000): Record<string, Route> => ({
    [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: TEAM, type: 'O' }),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    'GET /config/client': () => ({ CollapsedThreads: crt }),
    'GET /users/me/preferences/display_settings/name/collapsed_reply_threads': () => Response.json({ id: 'app.preference.get.app_error', message: 'm', status_code: 400 }, { status: 400 }),
    [`GET /channels/${CH}/members/me`]: () => ({ channel_id: CH, last_viewed_at: lastViewedAt }),
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const shownIds = (out: string) => [...out.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];
  const query = (prefix: string) => new URLSearchParams(urls.find((u) => u.startsWith(prefix))!.split('?')[1]);

  test('without from, reads newest first, with no line about the direction', async () => {
    routes = { ...base(), [`GET /channels/${CH}/posts`]: () => list([1, 2, 3]) };
    const out = await setup()('read_channel', { channel: CH, limit: 2 });
    expect(shownIds(out)).toEqual([id(3), id(2)]);
    expect(out).not.toContain('古い順');
    expect(hits).not.toContain(`GET /channels/${CH}/members/me`);
    expect(query(`GET /channels/${CH}/posts`).get('per_page')).toBe('3');
    expect(query(`GET /channels/${CH}/posts`).get('skipFetchThreads')).toBe('true');
  });

  test('from unread starts at the first unread post, oldest first, asking for one more than the limit and ignoring posts outside order', async () => {
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => list([4, 5, 6], [0]) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 2 });
    expect(shownIds(out)).toEqual([id(4), id(5)]);
    expect(out).toContain('未読の先頭から古い順');
    const q = query(`GET /users/u1/channels/${CH}/posts/unread`);
    expect(Object.fromEntries(q)).toEqual({ limit_before: '0', limit_after: '3', collapsedThreads: 'true', skipFetchThreads: 'true' });
    expect(cursorIn(out)).toBeDefined();
  });

  test('the next page continues after the last post shown, oldest first, keeping the CRT decision of the first page', async () => {
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => list([4, 5, 6]), [`GET /channels/${CH}/posts`]: () => list([6, 7]) };
    const call = setup();
    const first = await call('read_channel', { channel: CH, from: 'unread', limit: 2 });
    routes['GET /config/client'] = () => ({ CollapsedThreads: 'disabled' });
    hits = []; urls = [];
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(shownIds(out)).toEqual([id(6), id(7)]);
    expect(Object.fromEntries(query(`GET /channels/${CH}/posts`))).toEqual({ after: id(5), per_page: '3', collapsedThreads: 'true', skipFetchThreads: 'true' });
    expect(hits).not.toContain('GET /config/client');
    expect(out).toContain('（続きはありません）');
    expect(out).toContain('ルート投稿だけ');
  });

  test('with CRT off, asks for replies too and says so', async () => {
    routes = { ...base('disabled'), [`GET /users/u1/channels/${CH}/posts/unread`]: () => list([4]) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread' });
    expect(query(`GET /users/u1/channels/${CH}/posts/unread`).get('collapsedThreads')).toBe('false');
    expect(out).toContain('返信も含みます');
    expect(out).not.toContain('ルート投稿だけ');
  });

  test('says there is nothing unread when Mattermost returns no posts', async () => {
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => ({ order: [], posts: {} }) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread' });
    expect(out).toContain('未読はありません。');
    expect(out).toContain('（続きはありません）');
  });

  test('with nothing unread, does not read again even if Mattermost names a post before', async () => {
    // Not a combination Mattermost gives today (prev_post_id is '' with nothing unread): it pins that an empty first page is never read again.
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => ({ order: [], posts: {}, prev_post_id: id(1) }) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread' });
    expect(out).toContain('未読はありません。');
    expect(hits).not.toContain(`GET /channels/${CH}/posts`);
  });

  test('when no read position is recorded, says so and reads newest first with a newest-first cursor', async () => {
    routes = { ...base('always_on', 0), [`GET /channels/${CH}/posts`]: () => list([1, 2, 3]) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 2 });
    expect(out).toContain('新しい順に読んでいます');
    expect(shownIds(out)).toEqual([id(3), id(2)]);
    expect(hits).not.toContain(`GET /users/u1/channels/${CH}/posts/unread`);
    expect(JSON.parse(Buffer.from(cursorIn(out)!, 'base64url').toString())).toMatchObject({ before: id(2) });
  });

  const membersMe = (status: number, mmId: string) => ({ ...base(), [`GET /channels/${CH}/members/me`]: () => Response.json({ id: mmId, message: 'm', status_code: status }, { status }) });

  const refused = (status: number) => ({ ...base(), 'GET /users/me/teams': () => [], [`GET /channels/${CH}`]: () => Response.json({ id: 'x', message: 'm', status_code: status }, { status }) });

  test('words 403 from fetching the channel as get_channel does', async () => {
    routes = refused(403);
    expect(await setup()('read_channel', { channel: CH }, true)).toBe('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
  });

  test('words 404 from fetching the channel, with no channel of that name either, as get_channel does', async () => {
    routes = refused(404);
    expect(await setup()('read_channel', { channel: CH }, true)).toBe('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
  });

  test('when members/me answers 404, says the user has not joined and to use from latest', async () => {
    routes = membersMe(404, 'app.channel.get_member.missing.app_error');
    const out = await setup()('read_channel', { channel: CH, from: 'unread' }, true);
    expect(out).toBe('このチャンネルに参加していないため、未読の位置がありません。from: "latest" で読んでください。');
    expect(out).not.toContain('再試行');
  });

  test('when members/me answers 403, says it may be not joined or a passing failure, without saying which', async () => {
    routes = membersMe(403, 'api.context.permissions.app_error');
    const out = await setup()('read_channel', { channel: CH, from: 'unread' }, true);
    expect(out).toBe('このチャンネルの未読の位置を取得できませんでした（参加していないか、Mattermost の一時的な障害）。参加していないなら from: "latest" で読んでください。参加しているはずなら、少し待ってから再試行してください。');
  });

  test('a newest-first cursor keeps reading newest first even with from unread', async () => {
    routes = { ...base('always_on', 0), [`GET /channels/${CH}/posts`]: () => list([1, 2, 3]) };
    const call = setup();
    const first = await call('read_channel', { channel: CH, from: 'unread', limit: 2 });
    hits = []; urls = [];
    await call('read_channel', { channel: CH, from: 'unread', cursor: cursorIn(first) });
    expect(hits).not.toContain(`GET /channels/${CH}/members/me`);
    expect(hits).not.toContain(`GET /users/u1/channels/${CH}/posts/unread`);
    expect(query(`GET /channels/${CH}/posts`).get('before')).toBe(id(2));
    expect(query(`GET /channels/${CH}/posts`).get('skipFetchThreads')).toBe('true');
  });

  test('a later unread page with no posts left says there are no posts rather than no unread', async () => {
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => list([4, 5, 6]), [`GET /channels/${CH}/posts`]: () => ({ order: [], posts: {} }) };
    const call = setup();
    const first = await call('read_channel', { channel: CH, from: 'unread', limit: 2 });
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(out).toContain('投稿はありません。');
    expect(out).not.toContain('未読はありません。');
  });

  test('orders unread posts with the same create_at by post_id', async () => {
    const same = (n: number) => ({ ...p(n), create_at: 5000 });
    routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: () => ({ order: [id(9), id(8)], posts: { [id(9)]: same(9), [id(8)]: same(8) } }) };
    const out = await setup()('read_channel', { channel: CH, from: 'unread' });
    expect(shownIds(out)).toEqual([id(8), id(9)]);
  });

  describe('the first unread page', () => {
    // Post 1 is read; posts 2 and 3 share the first unread millisecond.
    const corpus = [p(1), p(2, { create_at: 1010 }), p(3, { create_at: 1010 }), p(4, { create_at: 1020 }), p(5, { create_at: 1030 })];
    // Like Mattermost: posts/unread reads strictly after the first unread post, so post 3 is left out, and names the post before it.
    const unread = (prev: string) => () => ({ order: [id(5), id(4), id(2)], posts: Object.fromEntries(corpus.map((x) => [x.id, x])), prev_post_id: prev });
    // Like Mattermost: after= by create_at strictly later, the oldest per_page, listed newest first.
    const after = (req: Request) => {
      const q = new URL(req.url).searchParams;
      const t = corpus.find((x) => x.id === q.get('after'))?.create_at;
      const got = t === undefined ? [] : corpus.filter((x) => x.create_at > t).slice(0, Number(q.get('per_page'))).reverse();
      return { order: got.map((x) => x.id), posts: Object.fromEntries(got.map((x) => [x.id, x])) };
    };

    test.each([['always_on', 'true'], ['disabled', 'false']])('with CRT %s, reads again after the post before the first unread one, so posts of its millisecond are not left out', async (crt, collapsed) => {
      routes = { ...base(crt), [`GET /users/u1/channels/${CH}/posts/unread`]: unread(id(1)), [`GET /channels/${CH}/posts`]: after };
      const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 4 });
      expect(shownIds(out)).toEqual([id(2), id(3), id(4), id(5)]);
      expect(Object.fromEntries(query(`GET /channels/${CH}/posts`))).toEqual({ after: id(1), per_page: '5', collapsedThreads: collapsed, skipFetchThreads: 'true' });
      expect(out).toContain('（続きはありません）');
    });

    test('gives a cursor after the last post shown when more posts follow', async () => {
      routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: unread(id(1)), [`GET /channels/${CH}/posts`]: after };
      const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 3 });
      expect(shownIds(out)).toEqual([id(2), id(3), id(4)]);
      expect(JSON.parse(Buffer.from(cursorIn(out)!, 'base64url').toString())).toMatchObject({ channel_id: CH, after: id(4), crt: true });
    });

    test('keeps Mattermost\'s page when there is no post before the first unread one', async () => {
      routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: unread(''), [`GET /channels/${CH}/posts`]: after };
      const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 4 });
      expect(shownIds(out)).toEqual([id(2), id(4), id(5)]);
      expect(hits).not.toContain(`GET /channels/${CH}/posts`);
    });

    test('keeps Mattermost\'s page when the post before is gone by the second call', async () => {
      routes = { ...base(), [`GET /users/u1/channels/${CH}/posts/unread`]: unread(id(9)), [`GET /channels/${CH}/posts`]: after };
      const out = await setup()('read_channel', { channel: CH, from: 'unread', limit: 4 });
      expect(shownIds(out)).toEqual([id(2), id(4), id(5)]);
      expect(out).not.toContain('未読はありません');
    });
  });

  test('rejects an unread cursor issued for another channel', async () => {
    const OTHER = 'o'.repeat(26);
    routes = {
      ...base(), [`GET /users/u1/channels/${OTHER}/posts/unread`]: () => list([4, 5, 6]),
      [`GET /channels/${OTHER}`]: () => ({ id: OTHER, name: 'other', display_name: 'Other', team_id: TEAM, type: 'O' }),
      [`GET /channels/${OTHER}/members/me`]: () => ({ last_viewed_at: 1000 }),
    };
    const call = setup();
    const first = await call('read_channel', { channel: OTHER, from: 'unread', limit: 2 });
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) }, true);
    expect(out).toContain('cursor');
  });
});

describe('read_channel with since and until', () => {
  const CH = 'c'.repeat(26);
  const TEAM = 't'.repeat(26);
  const T0 = Date.parse('2026-11-03T00:00:00Z');
  type P = { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number };
  let corpus: P[];
  // Posts n = 0..count-1, one second apart from T0, so post n is at T0 + n s.
  const fill = (count: number, at = (n: number) => T0 + n * 1000) => {
    corpus = Array.from({ length: count }, (_, n) => ({ id: id(n), user_id: 'u2', channel_id: CH, root_id: '', message: `m${n}`, create_at: at(n) }));
  };
  const iso = (n: number) => new Date(T0 + n * 1000).toISOString();
  // Mattermost orders by create_at alone; posts of the same millisecond come by id descending here, as one order it may give.
  const byTie = (a: P, b: P) => (a.id < b.id ? 1 : -1);
  const byNewest = () => [...corpus].sort((a, b) => b.create_at - a.create_at || byTie(a, b));
  const byOldest = () => [...corpus].sort((a, b) => a.create_at - b.create_at || byTie(a, b));
  const asList = (ps: P[]) => ({ order: ps.map((p) => p.id), posts: Object.fromEntries(ps.map((p) => [p.id, p])) });
  // Like Mattermost: page/per_page by offset, newest first. after= takes the oldest per_page strictly later, before= the newest per_page strictly earlier,
  // both listed newest first and nothing when the cursor's post is gone. At most 200 per call.
  const postsRoute = (req: Request) => {
    const q = new URL(req.url).searchParams;
    const per = Math.min(Number(q.get('per_page')), 200);
    const at = (pid: string) => corpus.find((p) => p.id === pid)?.create_at;
    const after = q.get('after');
    const before = q.get('before');
    if (after) {
      const t = at(after);
      return asList(t === undefined ? [] : byOldest().filter((p) => p.create_at > t).slice(0, per).reverse());
    }
    if (before) {
      const t = at(before);
      return asList(t === undefined ? [] : byNewest().filter((p) => p.create_at < t).slice(0, per));
    }
    const k = Number(q.get('page') ?? 0);
    return asList(byNewest().slice(k * per, (k + 1) * per));
  };
  // Like Mattermost: the oldest post after last_viewed_at, then those strictly after it, listed newest first, naming the newest post before it.
  const unreadRoute = (viewed: number) => (req: Request) => {
    const after = Number(new URL(req.url).searchParams.get('limit_after'));
    const first = byOldest().find((p) => p.create_at > viewed);
    const prev = first ? byNewest().find((p) => p.create_at < first.create_at)?.id ?? '' : '';
    return { ...asList(first ? [first, ...byOldest().filter((p) => p.create_at > first.create_at).slice(0, after - 1)].reverse() : []), prev_post_id: prev };
  };
  const base = (): Record<string, Route> => ({
    [`GET /channels/${CH}`]: () => ({ id: CH, name: 'town', display_name: 'Town', team_id: TEAM, type: 'O' }),
    [`GET /teams/${TEAM}`]: () => ({ id: TEAM, name: 'team-a' }),
    [`GET /channels/${CH}/posts`]: postsRoute,
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
  });
  const shownIds = (out: string) => [...out.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];
  const pages = () => urls.filter((u) => u.startsWith(`GET /channels/${CH}/posts`)).map((u) => new URLSearchParams(u.split('?')[1]));
  const offsets = () => pages().filter((q) => q.has('page')).map((q) => Number(q.get('page')));

  test.each([
    [{ until: '2026-11-03T10:00' }, 'until は since と一緒に'],
    [{ since: '2026-11-03T10:00', from: 'latest' }, 'since と from は同時に指定できません'],
    [{ since: '2026-11-03T10:00', from: 'unread' }, 'since と from は同時に指定できません'],
    [{ since: '2026-11-03T10:00', until: '2026-11-03T10:00' }, 'until は since より後'],
    [{ since: '2026-11-03' }, 'since「2026-11-03」を日時として読めません'],
    [{ since: '2026-11-03T10:00', until: 'later' }, 'until「later」を日時として読めません'],
  ])('refuses %j before calling Mattermost', async (args, message) => {
    routes = base();
    const out = await setup()('read_channel', { channel: CH, ...args }, true);
    expect(out).toContain(message);
    expect(hits).toEqual([]);
  });

  test('reads from since, oldest first, including since itself and leaving out until itself, with replies, and says so', async () => {
    fill(10);
    corpus[4].root_id = id(1);
    routes = base();
    const out = await setup()('read_channel', { channel: CH, since: iso(3), until: iso(6) });
    expect(shownIds(out)).toEqual([id(3), id(4), id(5)]);
    expect(out).toContain('範囲: 2026-11-03T00:00:03Z | 2026-11-03T09:00:03+09:00 から 2026-11-03T00:00:06Z | 2026-11-03T09:00:06+09:00 の前まで、古い順（返信も含みます）');
    expect(out).toContain('（続きはありません）');
  });

  test('takes a time without a zone as JST', async () => {
    fill(10);
    routes = base();
    const out = await setup()('read_channel', { channel: CH, since: '2026-11-03T09:00:08' });
    expect(shownIds(out)).toEqual([id(8), id(9)]);
    expect(out).toContain('から 最新まで');
  });

  // Reads every page from the first call and returns the post ids in the order shown, with the last output.
  const readAll = async (call: ReturnType<typeof setup>, args: Record<string, unknown>) => {
    const seen: string[] = [];
    let out = await call('read_channel', { channel: CH, ...args });
    for (let i = 0; ; i++) {
      seen.push(...shownIds(out));
      const cursor = cursorIn(out);
      if (!cursor || i > 50) return { seen, out };
      out = await call('read_channel', { channel: CH, cursor });
    }
  };
  const unreadBase = (viewed: number): Record<string, Route> => ({
    ...base(),
    'GET /config/client': () => ({ CollapsedThreads: 'always_on' }),
    [`GET /channels/${CH}/members/me`]: () => ({ channel_id: CH, last_viewed_at: viewed }),
    [`GET /users/u1/channels/${CH}/posts/unread`]: unreadRoute(viewed),
  });
  const secs = (...t: number[]) => (n: number) => T0 + t[n] * 1000;
  const GONE = '続きを取りこぼしている可能性があります';

  test('newest first, the posts of the millisecond at the end of a page move to the next page, so none drops out', async () => {
    fill(10, secs(0, 1, 2, 3, 4, 5, 5, 5, 8, 9));
    routes = base();
    const { seen } = await readAll(setup(), { limit: 3 });
    expect(seen).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(id));
  });

  test('from unread, the posts of the millisecond at the end of a page move to the next page, so none drops out', async () => {
    fill(10, secs(0, 1, 2, 3, 4, 4, 4, 7, 8, 9));
    routes = unreadBase(T0 + 1000);
    const { seen } = await readAll(setup(), { from: 'unread', limit: 3 });
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(id));
  });

  test('in a range, the posts of the millisecond at the end of a page move to the next page, so none drops out', async () => {
    fill(10, secs(0, 1, 2, 3, 3, 3, 6, 7, 8, 9));
    routes = base();
    const { seen } = await readAll(setup(), { since: iso(1), limit: 3 });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(id));
  });

  test('in a range starting before the first post, the oldest page leaves the posts of its newest millisecond to the read after it', async () => {
    // Post 4, the newest of the oldest page by offset, shares its millisecond with post 5, which the offset puts on the page before.
    fill(205, (n) => T0 + (n <= 5 ? Math.min(n, 4) : n) * 1000);
    routes = base();
    const { seen } = await readAll(setup(), { since: new Date(T0 - 60_000).toISOString(), limit: 100 });
    expect(new Set(seen).size).toBe(205);
    expect(seen.length).toBe(205);
  });

  test('in a range, fetches once within a call when no millisecond is shared', async () => {
    fill(10);
    routes = base();
    await setup()('read_channel', { channel: CH, since: iso(1), limit: 3 });
    const reads = pages().filter((q) => q.has('after'));
    expect(reads).toHaveLength(1);
    expect(reads[0].get('per_page')).toBe('4');
  });

  test('in a range starting before the first post of a 201-post channel, the oldest page of one post starts the read and nothing drops out', async () => {
    fill(201);
    routes = base();
    const { seen } = await readAll(setup(), { since: new Date(T0 - 60_000).toISOString(), limit: 100 });
    expect(seen[0]).toBe(id(0));
    expect(new Set(seen).size).toBe(201);
  });

  test('when the start drifts before since and the page ends inside a millisecond, reading on keeps the rest of that millisecond', async () => {
    // Posts 18 to 22 are in range; 19, 20 and 21 share a millisecond that the first page of 4 cuts.
    fill(23, (n) => T0 + (n < 18 ? n : [20, 21, 21, 21, 25][n - 18]) * 1000);
    routes = base();
    let first = true;
    routes[`GET /channels/${CH}/posts`] = (req) => {
      const q = new URL(req.url).searchParams;
      if (q.has('after') && first) {
        first = false;
        // A post deleted during the search shifts the pages: the after= read starts at post 16, before since.
        return asList(byOldest().filter((p) => p.create_at >= T0 + 16_000).slice(0, Number(q.get('per_page'))));
      }
      return postsRoute(req);
    };
    const { seen } = await readAll(setup(), { since: iso(20), limit: 3 });
    expect(seen).toEqual([18, 19, 20, 21, 22].map(id));
  });

  test('when every post fetched shares one millisecond, still shows a full page and pages on from its last post', async () => {
    fill(5, () => T0);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, limit: 2 });
    expect(shownIds(first)).toEqual([id(4), id(3)]);
    expect(JSON.parse(Buffer.from(cursorIn(first)!, 'base64url').toString())).toMatchObject({ before: id(3) });
  });

  test.each([
    ['newest first', {}, 'cursor を渡さずに呼ぶと、最新から読み直せます', '投稿はありません。'],
    ['from unread', { from: 'unread' }, '前のページの最後の投稿の時刻を since に渡すと', '投稿はありません。'],
    ['in a range', { since: '2026-11-03T09:00:00' }, '前のページの最後の投稿の時刻を since に渡すと', 'この範囲に投稿はありません。'],
  ])('%s, a later page with nothing left after a deleted post says posts may have been missed and how to read again', async (_, args, how, none) => {
    fill(4);
    routes = unreadBase(T0 - 1);
    const call = setup();
    const first = await call('read_channel', { channel: CH, limit: 2, ...args });
    const last = shownIds(first).at(-1);
    corpus = corpus.filter((p) => p.id !== last);
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(out).toContain(none);
    expect(out).toContain(GONE);
    expect(out).toContain(how);
    expect(out).toContain('limit を大きくして読み直すと抜けにくくなります）');
    expect(out).not.toContain('until は前と同じ値');
  });

  test('a range cursor reads its page with one fetch when no millisecond is shared', async () => {
    fill(20);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(1), limit: 3 });
    hits = []; urls = [];
    await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(pages().filter((q) => q.has('after'))).toHaveLength(1);
  });

  test('a later range page with an until says to pass the same until again', async () => {
    fill(4);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(0), until: iso(10), limit: 2 });
    corpus = corpus.filter((p) => p.id !== shownIds(first).at(-1));
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(out).toContain(GONE);
    expect(out).toContain('until は前と同じ値を渡してください');
  });

  test('a first page with no posts says only that there are none, also for a range over an empty channel', async () => {
    corpus = [];
    routes = base();
    const call = setup();
    const range = await call('read_channel', { channel: CH, since: iso(0) });
    expect(range).toContain('この範囲に投稿はありません。');
    expect(range).not.toContain(GONE);
    const latest = await call('read_channel', { channel: CH });
    expect(latest).toContain('投稿はありません。');
    expect(latest).not.toContain(GONE);
    routes = unreadBase(T0);
    const unread = await call('read_channel', { channel: CH, from: 'unread' });
    expect(unread).toContain('未読はありません。');
    expect(unread).not.toContain(GONE);
  });

  test('every call asks Mattermost to skip fetching threads', async () => {
    fill(450);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(5), limit: 3 });
    await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(pages().length).toBeGreaterThan(3);
    expect(pages().every((q) => q.get('skipFetchThreads') === 'true')).toBe(true);
  });

  test('when page 0 holds a post before since, reads on after the newest such post without searching further', async () => {
    fill(150);
    routes = base();
    const out = await setup()('read_channel', { channel: CH, since: iso(100), limit: 5 });
    expect(offsets()).toEqual([0]);
    expect(pages()[1].get('after')).toBe(id(99));
    expect(shownIds(out)).toEqual([100, 101, 102, 103, 104].map(id));
  });

  test('widens the page by powers of two and narrows by halves to the first page holding a post before since', async () => {
    fill(2000);
    routes = base();
    // Post 300 is on page 8 (offsets 1600..1799 hold posts 399..200); pages 0..7 are all at or after since.
    const out = await setup()('read_channel', { channel: CH, since: iso(300), limit: 2 });
    expect(offsets()).toEqual([0, 1, 2, 4, 8, 6, 7]);
    expect(pages().find((q) => q.has('after'))!.get('after')).toBe(id(299));
    expect(shownIds(out)).toEqual([id(300), id(301)]);
  });

  test('when the widening reaches an empty page, still finds an earlier page holding a post before since', async () => {
    fill(1150);
    routes = base();
    // Pages 0..4 are full, page 5 holds posts 149..0 and pages from 6 on are empty, so page 8 is empty; post 120 is on page 5.
    const out = await setup()('read_channel', { channel: CH, since: iso(120), limit: 2 });
    expect(offsets()).toEqual([0, 1, 2, 4, 8, 6, 5]);
    expect(shownIds(out)).toEqual([id(120), id(121)]);
  });

  test('when every post is at or after since, starts from the oldest post of the channel, including it', async () => {
    fill(450);
    routes = base();
    const call = setup();
    const out = await call('read_channel', { channel: CH, since: iso(-60), limit: 3 });
    expect(shownIds(out)).toEqual([id(0), id(1), id(2)]);
    const next = await call('read_channel', { channel: CH, cursor: cursorIn(out) });
    expect(shownIds(next)).toEqual([id(3), id(4), id(5)]);
  });

  test('from the oldest post, stops at until without reading further', async () => {
    fill(150);
    routes = base();
    const out = await setup()('read_channel', { channel: CH, since: iso(-60), until: iso(2) });
    expect(shownIds(out)).toEqual([id(0), id(1)]);
    expect(pages().some((q) => q.has('after'))).toBe(false);
    expect(out).toContain('（続きはありません）');
  });

  test('says when the channel has no posts', async () => {
    fill(0);
    routes = base();
    const out = await setup()('read_channel', { channel: CH, since: iso(0) });
    expect(out).toContain('この範囲に投稿はありません。');
    expect(offsets()).toEqual([0]);
  });

  test('pages on with the cursor, keeping since and until, and ends when the post after the page is at until', async () => {
    fill(20);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(2), until: iso(8), limit: 3 });
    expect(shownIds(first)).toEqual([id(2), id(3), id(4)]);
    hits = []; urls = [];
    const second = await call('read_channel', { channel: CH, since: iso(0), cursor: cursorIn(first) });
    expect(shownIds(second)).toEqual([id(5), id(6), id(7)]);
    expect(Object.fromEntries(pages()[0])).toEqual({ after: id(4), per_page: '4', skipFetchThreads: 'true' });
    expect(second).toContain('の前まで');
    expect(second).toContain('（続きはありません）');
  });

  test('without until, a later page also shows posts that arrived after the first page', async () => {
    fill(5);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(1), limit: 2 });
    corpus.push({ id: id(5), user_id: 'u2', channel_id: CH, root_id: '', message: 'm5', create_at: T0 + 5000 });
    const second = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(shownIds(second)).toEqual([id(3), id(4)]);
    expect(shownIds(await call('read_channel', { channel: CH, cursor: cursorIn(second) }))).toEqual([id(5)]);
  });

  test('when the start drifts before since, drops those posts and reads on until the page is full', async () => {
    fill(30);
    routes = base();
    // A post deleted during the search shifts the pages: here the after= reads start well before since.
    let first = true;
    routes[`GET /channels/${CH}/posts`] = (req) => {
      const q = new URL(req.url).searchParams;
      if (q.has('after') && first) {
        first = false;
        return asList(corpus.slice(10, 10 + Number(q.get('per_page'))));
      }
      return postsRoute(req);
    };
    const out = await setup()('read_channel', { channel: CH, since: iso(20), limit: 3 });
    expect(shownIds(out)).toEqual([id(20), id(21), id(22)]);
    expect(cursorIn(out)).toBeDefined();
  });

  test('a range cursor is not taken for an unread or newest-first cursor, nor the other way round', async () => {
    fill(10);
    routes = base();
    const call = setup();
    const range = await call('read_channel', { channel: CH, since: iso(1), limit: 2 });
    hits = []; urls = [];
    await call('read_channel', { channel: CH, cursor: cursorIn(range) });
    expect(pages().every((q) => !q.has('collapsedThreads') && !q.has('before'))).toBe(true);
    const latest = await call('read_channel', { channel: CH, limit: 2 });
    hits = []; urls = [];
    const next = await call('read_channel', { channel: CH, cursor: cursorIn(latest) });
    expect(next).not.toContain('範囲:');
    expect(pages()[0].get('before')).toBe(id(8));
  });

  test('with a range cursor, does not check since, until or from', async () => {
    fill(10);
    routes = base();
    const call = setup();
    const first = await call('read_channel', { channel: CH, since: iso(1), limit: 2 });
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first), until: 'x', from: 'unread' });
    expect(shownIds(out)).toEqual([id(3), id(4)]);
  });

  test('an unread cursor still reads on as unread, with the CRT decision', async () => {
    fill(10);
    routes = { ...base(), [`GET /channels/${CH}/members/me`]: () => ({ last_viewed_at: T0 }), 'GET /config/client': () => ({ CollapsedThreads: 'always_on' }), [`GET /users/u1/channels/${CH}/posts/unread`]: () => asList(corpus.slice(1, 4).reverse()) };
    const call = setup();
    const first = await call('read_channel', { channel: CH, from: 'unread', limit: 2 });
    hits = []; urls = [];
    const out = await call('read_channel', { channel: CH, cursor: cursorIn(first) });
    expect(out).not.toContain('範囲:');
    expect(pages()[0].get('collapsedThreads')).toBe('true');
  });

  test('rejects a range cursor issued for another channel', async () => {
    const OTHER = 'o'.repeat(26);
    fill(10);
    routes = { ...base(), [`GET /channels/${OTHER}`]: () => ({ id: OTHER, name: 'other', display_name: 'Other', team_id: TEAM, type: 'O' }), [`GET /channels/${OTHER}/posts`]: postsRoute };
    const call = setup();
    const first = await call('read_channel', { channel: OTHER, since: iso(1), limit: 2 });
    expect(await call('read_channel', { channel: CH, cursor: cursorIn(first) }, true)).toContain('cursor');
  });
});

describe('list_saved_posts', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const FLAGGED = 'GET /users/u1/posts/flagged';
  const post = (id: string, create_at: number) => ({ id, user_id: 'u1', channel_id: C, root_id: '', message: `m ${id}`, create_at });
  const pid = (n: number) => `s${String(n).padStart(25, '0')}`;
  const list = (ps: { id: string }[]) => ({ order: ps.map((p) => p.id), posts: Object.fromEntries(ps.map((p) => [p.id, p])) });
  const byOffset = (all: ReturnType<typeof post>[]) => (req: Request) => {
    const q = new URL(req.url).searchParams;
    const at = Number(q.get('page'));
    return list(all.slice(at, at + Number(q.get('per_page'))));
  };
  const inTurn = (pages: ReturnType<typeof post>[][]) => {
    let n = 0;
    return () => list(pages[n++] ?? []);
  };
  const base = () => ({
    'GET /users/me/channels': () => [{ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O' }],
    'GET /users/me/teams': () => [{ id: T, name: 'team-a' }],
    'POST /users/ids': () => [{ id: 'u1', username: 'alice' }],
  });
  const shownIds = (out: string) => [...out.matchAll(/^--- post_id: ([a-z0-9]{26})/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];
  const asked = (key: string) => urls.filter((u) => u.startsWith(FLAGGED)).map((u) => Number(new URL(`http://x${u.slice(4)}`).searchParams.get(key)));
  const offsets = () => asked('page');
  const NOTE = '新しい 1000 件だけ';

  test('puts the real team before the channel on a joined line, so a display name ending in a fake team comes after it', async () => {
    routes = { ...base(), 'GET /users/me/channels': () => [{ id: C, name: 'town', display_name: 'Town | チーム: evil（team_id: fake）', team_id: T, type: 'O' }],
      [FLAGGED]: byOffset([post('x'.repeat(26), 2)]) };
    const out = await setup()('list_saved_posts', {});
    expect(out).toContain(`チーム: team-a（team_id: ${T}） | チャンネル: channel_id: ${C}、name: town、表示名: Town | チーム: evil（team_id: fake）`);
    expect(out.indexOf(`team_id: ${T}`)).toBeLessThan(out.indexOf('team_id: fake'));
  });

  test('labels a saved post in an archived channel with that channel and builds the permalink from its team', async () => {
    const OLD = 'g'.repeat(26);
    const T2 = 'u'.repeat(26);
    routes = { ...base(),
      'GET /users/me/teams': () => [{ id: T, name: 'team-a' }, { id: T2, name: 'team-b' }],
      // Mattermost lists an archived channel only when include_deleted is true.
      'GET /users/me/channels': (req) => [
        { id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O', delete_at: 0 },
        ...(new URL(req.url).searchParams.get('include_deleted') === 'true' ? [{ id: OLD, name: 'old', display_name: 'Old', team_id: T2, type: 'O', delete_at: 5 }] : []),
      ],
      [FLAGGED]: byOffset([{ ...post('x'.repeat(26), 2), channel_id: OLD }, post('y'.repeat(26), 1)]) };
    const out = await setup()('list_saved_posts', {});
    expect(urls).toContain('GET /users/me/channels?include_deleted=true');
    expect(out).toContain(`チーム: team-b（team_id: ${T2}） | チャンネル: channel_id: ${OLD}、name: old、表示名: Old（アーカイブ済み）`);
    expect(out).toContain(`チーム: team-a（team_id: ${T}） | チャンネル: channel_id: ${C}、name: town、表示名: Town`);
    expect(out).toContain(`https://mm.example/team-b/pl/${'x'.repeat(26)}`);
  });

  test('lists the saved posts newest first (ties by post_id) with their channel and team', async () => {
    const [a, b, c] = [post('b'.repeat(26), 2000), post('a'.repeat(26), 2000), post('c'.repeat(26), 3000)];
    routes = { ...base(), [FLAGGED]: byOffset([a, b, c]) };
    const out = await setup()('list_saved_posts', {});
    expect(shownIds(out)).toEqual([c.id, b.id, a.id]);
    expect(out).toContain(`channel_id: ${C}、name: town`);
    expect(out).toContain(`チーム: team-a（team_id: ${T}）`);
    expect(out).toContain('（続きはありません）');
  });

  test('a cursor pages on without gaps or duplicates and keeps the page size', async () => {
    const all = Array.from({ length: 5 }, (_, i) => post(pid(i), 10_000 - i));
    routes = { ...base(), [FLAGGED]: byOffset(all) };
    const call = setup();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const out = await call('list_saved_posts', cursor ? { limit: 50, cursor } : { limit: 2 });
      seen.push(...shownIds(out));
      cursor = cursorIn(out);
      if (cursor) expect(shownIds(out)).toHaveLength(2);
    } while (cursor);
    expect(seen).toEqual(all.map((p) => p.id));
  });

  test('reads limit + 21 rows first, then 200 rows at a time each starting 20 rows back, as row offsets in page, until an empty page', async () => {
    const all = Array.from({ length: 401 }, (_, i) => post(pid(i), 5000));
    routes = { ...base(), [FLAGGED]: byOffset(all) };
    await setup()('list_saved_posts', {});
    expect(offsets()).toEqual([0, 21, 201, 381, 561]);
    expect(asked('per_page')).toEqual([41, 200, 200, 200, 200]);
  });

  test('stops after the first read once it filled the page and reached older posts', async () => {
    routes = { ...base(), [FLAGGED]: byOffset(Array.from({ length: 450 }, (_, i) => post(pid(i), 10_000 - i))) };
    const out = await setup()('list_saved_posts', { limit: 20 });
    expect(offsets()).toEqual([0]);
    expect(asked('per_page')).toEqual([41]);
    expect(shownIds(out)).toHaveLength(20);
    expect(cursorIn(out)).toBeDefined();
  });

  test('reads on when the oldest post of the last read has the same time as the last one shown', async () => {
    routes = { ...base(), [FLAGGED]: byOffset(Array.from({ length: 201 }, (_, i) => post(pid(i), 5000))) };
    await setup()('list_saved_posts', { limit: 2 });
    expect(offsets()).toEqual([0, 3, 183, 363]);
  });

  test('does not stop with exactly limit posts, as it cannot tell yet whether more follow', async () => {
    routes = { ...base(), [FLAGGED]: byOffset(Array.from({ length: 20 }, (_, i) => post(pid(i), 10_000 - i))) };
    const out = await setup()('list_saved_posts', { limit: 20 });
    expect(offsets()).toEqual([0, 21]);
    expect(cursorIn(out)).toBeUndefined();
  });

  test('does not stop at a short read, which permission filtering can cause, but at an empty one', async () => {
    const all = Array.from({ length: 60 }, (_, i) => post(pid(i), 10_000 - i));
    const hidden = new Set(all.slice(5, 41).map((p) => p.id));
    routes = { ...base(), [FLAGGED]: (req: Request) => list(byOffset(all)(req).order.filter((id) => !hidden.has(id)).map((id) => all.find((p) => p.id === id)!)) };
    const out = await setup()('list_saved_posts', { limit: 20 });
    expect(offsets()).toEqual([0, 21]);
    expect(shownIds(out)).toEqual([...all.slice(0, 5), ...all.slice(41, 56)].map((p) => p.id));
  });

  test('reads the first rows again 200 at a time when the small first read comes back empty, as all of its rows may be ones the user may not read', async () => {
    const all = Array.from({ length: 60 }, (_, i) => post(pid(i), 10_000 - i));
    routes = { ...base(), [FLAGGED]: (req: Request) => (new URL(req.url).searchParams.get('per_page') === '41' ? list([]) : byOffset(all)(req)) };
    const out = await setup()('list_saved_posts', { limit: 20 });
    expect(offsets()).toEqual([0, 0]);
    expect(asked('per_page')).toEqual([41, 200]);
    expect(shownIds(out)).toEqual(all.slice(0, 20).map((p) => p.id));
  });

  test('shows a post that comes in two reads once', async () => {
    const [a, b, c] = [post(pid(1), 3000), post(pid(2), 2000), post(pid(3), 1000)];
    routes = { ...base(), [FLAGGED]: inTurn([[a, b], [b, c]]) };
    expect(shownIds(await setup()('list_saved_posts', {}))).toEqual([a.id, b.id, c.id]);
  });

  // For limit 1 the reads cover rows 0-21, 2-201 and 182-381, so rows 2-22 and 182-202 are 21 rows across the end of a read, 20 before it and 1 after.
  // The first case needs the second read to start back at row 2, the second case needs the full 20 rows of overlap.
  test.each([
    ['the small first read', 2, 0],
    ['a read of 200', 182, 1],
  ])('misses no post of a group of 21 with the same time across the end of %s, though the next read orders the group the other way', async (_, before, descRead) => {
    const all = [
      ...Array.from({ length: before }, (_, i) => post(pid(i), 10_000 - i)),
      ...Array.from({ length: 21 }, (_, i) => post(pid(1000 + i), 5000)),
      ...Array.from({ length: 30 }, (_, i) => post(pid(2000 + i), 1000 - i)),
    ];
    // The read that ends inside the group puts its smallest post_id after the end; the next read puts it first, where that read starts.
    let reads = 0;
    routes = { ...base(), [FLAGGED]: (req: Request) => {
      const desc = reads++ === descRead;
      return byOffset([...all].sort((x, y) => y.create_at - x.create_at || (desc ? y.id.localeCompare(x.id) : x.id.localeCompare(y.id))))(req);
    } };
    const last = all[before - 1];
    const out = await setup()('list_saved_posts', { cursor: Buffer.from(JSON.stringify({ create_at: last.create_at, id: last.id, per_page: 1 })).toString('base64url') });
    expect(shownIds(out)).toEqual([pid(1000)]);
  });

  test('reads up to row 1000 and then says only the newest 1000 were looked at, on pages with and without a cursor', async () => {
    const all = Array.from({ length: 1100 }, (_, i) => post(pid(i), 5000));
    routes = { ...base(), [FLAGGED]: byOffset(all) };
    const call = setup();
    const first = await call('list_saved_posts', { limit: 50 });
    expect(offsets()).toEqual([0, 51, 231, 411, 591, 771, 951, 1000]);
    expect(asked('per_page')).toEqual([71, 200, 200, 200, 200, 200, 49, 20]);
    expect(first).toContain(NOTE);
    const cursor = cursorIn(first);
    expect(cursor).toBeDefined();
    const lastId = pid(999);
    const end = await call('list_saved_posts', { cursor: Buffer.from(JSON.stringify({ create_at: 5000, id: lastId, per_page: 50 })).toString('base64url') });
    expect(end).toContain(NOTE);
    expect(end).not.toContain('保存した投稿はありません。');
    expect(cursorIn(end)).toBeUndefined();
  });

  test('does not add the note when nothing comes after row 1000, though it read up to there', async () => {
    routes = { ...base(), [FLAGGED]: byOffset(Array.from({ length: 990 }, (_, i) => post(pid(i), 5000))) };
    const out = await setup()('list_saved_posts', { limit: 50 });
    expect(offsets()).toEqual([0, 51, 231, 411, 591, 771, 951, 1000]);
    expect(out).not.toContain(NOTE);
  });

  describe('a cursor carries the row of the last post shown, and the next page starts reading 20 rows before it', () => {
    const desc = (n: number, from = 0) => Array.from({ length: n }, (_, i) => post(pid(from + i), 100_000 - from - i));
    const cursorAt = (p: { id: string; create_at: number }, at: number, per = 50) => Buffer.from(JSON.stringify({ create_at: p.create_at, id: p.id, per_page: per, at })).toString('base64url');
    const atIn = (out: string) => JSON.parse(Buffer.from(cursorIn(out)!, 'base64url').toString()).at;

    test('reads limit + 41 rows from there once, and gives the next cursor the row of its last post', async () => {
      const all = desc(300);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      const call = setup();
      const first = await call('list_saved_posts', { limit: 50 });
      expect(atIn(first)).toBe(49);
      urls.length = 0;
      const second = await call('list_saved_posts', { cursor: cursorIn(first) });
      expect(offsets()).toEqual([29]);
      expect(asked('per_page')).toEqual([91]);
      expect(shownIds(second)).toEqual(all.slice(50, 100).map((p) => p.id));
      expect(atIn(second)).toBe(99);
    });

    test('reads from row 0, as from the start, with a cursor that has no row', async () => {
      const all = desc(300);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      const old = Buffer.from(JSON.stringify({ create_at: all[49].create_at, id: all[49].id, per_page: 50 })).toString('base64url');
      const out = await setup()('list_saved_posts', { cursor: old });
      expect(offsets()).toEqual([0, 51]);
      expect(asked('per_page')).toEqual([71, 200]);
      expect(shownIds(out)).toEqual(all.slice(50, 100).map((p) => p.id));
    });

    test('pages through every post once, in order, with the row in each cursor', async () => {
      const all = desc(300);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      const call = setup();
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const out = await call('list_saved_posts', cursor ? { cursor } : { limit: 50 });
        seen.push(...shownIds(out));
        cursor = cursorIn(out);
      } while (cursor);
      expect(seen).toEqual(all.map((p) => p.id));
    });

    test('keeps the read when posts saved since put newer posts at its start', async () => {
      const all = desc(300, 100);
      routes = { ...base(), [FLAGGED]: byOffset([...desc(30), ...all]) };
      const out = await setup()('list_saved_posts', { cursor: cursorAt(all[49], 49) });
      expect(offsets()[0]).toBe(29);
      expect(shownIds(out)).toEqual(all.slice(50, 100).map((p) => p.id));
    });

    test.each([
      ['posts unsaved since moved older posts to its start', 30, desc(270, 30), 49],
      ['it starts inside a group of the same time as the last post shown', 0, [...desc(10), ...Array.from({ length: 290 }, (_, i) => post(pid(500 + i), 5000))], 49],
      ['the row is past the last saved post', 0, desc(300), 500],
    ] as const)('reads again from row 0 when %s', async (_, gone, list, at) => {
      routes = { ...base(), [FLAGGED]: byOffset([...list]) };
      const last = gone ? desc(50)[49] : list[49];
      const out = await setup()('list_saved_posts', { cursor: cursorAt(last, at) });
      expect(offsets().slice(0, 2)).toEqual([at - 20, 0]);
      const want = [...list].sort((x, y) => y.create_at - x.create_at || x.id.localeCompare(y.id)).filter((p) => p.create_at < last.create_at || (p.create_at === last.create_at && p.id > last.id)).slice(0, 50);
      expect(shownIds(out)).toEqual(want.map((p) => p.id));
    });

    test('reads on from there when the row is far before the last post shown', async () => {
      const all = desc(300);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      const out = await setup()('list_saved_posts', { cursor: cursorAt(all[149], 25) });
      expect(offsets()).toEqual([5, 76]);
      expect(shownIds(out)).toEqual(all.slice(150, 200).map((p) => p.id));
    });

    test.each([
      [10, 'row 0, as from the start', 0, 71],
      [20, 'row 0, as from the start', 0, 71],
      [21, 'row 1', 1, 91],
      [1000, 'row 0, as the row is past the 1000 it reads', 0, 71],
    ])('with the row at %i, reads from %s', async (at, _, from, size) => {
      const all = desc(1100);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      await setup()('list_saved_posts', { cursor: cursorAt(all[Math.min(at, 999)], at) });
      expect(offsets()[0]).toBe(from);
      expect(asked('per_page')[0]).toBe(size);
    });

    test('near row 1000, reads only up to row 1000 and shows nothing after it', async () => {
      const all = desc(1100);
      routes = { ...base(), [FLAGGED]: byOffset(all) };
      const out = await setup()('list_saved_posts', { cursor: cursorAt(all[990], 990) });
      expect(offsets()).toEqual([970, 1000]);
      expect(asked('per_page')).toEqual([30, 20]);
      expect(shownIds(out)).toEqual(all.slice(991, 1000).map((p) => p.id));
      expect(out).toContain(NOTE);
      expect(cursorIn(out)).toBeUndefined();
    });
  });

  test('does not add the note when the last read before row 1000 is not empty and the stop condition holds', async () => {
    const all = [...Array.from({ length: 975 }, (_, i) => post(pid(i), 5000)), ...Array.from({ length: 125 }, (_, i) => post(pid(975 + i), 1000 - i))];
    routes = { ...base(), [FLAGGED]: byOffset(all) };
    const out = await setup()('list_saved_posts', { limit: 50 });
    expect(offsets()).toEqual([0, 51, 231, 411, 591, 771, 951]);
    expect(out).not.toContain(NOTE);
  });

  test('looks up the names of the users who reacted, and notes a post whose message attachments were cut, as search_posts does', async () => {
    const p = { ...post('r'.repeat(26), 1000), props: { attachments: [{ text: 'x'.repeat(4001) }] }, metadata: { reactions: [{ user_id: 'u2', emoji_name: '+1', create_at: 1 }] } };
    routes = { ...base(), [FLAGGED]: byOffset([p]), 'POST /users/ids': () => [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }] };
    const out = await setup()('list_saved_posts', {});
    expect(bodies['/users/ids']).toEqual(['u1', 'u2']);
    expect(out).toContain('リアクション: :+1: 1（@bob）');
    expect(out).toContain('（本文かメッセージ添付を 4000 文字で切った投稿があります）');
  });

  test('says when nothing is saved', async () => {
    routes = { ...base(), [FLAGGED]: byOffset([]) };
    const out = await setup()('list_saved_posts', {});
    expect(out).toContain('保存した投稿はありません。');
    expect(hits).not.toContain('GET /users/me/channels');
  });

  test('rejects a cursor from another tool', async () => {
    routes = base();
    const out = await setup()('list_saved_posts', { cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 20 })).toString('base64url') }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });
});

describe('search_files', () => {
  const A = 'a'.repeat(26);
  const B = 'b'.repeat(26);
  const DM = 'd'.repeat(26);
  const TA = 't'.repeat(26);
  const TB = 's'.repeat(26);
  const F1 = 'f'.repeat(26);
  const F2 = 'g'.repeat(26);
  const P1 = 'p'.repeat(26);
  const file = (id: string, extra: Record<string, unknown> = {}) => ({
    id, name: `${id.slice(0, 3)}.pdf`, extension: 'pdf', mime_type: 'application/pdf', size: 1234, user_id: 'u2', post_id: P1, channel_id: A, create_at: Date.UTC(2026, 9, 1, 0, 0, 0), ...extra,
  });
  const found = (fs: ReturnType<typeof file>[]) => ({ order: fs.map((f) => f.id), file_infos: Object.fromEntries(fs.map((f) => [f.id, f])) });
  const mmError = (status: number, id = 'x') => () => Response.json({ id, message: 'm', status_code: status }, { status });
  let searched: string[] = [];
  const onlyAsked = () => searched.every((t) => t === '*');
  const base = () => {
    searched = [];
    return {
    'POST /files/search': () => {
      const t = (bodies['/files/search'] as { terms: string }).terms;
      searched.push(t);
      return t === '*' ? found([]) : found([file(F1)]);
    },
    'GET /users/me/channels': () => [{ id: A, name: 'town', display_name: 'Town', team_id: TA, type: 'O' }],
    'GET /users/me/teams': () => [{ id: TA, name: 'team-a' }, { id: TB, name: 'team-b' }],
    'POST /users/ids': () => [{ id: 'u2', username: 'bob' }],
    [`GET /teams/${TA}/channels/name/town`]: () => ({ id: A, name: 'town', display_name: 'Town', team_id: TA, type: 'O' }),
    [`GET /teams/${TA}/channels/name/dup`]: () => ({ id: A, name: 'dup', display_name: 'Dup', team_id: TA, type: 'O' }),
    [`GET /teams/${TB}/channels/name/dup`]: () => ({ id: B, name: 'dup', display_name: 'Dup', team_id: TB, type: 'O' }),
    'GET /teams/name/team-b/channels/name/dup': () => ({ id: B, name: 'dup', display_name: 'Dup', team_id: TB, type: 'O' }),
    [`GET /channels/${B}`]: () => ({ id: B, name: 'dup', display_name: 'Dup', team_id: TB, type: 'O' }),
    [`GET /teams/${TB}`]: () => ({ id: TB, name: 'team-b' }),
    'GET /users/username/bob': () => ({ id: 'u2', username: 'bob' }),
    'GET /users/username/carol': () => ({ id: 'u3', username: 'carol' }),
    [`GET /teams/${TA}/channels/name/u1__u2`]: () => ({ id: DM, name: 'u1__u2', display_name: '', team_id: '', type: 'D' }),
    [`GET /teams/${TB}/channels/name/u1__u2`]: () => ({ id: DM, name: 'u1__u2', display_name: '', team_id: '', type: 'D' }),
    };
  };
  const sent = () => (bodies['/files/search'] as { terms: string }).terms;
  const terms = async (t: string) => {
    routes = base();
    await setup()('search_files', { terms: t });
    return sent();
  };

  test('searches all teams once in JST, asking for 100, without paging Mattermost', async () => {
    routes = base();
    await setup()('search_files', { terms: 'report ext:pdf', limit: 50 });
    expect(bodies['/files/search']).toEqual({ terms: 'report ext:pdf', is_or_search: false, include_deleted_channels: false, time_zone_offset: 32400, page: 0, per_page: 100 });
    expect(hits.filter((h) => h.includes('files/search'))).toEqual(['POST /files/search']);
  });

  test('shows each file with its file_id, uploader, time, channel and team, post_id and permalink', async () => {
    routes = base();
    const out = await setup()('search_files', { terms: 'fff' });
    expect(out).toContain('ファイルの検索: fff');
    expect(out).toContain(`file_id: ${F1}、種類: application/pdf、1234 バイト、名前: fff.pdf`);
    expect(out).toContain('@bob | 2026-10-01T00:00:00Z | 2026-10-01T09:00:00+09:00');
    expect(out).toContain(`チーム: team-a（team_id: ${TA}） | チャンネル: channel_id: ${A}、name: town、表示名: Town`);
    expect(out).toContain(`post_id: ${P1}`);
    expect(out).toContain(`https://mm.example/team-a/pl/${P1}`);
  });

  test('marks a channel bookmark file, which has no post, without looking up its uploader', async () => {
    routes = { ...base(), 'POST /files/search': () => found([file(F1, { post_id: '', user_id: 'bookmark' })]) };
    const out = await setup()('search_files', { terms: 'fff' });
    expect(out).toContain('チャンネルのブックマークのファイル（投稿なし）');
    expect(out).not.toContain('post_id:');
    expect(hits).not.toContain('POST /users/ids');
  });

  test('looks up, once, a channel the listing lacks, as one archived after the search, for its line and team', async () => {
    routes = {
      ...base(),
      'POST /files/search': () => found([file(F1, { channel_id: B }), file(F2, { channel_id: B })]),
      [`GET /channels/${B}`]: () => ({ id: B, name: 'dup', display_name: 'Dup', team_id: TB, type: 'O', delete_at: 1 }),
    };
    const out = await setup()('search_files', { terms: 'fff' });
    expect(out).toContain('Dup（アーカイブ済み）');
    expect(out).toContain(`https://mm.example/team-b/pl/${P1}`);
    expect(hits.filter((h) => h === `GET /channels/${B}`)).toHaveLength(1);
  });

  test.each([403, 404])('shows only the channel_id when the channel the listing lacks answers %i', async (status) => {
    const GONE = 'z'.repeat(26);
    routes = { ...base(), 'POST /files/search': () => found([file(F1, { channel_id: GONE })]), [`GET /channels/${GONE}`]: mmError(status) };
    const out = await setup()('search_files', { terms: 'fff' });
    expect(out).toContain(`channel_id: ${GONE}`);
    expect(out).toContain(`https://mm.example/team-a/pl/${P1}`);
  });

  test('fails rather than guessing the team when looking up a channel the listing lacks fails otherwise', async () => {
    routes = { ...base(), 'POST /files/search': () => found([file(F1, { channel_id: B })]), [`GET /channels/${B}`]: mmError(500) };
    await setup()('search_files', { terms: 'fff' }, true);
  });

  test('pages through the 100 results with limit, a cursor keeping the page size, and notes the 100-result cap', async () => {
    const all = Array.from({ length: 100 }, (_, i) => file(`f${String(i).padStart(25, '0')}`, { create_at: 10_000 - i }));
    routes = { ...base(), 'POST /files/search': () => found(all) };
    const call = setup();
    const first = await call('search_files', { terms: 'x', limit: 30 });
    expect(first).toContain('これより古い一致');
    const ids = (out: string) => [...out.matchAll(/file_id: (f\d{25})/g)].map((m) => m[1]);
    expect(ids(first)).toEqual(all.slice(0, 30).map((f) => f.id));
    const cursor = /next_cursor: (\S+)/.exec(first)![1];
    expect(ids(await call('search_files', { terms: 'x', limit: 5, cursor }))).toEqual(all.slice(30, 60).map((f) => f.id));
    routes['POST /files/search'] = () => found(all.slice(0, 99));
    expect(await call('search_files', { terms: 'x' })).not.toContain('これより古い一致');
  });

  test('says when nothing matches', async () => {
    routes = { ...base(), 'POST /files/search': () => found([]) };
    expect(await setup()('search_files', { terms: 'x' })).toContain('一致するファイルはありません。');
  });

  test('says file search is turned off when Mattermost answers 501 store.sql_file_info.search.disabled', async () => {
    routes = { ...base(), 'POST /files/search': mmError(501, 'store.sql_file_info.search.disabled') };
    const out = await setup()('search_files', { terms: 'x' }, true);
    expect(out).toBe('この Mattermost ではファイルの検索が無効になっています（システムコンソールの設定）。ファイル名を含む投稿は search_posts で探せます。');
  });

  test('lists the user\'s channels without archived ones, which the file search leaves out, and looks no listed channel up', async () => {
    routes = base();
    await setup()('search_files', { terms: 'fff' });
    expect(urls).toContain('GET /users/me/channels');
    expect(urls.filter((u) => u.startsWith('GET /users/me/channels')).every((u) => !u.includes('include_deleted'))).toBe(true);
    expect(hits.some((h) => h.startsWith('GET /channels/'))).toBe(false);
  });

  test('rejects a search_posts cursor, which has the same page and per_page', async () => {
    routes = base();
    const out = await setup()('search_files', { terms: 'x', cursor: Buffer.from(JSON.stringify({ page: 1, per_page: 20 })).toString('base64url') }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });

  describe('on a server with file search turned off', () => {
    const off = () => ({ ...base(), 'POST /files/search': () => {
      searched.push((bodies['/files/search'] as { terms: string }).terms);
      return Response.json({ id: 'store.sql_file_info.search.disabled', message: 'm', status_code: 501 }, { status: 501 });
    } });

    test('says file search is off rather than that an in: channel is not found, asking with "*" only', async () => {
      routes = off();
      expect(await setup()('search_files', { terms: 'x in:nowhere' }, true)).toContain('ファイルの検索が無効になっています');
      expect(searched).toEqual(['*']);
    });

    test('says file search is off for terms that resolve, without asking first', async () => {
      routes = off();
      expect(await setup()('search_files', { terms: 'x in:town' }, true)).toContain('ファイルの検索が無効になっています');
      expect(searched).toEqual([`x in:${A}`]);
    });
  });

  test('on a server with file search on, an in: that cannot be resolved is reported after one "*" request', async () => {
    routes = base();
    expect(await setup()('search_files', { terms: 'x in:nowhere' }, true)).toBe('チャンネル「nowhere」が見つかりません。');
    expect(searched).toEqual(['*']);
  });

  test('an in: that resolves is searched without asking first', async () => {
    routes = base();
    await setup()('search_files', { terms: 'x in:town' });
    expect(searched).toEqual([`x in:${A}`]);
  });

  test('when the "*" request fails otherwise, reports the in: error', async () => {
    routes = { ...base(), 'POST /files/search': () => {
      searched.push((bodies['/files/search'] as { terms: string }).terms);
      return mmError(500)();
    } };
    expect(await setup()('search_files', { terms: 'x in:nowhere' }, true)).toBe('チャンネル「nowhere」が見つかりません。');
    expect(searched).toEqual(['*']);
  });

  test('rejects a cursor of another shape', async () => {
    routes = base();
    const out = await setup()('search_files', { terms: 'x', cursor: Buffer.from(JSON.stringify({ offset: 0, per_page: 20 })).toString('base64url') }, true);
    expect(out).toBe('cursor が不正です。前回の出力の next_cursor をそのまま渡してください。');
  });

  // Not repeating the rules of in: here: search_posts covers them, and both tools share resolveInFilters.
  describe('in: filters', () => {
    test('replaces a channel name with its channel_id, in place', async () => {
      expect(await terms('report in:town ext:pdf')).toBe(`report in:${A} ext:pdf`);
    });

    test('a name in several teams searches all of them and says so; -in: excludes all of them', async () => {
      routes = base();
      const out = await setup()('search_files', { terms: 'x in:dup' });
      expect(sent()).toBe(`x in:${A} in:${B}`);
      expect(out).toContain('in:dup は複数のチームにあるため、すべてで探しました（team-a、team-b）。');
      expect(out).toContain('ファイルの検索: x in:dup');
      expect(await terms('x -in:dup')).toBe(`x -in:${A} -in:${B}`);
    });

    test('without a DM, in:@user fails and -in:@user drops the condition', async () => {
      routes = base();
      const call = setup();
      expect(await call('search_files', { terms: 'x in:@carol' }, true)).toBe('@carol との DM はまだありません。');
      expect(onlyAsked()).toBe(true);
      await call('search_files', { terms: 'x -in:@carol y' });
      expect(sent()).toBe('x y');
      expect(hits).not.toContain('POST /channels/direct');
    });

    test('asks for a term when dropping -in:@user leaves nothing to search', async () => {
      routes = base();
      expect(await setup()('search_files', { terms: '-in:@carol' }, true)).toBe('検索語か条件を 1 つ以上指定してください。');
      expect(onlyAsked()).toBe(true);
    });

    test('says a channel is not found, for a name, a channel_id or team/channel answered with 403 or 404, without searching for the terms', async () => {
      routes = { ...base(), [`GET /channels/${B}`]: mmError(403), 'GET /teams/name/team-b/channels/name/dup': mmError(404) };
      const call = setup();
      expect(await call('search_files', { terms: 'x in:nowhere' }, true)).toBe('チャンネル「nowhere」が見つかりません。');
      expect(await call('search_files', { terms: `x -in:${B}` }, true)).toBe(`チャンネル「${B}」が見つかりません。`);
      expect(await call('search_files', { terms: 'x in:team-b/dup' }, true)).toBe('チャンネル「team-b/dup」が見つかりません。');
      routes[`GET /channels/${B}`] = mmError(404);
      expect(await call('search_files', { terms: `x in:${B}` }, true)).toBe(`チャンネル「${B}」が見つかりません。`);
      expect(onlyAsked()).toBe(true);
    });
  });
});

describe('list_channel_members', () => {
  const C = 'c'.repeat(26);
  const T = 't'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const mmError = (status: number, id = 'x') => () => Response.json({ id, message: 'm', status_code: status }, { status });
  const user = (n: number, extra: Record<string, unknown> = {}) => ({ id: `u${String(n).padStart(25, '0')}`, username: `user${n}`, ...extra });
  const base = () => ({
    [`GET /channels/${C}`]: () => ({ id: C, name: 'town', display_name: 'Town', team_id: T, type: 'O', purpose: '', header: '' }),
    [`GET /teams/${T}`]: () => ({ id: T, name: 'team-a' }),
    [`GET /channels/${C}/stats`]: () => ({ channel_id: C, member_count: 3 }),
    'GET /users': (req: Request) => {
      const q = new URL(req.url).searchParams;
      const all = [user(1, { first_name: 'Ann', last_name: 'Lee', nickname: 'annie', position: 'PM' }), user(2, { is_bot: true }), user(3)];
      const at = Number(q.get('page')) * Number(q.get('per_page'));
      return all.slice(at, at + Number(q.get('per_page')));
    },
  });
  const names = (out: string) => [...out.matchAll(/^- @(\S+?)（/gm)].map((m) => m[1]);
  const cursorIn = (out: string) => /next_cursor: (\S+)/.exec(out)?.[1];

  test('lists the active members by username with name, nickname, position, bot and user_id, after the channel and the member count', async () => {
    routes = base();
    const out = await setup()('list_channel_members', { channel: C });
    expect(urls).toContain(`GET /users?in_channel=${C}&active=true&page=0&per_page=50`);
    expect(out).toContain(`チャンネル: channel_id: ${C}、name: town、表示名: Town`);
    expect(out).toContain('メンバー数: 3');
    expect(out).toContain(`- @user1（名前: Ann Lee、ニックネーム: annie、役職: PM、user_id: ${user(1).id}）`);
    expect(out).toContain(`- @user2（Bot アカウント、user_id: ${user(2).id}）`);
    expect(names(out)).toEqual(['user1', 'user2', 'user3']);
  });

  test('keeps a member\'s name, nickname and position with a line break on one line', async () => {
    routes = { ...base(), 'GET /users': () => [user(1, { first_name: 'A\nnn', nickname: 'an\u2028nie', position: 'P\nM' })] };
    const out = await setup()('list_channel_members', { channel: C });
    expect(out).toContain(`- @user1（名前: A nn、ニックネーム: an nie、役職: P M、user_id: ${user(1).id}）`);
  });

  test('pages with limit, a cursor keeping the page size; a full last page leads to an empty one that only says there is no more', async () => {
    routes = base();
    const call = setup();
    const first = await call('list_channel_members', { channel: C, limit: 1 });
    expect(names(first)).toEqual(['user1']);
    const second = await call('list_channel_members', { channel: C, limit: 50, cursor: cursorIn(first) });
    expect(names(second)).toEqual(['user2']);
    expect(urls.at(-1)).toBe(`GET /users?in_channel=${C}&active=true&page=1&per_page=1`);
    expect(second).not.toContain('メンバー数');
    const third = await call('list_channel_members', { channel: C, cursor: cursorIn(second) });
    const fourth = await call('list_channel_members', { channel: C, cursor: cursorIn(third) });
    expect(names(fourth)).toEqual([]);
    expect(fourth).not.toContain('メンバーはいません');
    expect(fourth).toContain('（続きはありません）');
    expect(hits.filter((h) => h === `GET /channels/${C}/stats`)).toHaveLength(1);
  });

  test('says when the channel has no members to show', async () => {
    routes = { ...base(), 'GET /users': () => [] };
    const out = await setup()('list_channel_members', { channel: C });
    expect(out).toContain('メンバーはいません。');
    expect(cursorIn(out)).toBeUndefined();
  });

  test('says members of a channel the user has not joined cannot be seen, without asking for the count', async () => {
    routes = { ...base(), 'GET /users': mmError(403, 'api.context.permissions.app_error') };
    const out = await setup()('list_channel_members', { channel: C }, true);
    expect(out).toBe('このチャンネルのメンバーを見る権限がありません。参加していないチャンネルのメンバーは、公開チャンネルでも見られません。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
    expect(hits).not.toContain(`GET /channels/${C}/stats`);
  });

  test('says the same when the user leaves the channel between reading the members and the count, and passes other errors of the count through', async () => {
    routes = { ...base(), [`GET /channels/${C}/stats`]: mmError(403, 'api.context.permissions.app_error') };
    const call = setup();
    expect(await call('list_channel_members', { channel: C }, true)).toBe('このチャンネルのメンバーを見る権限がありません。参加していないチャンネルのメンバーは、公開チャンネルでも見られません。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
    routes[`GET /channels/${C}/stats`] = mmError(404);
    expect(await call('list_channel_members', { channel: C }, true)).toContain('Mattermost がエラーを返しました（404）');
  });

  test('words 403 and 404 from fetching the channel as get_channel does', async () => {
    routes = { ...base(), 'GET /users/me/teams': () => [], [`GET /channels/${C}`]: mmError(403) };
    const call = setup();
    expect(await call('list_channel_members', { channel: C }, true)).toBe('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。続くなら、チャンネルから外されたか、サーバーの権限の設定で読む権限が外されている可能性があるので、管理者に確かめてください。');
    routes[`GET /channels/${C}`] = mmError(404);
    expect(await call('list_channel_members', { channel: C }, true)).toContain('チャンネルが見つかりません');
  });

  test('rejects a cursor issued for another channel, and one of another shape', async () => {
    routes = base();
    const call = setup();
    const bad = 'cursor が不正です。前回の出力の next_cursor をそのまま渡してください。';
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(await call('list_channel_members', { channel: C, cursor: enc({ channel_id: OTHER, page: 1, per_page: 1 }) }, true)).toBe(bad);
    expect(await call('list_channel_members', { channel: C, cursor: enc({ page: 1, per_page: 1 }) }, true)).toBe(bad);
  });
});

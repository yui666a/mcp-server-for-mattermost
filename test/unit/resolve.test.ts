import { createHash } from 'node:crypto';
import { describe, expect, onTestFinished, test } from 'vitest';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../../src/mattermost/client.ts';
import { InputError } from '../../src/mcp/format.ts';
import { Ambiguous, ChannelFetchError, NoDirectChannel, resolveChannel, resolveUser, type Mm } from '../../src/mcp/resolve.ts';

const ME = 'a'.repeat(26);
const BOB = 'b'.repeat(26);
const CH_A = 'c'.repeat(26);
const CH_B = 'd'.repeat(26);
const DM = 'e'.repeat(26);
const teams = [{ id: 'ta'.padEnd(26, '0'), name: 'team-a' }, { id: 'tb'.padEnd(26, '0'), name: 'team-b' }];
const ch = (id: string, name: string, team_id: string, type = 'O') => ({ id, name, display_name: name.toUpperCase(), team_id, type });

function fake(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const mm: Mm = {
    call: async <T>(_u: string, method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (!(path in routes)) throw new MmError(404, 'store.sql_channel.get_by_name.missing.app_error', 'not found');
      return routes[path] as T;
    },
  };
  return { mm, calls };
}

const dmName = [ME, BOB].sort().join('__');
const routes = {
  '/users/me/teams': teams,
  [`/teams/${teams[0].id}`]: teams[0],
  [`/channels/${CH_A}`]: ch(CH_A, 'general-dup', teams[0].id),
  [`/channels/${DM}`]: ch(DM, dmName, '', 'D'),
  '/teams/name/team-b/channels/name/general-dup': ch(CH_B, 'general-dup', teams[1].id),
  [`/teams/${teams[0].id}/channels/name/only-a`]: ch(CH_A, 'only-a', teams[0].id),
  [`/teams/${teams[0].id}/channels/name/general-dup`]: ch(CH_A, 'general-dup', teams[0].id),
  [`/teams/${teams[1].id}/channels/name/general-dup`]: ch(CH_B, 'general-dup', teams[1].id),
  '/users/username/bob': { id: BOB, username: 'bob' },
  [`/users/${BOB}`]: { id: BOB, username: 'bob' },
  [`/teams/${teams[0].id}/channels/name/${dmName}`]: ch(DM, dmName, '', 'D'),
};

test('resolve team/channel, bare name, @user DM, id', async () => {
  const { mm, calls } = fake(routes);
  expect(await resolveChannel(mm, ME, CH_A)).toEqual({ id: CH_A, name: 'general-dup', displayName: 'GENERAL-DUP', teamId: teams[0].id, teamName: 'team-a', raw: routes[`/channels/${CH_A}`] });
  expect(await resolveChannel(mm, ME, 'team-b/general-dup')).toMatchObject({ id: CH_B, teamId: teams[1].id, teamName: 'team-b' });
  expect(await resolveChannel(mm, ME, 'only-a')).toMatchObject({ id: CH_A, name: 'only-a', teamName: 'team-a' });
  expect(await resolveChannel(mm, ME, '@bob')).toMatchObject({ id: DM, name: dmName, teamId: '', displayName: '@bob' });
  expect(await resolveChannel(mm, ME, DM)).toMatchObject({ id: DM, teamId: '', teamName: 'team-a' });
  expect(calls).not.toContain('POST /channels/direct');

  expect(await resolveUser(mm, ME, '@bob')).toMatchObject({ id: BOB, username: 'bob' });
  expect(await resolveUser(mm, ME, BOB)).toMatchObject({ id: BOB, username: 'bob' });
  await expect(resolveUser(mm, ME, 'bob')).rejects.toThrow(/@ユーザー名/);
  await expect(resolveChannel(mm, ME, 'nowhere')).rejects.toThrow(/見つかりません/);
});

test('bare name in two teams throws Ambiguous with both candidates', async () => {
  const { mm } = fake(routes);
  const e = await resolveChannel(mm, ME, 'general-dup').catch((x) => x);
  expect(e).toBeInstanceOf(Ambiguous);
  expect(e.candidates).toEqual([
    { team: 'team-a', name: 'general-dup', id: CH_A },
    { team: 'team-b', name: 'general-dup', id: CH_B },
  ]);
  for (const s of ['team-a', 'team-b', CH_A, CH_B]) expect(e.message).toContain(s);
});

test('errors other than not-found while looking up a bare name are not swallowed', async () => {
  const mm: Mm = {
    call: async <T>(_u: string, _m: string, path: string) => {
      if (path === '/users/me/teams') return teams as T;
      throw new MmError(500, 'x', 'boom');
    },
  };
  await expect(resolveChannel(mm, ME, 'general-dup')).rejects.toMatchObject({ status: 500 });
});

test('names that are not plain Mattermost names are rejected before any request', async () => {
  const { mm, calls } = fake(routes);
  for (const spec of ['..', '.', 'team-a/..', '../general-dup', 'team-a/.', 'a b', 'team-a/x?y', '@..', '@.', '@bo%2fb', 'gen/eral/dup']) {
    await expect(resolveChannel(mm, ME, spec), spec).rejects.toBeInstanceOf(InputError);
  }
  for (const spec of ['@..', '@.', '@a/b', '@']) await expect(resolveUser(mm, ME, spec), spec).rejects.toBeInstanceOf(InputError);
  expect(calls.filter((c) => !c.endsWith('/users/me/teams'))).toEqual([]);
});

describe('a missing ID that is the name of a channel (26 lower-case letters and digits)', () => {
  const NAME = 'n'.repeat(26);
  const named = ch('f'.repeat(26), NAME, teams[0].id);

  test('is not used in place of the missing ID, but named in the error with its team/channel form', async () => {
    const { mm, calls } = fake({ ...routes, [`/teams/${teams[0].id}/channels/name/${NAME}`]: named, [`/teams/name/team-a/channels/name/${NAME}`]: named });
    await expect(resolveChannel(mm, ME, NAME)).rejects.toThrow(new InputError(
      `チャンネル ID「${NAME}」のチャンネルはありません。ユーザー ID や投稿 ID を渡したのなら、チャンネルの指定ではありません。同じ文字列を名前に持つチャンネルはあります。そのチャンネルを指すときだけ、「team-a/${NAME}」（${NAME.toUpperCase()}）の形で指定してください。`,
    ));
    expect(calls).toEqual([`GET /channels/${NAME}`, 'GET /users/me/teams', `GET /teams/${teams[0].id}/channels/name/${NAME}`, `GET /teams/${teams[1].id}/channels/name/${NAME}`]);
    expect(await resolveChannel(mm, ME, `team-a/${NAME}`)).toMatchObject({ id: named.id, name: NAME });
  });

  test('keeps the 404 of the ID when no channel has that name either', async () => {
    const { mm, calls } = fake(routes);
    const e = await resolveChannel(mm, ME, NAME).catch((x) => x);
    expect(e).toBeInstanceOf(ChannelFetchError);
    expect(e.status).toBe(404);
    expect(calls).toContain(`GET /teams/${teams[0].id}/channels/name/${NAME}`);
  });

  test('puts the display name of a candidate on one line, as anyone who creates the channel can write line breaks in it', async () => {
    const { mm } = fake({ ...routes, [`/teams/${teams[0].id}/channels/name/${NAME}`]: { ...named, display_name: 'a\nb\u2028c' } });
    const e = await resolveChannel(mm, ME, NAME).catch((x) => x);
    expect(e.message).toContain(`「team-a/${NAME}」（a b c）`);
    expect(e.message).not.toMatch(/[\n\u2028]/);
  });

  test('names every team that has that name', async () => {
    const { mm } = fake({ ...routes, [`/teams/${teams[0].id}/channels/name/${NAME}`]: named, [`/teams/${teams[1].id}/channels/name/${NAME}`]: ch('g'.repeat(26), NAME, teams[1].id) });
    await expect(resolveChannel(mm, ME, NAME)).rejects.toThrow(`「team-a/${NAME}」（${NAME.toUpperCase()}）か「team-b/${NAME}」（${NAME.toUpperCase()}）の形で指定してください。`);
  });

  test('is not looked up by name after a 403, which means the ID exists', async () => {
    const calls: string[] = [];
    const mm: Mm = { call: async (_u, m, p) => {
      calls.push(`${m} ${p}`);
      throw new MmError(403, 'api.context.permissions.app_error', 'x');
    } };
    await expect(resolveChannel(mm, ME, NAME)).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual([`GET /channels/${NAME}`]);
  });

  test('with upper case, is looked up by name in lower case, which is the only case a channel name has', async () => {
    const upper = 'N'.repeat(26);
    const { mm, calls } = fake({ ...routes, [`/teams/${teams[0].id}/channels/name/${NAME}`]: named });
    await expect(resolveChannel(mm, ME, upper)).rejects.toThrow(`「team-a/${NAME}」（${NAME.toUpperCase()}）の形で指定してください。`);
    expect(calls).toContain(`GET /teams/${teams[0].id}/channels/name/${NAME}`);
    await expect(resolveChannel(fake(routes).mm, ME, upper)).rejects.toMatchObject({ status: 404 });
  });

  test('an error other than not-found while looking up by name is not swallowed', async () => {
    const mm: Mm = { call: async <T>(_u: string, _m: string, p: string) => {
      if (p === '/users/me/teams') return teams as T;
      if (p === `/channels/${NAME}`) throw new MmError(404, 'x', 'x');
      throw new MmError(500, 'x', 'boom');
    } };
    await expect(resolveChannel(mm, ME, NAME)).rejects.toMatchObject({ status: 500 });
  });

  test('a channel found by its ID looks up neither the teams nor any name', async () => {
    const { mm, calls } = fake(routes);
    await resolveChannel(mm, ME, CH_A);
    expect(calls).toEqual([`GET /channels/${CH_A}`, `GET /teams/${teams[0].id}`]);
  });
});

test.each([
  ['team-a/', 'チャンネル名が空です。'],
  ['@', 'ユーザー名が空です。'],
])('an empty name in %j says which name is empty', async (spec, message) => {
  await expect(resolveChannel(fake(routes).mm, ME, spec)).rejects.toThrow(new InputError(message));
});

test('a user ID written in upper case is looked up in lower case, which is the only case Mattermost IDs have', async () => {
  const { mm, calls } = fake(routes);
  expect(await resolveUser(mm, ME, BOB.toUpperCase())).toMatchObject({ id: BOB });
  expect(calls).toEqual([`GET /users/${BOB}`]);
});

test('with names: false, a channel given by its ID looks up neither its team nor the users of a DM or group DM', async () => {
  const GM_ID = 'g'.repeat(26);
  const { mm, calls } = fake({ ...routes, [`/channels/${GM_ID}`]: { id: GM_ID, name: 'f'.repeat(40), display_name: 'x', team_id: '', type: 'G' } });
  expect(await resolveChannel(mm, ME, DM, { names: false })).toMatchObject({ id: DM, teamName: '' });
  expect(await resolveChannel(mm, ME, GM_ID, { names: false })).toMatchObject({ id: GM_ID });
  expect(await resolveChannel(mm, ME, CH_A, { names: false })).toMatchObject({ id: CH_A, teamName: '' });
  expect(calls).toEqual([`GET /channels/${DM}`, `GET /channels/${GM_ID}`, `GET /channels/${CH_A}`]);
});

describe('a DM or group DM given by its channel ID is named as when given as @user or @a,b', () => {
  const GM_ID = 'g'.repeat(26);
  const CAROL = 'c'.padEnd(26, '1');
  const gm = { id: GM_ID, name: 'f'.repeat(40), display_name: 'alice, bob, carol', team_id: '', type: 'G' };
  const members = [{ id: ME, username: 'alice' }, { id: CAROL, username: 'carol' }, { id: BOB, username: 'bob' }];
  const withGm = (extra: Record<string, unknown> = {}) => fake({ ...routes, [`/channels/${GM_ID}`]: gm, [`/users?in_channel=${GM_ID}&per_page=8`]: members, ...extra });

  test('a DM by the other user', async () => {
    const { mm, calls } = fake(routes);
    expect(await resolveChannel(mm, ME, DM)).toMatchObject({ id: DM, displayName: '@bob' });
    expect(calls).toContain(`GET /users/${BOB}`);
    const RIGHT = 'r'.repeat(26);
    const { mm: mm2 } = fake({ ...routes, [`/channels/${RIGHT}`]: ch(RIGHT, `${BOB}__${ME}`, '', 'D') });
    expect(await resolveChannel(mm2, ME, RIGHT)).toMatchObject({ displayName: '@bob' });
  });

  test('the DM with oneself by one\'s own name', async () => {
    const SELF = 's'.repeat(26);
    const { mm } = fake({ ...routes, [`/channels/${SELF}`]: ch(SELF, `${ME}__${ME}`, '', 'D'), [`/users/${ME}`]: { id: ME, username: 'alice' } });
    expect(await resolveChannel(mm, ME, SELF)).toMatchObject({ displayName: '@alice' });
  });

  test('a group DM by the others, sorted, without oneself', async () => {
    const { mm } = withGm();
    expect(await resolveChannel(mm, ME, GM_ID)).toMatchObject({ id: GM_ID, displayName: '@bob, @carol' });
  });

  test('a group DM with no one else keeps its display name', async () => {
    const { mm } = withGm({ [`/users?in_channel=${GM_ID}&per_page=8`]: [members[0]] });
    expect(await resolveChannel(mm, ME, GM_ID)).toMatchObject({ displayName: 'alice, bob, carol' });
  });

  test.each([
    ['a Mattermost error', () => new MmError(404, 'app.user.missing_account.const', 'x')],
    ['Mattermost being unreachable', () => new UpstreamUnavailable('Mattermost unreachable', true)],
  ])('%s while looking the users up keeps the display name, for a DM and a group DM', async (_name, error) => {
    const failing = (base: Mm): Mm => ({ call: async <T>(u: string, m: string, p: string) => {
      if (p.startsWith('/users/') && p !== '/users/me/teams' || p.startsWith('/users?')) throw error();
      return base.call<T>(u, m, p);
    } });
    expect(await resolveChannel(failing(fake(routes).mm), ME, DM)).toMatchObject({ id: DM, displayName: dmName.toUpperCase() });
    expect(await resolveChannel(failing(withGm().mm), ME, GM_ID)).toMatchObject({ displayName: 'alice, bob, carol' });
  });

  test.each([
    ['a rate limit', () => new RateLimited(5, false)],
    ['a reauthorization', () => new Reauthorize(false)],
  ])('%s while looking the users up is not swallowed', async (_name, error) => {
    const base = fake(routes).mm;
    const mm: Mm = { call: async <T>(u: string, m: string, p: string) => {
      if (p === `/users/${BOB}`) throw error();
      return base.call<T>(u, m, p);
    } };
    await expect(resolveChannel(mm, ME, DM)).rejects.toBeInstanceOf(error().constructor);
  });

  test('a DM whose name does not hold the caller, or is not a pair of IDs, is not looked up', async () => {
    const OTHERS = 'x'.repeat(26);
    const name = `${BOB}__${'z'.repeat(26)}`;
    const { mm, calls } = fake({ ...routes, [`/channels/${OTHERS}`]: ch(OTHERS, name, '', 'D') });
    expect(await resolveChannel(mm, ME, OTHERS)).toMatchObject({ displayName: name.toUpperCase() });
    const SHORT = 'y'.repeat(26);
    const { mm: mm2, calls: calls2 } = fake({ ...routes, [`/channels/${SHORT}`]: { id: SHORT, display_name: '', team_id: '', type: 'D' } });
    expect(await resolveChannel(mm2, ME, SHORT)).toMatchObject({ displayName: '' });
    for (const c of [calls, calls2]) expect(c.filter((x) => x.startsWith('GET /users/') && x !== 'GET /users/me/teams')).toEqual([]);
  });

  test('a private channel given by its ID looks no user up', async () => {
    const PRIV = 'p'.repeat(26);
    const { mm, calls } = fake({ ...routes, [`/channels/${PRIV}`]: ch(PRIV, 'secret', teams[0].id, 'P') });
    await resolveChannel(mm, ME, PRIV);
    expect(calls.filter((c) => c.startsWith('GET /users'))).toEqual([]);
  });
});

describe('names are looked up in lower case, which is all Mattermost allows', () => {
  test('a bare channel name, keeping the name as written in the errors', async () => {
    const { mm, calls } = fake(routes);
    expect(await resolveChannel(mm, ME, 'Only-A')).toMatchObject({ id: CH_A, teamName: 'team-a' });
    expect(calls).toContain(`GET /teams/${teams[0].id}/channels/name/only-a`);
    await expect(resolveChannel(mm, ME, 'NoWhere')).rejects.toThrow(new InputError('チャンネル「NoWhere」が見つかりません。'));
    const e = await resolveChannel(mm, ME, 'General-Dup').catch((x) => x);
    expect(e).toBeInstanceOf(Ambiguous);
    expect(e.message).toContain('「General-Dup」に当たるチャンネルが複数あります。');
  });

  test('team/channel, with the team name in lower case in the result', async () => {
    const { mm, calls } = fake(routes);
    expect(await resolveChannel(mm, ME, 'Team-B/General-Dup')).toMatchObject({ id: CH_B, teamName: 'team-b' });
    expect(calls).toEqual(['GET /teams/name/team-b/channels/name/general-dup']);
  });
});

describe('@user that cannot be looked up', () => {
  test.each([
    [404, 'app.user.get_by_username.app_error'],
    [403, 'api.context.permissions.app_error'],
    [400, 'api.context.invalid_body_param.app_error', '@all'],
  ])('a %i from the user lookup says the user is not found', async (status, id, spec = '@ghost') => {
    const mm: Mm = { call: async <T>(_u: string, _m: string, p: string) => {
      if (p === '/users/me/teams') return teams as T;
      throw new MmError(status, id, 'x');
    } };
    await expect(resolveChannel(mm, ME, spec)).rejects.toThrow(new InputError(`ユーザー「${spec}」が見つかりません。`));
  });

  test('a 403 from the teams lookup is not reported as a missing user', async () => {
    const mm: Mm = { call: async () => {
      throw new MmError(403, 'api.context.permissions.app_error', 'x');
    } };
    const e = await resolveChannel(mm, ME, '@bob').catch((x) => x);
    expect(e).toBeInstanceOf(MmError);
    expect(e.status).toBe(403);
  });
});

test('@、, with no name at all, is left to the name check', async () => {
  await expect(resolveChannel(fake(routes).mm, ME, '@、')).rejects.toThrow('使えない文字を含みます');
});

describe('a real channel ID written in upper case', () => {
  const UPPER = CH_A.toUpperCase();

  test('is looked up again in lower case before any name', async () => {
    const { mm, calls } = fake(routes);
    expect(await resolveChannel(mm, ME, UPPER)).toMatchObject({ id: CH_A });
    expect(calls.slice(0, 2)).toEqual([`GET /channels/${UPPER}`, `GET /channels/${CH_A}`]);
  });

  test('goes on to the names only when the lower case ID is not found either', async () => {
    const { mm, calls } = fake(Object.fromEntries(Object.entries(routes).filter(([k]) => k !== `/channels/${CH_A}`)));
    await expect(resolveChannel(mm, ME, UPPER)).rejects.toMatchObject({ status: 404 });
    expect(calls.slice(0, 3)).toEqual([`GET /channels/${UPPER}`, `GET /channels/${CH_A}`, 'GET /users/me/teams']);
  });

  test.each([403, 500])('a %i for the lower case ID is thrown as it is, without looking names up', async (status) => {
    const calls: string[] = [];
    const mm: Mm = { call: async (_u, m, p) => {
      calls.push(`${m} ${p}`);
      throw new MmError(p === `/channels/${UPPER}` ? 404 : status, 'x', 'x');
    } };
    await expect(resolveChannel(mm, ME, UPPER)).rejects.toMatchObject({ status });
    expect(calls).toEqual([`GET /channels/${UPPER}`, `GET /channels/${CH_A}`]);
  });
});

test('a 、 before a word that cannot be a user name is left to the name check, not called a separator', async () => {
  await expect(resolveChannel(fake(routes).mm, ME, '@bob、議事録')).rejects.toThrow('使えない文字を含みます');
});

test.each(['@bob、carol', '@bob，carol', '@a,b、c', '@bob、', '@bob、、carol', '@bob、@'])('%j is refused for its separator before any request', async (spec) => {
  const { mm, calls } = fake(routes);
  await expect(resolveChannel(mm, ME, spec)).rejects.toThrow(new InputError('@a,b の区切りは半角のカンマ（,）で書いてください。読点（、）や全角のカンマ（，）は使えません。'));
  expect(calls).toEqual([]);
});

test('every form of channel spec also returns the fetched channel as raw', async () => {
  const { mm } = fake(routes);
  expect((await resolveChannel(mm, ME, CH_A)).raw).toBe(routes[`/channels/${CH_A}`]);
  expect((await resolveChannel(mm, ME, 'team-b/general-dup')).raw).toBe(routes['/teams/name/team-b/channels/name/general-dup']);
  expect((await resolveChannel(mm, ME, 'only-a')).raw).toBe(routes[`/teams/${teams[0].id}/channels/name/only-a`]);
  expect((await resolveChannel(mm, ME, '@bob')).raw).toBe(routes[`/teams/${teams[0].id}/channels/name/${dmName}`]);
});

describe('@user with create', () => {
  const CAROL = 'f'.repeat(26);
  const NEW_DM = 'g'.repeat(26);
  function writer(extra: Record<string, unknown> = {}, post: (body: unknown) => unknown = () => ch(NEW_DM, [ME, CAROL].sort().join('__'), '', 'D')) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const mm: Mm = {
      call: async <T>(_u: string, method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (method === 'POST' && path === '/channels/direct') return post(body) as T;
        const r: Record<string, unknown> = { ...routes, '/users/username/carol': { id: CAROL, username: 'carol', delete_at: 0 }, ...extra };
        if (!(path in r)) throw new MmError(404, 'app.channel.get_by_name.missing.app_error', 'not found');
        return r[path] as T;
      },
    };
    return { mm, posts: () => calls.filter((c) => c.method === 'POST') };
  }

  test('an existing DM is looked up without creating it', async () => {
    const { mm, posts } = writer();
    expect(await resolveChannel(mm, ME, '@bob', { create: true })).toMatchObject({ id: DM, displayName: '@bob' });
    expect(posts()).toEqual([]);
  });

  test('a missing DM is created only when asked to', async () => {
    const r = writer();
    await expect(resolveChannel(r.mm, ME, '@carol')).rejects.toBeInstanceOf(NoDirectChannel);
    expect(r.posts()).toEqual([]);
    expect(await resolveChannel(r.mm, ME, '@carol', { create: true })).toMatchObject({ id: NEW_DM, displayName: '@carol', teamName: 'team-a' });
    expect(r.posts()).toEqual([{ method: 'POST', path: '/channels/direct', body: [ME, CAROL] }]);
  });

  test('a DM with oneself is created with the own id twice', async () => {
    const { mm, posts } = writer({ '/users/username/me': { id: ME, username: 'me' } }, () => ch(NEW_DM, `${ME}__${ME}`, '', 'D'));
    expect(await resolveChannel(mm, ME, '@me', { create: true })).toMatchObject({ id: NEW_DM, displayName: '@me' });
    expect(posts()[0].body).toEqual([ME, ME]);
  });

  test('no DM is created with a deactivated user', async () => {
    const { mm, posts } = writer({ '/users/username/carol': { id: CAROL, username: 'carol', delete_at: 1 } });
    await expect(resolveChannel(mm, ME, '@carol', { create: true })).rejects.toThrow('@carol は無効化されているため、DM を作りません。');
    expect(posts()).toEqual([]);
  });

  test('a refused creation is worded by its reason', async () => {
    const refuse = (status: number, id: string) => writer({}, () => { throw new MmError(status, id, 'x'); }).mm;
    await expect(resolveChannel(refuse(403, 'api.context.permissions.app_error'), ME, '@carol', { create: true }))
      .rejects.toThrow('@carol との DM を作る権限が無いか、相手を見る権限がありません。');
    await expect(resolveChannel(refuse(403, 'api.channel.create_channel.direct_channel.team_restricted_error'), ME, '@carol', { create: true }))
      .rejects.toThrow('このサーバーでは、同じチームにいない相手との DM は作れません。');
    await expect(resolveChannel(refuse(403, 'api.channel.create_channel.direct_channel.remote_restricted.app_error'), ME, '@carol', { create: true }))
      .rejects.toThrow('@carol は別のサーバーのユーザーのため、このサーバーでは DM を作れません。');
    await expect(resolveChannel(refuse(403, 'other.id'), ME, '@carol', { create: true })).rejects.toMatchObject({ status: 403, id: 'other.id' });
    await expect(resolveChannel(refuse(500, 'x'), ME, '@carol', { create: true })).rejects.toMatchObject({ status: 500 });
  });

  test('an existing DM with a deactivated user is still looked up', async () => {
    const { mm, posts } = writer({ '/users/username/bob': { id: BOB, username: 'bob', delete_at: 1 } });
    expect(await resolveChannel(mm, ME, '@bob', { create: true })).toMatchObject({ id: DM });
    expect(posts()).toEqual([]);
  });

  test('a DM answered with 403 is treated as missing and created', async () => {
    const mm: Mm = {
      call: async <T>(_u: string, method: string, path: string) => {
        if (method === 'POST') return ch(NEW_DM, [ME, CAROL].sort().join('__'), '', 'D') as T;
        if (path === '/users/me/teams') return teams as T;
        if (path === '/users/username/carol') return { id: CAROL, username: 'carol', delete_at: 0 } as T;
        throw new MmError(403, 'api.context.permissions.app_error', 'forbidden');
      },
    };
    expect(await resolveChannel(mm, ME, '@carol', { create: true })).toMatchObject({ id: NEW_DM });
  });

  test('a user name is looked up in lower case', async () => {
    const { mm } = fake(routes);
    expect(await resolveUser(mm, ME, '@Bob')).toMatchObject({ id: BOB });
    expect(await resolveChannel(mm, ME, '@BOB')).toMatchObject({ id: DM, displayName: '@bob' });
  });
});

describe('@a,b group DM', () => {
  const CAROL = 'f'.repeat(26);
  const DAVE = 'h'.repeat(26);
  const GM = 'm'.repeat(26);
  const NEW_GM = 'n'.repeat(26);
  const users: Record<string, { id: string; username: string; delete_at: number }> = {
    me: { id: ME, username: 'me', delete_at: 0 },
    bob: { id: BOB, username: 'bob', delete_at: 0 },
    carol: { id: CAROL, username: 'carol', delete_at: 0 },
    dave: { id: DAVE, username: 'dave', delete_at: 0 },
  };
  const groupName = (ids: string[]) => createHash('sha1').update([...ids].sort().join('')).digest('hex');
  const existing = groupName([ME, BOB, CAROL]);
  function group(opts: { teams?: unknown[]; deactivated?: string; post?: () => unknown } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const mm: Mm = {
      call: async <T>(_u: string, method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (path === '/users/me/teams') return (opts.teams ?? teams) as T;
        if (method === 'POST' && path === '/users/usernames') {
          return (body as string[]).filter((n) => n in users).map((n) => ({ ...users[n], delete_at: n === opts.deactivated ? 1 : 0 })) as T;
        }
        if (method === 'POST' && path === '/channels/group') return (opts.post ? opts.post() : ch(NEW_GM, 'x', '', 'G')) as T;
        if (path === `/teams/${teams[0].id}/channels/name/${existing}`) return ch(GM, existing, '', 'G') as T;
        throw new MmError(404, 'app.channel.get_by_name.missing.app_error', 'not found');
      },
    };
    return { mm, calls, posts: () => calls.filter((c) => c.method === 'POST' && c.path !== '/users/usernames') };
  }

  test('an existing group DM is looked up by the hash of its members, whatever the order or the form of the names', async () => {
    for (const spec of ['@bob,carol', '@carol,bob', '@bob, @carol', '@Bob,CAROL', '@bob,carol,bob', '@me,bob,carol']) {
      const { mm, posts } = group();
      expect(await resolveChannel(mm, ME, spec, { create: true }), spec).toMatchObject({ id: GM, displayName: '@bob, @carol', teamName: 'team-a' });
      expect(posts(), spec).toEqual([]);
    }
  });

  test('looks the users up in one call with lower-case names', async () => {
    const { mm, calls } = group();
    await resolveChannel(mm, ME, '@Carol,bob');
    expect(calls.find((c) => c.path === '/users/usernames')?.body).toEqual(['carol', 'bob']);
  });

  test('a missing group DM is created only when asked to, with the other members', async () => {
    const r = group();
    await expect(resolveChannel(r.mm, ME, '@bob,dave')).rejects.toThrow(new NoDirectChannel('@bob, @dave とのグループ DM はまだありません。'));
    expect(r.posts()).toEqual([]);
    expect(await resolveChannel(r.mm, ME, '@dave,bob', { create: true })).toMatchObject({ id: NEW_GM, displayName: '@bob, @dave' });
    expect(r.posts()).toEqual([{ method: 'POST', path: '/channels/group', body: [DAVE, BOB] }]);
  });

  test.each([
    ['@bob,', '空の名前'],
    ['@,bob', '空の名前'],
    ['@bob,,carol', '空の名前'],
    ['@bob,bo/b', '使えない文字'],
  ])('%s is refused before any user lookup', async (spec, msg) => {
    const { mm, calls } = group();
    await expect(resolveChannel(mm, ME, spec)).rejects.toThrow(msg);
    expect(calls.filter((c) => c.path !== '/users/me/teams')).toEqual([]);
  });

  test.each([
    ['@bob,Bob', true],
    ['@me,bob', false],
    ['@me,me', true],
  ])('%s names one other user or none and points to @user', async (spec, beforeLookup) => {
    const { mm, calls } = group();
    await expect(resolveChannel(mm, ME, spec)).rejects.toThrow('1 人との DM は @ユーザー名 で指定します');
    expect(calls.some((c) => c.path === '/users/usernames')).toBe(!beforeLookup);
  });

  test('takes up to 7 others, also when the own name makes it 8, and refuses 8 others', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `u${i}`);
    for (const [i, n] of many.entries()) users[n] = { id: `${i}`.padEnd(26, 'z'), username: n, delete_at: 0 };
    onTestFinished(() => many.forEach((n) => delete users[n]));
    const seven = many.slice(0, 7);
    expect(await resolveChannel(group().mm, ME, `@${seven.join(',')}`, { create: true })).toMatchObject({ id: NEW_GM });
    expect(await resolveChannel(group().mm, ME, `@me,${seven.join(',')}`, { create: true })).toMatchObject({ id: NEW_GM });
    await expect(resolveChannel(group().mm, ME, `@${many.join(',')}`, { create: true })).rejects.toThrow('自分以外に 7 人まで');
    const nine = group();
    await expect(resolveChannel(nine.mm, ME, `@${[...many, 'bob'].join(',')}`, { create: true })).rejects.toThrow('自分以外に 7 人まで');
    expect(nine.calls.some((c) => c.path === '/users/usernames')).toBe(false);
  });

  test('names that are not found are listed', async () => {
    await expect(resolveChannel(group().mm, ME, '@bob,ghost,nobody')).rejects.toThrow(new InputError('ユーザーが見つかりません: @ghost, @nobody。'));
  });

  test('without a team, the users are looked up but no group DM is looked up or created', async () => {
    const { mm, calls } = group({ teams: [] });
    await expect(resolveChannel(mm, ME, '@bob,dave', { create: true })).rejects.toThrow('所属しているチームがない');
    expect(calls.filter((c) => c.path.startsWith('/teams/') || c.path === '/channels/group')).toEqual([]);
    expect(calls.some((c) => c.path === '/users/usernames')).toBe(true);
  });

  test('no group DM is created with a deactivated user, while an existing one is still looked up', async () => {
    const r = group({ deactivated: 'dave' });
    await expect(resolveChannel(r.mm, ME, '@bob,dave', { create: true })).rejects.toThrow('@dave は無効化されているため、グループ DM を作りません。');
    expect(r.posts()).toEqual([]);
    expect(await resolveChannel(group({ deactivated: 'carol' }).mm, ME, '@bob,carol', { create: true })).toMatchObject({ id: GM });
  });

  test('a read of a missing group DM with a deactivated user says it does not exist yet', async () => {
    await expect(resolveChannel(group({ deactivated: 'dave' }).mm, ME, '@bob,dave')).rejects.toBeInstanceOf(NoDirectChannel);
  });

  test('errors other than not-found while looking the group DM up are not swallowed', async () => {
    const paths: string[] = [];
    const mm: Mm = {
      call: async <T>(_u: string, method: string, path: string, body?: unknown) => {
        paths.push(`${method} ${path}`);
        if (path === '/users/me/teams') return teams as T;
        if (path === '/users/usernames') return (body as string[]).map((n) => users[n]) as T;
        throw new MmError(500, 'x', 'boom');
      },
    };
    await expect(resolveChannel(mm, ME, '@bob,dave', { create: true })).rejects.toMatchObject({ status: 500 });
    expect(paths).not.toContain('POST /channels/group');
  });

  test('a refused creation is worded by its reason', async () => {
    const refuse = (status: number, id: string) => group({ post: () => { throw new MmError(status, id, 'x'); } }).mm;
    await expect(resolveChannel(refuse(403, 'api.context.permissions.app_error'), ME, '@bob,dave', { create: true }))
      .rejects.toThrow('@bob, @dave とのグループ DM を作る権限が無いか、相手を見る権限がありません。');
    await expect(resolveChannel(refuse(403, 'api.channel.create_group.remote_restricted.app_error'), ME, '@bob,dave', { create: true }))
      .rejects.toThrow('別のサーバーのユーザーを含むため、このサーバーではグループ DM を作れません。');
    await expect(resolveChannel(refuse(400, 'api.channel.create_group.bad_user.app_error'), ME, '@bob,dave', { create: true }))
      .rejects.toThrow('グループ DM に加えられないユーザーが含まれています。');
    await expect(resolveChannel(refuse(500, 'x'), ME, '@bob,dave', { create: true })).rejects.toMatchObject({ status: 500 });
  });
});

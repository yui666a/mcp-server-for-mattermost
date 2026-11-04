import { describe, expect, test } from 'vitest';
import { MmError } from '../../src/mattermost/client.ts';
import { InputError } from '../../src/mcp/format.ts';
import { Ambiguous, NoDirectChannel, resolveChannel, resolveUser, type Mm } from '../../src/mcp/resolve.ts';

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

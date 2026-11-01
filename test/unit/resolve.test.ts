import { expect, test } from 'vitest';
import { MmError } from '../../src/mattermost/client.ts';
import { InputError } from '../../src/mcp/format.ts';
import { Ambiguous, resolveChannel, resolveUser, type Mm } from '../../src/mcp/resolve.ts';

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
  expect(await resolveChannel(mm, ME, CH_A)).toEqual({ id: CH_A, name: 'general-dup', displayName: 'GENERAL-DUP', teamId: teams[0].id, teamName: 'team-a' });
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

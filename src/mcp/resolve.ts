import { createHash } from 'node:crypto';
import { MmError, type MmClient } from '../mattermost/client.ts';
import { InputError } from './format.ts';

export type Mm = Pick<MmClient, 'call'>;
export type ChannelRef = { id: string; name: string; displayName: string; teamId: string; teamName: string };
export type UserRef = {
  id: string; username: string; first_name?: string; last_name?: string; nickname?: string; position?: string;
  email?: string; locale?: string; is_bot?: boolean; delete_at?: number; timezone?: Record<string, string>;
};
export type MmChannel = { id: string; name: string; display_name: string; team_id: string; type: string };
export type MmChannelFull = MmChannel & { purpose: string; header: string };
export type ResolvedChannel = ChannelRef & { raw: MmChannelFull };

// A subclass rather than converting to a message here: the other tools keep the generic Mattermost error, and only get_channel words it.
export class ChannelFetchError extends MmError {}
export class NoDirectChannel extends InputError {}
export type MmTeam = { id: string; name: string; display_name?: string };
type Candidate = { team: string; name: string; id: string };

export class Ambiguous extends InputError {
  name = 'Ambiguous';
  readonly candidates: Candidate[];
  constructor(spec: string, candidates: Candidate[]) {
    super([
      `「${spec}」に当たるチャンネルが複数あります。チャンネル ID か「チーム名/チャンネル名」で指定してください。`,
      ...candidates.map((c) => `- ${c.team}/${c.name}（channel_id: ${c.id}）`),
    ].join('\n'));
    this.candidates = candidates;
  }
}

const ID = /^[A-Za-z0-9]{26}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

// Checked rather than only encodeURIComponent'ed: "." and ".." survive encoding and fetch would normalise them into another endpoint.
function plain(name: string, what: string): string {
  if (!NAME.test(name) || name === '.' || name === '..') throw new InputError(`${what}「${name}」は Mattermost の名前として使えない文字を含みます。`);
  return name;
}
const missing = (e: unknown) => e instanceof MmError && (e.status === 403 || e.status === 404);
const ref = (c: MmChannelFull, teamName: string): ResolvedChannel => ({ id: c.id, name: c.name, displayName: c.display_name, teamId: c.team_id, teamName, raw: c });
const fetchChannel = (mm: Mm, userId: string, path: string) => mm.call<MmChannelFull>(userId, 'GET', path).catch((e) => {
  throw e instanceof MmError ? new ChannelFetchError(e.status, e.id, e.message) : e;
});

export const myTeams = (mm: Mm, userId: string) => mm.call<MmTeam[]>(userId, 'GET', '/users/me/teams');

// Not leaving the team out for DMs and group DMs: /<team>/pl/<id> needs one, and any team of the viewer opens the post.
export async function teamNameOf(mm: Mm, userId: string, teamId: string): Promise<string> {
  if (teamId) return (await mm.call<MmTeam>(userId, 'GET', `/teams/${teamId}`)).name;
  return (await myTeams(mm, userId))[0]?.name ?? '';
}

export async function resolveUser(mm: Mm, userId: string, spec: string): Promise<UserRef> {
  const s = spec.trim();
  // Lowered rather than passed as typed: Mattermost user names are lower case only, and it answers 400 to any upper case letter.
  if (s.startsWith('@')) return mm.call<UserRef>(userId, 'GET', `/users/username/${plain(s.slice(1), 'ユーザー名').toLowerCase()}`);
  if (ID.test(s)) return mm.call<UserRef>(userId, 'GET', `/users/${s}`);
  throw new InputError('ユーザーはユーザー ID か @ユーザー名 で指定してください。');
}

// Same reason for both the permission to create and the visibility of the other user: Mattermost answers both with one id.
const CREATE_REFUSED: readonly [number, string, (who: string) => string][] = [
  [403, 'api.context.permissions.app_error', (who) => `${who} との DM を作る権限が無いか、相手を見る権限がありません。`],
  [403, 'api.channel.create_channel.direct_channel.team_restricted_error', () => 'このサーバーでは、同じチームにいない相手との DM は作れません。'],
  [403, 'api.channel.create_channel.direct_channel.remote_restricted.app_error', (who) => `${who} は別のサーバーのユーザーのため、このサーバーでは DM を作れません。`],
];
const GROUP_REFUSED: typeof CREATE_REFUSED = [
  [403, 'api.context.permissions.app_error', (who) => `${who} とのグループ DM を作る権限が無いか、相手を見る権限がありません。`],
  [403, 'api.channel.create_group.remote_restricted.app_error', () => '別のサーバーのユーザーを含むため、このサーバーではグループ DM を作れません。'],
  [400, 'api.channel.create_group.bad_user.app_error', () => 'グループ DM に加えられないユーザーが含まれています。'],
];
const refusalWorded = (who: string, table = CREATE_REFUSED) => (e: unknown): never => {
  const w = e instanceof MmError && table.find(([status, id]) => status === e.status && id === e.id);
  throw w ? new InputError(w[2](who)) : e;
};

// Not creating unless asked: a read must not leave behind a DM the user never opened.
export async function resolveChannel(mm: Mm, userId: string, spec: string, opts: { create?: boolean } = {}): Promise<ResolvedChannel> {
  const s = spec.trim();
  if (ID.test(s)) {
    const c = await fetchChannel(mm, userId, `/channels/${s}`);
    return ref(c, await teamNameOf(mm, userId, c.team_id));
  }
  const slash = s.indexOf('/');
  if (slash > 0) {
    const team = plain(s.slice(0, slash), 'チーム名');
    const c = await fetchChannel(mm, userId, `/teams/name/${team}/channels/name/${plain(s.slice(slash + 1), 'チャンネル名')}`);
    return ref(c, team);
  }
  if (!s.startsWith('@')) plain(s, 'チャンネル名');
  const teams = await myTeams(mm, userId);
  if (s.startsWith('@') && s.includes(',')) return resolveGroup(mm, userId, s, teams, opts.create);
  if (s.startsWith('@')) {
    const other = await resolveUser(mm, userId, s);
    if (!teams.length) throw new InputError('所属しているチームがないため DM を探せません。');
    // Looked up before POST /channels/direct even when creating: a user without the permission to create can still write to an existing DM.
    const name = [userId, other.id].sort().join('__');
    const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${teams[0].id}/channels/name/${name}`).catch((e) => {
      if (!missing(e)) throw e;
      if (!opts.create) throw new NoDirectChannel(`@${other.username} との DM はまだありません。`);
      // Refused although Mattermost would create it: the other user cannot read it, and an empty DM would be all that is left.
      if (other.delete_at) throw new InputError(`@${other.username} は無効化されているため、DM を作りません。`);
      return mm.call<MmChannelFull>(userId, 'POST', '/channels/direct', [userId, other.id]).catch(refusalWorded(`@${other.username}`));
    });
    return { ...ref(c, teams[0].name), displayName: `@${other.username}` };
  }
  const found: ResolvedChannel[] = [];
  // Sequential rather than Promise.all: parallel lookups would exceed the per-user concurrency limit.
  for (const t of teams) {
    const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${t.id}/channels/name/${s}`).catch((e) => {
      if (missing(e)) return undefined;
      throw e;
    });
    if (c) found.push(ref(c, t.name));
  }
  if (found.length > 1) throw new Ambiguous(s, found.map((c) => ({ team: c.teamName, name: c.name, id: c.id })));
  if (!found.length) throw new InputError(`チャンネル「${s}」が見つかりません。`);
  return found[0];
}

const ONE_OTHER = 'グループ DM には、自分以外に 2 人以上を指定してください。1 人との DM は @ユーザー名 で指定します。';
const TOO_MANY = 'グループ DM に指定できるのは、自分以外に 7 人までです。';

async function resolveGroup(mm: Mm, userId: string, spec: string, teams: MmTeam[], create?: boolean): Promise<ResolvedChannel> {
  const parts = spec.slice(1).split(',').map((p) => p.trim().replace(/^@/, ''));
  if (parts.some((p) => !p)) throw new InputError('グループ DM の指定に空の名前があります。@a,b の形で、カンマの間にユーザー名を書いてください。');
  const names = [...new Set(parts.map((p) => plain(p, 'ユーザー名').toLowerCase()))];
  // Bounded before the lookup only by the names given: whether one of them is the caller is known after it, and the caller's own name may make 8.
  if (names.length < 2) throw new InputError(ONE_OTHER);
  if (names.length > 8) throw new InputError(TOO_MANY);
  const found = await mm.call<UserRef[]>(userId, 'POST', '/users/usernames', names);
  const missingNames = names.filter((n) => !found.some((u) => u.username === n));
  if (missingNames.length) throw new InputError(`ユーザーが見つかりません: ${missingNames.map((n) => `@${n}`).join(', ')}。`);
  const others = found.filter((u) => u.id !== userId);
  if (others.length < 2) throw new InputError(ONE_OTHER);
  if (others.length > 7) throw new InputError(TOO_MANY);
  if (!teams.length) throw new InputError('所属しているチームがないため、グループ DM を探せません。');
  const label = others.map((u) => `@${u.username}`).sort().join(', ');
  // Same hash as Mattermost's GetGroupNameFromUserIds, so that a read finds the group DM without POST /channels/group, which creates it.
  const name = createHash('sha1').update([userId, ...others.map((u) => u.id)].sort().join('')).digest('hex');
  const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${teams[0].id}/channels/name/${name}`).catch((e) => {
    if (!missing(e)) throw e;
    if (!create) throw new NoDirectChannel(`${label} とのグループ DM はまだありません。`);
    const gone = others.find((u) => u.delete_at);
    if (gone) throw new InputError(`@${gone.username} は無効化されているため、グループ DM を作りません。`);
    return mm.call<MmChannelFull>(userId, 'POST', '/channels/group', others.map((u) => u.id)).catch(refusalWorded(label, GROUP_REFUSED));
  });
  return { ...ref(c, teams[0].name), displayName: label };
}

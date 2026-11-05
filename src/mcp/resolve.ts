import { createHash } from 'node:crypto';
import { MmError, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import { ASK_ADMIN, InputError, oneLine, RETRY, unformat } from './format.ts';

export type Mm = Pick<MmClient, 'call'>;
export type ChannelRef = { id: string; name: string; displayName: string; teamId: string; teamName: string };
export type UserRef = {
  id: string; username: string; first_name?: string; last_name?: string; nickname?: string; position?: string;
  email?: string; locale?: string; is_bot?: boolean; delete_at?: number; timezone?: Record<string, string>;
};
export type MmChannel = { id: string; name: string; display_name: string; team_id: string; type: string };
export type MmChannelFull = MmChannel & { purpose: string; header: string };
export type ResolvedChannel = ChannelRef & { raw: MmChannelFull };

// A subclass rather than converting to a message here: the other tools keep the generic Mattermost error, and only callers that word a channel lookup's 403 and 404 themselves convert it.
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

// A subclass so that a search can say it in its own words: it leaves out archived channels, which the read tools can still read by ID.
export class ChannelNotFound extends InputError {
  constructor(spec: string) {
    super(`チャンネル「${spec}」が見つかりません。名前の誤りなら search_channels で確かめてください。参加していない非公開チャンネルとアーカイブ済みのチャンネルは名前では見つかりません（アーカイブ済みのチャンネルは書き込めませんが、読むだけなら利用者に ID を確かめて ID で指定できます）。${RETRY}${ASK_ADMIN}`);
  }
}

const ID = /^[A-Za-z0-9]{26}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

// Checked rather than only encodeURIComponent'ed: "." and ".." survive encoding and fetch would normalise them into another endpoint.
function plain(name: string, what: string): string {
  if (!name) throw new InputError(`${what}が空です。`);
  if (!NAME.test(name) || name === '.' || name === '..') throw new InputError(`${what}「${oneLine(name)}」は Mattermost の名前として使えない文字を含みます。`);
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
  const s = unformat(spec);
  // Lowered rather than passed as typed: Mattermost user names are lower case only, and it answers 400 to any upper case letter.
  if (s.startsWith('@')) return mm.call<UserRef>(userId, 'GET', `/users/username/${plain(s.slice(1), 'ユーザー名').toLowerCase()}`);
  // Lowered rather than passed as typed: Mattermost IDs are lower case only, so an upper case ID would only find nothing.
  if (ID.test(s)) return mm.call<UserRef>(userId, 'GET', `/users/${s.toLowerCase()}`);
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
export async function resolveChannel(mm: Mm, userId: string, spec: string, opts: { create?: boolean; names?: boolean } = {}): Promise<ResolvedChannel> {
  const s = unformat(spec);
  if (ID.test(s)) {
    const lower = s.toLowerCase();
    // Lowered from the start rather than tried as written: Mattermost IDs are lower case only, so an upper case ID is the same ID written
    // differently, and the ID as written could only find nothing.
    const c = await fetchChannel(mm, userId, `/channels/${lower}`).catch(async (e) => {
      // Not on a 403, which means the ID exists.
      if (!(e instanceof ChannelFetchError && e.status === 404)) throw e;
      const found = await byName(mm, userId, lower, await myTeams(mm, userId));
      if (!found.length) throw e;
      // Not used in place of the ID: a user ID or post ID mistaken for a channel would send to whoever named a channel after it.
      throw new InputError([
        `チャンネル ID「${s}」のチャンネルはありません。ユーザー ID や投稿 ID を渡したのなら、チャンネルの指定ではありません。`,
        `同じ文字列を名前に持つチャンネルはあります。そのチャンネルを指すときだけ、${found.map((f) => `「${f.teamName}/${lower}」（${oneLine(f.displayName)}）`).join('か')}の形で指定してください。`,
      ].join(''));
    });
    // Not looked up when only the ID is wanted (in: in a search): a lookup the output does not use could still fail on a rate limit.
    if (opts.names === false) return ref(c, '');
    const r = ref(c, await teamNameOf(mm, userId, c.team_id));
    const label = await dmLabel(mm, userId, c);
    return label ? { ...r, displayName: label } : r;
  }
  const slash = s.indexOf('/');
  // Lowered rather than passed as typed, here and for a bare channel name: Mattermost names are lower case only, and it answers 400 to any upper case letter.
  if (slash > 0) {
    const team = plain(s.slice(0, slash), 'チーム名').toLowerCase();
    const c = await fetchChannel(mm, userId, `/teams/name/${team}/channels/name/${plain(s.slice(slash + 1), 'チャンネル名').toLowerCase()}`);
    return ref(c, team);
  }
  // Only when every part could be a user name: @bob、議事録 is a missing space before a search word, not a separator.
  const parts = s.slice(1).split(/[,、，]/).map((p) => p.trim().replace(/^@/, '')).filter(Boolean);
  // Not counting empty parts as names: a trailing 、 as in @bob、 is a separator, not a character a user name cannot have.
  if (s.startsWith('@') && /[、，]/.test(s) && parts.length && parts.every((p) => NAME.test(p))) throw new InputError('@a,b の区切りは半角のカンマ（,）で書いてください。読点（、）や全角のカンマ（，）は使えません。');
  if (!s.startsWith('@')) plain(s, 'チャンネル名');
  const teams = await myTeams(mm, userId);
  if (s.startsWith('@') && s.includes(',')) return resolveGroup(mm, userId, s, teams, opts.create);
  if (s.startsWith('@')) {
    // 400 and 403 too: a reserved name such as @all fails Mattermost's check with 400, and with view restrictions a missing name gets 403.
    const other = await resolveUser(mm, userId, s).catch((e) => {
      if (e instanceof MmError && [400, 403, 404].includes(e.status)) throw new InputError(`ユーザー「${s}」が見つかりません。`);
      throw e;
    });
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
  const found = await byName(mm, userId, s.toLowerCase(), teams);
  if (found.length > 1) throw new Ambiguous(s, found.map((c) => ({ team: c.teamName, name: c.name, id: c.id })));
  if (!found.length) throw new ChannelNotFound(s);
  return found[0];
}

// Not using display_name: Mattermost leaves a DM's empty and puts every member, the caller included, in a group DM's.
export async function dmLabel(mm: Mm, userId: string, c: MmChannel): Promise<string | undefined> {
  // Given up on rather than failing the tool: the name is only for the output, and Mattermost's display_name is left as it was.
  const giveUp = (e: unknown) => {
    if (e instanceof MmError || e instanceof UpstreamUnavailable) return undefined;
    throw e;
  };
  if (c.type === 'D') {
    const ids = /^([a-z0-9]{26})__([a-z0-9]{26})$/.exec(c.name ?? '');
    if (!ids || (ids[1] !== userId && ids[2] !== userId)) return undefined;
    const other = ids[1] === userId ? ids[2] : ids[1];
    const u = await mm.call<UserRef>(userId, 'GET', `/users/${other}`).catch(giveUp);
    return u && `@${u.username}`;
  }
  if (c.type === 'G') {
    const members = await mm.call<UserRef[]>(userId, 'GET', `/users?in_channel=${c.id}&per_page=8`).catch(giveUp);
    const others = (members ?? []).filter((u) => u.id !== userId);
    return others.length ? others.map((u) => `@${u.username}`).sort().join(', ') : undefined;
  }
  return undefined;
}

async function byName(mm: Mm, userId: string, name: string, teams: MmTeam[]): Promise<ResolvedChannel[]> {
  const found: ResolvedChannel[] = [];
  // Sequential rather than Promise.all: parallel lookups would exceed the per-user concurrency limit.
  for (const t of teams) {
    const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${t.id}/channels/name/${name}`).catch((e) => {
      if (missing(e)) return undefined;
      throw e;
    });
    if (c) found.push(ref(c, t.name));
  }
  return found;
}

const ONE_OTHER = 'グループ DM には、自分以外に 2 人以上を指定してください。1 人との DM は @ユーザー名 で指定します。';
const TOO_MANY = 'グループ DM に指定できるのは、自分以外に 7 人までです。';

async function resolveGroup(mm: Mm, userId: string, spec: string, teams: MmTeam[], create?: boolean): Promise<ResolvedChannel> {
  const parts = spec.slice(1).split(',').map((p) => p.trim().replace(/^@/, ''));
  if (parts.some((p) => !p)) throw new InputError('グループ DM の指定に空の名前があります。@a,b の形で、カンマの間にユーザー名を書いてください（カンマの前後に空白を入れない）。');
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

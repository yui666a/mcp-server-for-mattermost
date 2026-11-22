import { createHash } from 'node:crypto';
import { msg } from '../i18n/index.ts';
import { CallAborted, MmError, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import { InputError, oneLine, unformat } from './format.ts';

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
      msg().resolve.ambiguous(spec),
      ...candidates.map((c) => msg().resolve.candidate(c.team, c.name, c.id)),
    ].join('\n'));
    this.candidates = candidates;
  }
}

// A subclass so that a search can say it in its own words: it reaches an archived channel only by its ID in in:, not by reading it as the read tools do.
export class ChannelNotFound extends InputError {
  constructor(spec: string) {
    super(`${msg().resolve.channelNotFound(spec)}${msg().common.retry}${msg().common.askAdmin}`);
  }
}

const ID = /^[A-Za-z0-9]{26}$/;
const NAME = /^[A-Za-z0-9._-]+$/;

// Checked rather than only encodeURIComponent'ed: "." and ".." survive encoding and fetch would normalise them into another endpoint.
function plain(name: string, what: string): string {
  if (!name) throw new InputError(msg().resolve.nameEmpty(what));
  if (!NAME.test(name) || name === '.' || name === '..') throw new InputError(msg().resolve.nameInvalid(what, oneLine(name)));
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
  if (s.startsWith('@')) return mm.call<UserRef>(userId, 'GET', `/users/username/${plain(s.slice(1), msg().resolve.userName).toLowerCase()}`);
  // Lowered rather than passed as typed: Mattermost IDs are lower case only, so an upper case ID would only find nothing.
  if (ID.test(s)) return mm.call<UserRef>(userId, 'GET', `/users/${s.toLowerCase()}`);
  throw new InputError(msg().resolve.userSpec);
}

// Same reason for both the permission to create and the visibility of the other user: Mattermost answers both with one id.
// Functions rather than constants: the text is looked up when the error happens, in the locale then set.
const CREATE_REFUSED = (): readonly [number, string, (who: string) => string][] => [
  [403, 'api.context.permissions.app_error', (who) => msg().resolve.dmDenied(who)],
  [403, 'api.channel.create_channel.direct_channel.team_restricted_error', () => msg().resolve.dmTeamRestricted],
  [403, 'api.channel.create_channel.direct_channel.remote_restricted.app_error', (who) => msg().resolve.dmRemote(who)],
];
const GROUP_REFUSED: typeof CREATE_REFUSED = () => [
  [403, 'api.context.permissions.app_error', (who) => msg().resolve.groupDenied(who)],
  [403, 'api.channel.create_group.remote_restricted.app_error', () => msg().resolve.groupRemote],
  [400, 'api.channel.create_group.bad_user.app_error', () => msg().resolve.groupBadUser],
];
const refusalWorded = (who: string, table = CREATE_REFUSED) => (e: unknown): never => {
  const w = e instanceof MmError && table().find(([status, id]) => status === e.status && id === e.id);
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
        msg().resolve.channelIdMissing(s),
        msg().resolve.sameNameExists(found.map((f) => `${f.teamName}/${lower}`)),
        // Not "- " at the head: mark_as_read puts this message in one item of its list, where such a line would read as another item.
        // Not indented either: an indented line can show as code where the result is shown as Markdown.
        ...found.map((f) => msg().resolve.candidateName(`${f.teamName}/${lower}`, oneLine(f.displayName || f.name))),
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
    const team = plain(s.slice(0, slash), msg().resolve.teamName).toLowerCase();
    const c = await fetchChannel(mm, userId, `/teams/name/${team}/channels/name/${plain(s.slice(slash + 1), msg().resolve.channelName).toLowerCase()}`);
    return ref(c, team);
  }
  // Only when every part could be a user name: @bob、議事録 is a missing space before a search word, not a separator.
  const parts = s.slice(1).split(/[,、，]/).map((p) => p.trim().replace(/^@/, '')).filter(Boolean);
  // Not counting empty parts as names: a trailing 、 as in @bob、 is a separator, not a character a user name cannot have.
  if (s.startsWith('@') && /[、，]/.test(s) && parts.length && parts.every((p) => NAME.test(p))) throw new InputError(msg().resolve.commaSeparator);
  if (!s.startsWith('@')) plain(s, msg().resolve.channelName);
  const teams = await myTeams(mm, userId);
  if (s.startsWith('@') && s.includes(',')) return resolveGroup(mm, userId, s, teams, opts.create);
  if (s.startsWith('@')) {
    // 400 and 403 too: a reserved name such as @all fails Mattermost's check with 400, and with view restrictions a missing name gets 403.
    const other = await resolveUser(mm, userId, s).catch((e) => {
      if (e instanceof MmError && [400, 403, 404].includes(e.status)) throw new InputError(msg().resolve.userNotFound(s));
      throw e;
    });
    if (!teams.length) throw new InputError(msg().resolve.noTeamsForDm);
    // Looked up before POST /channels/direct even when creating: a user without the permission to create can still write to an existing DM.
    const name = [userId, other.id].sort().join('__');
    const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${teams[0].id}/channels/name/${name}`).catch((e) => {
      if (!missing(e)) throw e;
      if (!opts.create) throw new NoDirectChannel(msg().resolve.noDm(`@${other.username}`));
      // Refused although Mattermost would create it: the other user cannot read it, and an empty DM would be all that is left.
      if (other.delete_at) throw new InputError(msg().resolve.deactivatedDm(`@${other.username}`));
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
    // Not giving up on a call the caller aborted: there is no one left to read the output.
    if (!(e instanceof CallAborted) && (e instanceof MmError || e instanceof UpstreamUnavailable)) return undefined;
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

async function resolveGroup(mm: Mm, userId: string, spec: string, teams: MmTeam[], create?: boolean): Promise<ResolvedChannel> {
  const parts = spec.slice(1).split(',').map((p) => p.trim().replace(/^@/, ''));
  if (parts.some((p) => !p)) throw new InputError(msg().resolve.groupEmptyName);
  const names = [...new Set(parts.map((p) => plain(p, msg().resolve.userName).toLowerCase()))];
  // Bounded before the lookup only by the names given: whether one of them is the caller is known after it, and the caller's own name may make 8.
  if (names.length < 2) throw new InputError(msg().resolve.oneOther);
  if (names.length > 8) throw new InputError(msg().resolve.tooMany);
  const found = await mm.call<UserRef[]>(userId, 'POST', '/users/usernames', names);
  const missingNames = names.filter((n) => !found.some((u) => u.username === n));
  if (missingNames.length) throw new InputError(msg().resolve.usersNotFound(missingNames.map((n) => `@${n}`).join(', ')));
  const others = found.filter((u) => u.id !== userId);
  if (others.length < 2) throw new InputError(msg().resolve.oneOther);
  if (others.length > 7) throw new InputError(msg().resolve.tooMany);
  if (!teams.length) throw new InputError(msg().resolve.noTeamsForGroup);
  const label = others.map((u) => `@${u.username}`).sort().join(', ');
  // Same hash as Mattermost's GetGroupNameFromUserIds, so that a read finds the group DM without POST /channels/group, which creates it.
  const name = createHash('sha1').update([userId, ...others.map((u) => u.id)].sort().join('')).digest('hex');
  const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${teams[0].id}/channels/name/${name}`).catch((e) => {
    if (!missing(e)) throw e;
    if (!create) throw new NoDirectChannel(msg().resolve.noGroupDm(label));
    const gone = others.find((u) => u.delete_at);
    if (gone) throw new InputError(msg().resolve.deactivatedGroup(`@${gone.username}`));
    return mm.call<MmChannelFull>(userId, 'POST', '/channels/group', others.map((u) => u.id)).catch(refusalWorded(label, GROUP_REFUSED));
  });
  return { ...ref(c, teams[0].name), displayName: label };
}

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
  if (s.startsWith('@')) return mm.call<UserRef>(userId, 'GET', `/users/username/${plain(s.slice(1), 'ユーザー名')}`);
  if (ID.test(s)) return mm.call<UserRef>(userId, 'GET', `/users/${s}`);
  throw new InputError('ユーザーはユーザー ID か @ユーザー名 で指定してください。');
}

export async function resolveChannel(mm: Mm, userId: string, spec: string): Promise<ResolvedChannel> {
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
  if (s.startsWith('@')) {
    const other = await resolveUser(mm, userId, s);
    if (!teams.length) throw new InputError('所属しているチームがないため DM を探せません。');
    // POST /channels/direct is not used: it creates the DM, and this is a read.
    const name = [userId, other.id].sort().join('__');
    const c = await mm.call<MmChannelFull>(userId, 'GET', `/teams/${teams[0].id}/channels/name/${name}`).catch((e) => {
      if (missing(e)) throw new NoDirectChannel(`@${other.username} との DM はまだありません。`);
      throw e;
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

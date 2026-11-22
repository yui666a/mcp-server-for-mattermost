import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CallAborted, MmError, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import { offsetMinutesAt, timeZone, zonedDay } from '../zone.ts';
import { msg } from '../i18n/index.ts';
import { idArg } from './args.ts';
import { bodyCutNote, BODY_MAX_CHARS, decodeCursor, encodeCursor, fileLine, formatPost, formatTime, graphemeCount, indented, InputError, localTime, oneLine, postTruncated, postUserIds, truncate, unformat, type MmFileInfo, type MmPost } from './format.ts';
import { pageCursor, paginate } from './paging.ts';
import { mentionsMe, mentionTerms, type MentionUser } from './mentions.ts';
import { parsePostRef } from './permalink.ts';
import { Ambiguous, ChannelFetchError, ChannelNotFound, myTeams, NoDirectChannel, resolveChannel, resolveUser, teamNameOf, type ChannelRef, type Mm, type MmChannel, type MmTeam, type ResolvedChannel, type UserRef } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { worded, type Wording } from './tools-send.ts';
import { parseWhen, whenForm } from './when.ts';

type PostList = { order: string[]; posts: Record<string, MmPost>; has_next?: boolean | null; prev_post_id?: string };
type Page = { lines: string[]; next?: object; posts?: MmPost[]; notes?: string[] };

type ReadMm = Mm & Pick<MmClient, 'callBytes'>;
type FoundFile = MmFileInfo & { user_id: string; post_id: string; channel_id: string; create_at: number };
type FileList = { order: string[]; file_infos: Record<string, FoundFile> };

const MM_SEARCH_CAP = 100;
const SAVED_PAGE = 200;
const SAVED_OVERLAP = 20;
const SAVED_SCAN = 1000;
const POST_PAGE = 200;
const DAY_MS = 86_400_000;
const PREVIEW_MAX_WIDTH = 1920;
const IMAGE_MAX_SIDE = 3000;
// Decimal MB rather than MiB: base64 of 3.75e6 bytes is 5e6, inside a 5MB request limit whichever unit it means.
const IMAGE_MAX_BYTES = 3_750_000;
const TEXT_MAX_CHARS = 10_000;
const USER_IDS_CHUNK = 1_000;
// 4 bytes per code point rather than per grapheme: a grapheme has no byte limit, so text of long graphemes is cut by bytes first.
const TEXT_FETCH_BYTES = 4 * TEXT_MAX_CHARS;
// Shift_JIS and EUC-JP only for these: their decoders also accept the head of binary files such as PDF.
const SJIS_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'log']);
// A function rather than a constant: the texts follow the language at the time of the call.
const fileWording = (): Wording => ({
  id: [
    [404, 'app.file_info.get.app_error', msg().read.fileNotFound],
    [403, 'api.file.get_file.abac_denied.app_error', msg().read.fileAbac],
  ],
  status: [[403, `${msg().read.fileForbidden}${msg().common.retry}${msg().common.askAdmin}`]],
});

// Not trusting Content-Type: Mattermost labels every preview image/jpeg, PNG ones included.
function imageType(b: Uint8Array): string | undefined {
  const at = (off: number, sig: number[]) => sig.every((x, i) => b[off + i] === x);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return undefined;
}

type Decoded = { text: string; encoding: string; guessed: boolean; cutTail: boolean };
const KANA = /[\u3041-\u3096\u30a1-\u30fa]/;
const HALF_KANA = /[\uff61-\uff9f]/;
// Every character half-width kana Shift_JIS can pass for in UTF-8: a lead byte C2–DF and a trail byte A1–BF, the kana being single bytes A1–DF.
const fromHalfKana = (s: string): boolean => [...s].every((c) => {
  const p = c.codePointAt(0)!;
  return p < 0x80 || (p <= 0x7ff && (p & 0x3f) >= 0x21);
});

// Not by mime_type: Mattermost guesses it from the extension, so a Shift_JIS CSV is labelled utf-8 and a file without an extension gets none.
// whole: the bytes are the whole file, so a character left incomplete at the end is the file's own and not where the fetch stopped.
function decodeText(b: Uint8Array, name: string, whole: boolean): Decoded | undefined {
  if (b.includes(0) || Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-') return undefined;
  // stream: true rather than a plain decode, which would reject the whole text for a character cut at the end of the bytes.
  const decode = (encoding: string) => {
    let d: TextDecoder;
    try {
      d = new TextDecoder(encoding, { fatal: true });
    } catch (e) {
      // Not for UTF-8: a Node without full ICU lacks only the legacy encodings, while a missing UTF-8 fatal mode would turn every file unreadable unnoticed.
      if (encoding === 'utf-8') throw e;
      return undefined;
    }
    try {
      const text = d.decode(b, { stream: true });
      let cutTail = false;
      if (whole) {
        try {
          d.decode();
        } catch {
          cutTail = true;
        }
      }
      return { text, cutTail };
    } catch {
      return undefined;
    }
  };
  const utf8 = decode('utf-8');
  // A cut last character after text half-width kana Shift_JIS could also make: it may as well be that or Latin-1, so UTF-8 is only a guess.
  // Not for any text without Japanese: emoji or Hangul would then read as Shift_JIS, one character swapped for another unnoticed.
  // Not when the file starts with a UTF-8 BOM: TextDecoder drops it from the text, but it is the strongest sign the file is UTF-8.
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const utf8Unsure = utf8?.cutTail && !bom && fromHalfKana(utf8.text);
  if (utf8 && !utf8Unsure) return { ...utf8, encoding: 'UTF-8', guessed: false };
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const utf8AsGuess = utf8 && { ...utf8, encoding: 'UTF-8', guessed: true };
  if (!SJIS_EXTENSIONS.has(ext)) return utf8AsGuess;
  const sjis = decode('shift_jis');
  const euc = decode('euc-jp');
  // One counts as not read when it needs its last character dropped and the other reads the whole: kana-less EUC-JP and odd-length half-width kana end that way.
  const sjisRead = sjis && !(sjis.cutTail && euc && !euc.cutTail) ? sjis : undefined;
  const eucRead = euc && !(euc.cutTail && sjis && !sjis.cutTail) ? euc : undefined;
  // Not EUC-JP for any text with kana: half-width kana Shift_JIS also reads as EUC-JP, though rarely with kana.
  if (eucRead && KANA.test(eucRead.text) && (!sjisRead || HALF_KANA.test(sjisRead.text))) return { ...eucRead, encoding: 'EUC-JP', guessed: true };
  if (utf8AsGuess && (!sjisRead || sjisRead.cutTail) && (!eucRead || eucRead.cutTail)) return utf8AsGuess;
  if (sjisRead) return { ...sjisRead, encoding: 'Shift_JIS', guessed: true };
  return eucRead ? { ...eucRead, encoding: 'EUC-JP', guessed: true } : utf8AsGuess;
}

async function fileText(mm: ReadMm, uid: string, fileId: string, f: MmFileInfo, about: string): Promise<string | CallToolResult> {
  if (f.size === 0) return `${about}\n${msg().read.fileEmpty}`;
  let b: Uint8Array;
  try {
    b = await mm.callBytes(uid, `/files/${fileId}`, undefined, { maxBytes: TEXT_FETCH_BYTES });
  } catch (e) {
    // Only a plain-text 500: that is net/http failing to seek a file the storage does not have, while Mattermost's own errors are JSON (an empty id in hardened mode).
    if (e instanceof UpstreamUnavailable && e.status === 500 && e.plainBody) {
      return `${about}\n${msg().read.fileFetch500}`;
    }
    if (!(e instanceof MmError)) throw e;
    if (e.id === 'api.file.get_file.rejected_by_plugin') return `${about}\n${msg().read.filePluginDownload}`;
    // Not saying the file is missing for sure: the local store answers any failure to open it (permissions, I/O) with the same 404.
    if (e.status === 404 && e.id === 'api.file.file_reader.app_error') return `${about}\n${msg().read.fileFetch404}`;
    return `${about}\n${msg().read.fileFetchFailed(e.status)}`;
  }
  // Fewer bytes than asked means the body ended: the file is whole whatever its info says. At the limit only a matching size tells.
  const whole = b.length < TEXT_FETCH_BYTES || b.length === f.size;
  const t = decodeText(b, f.name, whole);
  if (!t) return `${about}\n${msg().read.fileNotText}`;
  if (!t.text) return `${about}\n${t.cutTail ? msg().read.fileTailOnly : msg().read.fileEmpty}`;
  const { text: shown, truncated } = truncate(t.text, TEXT_MAX_CHARS);
  const head = [about, msg().read.fileEncoding(t.encoding)];
  if (t.guessed) head.push(msg().read.fileEncodingGuessed);
  if (t.cutTail) head.push(msg().read.fileTailCut);
  if (truncated || !whole) {
    const atLeast = !whole && f.size <= b.length;
    head.push(msg().read.fileFirstChars(graphemeCount(shown), whole || atLeast ? b.length : f.size, atLeast));
  }
  return { content: [{ type: 'text', text: head.join('\n') }, { type: 'text', text: shown }] };
}

// Not the offset of each date searched: Mattermost takes one offset per search, as its own client sends the user's current one.
const offsetSec = () => offsetMinutesAt(Date.now()) * 60;
const nextDay = (day: string) => new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);
const prevDay = (day: string) => new Date(Date.parse(day) - DAY_MS).toISOString().slice(0, 10);
const newestFirst = (a: MmPost, b: MmPost) => b.create_at - a.create_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const oldestFirst = (a: MmPost, b: MmPost) => a.create_at - b.create_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
// Where the posts sharing the last post's create_at begin (0 when all share it, or when empty).
// Not paging on from the last post itself: Mattermost's after= and before= compare create_at strictly, so the rest of its millisecond would drop out.
const tieStart = (ps: MmPost[]) => {
  let k = ps.length - 1;
  while (k > 0 && ps[k - 1].create_at === ps[k].create_at) k--;
  return Math.max(k, 0);
};

export const limitArg = (def: number, max: number) => z.number().int().min(1).max(max).optional()
  .describe(msg().descriptions.limit(def));
// A function rather than a constant: the description follows the language at registration time.
export const cursorArg = () => z.string().optional().describe(msg().descriptions.cursor);
export const perPage = (max: number) => z.number().int().min(1).max(max);
const channelKinds = z.array(z.enum(['public', 'private', 'dm', 'group_dm'])).min(1);

export function cursorOf<S extends z.ZodType>(schema: S, cursor: string | undefined): z.infer<S> | undefined {
  if (cursor === undefined) return undefined;
  const r = schema.safeParse(decodeCursor(cursor));
  if (!r.success) throw new InputError(msg().common.badCursor);
  return r.data;
}

export function render({ lines, next, posts = [], notes = [] }: Page): string {
  return [
    ...lines,
    ...notes,
    ...(posts.some(postTruncated) ? [msg().read.cutBodies(BODY_MAX_CHARS)] : []),
    next ? `next_cursor: ${encodeCursor(next)}` : msg().read.noMore,
  ].join('\n');
}

// Not writing an unknown partner as @<user_id>: it would be taken for a username and passed to tools that look users up by name.
export const dmPartner = (username: string | undefined, userId: string) => (username ? `@${username}` : msg().read.unknownUser(userId));

// archived is a field rather than words added to the display name: a display name written as "（アーカイブ済み）" would otherwise pass for one.
export function channelLines(c: ChannelRef & { archived?: boolean }): string[] {
  return [
    // Not the display name first: a name written as "（name: …、channel_id: …）" would then come before the real id.
    msg().read.channelLine(c.id, c.name, !!c.archived, oneLine(c.displayName) || c.name),
    c.teamId ? msg().read.teamLine(c.teamName, c.teamId) : msg().read.noTeam,
  ];
}

const resolvedLines = (ch: ResolvedChannel) => channelLines({ ...ch, archived: !!(ch.raw as ResolvedChannel['raw'] & { delete_at?: number }).delete_at });

// For a post fetched by id: get_post and read_thread word its 403 and 404 alike.
function postError(e: unknown): never {
  if (e instanceof MmError && e.status === 403) throw new InputError(msg().common.postForbidden);
  if (e instanceof MmError && e.status === 404) throw new InputError(msg().read.postNotFound);
  throw e;
}

// For the channel of a post already read: Mattermost may still refuse it on a passing failure, or after the channel went away in between.
function postChannelError(e: unknown): never {
  if (e instanceof MmError && e.status === 403) throw new InputError(`${msg().read.postChannelForbidden}${msg().common.retry}${msg().common.askAdmin}`);
  if (e instanceof MmError && e.status === 404) throw new InputError(msg().read.postChannelGone);
  throw e;
}

// Not the channel first on a shared line: the display name, written by users, would then sit before the real team, and a name ending in "| チーム: …（team_id: …）" would be read first.
export function channelInline(c: ChannelRef & { archived?: boolean }): string {
  const [channel, team] = channelLines(c);
  return `${team} | ${channel}`;
}

// The 404 of looking a channel up by id: /channels/{id} gives it only for a channel that does not exist, whereas a 404 by name may also be a private or archived channel, or a passing failure.
const BY_ID_404 = 'app.channel.get.existing.app_error';

// Not the private-channel wording for team/channel: by name Mattermost answers 404 to a private channel the user is not in.
const forbiddenExample = (spec: string) => (spec.includes('/') ? msg().read.forbiddenExampleTeam : msg().read.forbiddenExample);

export function channelError(e: unknown, spec: string): never {
  // Not converting a missing team: /teams/name/{team}/channels/name/{channel} answers it with 404 too.
  if (e instanceof ChannelFetchError && e.id !== 'app.team.get_by_name.missing.app_error') {
    if (e.status === 403) throw new InputError(`${msg().read.channelForbidden(forbiddenExample(spec))}${msg().common.retry}${msg().common.askAdmin}`);
    // Not keying on the name lookup's ids: a 404 without an id, as a proxy may give, is better read as one by name, which guides to retrying.
    if (e.status === 404 && e.id !== BY_ID_404) throw new InputError(`${msg().read.channelNotFoundByName}${msg().common.retry}${msg().common.askAdmin}`);
    if (e.status === 404) throw new InputError(msg().read.channelIdNotFound);
  }
  throw e;
}

async function usernames(mm: Mm, uid: string, posts: MmPost[]): Promise<Map<string, string>> {
  return usernamesOf(mm, uid, posts.flatMap(postUserIds));
}

export async function usernamesOf(mm: Mm, uid: string, all: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(all)];
  const out = new Map<string, string>();
  // In chunks, one after another: 1,000 ids are about 29KB of JSON, well inside Mattermost's MaximumPayloadSizeBytes (300,000 by default),
  // and sequential calls stay inside the per-user concurrency limit.
  for (let i = 0; i < ids.length; i += USER_IDS_CHUNK) {
    for (const u of await mm.call<UserRef[]>(uid, 'POST', '/users/ids', ids.slice(i, i + USER_IDS_CHUNK))) out.set(u.id, u.username);
  }
  return out;
}

const capNote = (n: number, what: string) => (n >= MM_SEARCH_CAP ? [msg().read.searchCap(MM_SEARCH_CAP, what)] : []);

// Go's unicode.IsSpace, which Mattermost's strings.Fields splits on. Not JS's \s: it adds U+FEFF and lacks U+0085.
const SEARCH_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const SEARCH_FLAGS = ['from', 'channel', 'in', 'before', 'after', 'on', 'ext'];
const fields = (s: string) => s.split(SEARCH_SPACE).filter(Boolean);

// Ported from Mattermost's model.splitWords, so that a quoted "in:x" stays a search word as the server reads it.
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (quoted) {
      words.push(text.slice(start, i + 1));
      quoted = false;
      start = i + 1;
    } else {
      const from = i > 0 && text[i - 1] === '-' ? i - 1 : i;
      // Not push(...): spreading the words as arguments throws a RangeError past a limit that depends on the stack size.
      for (const w of fields(text.slice(start, from))) words.push(w);
      quoted = true;
      start = from;
    }
  }
  return [...words, ...fields(text.slice(start))];
}

// Every flag is walked, not just in:, because any flag with an empty value takes the next word: in "from: in:x" the in:x is the from value.
function channelFilters(words: string[]): { at: number; span: number; value: string; exclude: boolean }[] {
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const colon = w.indexOf(':');
    const exclude = w.startsWith('-');
    if (colon < 0 || !SEARCH_FLAGS.includes(w.slice(exclude ? 1 : 0, colon).toLowerCase())) continue;
    let value = w.slice(colon + 1);
    let span = 1;
    if (!value) {
      if (i === words.length - 1) continue;
      value = words[i + 1];
      span = 2;
    }
    if (/^-?(in|channel):/i.test(w)) found.push({ at: i, span, value, exclude });
    i += span - 1;
  }
  return found;
}

async function filterChannelIds(mm: Mm, userId: string, spec: string, written: string, exclude: boolean, notes: string[], found: { archived: boolean }): Promise<string[]> {
  let ch;
  try {
    ch = await resolveChannel(mm, userId, spec, { names: false });
  } catch (e) {
    if (e instanceof Ambiguous) {
      const ids = [...new Set(e.candidates.map((c) => c.id))];
      if (ids.length > 1 && !exclude) notes.push(msg().read.inSeveralTeams(written, msg().format.list(e.candidates.map((c) => c.team))));
      return ids;
    }
    // No DM means no posts to exclude, so the condition is dropped rather than failing the search.
    if (e instanceof NoDirectChannel && exclude) return [];
    // Not the read tools' wording: for a search, the way to an archived channel is its ID in in:, not read_channel.
    const byName = `${msg().read.inChannelNotFound(spec)}${msg().common.retry}${msg().common.askAdmin}`;
    if (e instanceof ChannelNotFound) throw new InputError(byName);
    if (e instanceof ChannelFetchError && e.id === 'app.team.get_by_name.missing.app_error') {
      throw new InputError(msg().read.inTeamNotFound(spec));
    }
    if (e instanceof ChannelFetchError && e.status === 403) throw new InputError(`${msg().read.inChannelForbidden(spec, forbiddenExample(spec))}${msg().common.retry}${msg().common.askAdmin}`);
    // Told apart by the form of the spec, not by Mattermost's id: a 404 without an id, as a proxy may give, still gets a fitting message.
    if (e instanceof ChannelFetchError && e.status === 404) {
      throw new InputError(spec.includes('/') ? byName : msg().read.inChannelIdNotFound(spec));
    }
    throw e;
  }
  // Not dropping an -in: of an archived channel: it still excludes when another in: makes the search include archived channels.
  if (!exclude && (ch.raw as { delete_at?: number }).delete_at) found.archived = true;
  return [ch.id];
}

// Not higher: with 10 teams the worst case of in: (1 + flags × (teams + 1) GETs, 221), the search, the 3 calls for its output and up to 50
// channels the listing lacks take about 275 of the 300 requests a user may send per minute (one more per 1,000 users beyond the first),
// before anything else that minute.
const MAX_CHANNEL_FILTERS = 20;

// Rewritten here rather than left to Mattermost: a search across all teams looks channel names up without a team and matches nothing,
// and in:@user creates the DM (GetOrCreateDirectChannel) from a read-only tool.
export async function resolveInFilters(mm: Mm, userId: string, terms: string): Promise<{ terms: string; notes: string[]; archived: boolean }> {
  const words = splitWords(terms);
  const filters = channelFilters(words);
  if (!filters.length) return { terms, notes: [], archived: false };
  if (filters.length > MAX_CHANNEL_FILTERS) throw new InputError(msg().read.tooManyFilters(MAX_CHANNEL_FILTERS));
  const notes: string[] = [];
  const found = { archived: false };
  const out = words.map((w) => [w]);
  const written = (f: (typeof filters)[number]) => words.slice(f.at, f.at + f.span).join(' ');
  // Not left to resolveChannel, which removes them too: the checks for ~ and @ below run before it.
  const specOf = (f: (typeof filters)[number]) => unformat(unformat(f.value).replace(/^~+/, ''));
  for (const f of filters) {
    // Not stopping at a word of format characters only: Mattermost keeps it as a word, and it would hide the comma after it.
    let k = f.at + f.span;
    while (k < words.length && !unformat(words[k])) k++;
    const next = words[k];
    const word = unformat(next ?? '');
    // Not treating every 、 or ， as a comma: they also start search words such as 、議事録.
    if (specOf(f).startsWith('@') && /^,|^[、，][A-Za-z0-9._,@、，-]*$/.test(word)) {
      const fullWidth = /^[、，]/.test(word) ? msg().read.commaFullWidth : '';
      throw new InputError(`${msg().read.commaAfter(written(f), next)}${fullWidth}`);
    }
  }
  // Kept for this search only, not across searches: a channel created or joined in between would stay unseen.
  // POST is not kept: a group DM's POST /users/usernames rarely repeats within one search.
  const memo = new Map<string, Promise<unknown>>();
  const cached: Mm = {
    call: <T>(u: string, m: string, p: string, b?: unknown, sig?: AbortSignal) => {
      if (m !== 'GET') return mm.call<T>(u, m, p, b, sig);
      if (!memo.has(p)) memo.set(p, mm.call<T>(u, m, p, b, sig));
      return memo.get(p) as Promise<T>;
    },
  };
  // Sequential rather than Promise.all: parallel lookups would exceed the per-user concurrency limit.
  for (const f of filters) {
    const spec = specOf(f);
    const ids = await filterChannelIds(cached, userId, spec, written(f), f.exclude, notes, found);
    out.splice(f.at, f.span, ids.map((id) => `${f.exclude ? '-' : ''}in:${id}`), ...(f.span === 2 ? [[]] : []));
  }
  const rewritten = out.flat().join(' ');
  if (!rewritten) throw new InputError(msg().read.noTerms);
  return { terms: rewritten, notes, archived: found.archived };
}

const kindOf = (type: string) => msg().read.kinds[type] ?? type;

const listed = <T>(all: T[], c: { offset: number; per_page: number } | undefined, limit: number) => {
  const per = c?.per_page ?? limit;
  const offset = c?.offset ?? 0;
  const end = offset + per;
  return { shown: all.slice(offset, end), next: all.length > end ? { offset: end, per_page: per } : undefined };
};

export const presenceName = (status: string) => msg().read.presence[status] ?? status;

function timeZoneLines(tz: Record<string, string> | undefined): string[] {
  const auto = tz?.useAutomaticTimezone === 'true';
  const zone = (auto ? tz?.automaticTimezone : tz?.manualTimezone) ?? '';
  const now = localTime(zone, Date.now());
  return now ? [msg().read.timeZoneLine(zone, auto), msg().read.localTimeLine(now)] : [msg().read.timeZoneUnset];
}

async function presence(mm: Mm, uid: string, userId: string): Promise<string> {
  let s: { status: string; manual: boolean; dnd_end_time: number };
  try {
    s = await mm.call(uid, 'GET', `/users/${userId}/status`);
  } catch (e) {
    if (e instanceof MmError) return msg().read.presenceFailed;
    throw e;
  }
  // dnd_end_time keeps its last value after dnd ends, so it is read only while the status is dnd.
  const end = s.status === 'dnd' && s.dnd_end_time > 0 ? msg().read.presenceDndEnd(formatTime(s.dnd_end_time * 1000)) : '';
  return `${presenceName(s.status)}${end}${s.manual ? msg().read.presenceManual : ''}`;
}

type UnreadChannel = MmChannel & { last_post_at: number; last_root_post_at: number; total_msg_count: number; total_msg_count_root: number };
type Member = { channel_id: string; last_viewed_at: number; msg_count: number; msg_count_root: number; mention_count: number; mention_count_root: number; notify_props?: { mark_unread?: string } };
type Thread = { id: string; last_reply_at: number; last_viewed_at: number; unread_replies: number; unread_mentions: number; post: MmPost };
type ThreadList = { total_unread_threads: number; threads: Thread[] | null };
type UnreadKey = { s: number; m: number; t: number; id: string };

const THREAD_PAGE = 50;
const THREAD_PAGES = 4;
const MEMBER_PAGE = 200;
const CRT_PREF = '/users/me/preferences/display_settings/name/collapsed_reply_threads';

const byUnreadKey = (a: UnreadKey, b: UnreadKey) => a.s - b.s || a.m - b.m || b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function collapsedThreads(mm: Mm, uid: string): Promise<{ on: boolean; label: string }> {
  const server = (await mm.call<{ CollapsedThreads?: string }>(uid, 'GET', '/config/client?format=old')).CollapsedThreads ?? '';
  if (server !== 'default_on' && server !== 'default_off') return { on: server === 'always_on', label: msg().read.crtServer(server) };
  const pref = await mm.call<{ value: string }>(uid, 'GET', CRT_PREF).catch((e) => {
    // Not treating the 400 as an error: Mattermost answers 400 rather than 404 for a user who never saved the preference.
    if (e instanceof MmError && e.status === 400 && e.id === 'app.preference.get.app_error') return undefined;
    throw e;
  });
  return { on: pref ? pref.value === 'on' : server === 'default_on', label: msg().read.crtServerUser(server, pref?.value) };
}

async function myMembers(mm: Mm, uid: string): Promise<Member[]> {
  const members: Member[] = [];
  for (let page = 0; ; page++) {
    const got = await mm.call<Member[]>(uid, 'GET', `/users/me/channel_members?page=${page}&per_page=${MEMBER_PAGE}`);
    members.push(...got);
    if (got.length < MEMBER_PAGE) return members;
  }
}

async function unreadThreads(mm: Mm, uid: string, teams: MmTeam[], keep: (channelId: string) => boolean) {
  const threads = new Map<string, Thread & { teamName: string }>();
  const notes: string[] = [];
  for (const [i, t] of teams.entries()) {
    let before: string | undefined;
    // Ids before keep and the largest total: total counts the list's threads before keep (and also ones whose root post a retention policy removed), and deletes and reads only lower it.
    const seen = new Set<string>();
    let total = 0;
    for (let n = 1; ; n++) {
      // Not taking DM and group DM threads from every team: each team's list repeats them.
      const q = new URLSearchParams({ unread: 'true', per_page: String(THREAD_PAGE), ...(i ? { excludeDirect: 'true' } : {}), ...(before ? { before } : {}) });
      const r = await mm.call<ThreadList>(uid, 'GET', `/users/${uid}/teams/${t.id}/threads?${q}`);
      const got = r.threads ?? [];
      total = Math.max(total, r.total_unread_threads);
      for (const x of got) {
        seen.add(x.id);
        if (keep(x.post.channel_id) && !threads.has(x.id)) threads.set(x.id, { ...x, teamName: t.name });
      }
      if (got.length < THREAD_PAGE) {
        // Not trusting a short page as the end: before= compares with the starting thread's last reply, so deleting that thread or its replies in between skips or drops the rest.
        if (seen.size < total) notes.push(msg().read.threadsShort(t.name, total));
        break;
      }
      if (n === THREAD_PAGES) {
        if (seen.size < total) notes.push(msg().read.threadsCut(t.name, THREAD_PAGE, THREAD_PAGES, THREAD_PAGE * THREAD_PAGES, total));
        break;
      }
      // Not paging from the last thread alone: before= is strict, so threads sharing its last_reply_at would drop out.
      const edge = got.at(-1)!.last_reply_at;
      const newer = got.filter((x) => x.last_reply_at > edge);
      before = (newer.length ? newer.reduce((a, b) => (b.last_reply_at < a.last_reply_at ? b : a)) : got.at(-1)!).id;
    }
  }
  return { threads, notes };
}

function rangeOf(since: string | undefined, until: string | undefined, from: string | undefined): { since: number; until?: number } {
  if (since === undefined) throw new InputError(msg().read.untilNeedsSince);
  if (from !== undefined) throw new InputError(msg().read.sinceWithFrom);
  const r = { since: parseWhen(since, 'since'), until: until === undefined ? undefined : parseWhen(until, 'until') };
  if (r.until !== undefined && r.until <= r.since) throw new InputError(msg().read.untilBeforeSince);
  return r;
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const base = ctx.cfg.mmBrowserUrl;

  function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>, mm: ReadMm) => Promise<string | CallToolResult>) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } },
      guarded(ctx, name, async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
        const mm: ReadMm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal), callBytes: (u, p, _s, o) => ctx.mm.callBytes(u, p, extra.signal, o) };
        const r = await fn(args, mm);
        return typeof r === 'string' ? text(r) : r;
      // Cast rather than typed directly: the SDK's callback type is a conditional type TypeScript cannot resolve for a generic shape.
      }) as unknown as ToolCallback<S>);
  }

  // Not the channel's own team for the permalink of a DM or group DM: they have none, so the user's first team.
  async function places(mm: Mm, ids: string[], archived: boolean): Promise<(channelId: string) => { where: string; team: string }> {
    // Not the default listing unless archived is false: it leaves out archived channels the user is still in, where saved posts can sit.
    const listed = await mm.call<(MmChannel & { delete_at?: number })[]>(uid, 'GET', archived ? '/users/me/channels?include_deleted=true' : '/users/me/channels');
    const channels = new Map(listed.map((x) => [x.id, x]));
    // Not listing archived channels always for the few a search finds (those archived after it ran, or named by ID in in:); one by one, not in parallel, for the
    // per-user concurrency limit. Not the first team on errors other than 403 and 404: a user in several teams would get another team's
    // permalink without notice.
    for (const id of new Set(ids)) {
      if (channels.has(id)) continue;
      const ch = await mm.call<MmChannel & { delete_at?: number }>(uid, 'GET', `/channels/${id}`).catch((e) => {
        if (e instanceof MmError && (e.status === 403 || e.status === 404)) return undefined;
        throw e;
      });
      if (ch) channels.set(id, ch);
    }
    const teams = await myTeams(mm, uid);
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    return (channelId) => {
      const ch = channels.get(channelId);
      const team = ch?.team_id ? teamName.get(ch.team_id) : undefined;
      const where = ch
        ? channelInline({ id: ch.id, name: ch.name, displayName: ch.display_name || ch.name, teamId: ch.team_id, teamName: team ?? '', archived: !!ch.delete_at })
        : `channel_id: ${channelId}`;
      return { where, team: team ?? teams[0]?.name ?? '' };
    };
  }

  async function withChannels(mm: Mm, shown: MmPost[], archived = false): Promise<string[]> {
    // Not always listing archived channels: the post searches leave their posts out unless in: names one, and a user can be in many of them.
    const placeOf = await places(mm, shown.map((p) => p.channel_id), archived);
    const users = await usernames(mm, uid, shown);
    return shown.map((p) => {
      const { where, team } = placeOf(p.channel_id);
      return formatPost(p, { baseUrl: base, teamName: team, usernames: users, channel: where });
    });
  }

  tool('search_posts', msg().descriptions.searchPosts(timeZone()),
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg() },
    async ({ terms, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      const filtered = await resolveInFilters(mm, uid, terms);
      // Not passing the cursor's page to Mattermost: its database search ignores per_page and returns nothing for page > 0.
      const r = await mm.call<PostList>(uid, 'POST', '/posts/search', { terms: filtered.terms, is_or_search: false, include_deleted_channels: filtered.archived, time_zone_offset: offsetSec(), page: 0, per_page: MM_SEARCH_CAP });
      const all = r.order.map((id) => r.posts[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [msg().read.searchHead(terms), ...(shown.length ? await withChannels(mm, shown) : [msg().read.noPosts])];
      const more = all.length > (page + 1) * per;
      return render({ lines, posts: shown, next: more ? { page: page + 1, per_page: per } : undefined, notes: [...filtered.notes, ...capNote(all.length, msg().read.capOlder)] });
    });

  tool('list_saved_posts', msg().descriptions.listSavedPosts,
    { limit: limitArg(20, 50), cursor: cursorArg() },
    async ({ limit, cursor }, mm) => {
      const c = cursorOf(z.object({ create_at: z.number().int(), id: z.string(), per_page: perPage(50), at: z.number().int().min(0).optional() }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const older = (p: MmPost) => !c || p.create_at < c.create_at || (p.create_at === c.create_at && p.id > c.id);
      const found = new Map<string, MmPost>();
      const row = new Map<string, number>();
      let rest: MmPost[] = [];
      let capped = false;
      // Not reading 200 rows from the start: the first page is the common call, and Mattermost adds metadata to every row it returns.
      let at = 0;
      let size = Math.min(SAVED_PAGE, per + SAVED_OVERLAP + 1);
      // Not sending a page number: Mattermost uses page as the row offset.
      const read = async (from: number, n: number) => {
        const r = await mm.call<PostList>(uid, 'GET', `/users/${uid}/posts/flagged?page=${from}&per_page=${n}`);
        return r.order.map((id) => r.posts[id]).filter(Boolean);
      };
      // Not trusting the cursor's row: saving or unsaving between pages shifts it, and Mattermost drops and reorders posts after counting.
      // The read is kept only when a post in it is strictly newer than the cursor; the rows before it are then newer still, as Mattermost orders by create_at.
      let ahead: MmPost[] | undefined;
      const start = (c?.at ?? 0) - SAVED_OVERLAP;
      if (c && start > 0 && start < SAVED_SCAN - SAVED_OVERLAP) {
        const n = Math.min(SAVED_PAGE, per + 2 * SAVED_OVERLAP + 1, SAVED_SCAN - start);
        const got = await read(start, n);
        if (got.some((p) => p.create_at > c.create_at)) [ahead, at, size] = [got, start, n];
      }
      for (;;) {
        const got = ahead ?? await read(at, size);
        ahead = undefined;
        // Not stopping at a short page: Mattermost drops posts the user may not read after counting the page.
        // Not taking an empty first read as the end: the first read is small, and all of its rows may be ones the user may not read.
        if (!got.length && at === 0 && size < SAVED_PAGE) {
          size = SAVED_PAGE;
          continue;
        }
        if (!got.length) break;
        got.forEach((p, i) => {
          found.set(p.id, p);
          row.set(p.id, at + i);
        });
        rest = [...found.values()].filter(older).sort(newestFirst);
        if (rest.length > per && Math.min(...got.map((p) => p.create_at)) < rest[per - 1].create_at) break;
        // Not starting where the last read ended: Mattermost orders only by create_at, so posts of the same time can swap places between reads and one at the boundary would come in neither.
        // Not more rows back: a larger group of the same time across a boundary comes only from bulk imports, and an unsave during the call uses up the same margin.
        at += size - SAVED_OVERLAP;
        if (at + SAVED_OVERLAP >= SAVED_SCAN) {
          capped = true;
          break;
        }
        size = Math.min(SAVED_PAGE, SAVED_SCAN - at);
      }
      // Not more than SAVED_OVERLAP rows past the limit: if all of them are posts the user may not read, the note is left out, which takes that many in a row.
      if (capped) capped = (await read(SAVED_SCAN, SAVED_OVERLAP)).length > 0;
      const shown = rest.slice(0, per);
      const last = shown.at(-1);
      // Archived channels too: a saved post can sit in one the user is still in.
      const lines = [msg().read.savedHead, ...(shown.length ? await withChannels(mm, shown, true) : c ? [] : [msg().read.noSaved])];
      const notes = capped ? [msg().read.savedCap(SAVED_SCAN)] : [];
      return render({ lines, posts: shown, notes, next: rest.length > per && last ? { create_at: last.create_at, id: last.id, per_page: per, at: row.get(last.id) } : undefined });
    });

  tool('search_files', msg().descriptions.searchFiles,
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg() },
    async ({ terms, limit, cursor }, mm) => {
      // Marked here rather than on search_posts' cursor: that one is used more, and its cursors issued before a deploy would stop working.
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50), files: z.literal(true) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      const search = (t: string, perPageOf: number, archived = false) => mm.call<FileList>(uid, 'POST', '/files/search', {
        terms: t, is_or_search: false, include_deleted_channels: archived, time_zone_offset: offsetSec(), page: 0, per_page: perPageOf,
      }).catch((e) => {
        if (e instanceof MmError && e.status === 501 && e.id === 'store.sql_file_info.search.disabled') throw new InputError(msg().read.fileSearchOff);
        throw e;
      });
      const q = await resolveInFilters(mm, uid, terms).catch(async (e) => {
        if (!(e instanceof InputError)) throw e;
        // Asked with "*" only after a failure: Mattermost checks the setting before converting channel names, and "*" alone searches nothing.
        // Any other failure of this request is set aside: the in: error stays true and is the one the caller can act on.
        await search('*', 1).catch((off) => {
          if (off instanceof InputError) throw off;
        });
        throw e;
      });
      // Not passing the cursor's page to Mattermost: its database search returns nothing for page > 0.
      const r = await search(q.terms, MM_SEARCH_CAP, q.archived);
      const all = r.order.map((id) => r.file_infos[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [msg().read.filesHead(terms)];
      if (shown.length) {
        const placeOf = await places(mm, shown.map((f) => f.channel_id), false);
        // Not looking up the uploader of a channel bookmark file: its user_id is the fixed string "bookmark".
        const ids = [...new Set(shown.filter((f) => f.post_id).map((f) => f.user_id))];
        const users = ids.length ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', ids)).map((u) => [u.id, u.username])) : new Map<string, string>();
        for (const f of shown) {
          const { where, team } = placeOf(f.channel_id);
          const who = users.get(f.user_id);
          lines.push(
            `--- ${fileLine(f)}`,
            `${f.post_id ? (who ? `@${who}` : `user_id: ${f.user_id}`) : msg().read.bookmarkFile} | ${formatTime(f.create_at)}`,
            where,
            ...(f.post_id ? [`post_id: ${f.post_id}`, `${base}/${team}/pl/${f.post_id}`] : []),
          );
        }
      } else lines.push(msg().read.noFiles);
      const more = all.length > (page + 1) * per;
      return render({ lines, notes: [...q.notes, ...capNote(all.length, msg().read.capOlder)], next: more ? { page: page + 1, per_page: per, files: true } : undefined });
    });

  tool('read_channel', msg().descriptions.readChannel,
    {
      channel: z.string().min(1),
      from: z.enum(['latest', 'unread']).optional(),
      since: z.string().optional().describe(msg().descriptions.since(whenForm())),
      until: z.string().optional().describe(msg().descriptions.until),
      limit: limitArg(30, 100),
      cursor: cursorArg(),
    },
    async ({ channel, from, since, until, limit, cursor }, mm) => {
      const postId = z.string().regex(/^[A-Za-z0-9]{26}$/);
      const c = cursorOf(z.union([
        z.object({ channel_id: z.string(), after: postId, since: z.number().int(), until: z.number().int().optional(), per_page: perPage(100) }).strict(),
        z.object({ before: postId, per_page: perPage(100) }),
        z.object({ channel_id: z.string(), after: postId, per_page: perPage(100), crt: z.boolean() }),
      ]), cursor);
      const per = c?.per_page ?? limit ?? 30;
      const rc = c && 'since' in c ? c : undefined;
      const range = rc ?? (!c && (since !== undefined || until !== undefined) ? rangeOf(since, until, from) : undefined);
      const ch = await resolveChannel(mm, uid, channel).catch((e) => channelError(e, channel));
      const renderPage = async (head: string[], all: MmPost[], next: (last: MmPost) => object, none: string, gone: string) => {
        const shown = all.slice(0, all.length > per ? tieStart(all.slice(0, per + 1)) || per : per);
        const users = await usernames(mm, uid, shown);
        const lines = [...resolvedLines(ch), ...head, ...shown.map((p) => formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users }))];
        // Not asking Mattermost whether the cursor's post is gone: GET /posts answers 404 for soft and hard deletes alike, and a cursor is only given while posts remain past it.
        if (!shown.length) lines.push(none, ...(c ? [msg().read.cursorGone + gone] : []));
        return render({ lines, posts: shown, next: shown.length < all.length ? next(shown[shown.length - 1]) : undefined });
      };
      const unreadPage = (crt: boolean, r: PostList) => renderPage(
        [crt ? msg().read.unreadRootsOnly : msg().read.unreadAll],
        r.order.map((id) => r.posts[id]).filter(Boolean).sort(oldestFirst),
        (last) => ({ channel_id: ch.id, after: last.id, per_page: per, crt }),
        c ? msg().read.noPostsHere : msg().read.noUnread,
        msg().read.readAgainSince(false),
      );
      if (range) {
        if (rc && rc.channel_id !== ch.id) throw new InputError(msg().common.badCursor);
        const inRange = (p: MmPost) => p.create_at >= range.since && (range.until === undefined || p.create_at < range.until);
        const posts = async (q: Record<string, string>) => {
          const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${new URLSearchParams({ ...q, skipFetchThreads: 'true' })}`);
          return r.order.map((id) => r.posts[id]).filter(Boolean);
        };
        const forward = async (after: string | undefined, got: MmPost[]) => {
          for (let at = after; at && got.length <= per;) {
            const page = (await posts({ after: at, per_page: String(per + 1) })).sort(oldestFirst);
            const done = page.length <= per || page.some((p) => range.until !== undefined && p.create_at >= range.until);
            // Not leaving the last millisecond to the next fetch when the page fills the result: renderPage moves it to the next page, and leaving it always would cost a second fetch.
            const n = done || got.length + page.filter(inRange).length > per ? page.length : tieStart(page) || page.length;
            got.push(...page.slice(0, n).filter(inRange));
            if (done) break;
            at = page[n - 1].id;
          }
          return got;
        };
        let all: MmPost[];
        if (rc) all = await forward(rc.after, []);
        else {
          // Searching pages of 200 by offset for the newest post before since: there is no REST lookup by time, and since= returns an unordered 1000.
          const pageAt = (k: number) => posts({ page: String(k), per_page: String(POST_PAGE) });
          const hit = (page: MmPost[]) => !page.length || page.some((p) => p.create_at < range.since);
          let lo = -1;
          let loPage: MmPost[] = [];
          let hi = 0;
          let hiPage = await pageAt(0);
          for (let k = 1; !hit(hiPage); k *= 2) {
            [lo, loPage] = [hi, hiPage];
            [hi, hiPage] = [k, await pageAt(k)];
          }
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            const page = await pageAt(mid);
            if (hit(page)) [hi, hiPage] = [mid, page];
            else [lo, loPage] = [mid, page];
          }
          const start = hiPage.filter((p) => p.create_at < range.since).sort(newestFirst)[0];
          if (start) all = await forward(start.id, []);
          else {
            // Not reading on from the oldest post with after= alone: it would skip that post and those of the same millisecond.
            const sorted = [...loPage].sort(oldestFirst);
            const passed = sorted.some((p) => range.until !== undefined && p.create_at >= range.until);
            const seed = passed ? sorted : sorted.slice(0, tieStart(sorted) || sorted.length);
            all = await forward(passed ? undefined : seed.at(-1)?.id, seed.filter(inRange));
          }
        }
        const to = range.until === undefined ? msg().read.rangeToLatest : msg().read.rangeToBefore(formatTime(range.until));
        return renderPage(
          [msg().read.rangeHead(formatTime(range.since), to)],
          all,
          (last) => ({ channel_id: ch.id, after: last.id, since: range.since, until: range.until, per_page: per }),
          msg().read.rangeEmpty,
          msg().read.readAgainSince(range.until !== undefined),
        );
      }
      let head: string[] = [];
      if (c && 'crt' in c) {
        if (c.channel_id !== ch.id) throw new InputError(msg().common.badCursor);
        const q = new URLSearchParams({ after: c.after, per_page: String(per + 1), collapsedThreads: String(c.crt), skipFetchThreads: 'true' });
        return unreadPage(c.crt, await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${q}`));
      }
      if (!c && from === 'unread') {
        const me = await mm.call<{ last_viewed_at: number }>(uid, 'GET', `/channels/${ch.id}/members/me`).catch((e) => {
          if (e instanceof MmError && e.status === 404) throw new InputError(msg().read.notJoinedNoPosition);
          // Not saying the user has not joined on 403: Mattermost refuses a public channel the user has not joined with 403 before the membership lookup, and a passing failure answers 403 too.
          if (e instanceof MmError && e.status === 403) throw new InputError(`${msg().read.unreadPosition403}${msg().common.retrySoon}${msg().common.askAdmin}`);
          throw e;
        });
        // Falling back to newest first rather than walking back to the first post: a channel never opened counts its whole history as unread, with no bound on the walk.
        if (!me.last_viewed_at) head = [msg().read.neverOpened];
        else {
          const crt = (await collapsedThreads(mm, uid)).on;
          const q = new URLSearchParams({ limit_before: '0', limit_after: String(per + 1), collapsedThreads: String(crt), skipFetchThreads: 'true' });
          const first = await mm.call<PostList>(uid, 'GET', `/users/${uid}/channels/${ch.id}/posts/unread?${q}`);
          // Not keeping Mattermost's first page: it reads strictly after the first unread post, leaving out others of its millisecond, so it is read again after the post before it.
          // Not saying there is nothing unread when the second call comes back empty: the post before may have been deleted for good in between.
          if (!first.order.length || !first.prev_post_id) return unreadPage(crt, first);
          const after = new URLSearchParams({ after: first.prev_post_id, per_page: String(per + 1), collapsedThreads: String(crt), skipFetchThreads: 'true' });
          const again = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${after}`);
          return unreadPage(crt, again.order.length ? again : first);
        }
      }
      // Paging with before=<post_id> rather than page numbers: new posts arriving between calls would shift pages.
      const q = new URLSearchParams({ per_page: String(per + 1), ...(c && 'before' in c ? { before: c.before } : {}), skipFetchThreads: 'true' });
      const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${q}`);
      return renderPage(head, r.order.map((id) => r.posts[id]).filter(Boolean), (last) => ({ before: last.id, per_page: per }), msg().read.noPostsHere, msg().read.readAgainLatest);
    });

  tool('read_thread', msg().descriptions.readThread,
    { post_id: idArg, limit: limitArg(50, 200), cursor: cursorArg() },
    async ({ post_id, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ from_post: z.string().regex(/^[A-Za-z0-9]{26}$/), from_create_at: z.number().int(), per_page: perPage(200) }), cursor);
      const per = c?.per_page ?? limit ?? 50;
      const p = await mm.call<MmPost>(uid, 'GET', `/posts/${post_id}`).catch(postError);
      const rootId = p.root_id || p.id;
      const raw = await mm.call<MmChannel & { delete_at?: number }>(uid, 'GET', `/channels/${p.channel_id}`).catch(postChannelError);
      const ch: ChannelRef & { archived: boolean } = { id: raw.id, name: raw.name, displayName: raw.display_name, teamId: raw.team_id, teamName: await teamNameOf(mm, uid, raw.team_id), archived: !!raw.delete_at };
      // Asking for one more than needed and dropping the root: Mattermost counts the root in perPage on the first page only.
      const q = new URLSearchParams({ perPage: String(per + 1), direction: 'down', ...(c ? { fromPost: c.from_post, fromCreateAt: String(c.from_create_at) } : {}) });
      const r = await mm.call<PostList>(uid, 'GET', `/posts/${rootId}/thread?${q}`).catch((e) => {
        if (e instanceof MmError && e.status === 403) throw new InputError(`${msg().read.threadForbidden}${msg().common.retry}${msg().common.askAdmin}`);
        if (e instanceof MmError && e.status === 404) throw new InputError(msg().read.threadGone);
        throw e;
      });
      const replies = r.order.map((id) => r.posts[id]).filter((x) => x && x.id !== rootId)
        .sort((a, b) => a.create_at - b.create_at || (a.id < b.id ? -1 : 1));
      const shown = [...(c ? [] : [r.posts[rootId]].filter(Boolean)), ...replies.slice(0, per)];
      const users = await usernames(mm, uid, shown);
      const last = replies.slice(0, per).at(-1);
      const more = last !== undefined && (replies.length > per || r.has_next === true);
      return render({
        lines: [...channelLines(ch), msg().read.threadHead(rootId), ...shown.map((x) => formatPost(x, { baseUrl: base, teamName: ch.teamName, usernames: users }))],
        posts: shown,
        next: more ? { from_post: last.id, from_create_at: last.create_at, per_page: per } : undefined,
      });
    });

  tool('get_post', msg().descriptions.getPost,
    { post: z.string().min(1) },
    async ({ post }, mm) => {
      const id = parsePostRef(post, base);
      const p = await mm.call<MmPost & { reply_count?: number }>(uid, 'GET', `/posts/${id}`).catch(postError);
      const raw = await mm.call<MmChannel & { delete_at?: number }>(uid, 'GET', `/channels/${p.channel_id}`).catch(postChannelError);
      const ch: ChannelRef & { archived: boolean } = { id: raw.id, name: raw.name, displayName: raw.display_name, teamId: raw.team_id, teamName: await teamNameOf(mm, uid, raw.team_id), archived: !!raw.delete_at };
      const users = await usernames(mm, uid, [p]);
      const replies = p.reply_count ?? 0;
      // Not using render(): its "no more pages" line means nothing for a single post.
      return [
        ...channelLines(ch),
        formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users }),
        msg().read.replyCount(replies),
        ...(p.root_id ? [msg().read.inThread(p.root_id)]
          : replies ? [msg().read.hasReplies(p.id)] : []),
        // Not noting cut message attachments again: formatPost already says where it cut them.
        ...(truncate(p.message).truncated ? [msg().read.cutNote(bodyCutNote())] : []),
      ].join('\n');
    });

  tool('get_file', msg().descriptions.getFile(TEXT_MAX_CHARS),
    { file_id: idArg },
    async ({ file_id }, mm) => {
      const f = await worded(mm.call<MmFileInfo>(uid, 'GET', `/files/${file_id}/info`), fileWording());
      const about = msg().read.fileLabel(fileLine(f));
      // Not filtering on mime_type or has_preview_image: Mattermost decodes by content, and a GIF has a preview despite has_preview_image false.
      if (!f.width || !f.height) return fileText(mm, uid, file_id, f, about);
      const w = Math.min(f.width, PREVIEW_MAX_WIDTH);
      if (Math.max(w, Math.round((f.height * w) / f.width)) > IMAGE_MAX_SIDE) {
        return `${about}\n${msg().read.imageTooBig(IMAGE_MAX_SIDE)}`;
      }
      // Not the permission wording for a plugin's refusal: the information above was readable, as when a plugin refuses the content.
      const preview = mm.callBytes(uid, `/files/${file_id}/preview`).catch((e) => {
        if (e instanceof MmError && e.status === 403 && e.id === 'api.file.get_file_preview.rejected_by_plugin') return 'refused' as const;
        if (e instanceof MmError && e.status === 400 && e.id === 'api.file.get_file_preview.no_preview.app_error') return undefined;
        throw e;
      });
      const b = await worded(preview, fileWording());
      if (b === 'refused') return `${about}\n${msg().read.previewPlugin}`;
      if (!b) return `${about}\n${msg().read.previewNone}`;
      const mimeType = imageType(b);
      if (!mimeType) return `${about}\n${msg().read.previewUnknown}`;
      if (b.length > IMAGE_MAX_BYTES) return `${about}\n${msg().read.imageTooLarge(b.length)}`;
      return { content: [{ type: 'text', text: about }, { type: 'image', data: Buffer.from(b).toString('base64'), mimeType }] };
    });

  tool('search_channels', msg().descriptions.searchChannels,
    { query: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg() },
    async ({ query, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ offset: z.number().int().min(0), per_page: perPage(50) }), cursor);
      const q = query.toLowerCase();
      const teams = await myTeams(mm, uid);
      const teamName = new Map(teams.map((t: MmTeam) => [t.id, t.name]));
      const found = new Map<string, MmChannel & { label?: string }>();
      let capped = 0;
      // Sequential rather than Promise.all: parallel searches would exceed the per-user concurrency limit.
      for (const t of teams) {
        const pub = await mm.call<MmChannel[]>(uid, 'POST', `/teams/${t.id}/channels/search`, { term: query });
        capped = Math.max(capped, pub.length);
        for (const x of pub) found.set(x.id, x);
      }
      const mine = await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels');
      const dms = mine.filter((x) => x.type === 'D');
      // Not giving up on the names as list_my_channels does: a DM is matched by its partner's username, so it would silently drop out of the results.
      const partners = await usernamesOf(mm, uid, dms.map((x) => x.name.split('__').find((id) => id !== uid) ?? uid));
      for (const x of mine) {
        if (x.type === 'D') {
          const other = partners.get(x.name.split('__').find((id) => id !== uid) ?? uid);
          if (other?.toLowerCase().includes(q)) found.set(x.id, { ...x, label: `@${other}` });
        } else if (x.name.toLowerCase().includes(q) || x.display_name.toLowerCase().includes(q)) found.set(x.id, x);
      }
      const all = [...found.values()].sort((a, b) =>
        (teamName.get(a.team_id) ?? '').localeCompare(teamName.get(b.team_id) ?? '') || a.name.localeCompare(b.name));
      const { shown, next } = listed(all, c, limit ?? 20);
      const lines = [msg().read.channelSearchHead(query), ...shown.map((x) => {
        const team = teamName.get(x.team_id);
        const shown = oneLine(x.display_name ?? '');
        // Not the display name at the head of a channel whose team is unknown: users write it. A group DM's is the member list, which they cannot change.
        const where = team ? `${team}/${x.name}` : (x.label ?? (x.type === 'G' && shown ? shown : x.name));
        // Not the display name first: one written as "表示名: …、channel_id: …" would then come before the real id.
        return msg().read.channelRow(where, x.id, team ? x.team_id : undefined, kindOf(x.type), shown || x.label || x.name);
      })];
      if (!shown.length) lines.push(msg().read.noChannels);
      return render({ lines, next, notes: capNote(capped, msg().read.capChannels) });
    });

  tool('list_my_channels', msg().descriptions.listMyChannels,
    {
      types: channelKinds.optional(),
      limit: limitArg(50, 200),
      cursor: cursorArg(),
    },
    async ({ types, limit, cursor }, mm) => {
      const startedAt = Date.now();
      const c = cursorOf(pageCursor(z.object({ t: z.number().int(), id: z.string() })).extend({ per_page: perPage(200), types: channelKinds }), cursor);
      const per = c?.per_page ?? limit ?? 50;
      const kinds = c?.types ?? types ?? channelKinds.element.options;
      const code = { public: 'O', private: 'P', dm: 'D', group_dm: 'G' };
      const wanted = new Set(kinds.map((k) => code[k]));
      const mine = (await mm.call<(MmChannel & { last_post_at: number })[]>(uid, 'GET', '/users/me/channels')).filter((x) => wanted.has(x.type));
      const teamName = new Map((await myTeams(mm, uid)).map((t) => [t.id, t.name]));
      const p = paginate(mine.map((x) => ({ ...x, key: { t: x.last_post_at, id: x.id }, updatedAt: x.last_post_at })),
        (a, b) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0), c, per, startedAt);
      const shown = [...p.updated, ...p.body];
      const other = (x: MmChannel) => x.name.split('__').find((id) => id !== uid) ?? uid;
      const dms = shown.filter((x) => x.type === 'D');
      // Not failing the list when the partners' names cannot be read: they only label the DMs, which then show the partner's user_id marked as one, as dmLabel gives up.
      const partners = await usernamesOf(mm, uid, dms.map(other)).catch((e) => {
        // Not giving up on a call the user aborted: there is no one left to read the list.
        if (!(e instanceof CallAborted) && (e instanceof MmError || e instanceof UpstreamUnavailable)) return new Map<string, string>();
        throw e;
      });
      const line = (x: (typeof shown)[number]) => {
        const team = teamName.get(x.team_id);
        const label = x.type === 'D' ? dmPartner(partners.get(other(x)), other(x)) : oneLine(x.display_name) || x.name;
        const where = team ? `${team}/${x.name}` : x.type === 'D' || x.type === 'G' ? label : x.name;
        return msg().read.myChannelRow(where, x.id, x.team_id || undefined, kindOf(x.type), x.last_post_at ? formatTime(x.last_post_at) : undefined, label);
      };
      const lines = [
        msg().read.myChannelsHead,
        ...(p.updated.length ? [msg().read.myChannelsUpdated, ...p.updated.map(line)] : []),
        ...(p.updated.length && p.body.length ? [msg().read.myChannelsMore] : []),
        ...p.body.map(line),
      ];
      if (!shown.length && !c) lines.push(msg().read.noMyChannels);
      // Not ending with render()'s "no more pages": the listing is not finished, it has to start over.
      if (p.rest) return [...lines, msg().read.myChannelsRest(p.rest)].join('\n');
      return render({ lines, next: p.next && { ...p.next, per_page: per, types: kinds } });
    });

  tool('get_channel', msg().descriptions.getChannel,
    { channel: z.string().min(1), pinned_limit: limitArg(10, 50), cursor: cursorArg() },
    async ({ channel, pinned_limit, cursor }, mm) => {
      const c = cursorOf(z.object({ channel_id: z.string(), create_at: z.number().int(), id: z.string(), per_page: perPage(50) }), cursor);
      const per = c?.per_page ?? pinned_limit ?? 10;
      const ch = await resolveChannel(mm, uid, channel).catch((e) => channelError(e, channel));
      if (c && c.channel_id !== ch.id) throw new InputError(msg().common.badCursor);
      const lines = resolvedLines(ch);
      if (!c) {
        const stats = await mm.call<{ member_count: number }>(uid, 'GET', `/channels/${ch.id}/stats?exclude_files_count=true`).catch((e) => {
          if (e instanceof MmError && e.status === 403) return undefined;
          throw e;
        });
        lines.push(
          msg().read.typeLine(kindOf(ch.raw.type)),
          ...indented(msg().read.purposeLabel, ch.raw.purpose || msg().read.none),
          ...indented(msg().read.headerLabel, ch.raw.header || msg().read.none),
          msg().read.memberCount(stats?.member_count),
        );
      }
      // Sorting here rather than asking Mattermost for a page: /pinned has neither a limit nor paging.
      const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/pinned`).catch((e) => {
        if (!(e instanceof MmError && e.status === 403)) throw e;
        if (c) throw new InputError(`${msg().read.pinnedDenied}${msg().common.retry}${msg().common.askAdmin}`);
        return undefined;
      });
      // Not going through render: its closing line would read as no more pinned posts.
      if (!r) return [...lines, msg().read.pinnedUnavailable].join('\n');
      const all = r.order.map((id) => r.posts[id]).filter(Boolean)
        .sort((a, b) => b.create_at - a.create_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const rest = c ? all.filter((p) => p.create_at < c.create_at || (p.create_at === c.create_at && p.id > c.id)) : all;
      const shown = rest.slice(0, per);
      const users = await usernames(mm, uid, shown);
      lines.push(c ? msg().read.pinnedMore : msg().read.pinnedHead(all.length), ...shown.map((p) => formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users })));
      if (!all.length) lines.push(msg().read.noPinned);
      const last = shown.at(-1);
      return render({ lines, posts: shown, next: rest.length > per && last ? { channel_id: ch.id, create_at: last.create_at, id: last.id, per_page: per } : undefined });
    });

  tool('list_channel_members', msg().descriptions.listChannelMembers,
    { channel: z.string().min(1), limit: limitArg(50, 200), cursor: cursorArg() },
    async ({ channel, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ channel_id: z.string(), page: z.number().int().min(0), per_page: perPage(200) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 50;
      const page = c?.page ?? 0;
      const ch = await resolveChannel(mm, uid, channel).catch((e) => channelError(e, channel));
      if (c && c.channel_id !== ch.id) throw new InputError(msg().common.badCursor);
      // Not joining /channels/{id}/members with the users: /users?in_channel gives the profiles in one call.
      const q = new URLSearchParams({ in_channel: ch.id, active: 'true', page: String(page), per_page: String(per) });
      // Not rewording the 403 of /users alone: the user may leave the channel before /stats.
      const refused = (e: unknown): never => {
        if (e instanceof MmError && e.status === 403) throw new InputError(`${msg().read.membersForbidden}${msg().common.retry}${msg().common.askAdmin}`);
        throw e;
      };
      const users = await mm.call<UserRef[]>(uid, 'GET', `/users?${q}`).catch(refused);
      const lines = resolvedLines(ch);
      if (!c) lines.push(msg().read.memberCount((await mm.call<{ member_count: number }>(uid, 'GET', `/channels/${ch.id}/stats?exclude_files_count=true`).catch(refused)).member_count));
      lines.push(...users.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        return msg().read.memberRow(u.username, [`user_id: ${u.id}`, u.is_bot && msg().read.botAccount, name && msg().read.namePart(oneLine(name)), u.nickname && msg().read.nicknamePart(oneLine(u.nickname)), u.position && msg().read.positionPart(oneLine(u.position))].filter((x): x is string => !!x));
      }));
      if (!users.length && !c) lines.push(msg().read.noMembers);
      // Not asking for one more row to tell the last page: Mattermost pages by page * per_page, so a full last page is followed by an empty one.
      return render({ lines, next: users.length === per ? { channel_id: ch.id, page: page + 1, per_page: per } : undefined });
    });

  tool('get_unreads', msg().descriptions.getUnreads,
    { limit: limitArg(30, 100), cursor: cursorArg() },
    async ({ limit, cursor }, mm) => {
      const startedAt = Date.now();
      const c = cursorOf(pageCursor(z.object({ s: z.number().int(), m: z.number().int(), t: z.number().int(), id: z.string() })).extend({ per_page: perPage(100), crt: z.boolean() }), cursor);
      const per = c?.per_page ?? limit ?? 30;
      const crt = await collapsedThreads(mm, uid);
      // Refusing rather than carrying on: the channel's update time switches between last_root_post_at and last_post_at, so the cursor's position no longer means the same row.
      if (c && c.crt !== crt.on) throw new InputError(msg().read.crtChanged);
      const channels = new Map((await mm.call<UnreadChannel[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x]));
      const members = await myMembers(mm, uid);
      const teams = await myTeams(mm, uid);
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      let threads = new Map<string, Thread & { teamName: string }>();
      const notes: string[] = [];
      let threadsFailed = false;
      if (crt.on) {
        try {
          // Not keeping threads the threads API returns for archived channels: the channel list leaves those channels out, and nothing can mark such a thread read.
          const r = await unreadThreads(mm, uid, teams, (channelId) => channels.has(channelId));
          threads = r.threads;
          notes.push(...r.notes);
        } catch (e) {
          if (!(e instanceof MmError)) throw e;
          threadsFailed = true;
          notes.push(msg().read.threadsFailedNote(e.status, e.message));
        }
      }
      const unread = members.flatMap((mb) => {
        const ch = channels.get(mb.channel_id);
        if (!ch) return [];
        const count = crt.on ? ch.total_msg_count_root - mb.msg_count_root : ch.total_msg_count - mb.msg_count;
        const mentions = crt.on ? mb.mention_count_root : mb.mention_count;
        if (!count && !mentions) return [];
        if (mb.notify_props?.mark_unread === 'mention' && !mentions) return [];
        const updatedAt = crt.on ? ch.last_root_post_at : ch.last_post_at;
        return [{ kind: 'channel' as const, ch, count, mentions, updatedAt, key: { s: 0, m: mentions ? 0 : 1, t: updatedAt, id: ch.id } }];
      });
      const rows = [...unread, ...[...threads.values()].map((th) => ({ kind: 'thread' as const, th, updatedAt: th.last_reply_at, key: { s: 1, m: 0, t: th.last_reply_at, id: th.id } }))];
      const p = paginate(rows, byUnreadKey, c, per, startedAt);
      const shown = [...p.updated, ...p.body];
      const other = (x: MmChannel) => x.name.split('__').find((id) => id !== uid) ?? uid;
      const dmOf = (id: string) => {
        const ch = channels.get(id);
        return ch?.type === 'D' ? [other(ch)] : [];
      };
      const userIds = shown.flatMap((r) => (r.kind === 'thread' ? [...postUserIds(r.th.post), ...dmOf(r.th.post.channel_id)] : dmOf(r.ch.id)));
      const users = await usernamesOf(mm, uid, userIds);
      const where = (x: MmChannel) => {
        const label = x.type === 'D' ? dmPartner(users.get(other(x)), other(x)) : oneLine(x.display_name || x.name);
        const team = teamName.get(x.team_id);
        return { label, path: team ? `${team}/${x.name}` : x.type === 'D' || x.type === 'G' ? label : x.name };
      };
      const posts: MmPost[] = [];
      const line = (r: (typeof rows)[number]): string => {
        if (r.kind === 'channel') {
          const w = where(r.ch);
          return msg().read.unreadChannelRow(w.path, r.ch.id, r.ch.team_id || undefined, r.count, r.mentions, crt.on, formatTime(r.updatedAt), w.label);
        }
        const ch = channels.get(r.th.post.channel_id);
        const team = ch && teamName.get(ch.team_id);
        const at = ch ? channelInline({ id: ch.id, name: ch.name, displayName: where(ch).label, teamId: ch.team_id, teamName: team ?? '' }) : `channel_id: ${r.th.post.channel_id}`;
        posts.push(r.th.post);
        return [
          formatPost(r.th.post, { baseUrl: base, teamName: team ?? r.th.teamName, usernames: users, channel: at }),
          msg().read.unreadThreadLine(r.th.unread_replies, r.th.unread_mentions, formatTime(r.th.last_reply_at)),
        ].join('\n');
      };
      const lines = [
        msg().read.crtLine(crt.on, crt.label),
        msg().read.unreadCounts(unread.length, crt.on ? { failed: threadsFailed, count: threads.size } : undefined),
        ...(p.updated.length ? [msg().read.unreadUpdated, ...p.updated.map(line)] : []),
      ];
      const bodyChannels = p.body.filter((r) => r.kind === 'channel');
      const bodyThreads = p.body.filter((r) => r.kind === 'thread');
      if (bodyChannels.length) lines.push(msg().read.unreadChannelsHead, ...bodyChannels.map(line));
      if (bodyThreads.length) lines.push(msg().read.unreadThreadsHead, ...bodyThreads.map(line));
      if (!rows.length) lines.push(msg().read.noUnread);
      if (p.rest) return [...lines, ...notes, msg().read.unreadRest(p.rest)].join('\n');
      return render({ lines, posts, notes, next: p.next && { ...p.next, per_page: per, crt: crt.on } });
    });

  tool('get_mentions', msg().descriptions.getMentions,
    {
      unread_only: z.boolean().optional(),
      limit: limitArg(20, 50),
      cursor: cursorArg(),
    },
    async ({ unread_only, limit, cursor }, mm) => {
      const c = cursorOf(z.object({
        before: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(),
        last: z.object({ create_at: z.number().int(), id: z.string() }).optional(),
        unread: z.boolean().optional(),
        per_page: perPage(50),
      }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const unread = c ? c.unread === true : unread_only === true;
      const me = await mm.call<MentionUser>(uid, 'GET', '/users/me');
      const terms = mentionTerms(me).map((t) => `"${t}"`).join(' ');
      const notes: string[] = [];
      let unreadAfter = '';
      let isUnread = (_: MmPost) => true;
      if (unread) {
        const crt = (await collapsedThreads(mm, uid)).on;
        // Only where Mattermost counts an unread mention: by position alone, a post edited to add a mention would show or not depending on other candidates.
        // Not counting archived channels: the search leaves their posts out, and their old read positions would only push the search back.
        const created = new Map((await mm.call<(MmChannel & { create_at: number })[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x.create_at]));
        const chans = new Map((await myMembers(mm, uid)).filter((m) => created.has(m.channel_id) && (crt ? m.mention_count_root : m.mention_count) > 0).map((m) => [m.channel_id, m.last_viewed_at]));
        const threads = new Map<string, Thread>();
        if (crt) {
          const r = await unreadThreads(mm, uid, await myTeams(mm, uid), (channelId) => created.has(channelId));
          for (const t of r.threads.values()) if (t.unread_mentions > 0) threads.set(t.id, t);
          notes.push(...r.notes);
        }
        if (!chans.size && !threads.size) return render({ lines: [msg().read.mentionsTitleUnread, msg().read.unreadRule, msg().read.noUnreadMentions], notes });
        isUnread = (p) => {
          // Not leaving out the user's own webhook posts: Mattermost counts a webhook's mention of the user who made it.
          if (p.user_id === uid && p.props?.from_webhook !== 'true') return false;
          const at = crt && p.root_id ? threads.get(p.root_id)?.last_viewed_at : chans.get(p.channel_id);
          return at !== undefined && p.create_at > at;
        };
        // Not taking a read position of 0 as the floor: a channel never viewed or a thread first mentioned in a reply has 0, though nothing in it predates the channel or the root post.
        const floors = [...[...chans].map(([id, at]) => at || created.get(id)!), ...[...threads.values()].map((t) => Math.max(t.last_viewed_at, t.post.create_at))];
        // Not Math.min(...floors): the floors grow with the channels and threads, and spreading them as arguments throws a RangeError past a limit.
        unreadAfter = ` after:${prevDay(zonedDay(floors.reduce((a, b) => Math.min(a, b))))}`;
      }
      let before = c?.before;
      let last = c?.last;
      const shown: MmPost[] = [];
      let next: object | undefined;
      for (let round = 1; ; round++) {
        // Not paging Mattermost's search: its database search returns nothing for page > 0, so older hits are reached by moving before: back a day at a time.
        const r = await mm.call<PostList>(uid, 'POST', '/posts/search', {
          terms: `${terms}${unreadAfter}${before ? ` before:${before}` : ''}`, is_or_search: true, include_deleted_channels: false, time_zone_offset: offsetSec(), page: 0, per_page: MM_SEARCH_CAP,
        });
        const all = r.order.map((id) => r.posts[id]).filter(Boolean).sort(newestFirst);
        const full = all.length >= MM_SEARCH_CAP;
        const d = full ? zonedDay(all.at(-1)!.create_at) : '';
        const oneDay = full && zonedDay(all[0].create_at) === d;
        // Not showing day D's hits when the 100 are full: D's older posts may lie beyond the 100, so D is searched again in full next time.
        const rest = (full && !oneDay ? all.filter((p) => zonedDay(p.create_at) > d) : all)
          .filter((p) => !last || p.create_at < last.create_at || (p.create_at === last.create_at && p.id > last.id))
          .filter((p) => mentionsMe(p.message, me) && isUnread(p));
        const take = rest.slice(0, per);
        shown.push(...take);
        if (take.length) last = { create_at: take.at(-1)!.create_at, id: take.at(-1)!.id };
        if (rest.length > per) {
          next = { before, last, unread: unread || undefined, per_page: per };
          break;
        }
        if (!full) break;
        if (oneDay) notes.push(msg().read.mentionDayCap(d, MM_SEARCH_CAP));
        before = oneDay ? d : nextDay(d);
        if (take.length || round === 3) {
          if (!take.length) notes.push(msg().read.mentionRangeEmpty);
          next = { before, last, unread: unread || undefined, per_page: per };
          break;
        }
      }
      const lines = [
        msg().read.mentionsHead(unread, terms),
        ...(unread ? [msg().read.unreadRule] : []),
        ...(shown.length ? await withChannels(mm, shown) : next ? [] : [unread ? msg().read.noUnreadMentions : msg().read.noMentions]),
      ];
      return render({ lines, posts: shown, notes, next });
    });

  tool('search_users', msg().descriptions.searchUsers,
    { query: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg() },
    async ({ query, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ offset: z.number().int().min(0), per_page: perPage(50) }), cursor);
      const all = await mm.call<UserRef[]>(uid, 'POST', '/users/search', { term: query, limit: MM_SEARCH_CAP });
      const { shown, next } = listed(all, c, limit ?? 20);
      const lines = [msg().read.userSearchHead(query), ...shown.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        return msg().read.memberRow(u.username, [`user_id: ${u.id}`, name && msg().read.namePart(oneLine(name)), u.nickname && msg().read.nicknamePart(oneLine(u.nickname))].filter((x): x is string => !!x));
      })];
      if (!shown.length) lines.push(msg().read.noUsers);
      return render({ lines, next, notes: capNote(all.length, msg().read.capUsers) });
    });

  tool('get_user', msg().descriptions.getUser,
    { user: z.string().min(1) },
    async ({ user }, mm) => {
      const u = await resolveUser(mm, uid, user);
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return [
        `username: @${u.username}`,
        `user_id: ${u.id}`,
        ...(name ? [msg().read.nameLine(oneLine(name))] : []),
        ...(u.nickname ? [msg().read.nicknameLine(oneLine(u.nickname))] : []),
        ...(u.position ? [msg().read.positionLine(oneLine(u.position))] : []),
        ...(u.email ? [msg().read.emailLine(oneLine(u.email))] : []),
        ...(u.is_bot ? [msg().read.botLine] : []),
        ...(u.delete_at ? [msg().read.deactivatedLine] : []),
        ...timeZoneLines(u.timezone),
        msg().read.presenceLine(await presence(mm, uid, u.id)),
      ].join('\n');
    });
}

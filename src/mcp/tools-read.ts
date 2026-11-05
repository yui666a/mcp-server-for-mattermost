import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import { BAD_CURSOR, decodeCursor, encodeCursor, fileLine, formatPost, formatTime, graphemeCount, InputError, localTime, postTruncated, postUserIds, truncate, type MmFileInfo, type MmPost } from './format.ts';
import { pageCursor, paginate } from './paging.ts';
import { mentionsMe, mentionTerms, type MentionUser } from './mentions.ts';
import { parsePostRef } from './permalink.ts';
import { Ambiguous, ChannelFetchError, myTeams, NoDirectChannel, resolveChannel, resolveUser, teamNameOf, type ChannelRef, type Mm, type MmChannel, type MmTeam, type UserRef } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { worded, type Wording } from './tools-send.ts';
import { parseWhen } from './when.ts';

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
const JST_OFFSET_SEC = 9 * 3600;
const DAY_MS = 86_400_000;
const PREVIEW_MAX_WIDTH = 1920;
const IMAGE_MAX_SIDE = 3000;
// Decimal MB rather than MiB: base64 of 3.75e6 bytes is 5e6, inside a 5MB request limit whichever unit it means.
const IMAGE_MAX_BYTES = 3_750_000;
const TEXT_MAX_CHARS = 10_000;
// 4 bytes per code point rather than per grapheme: a grapheme has no byte limit, so text of long graphemes is cut by bytes first.
const TEXT_FETCH_BYTES = 4 * TEXT_MAX_CHARS;
// Shift_JIS and EUC-JP only for these: their decoders also accept the head of binary files such as PDF.
const SJIS_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'log']);
const FILE_WORDING: Wording = {
  id: [
    [404, 'app.file_info.get.app_error', 'ファイルが見つかりません（投稿が削除されたか、存在しません）'],
    [403, 'api.file.get_file.abac_denied.app_error', 'Mattermost のアクセス制御の方針（ABAC）により、このファイルを見られません'],
  ],
  status: [[403, 'このファイルを見る権限がありません']],
};

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

// Not by mime_type: Mattermost guesses it from the extension, so a Shift_JIS CSV is labelled utf-8 and a file without an extension gets none.
// whole: the bytes are the whole file, so a character left incomplete at the end is the file's own and not where the fetch stopped.
function decodeText(b: Uint8Array, name: string, whole: boolean): Decoded | undefined {
  if (b.includes(0) || Buffer.from(b.subarray(0, 5)).toString('latin1') === '%PDF-') return undefined;
  // stream: true rather than a plain decode, which would reject the whole text for a character cut at the end of the bytes.
  const decode = (encoding: string) => {
    const d = new TextDecoder(encoding, { fatal: true });
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
  if (utf8) return { ...utf8, encoding: 'UTF-8', guessed: false };
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!SJIS_EXTENSIONS.has(ext)) return undefined;
  const sjis = decode('shift_jis');
  const euc = decode('euc-jp');
  // One counts as not read when it needs its last character dropped and the other reads the whole: kana-less EUC-JP and odd-length half-width kana end that way.
  const sjisRead = sjis && !(sjis.cutTail && euc && !euc.cutTail) ? sjis : undefined;
  const eucRead = euc && !(euc.cutTail && sjis && !sjis.cutTail) ? euc : undefined;
  // Not EUC-JP for any text with kana: half-width kana Shift_JIS also reads as EUC-JP, though rarely with kana.
  if (eucRead && KANA.test(eucRead.text) && (!sjisRead || HALF_KANA.test(sjisRead.text))) return { ...eucRead, encoding: 'EUC-JP', guessed: true };
  if (sjisRead) return { ...sjisRead, encoding: 'Shift_JIS', guessed: true };
  return eucRead && { ...eucRead, encoding: 'EUC-JP', guessed: true };
}

async function fileText(mm: ReadMm, uid: string, fileId: string, f: MmFileInfo, about: string): Promise<string | CallToolResult> {
  if (f.size === 0) return `${about}\n中身は空です。`;
  let b: Uint8Array;
  try {
    b = await mm.callBytes(uid, `/files/${fileId}`, undefined, { maxBytes: TEXT_FETCH_BYTES });
  } catch (e) {
    // Only a 500 without a Mattermost error id: that is net/http failing to seek a file the storage does not have.
    if (e instanceof UpstreamUnavailable && e.status === 500 && !e.id) {
      return `${about}\n中身を取得できませんでした（HTTP 500）。保存先にファイルの実体が無いか、保存先の一時的な障害です。`;
    }
    if (!(e instanceof MmError)) throw e;
    return e.id === 'api.file.get_file.rejected_by_plugin'
      ? `${about}\nMattermost が中身のダウンロードを拒否しました（プラグインによる制限）。`
      : `${about}\n中身を取得できませんでした（HTTP ${e.status}）。`;
  }
  const t = decodeText(b, f.name, b.length >= f.size);
  if (!t) return `${about}\nテキストとして読めない形式のため、中身は返しません。`;
  if (!t.text) return `${about}\n${t.cutTail ? 'ファイルの末尾に不完全な文字があり、それを除くと読める中身がありません。' : '中身は空です。'}`;
  const { text: shown, truncated } = truncate(t.text, TEXT_MAX_CHARS);
  const head = [about, `文字コード: ${t.encoding}`];
  if (t.guessed) head.push('文字コードは中身から推定しました。文字化けしているなら、Shift_JIS、EUC-JP、Latin-1 など別の文字コードかもしれません。');
  if (t.cutTail) head.push('ファイルの末尾に不完全な文字があったため、その部分を除きました。');
  if (truncated || f.size > b.length) {
    head.push(`先頭の ${graphemeCount(shown)} 文字だけを返しました（ファイル全体は ${f.size} バイト）。`);
  }
  return { content: [{ type: 'text', text: head.join('\n') }, { type: 'text', text: shown }] };
}

const jstDay = (ms: number) => new Date(ms + JST_OFFSET_SEC * 1000).toISOString().slice(0, 10);
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
  .describe(`件数（既定 ${def}、最大 ${max}）。cursor を渡したときは無視する`);
export const cursorArg = z.string().optional().describe('前回の出力の next_cursor');
export const perPage = (max: number) => z.number().int().min(1).max(max);
const channelKinds = z.array(z.enum(['public', 'private', 'dm', 'group_dm'])).min(1);

export function cursorOf<S extends z.ZodType>(schema: S, cursor: string | undefined): z.infer<S> | undefined {
  if (cursor === undefined) return undefined;
  const r = schema.safeParse(decodeCursor(cursor));
  if (!r.success) throw new InputError(BAD_CURSOR);
  return r.data;
}

export function render({ lines, next, posts = [], notes = [] }: Page): string {
  return [
    ...lines,
    ...notes,
    ...(posts.some(postTruncated) ? ['（本文かメッセージ添付を 4000 文字で切った投稿があります）'] : []),
    next ? `next_cursor: ${encodeCursor(next)}` : '（続きはありません）',
  ].join('\n');
}

export function channelLines(c: ChannelRef): string[] {
  return [
    `チャンネル: ${c.displayName || c.name}（name: ${c.name}、channel_id: ${c.id}）`,
    c.teamId ? `チーム: ${c.teamName}（team_id: ${c.teamId}）` : 'チーム: なし（DM またはグループ DM）',
  ];
}

function channelError(e: unknown): never {
  // Not converting a missing team: /teams/name/{team}/channels/name/{channel} answers it with 404 too.
  if (e instanceof ChannelFetchError && e.id !== 'app.team.get_by_name.missing.app_error') {
    if (e.status === 403) throw new InputError('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）');
    if (e.status === 404) throw new InputError('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
  }
  throw e;
}

async function usernames(mm: Mm, uid: string, posts: MmPost[]): Promise<Map<string, string>> {
  const ids = [...new Set(posts.flatMap(postUserIds))];
  if (!ids.length) return new Map();
  const users = await mm.call<UserRef[]>(uid, 'POST', '/users/ids', ids);
  return new Map(users.map((u) => [u.id, u.username]));
}

const FILE_SEARCH_OFF = 'この Mattermost ではファイルの検索が無効になっています（システムコンソールの設定）。ファイル名を含む投稿は search_posts で探せます。';
const capNote = (n: number, what: string) => (n >= MM_SEARCH_CAP
  ? [`（Mattermost の検索は ${MM_SEARCH_CAP} 件までしか返さないため、${what}は出ていない可能性があります。条件を絞ってください）`]
  : []);

// Go's unicode.IsSpace, which Mattermost's strings.Fields splits on. Not JS's \s: it adds U+FEFF and lacks U+0085.
const SEARCH_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const SEARCH_FLAGS = ['from', 'channel', 'in', 'before', 'after', 'on', 'ext'];
const fields = (s: string) => s.split(SEARCH_SPACE).filter(Boolean);

// Ported from Mattermost's model.splitWords, so that a quoted "in:x" stays a search word as the server reads it.
function splitWords(text: string): string[] {
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
      words.push(...fields(text.slice(start, from)));
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

async function filterChannelIds(mm: Mm, userId: string, spec: string, exclude: boolean, notes: string[]): Promise<string[]> {
  try {
    return [(await resolveChannel(mm, userId, spec)).id];
  } catch (e) {
    if (e instanceof Ambiguous) {
      const ids = [...new Set(e.candidates.map((c) => c.id))];
      if (ids.length > 1 && !exclude) notes.push(`in:${spec} は複数のチームにあるため、すべてで探しました（${e.candidates.map((c) => c.team).join('、')}）。`);
      return ids;
    }
    // No DM means no posts to exclude, so the condition is dropped rather than failing the search.
    if (e instanceof NoDirectChannel && exclude) return [];
    if (e instanceof ChannelFetchError && (e.status === 403 || e.status === 404)) throw new InputError(`チャンネル「${spec}」が見つかりません。`);
    throw e;
  }
}

// Not higher: with 10 teams the worst case (1 + flags × (teams + 1) GETs) already takes 221 of the 300 requests a user may send per minute,
// before anything else the user sends in that minute.
const MAX_CHANNEL_FILTERS = 20;

// Rewritten here rather than left to Mattermost: a search across all teams looks channel names up without a team and matches nothing,
// and in:@user creates the DM (GetOrCreateDirectChannel) from a read-only tool.
export async function resolveInFilters(mm: Mm, userId: string, terms: string): Promise<{ terms: string; notes: string[] }> {
  const words = splitWords(terms);
  const filters = channelFilters(words);
  if (!filters.length) return { terms, notes: [] };
  if (filters.length > MAX_CHANNEL_FILTERS) throw new InputError(`in: と channel: は 1 回の検索で ${MAX_CHANNEL_FILTERS} 個まで指定できます。`);
  const notes: string[] = [];
  const out = words.map((w) => [w]);
  for (const f of filters) {
    const next = words[f.at + f.span];
    // Not treating every 、 as a comma: 、 also starts search words such as 、議事録.
    if (f.value.replace(/^~+/, '').startsWith('@') && /^[,，]|^、[A-Za-z0-9._,@、，-]*$/.test(next ?? '')) {
      const fullWidth = /^[、，]/.test(next ?? '') ? '区切りは半角のカンマ（,）で書いてください。' : '';
      throw new InputError(`in:${f.value} の後の「${next}」: 検索の in: では @a,b のようにカンマの前後に空白を入れずに書いてください。${fullWidth}`);
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
    const spec = f.value.replace(/^~+/, '');
    const ids = await filterChannelIds(cached, userId, spec, f.exclude, notes);
    out.splice(f.at, f.span, ids.map((id) => `${f.exclude ? '-' : ''}in:${id}`), ...(f.span === 2 ? [[]] : []));
  }
  const rewritten = out.flat().join(' ');
  if (!rewritten) throw new InputError('検索語か条件を 1 つ以上指定してください。');
  return { terms: rewritten, notes };
}

const listed = <T>(all: T[], c: { offset: number; per_page: number } | undefined, limit: number) => {
  const per = c?.per_page ?? limit;
  const offset = c?.offset ?? 0;
  const end = offset + per;
  return { shown: all.slice(offset, end), next: all.length > end ? { offset: end, per_page: per } : undefined };
};

export const PRESENCE: Record<string, string> = { online: 'オンライン', away: '離席', dnd: '取り込み中', offline: 'オフライン', ooo: '不在' };

function timeZoneLines(tz: Record<string, string> | undefined): string[] {
  const auto = tz?.useAutomaticTimezone === 'true';
  const zone = (auto ? tz?.automaticTimezone : tz?.manualTimezone) ?? '';
  const now = localTime(zone, Date.now());
  return now ? [`タイムゾーン: ${zone}（${auto ? '自動' : '手動'}）`, `現地時刻: ${now}`] : ['タイムゾーン: 未設定'];
}

async function presence(mm: Mm, uid: string, userId: string): Promise<string> {
  let s: { status: string; manual: boolean; dnd_end_time: number };
  try {
    s = await mm.call(uid, 'GET', `/users/${userId}/status`);
  } catch (e) {
    if (e instanceof MmError) return '取得できませんでした';
    throw e;
  }
  // dnd_end_time keeps its last value after dnd ends, so it is read only while the status is dnd.
  const end = s.status === 'dnd' && s.dnd_end_time > 0 ? `（終了: ${formatTime(s.dnd_end_time * 1000)}）` : '';
  return `${PRESENCE[s.status] ?? s.status}${end}${s.manual ? '（手動で設定）' : ''}`;
}

type UnreadChannel = MmChannel & { last_post_at: number; last_root_post_at: number; total_msg_count: number; total_msg_count_root: number };
type Member = { channel_id: string; last_viewed_at: number; msg_count: number; msg_count_root: number; mention_count: number; mention_count_root: number; notify_props?: { mark_unread?: string } };
type Thread = { id: string; last_reply_at: number; last_viewed_at: number; unread_replies: number; unread_mentions: number; post: MmPost };
type ThreadList = { total_unread_threads: number; threads: Thread[] | null };
type UnreadKey = { s: number; m: number; t: number; id: string };

const THREAD_PAGE = 50;
const THREAD_PAGES = 4;
const MEMBER_PAGE = 200;
const UNREAD_RULE = '未読の判定: Mattermost が未読のメンションを数えているチャンネルとスレッドの、既読の位置より後の投稿（スレッドの折りたたみ（CRT）が有効なら、返信はスレッドの既読の位置で判定。自分の投稿は出さないが、自分の Webhook の投稿は出す）';
const CRT_PREF = '/users/me/preferences/display_settings/name/collapsed_reply_threads';

const byUnreadKey = (a: UnreadKey, b: UnreadKey) => a.s - b.s || a.m - b.m || b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function collapsedThreads(mm: Mm, uid: string): Promise<{ on: boolean; label: string }> {
  const server = (await mm.call<{ CollapsedThreads?: string }>(uid, 'GET', '/config/client?format=old')).CollapsedThreads ?? '';
  if (server !== 'default_on' && server !== 'default_off') return { on: server === 'always_on', label: `サーバー設定: ${server}` };
  const pref = await mm.call<{ value: string }>(uid, 'GET', CRT_PREF).catch((e) => {
    // Not treating the 400 as an error: Mattermost answers 400 rather than 404 for a user who never saved the preference.
    if (e instanceof MmError && e.status === 400 && e.id === 'app.preference.get.app_error') return undefined;
    throw e;
  });
  return { on: pref ? pref.value === 'on' : server === 'default_on', label: `サーバー設定: ${server}、利用者の設定: ${pref?.value ?? 'なし'}` };
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
    // Ids before keep and the largest total: total counts the same threads as the list, and deleting the starting thread or its replies only lowers it.
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
        if (seen.size < total) notes.push(`（${t.name} の未読スレッドを total_unread_threads: ${total} に対して取り切れませんでした。取得の合間にスレッドや返信が削除されたときなどに、続きを取りこぼすことがあります。呼び直すと取り直せます）`);
        break;
      }
      if (n === THREAD_PAGES) {
        if (seen.size < total) notes.push(`（${t.name} の未読スレッドは、${THREAD_PAGE} 件ずつ ${THREAD_PAGES} 回の取得で打ち切りました。境目と同じ時刻のスレッドは取り直すので、取得した異なるスレッドは ${THREAD_PAGE * THREAD_PAGES} 件より少ないことがあります（total_unread_threads: ${total}））`);
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
  if (since === undefined) throw new InputError('until は since と一緒に指定してください。');
  if (from !== undefined) throw new InputError('since と from は同時に指定できません。since を渡すと、その時刻から古い順に読みます。');
  const r = { since: parseWhen(since, 'since'), until: until === undefined ? undefined : parseWhen(until, 'until') };
  if (r.until !== undefined && r.until <= r.since) throw new InputError('until は since より後の時刻にしてください。');
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

  async function withChannels(mm: Mm, shown: MmPost[]): Promise<string[]> {
    // Not the default listing: it leaves out archived channels the user is still in, where saved posts can sit.
    const channels = new Map((await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels?include_deleted=true')).map((x) => [x.id, x]));
    const teams = await myTeams(mm, uid);
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const users = await usernames(mm, uid, shown);
    return shown.map((p) => {
      const ch = channels.get(p.channel_id);
      const team = ch?.team_id ? teamName.get(ch.team_id) : undefined;
      const where = ch
        ? channelLines({ id: ch.id, name: ch.name, displayName: ch.display_name, teamId: ch.team_id, teamName: team ?? '' }).join(' | ')
        : `channel_id: ${p.channel_id}`;
      return formatPost(p, { baseUrl: base, teamName: team ?? teams[0]?.name ?? '', usernames: users, channel: where });
    });
  }

  tool('search_posts', '参加しているチームのメッセージを検索する。Mattermost の検索構文（from:、in:、before:、after:、on: など）をそのまま使える。in: にはチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM。カンマの前後に空白を入れない）を渡せる。同じ名前が複数のチームにあれば、すべてで探す。見つからなければエラー（見る権限の無い非公開チャンネルも見つからない扱い）。参加しているチームの、参加していないチャンネル（見られる非公開を含む）は 0 件になる。DM は作らない。日付は日本時間（JST）で解釈する。新しい順。メッセージ添付（Bot や webhook などが付ける整形表示）の中身は検索の対象外（Mattermost の標準のデータベース検索は添付を検索しないため。その中身を探すなら read_channel で読む。read_channel なら since と until で期間を指定して読める）',
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
    async ({ terms, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      const filtered = await resolveInFilters(mm, uid, terms);
      // Not passing the cursor's page to Mattermost: its database search ignores per_page and returns nothing for page > 0.
      const r = await mm.call<PostList>(uid, 'POST', '/posts/search', { terms: filtered.terms, is_or_search: false, include_deleted_channels: false, time_zone_offset: JST_OFFSET_SEC, page: 0, per_page: MM_SEARCH_CAP });
      const all = r.order.map((id) => r.posts[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [`検索: ${terms}`, ...(shown.length ? await withChannels(mm, shown) : ['一致する投稿はありません。'])];
      const more = all.length > (page + 1) * per;
      return render({ lines, posts: shown, next: more ? { page: page + 1, per_page: per } : undefined, notes: [...filtered.notes, ...capNote(all.length, 'これより古い一致')] });
    });

  tool('list_saved_posts', '自分が保存した（フラグを付けた）投稿を新しい順に一覧する。参加しているチャンネルの投稿だけが対象で、アーカイブ済みのチャンネルの投稿も含む',
    { limit: limitArg(20, 50), cursor: cursorArg },
    async ({ limit, cursor }, mm) => {
      const c = cursorOf(z.object({ create_at: z.number().int(), id: z.string(), per_page: perPage(50) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const older = (p: MmPost) => !c || p.create_at < c.create_at || (p.create_at === c.create_at && p.id > c.id);
      const found = new Map<string, MmPost>();
      let rest: MmPost[] = [];
      let capped = false;
      // Not putting Mattermost's offset in the cursor: saving or unsaving between pages would shift it.
      // Not reading 200 rows from the start: the first page is the common call, and Mattermost adds metadata to every row it returns.
      let at = 0;
      let size = Math.min(SAVED_PAGE, per + SAVED_OVERLAP + 1);
      for (;;) {
        // Not sending a page number: Mattermost uses page as the row offset.
        const r = await mm.call<PostList>(uid, 'GET', `/users/${uid}/posts/flagged?page=${at}&per_page=${size}`);
        const got = r.order.map((id) => r.posts[id]).filter(Boolean);
        // Not stopping at a short page: Mattermost drops posts the user may not read after counting the page.
        // Not taking an empty first read as the end: the first read is small, and all of its rows may be ones the user may not read.
        if (!got.length && at === 0 && size < SAVED_PAGE) {
          size = SAVED_PAGE;
          continue;
        }
        if (!got.length) break;
        for (const p of got) found.set(p.id, p);
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
      const shown = rest.slice(0, per);
      const last = shown.at(-1);
      const lines = ['保存した投稿（新しい順）', ...(shown.length ? await withChannels(mm, shown) : c ? [] : ['保存した投稿はありません。'])];
      const notes = capped ? [`（保存した投稿のうち新しい ${SAVED_SCAN} 件だけを見ています）`] : [];
      return render({ lines, posts: shown, notes, next: rest.length > per && last ? { create_at: last.create_at, id: last.id, per_page: per } : undefined });
    });

  tool('search_files', 'ファイルを名前で探す（サーバーが中身を抽出していれば中身にも当たる）。参加しているチャンネル、DM、グループ DM のファイルが対象で、参加していない公開チャンネルとアーカイブ済みのチャンネルのファイルは出ない。Mattermost の検索構文（from:、in:、ext:、before:、after:、on: など）を使え、日付は日本時間（JST）で解釈する。in: にはチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM。カンマの前後に空白を入れない）を渡せる。同じ名前が複数のチームにあれば、すべてで探す。見つからなければエラー（見る権限の無い非公開チャンネルも見つからない扱い）。DM は作らない。名前は語の単位で当たり、日本語の名前は名前全体か先頭からの前方一致（例: 2026年10月*）でしか当たらない。新しい順。file_id は get_file に、post_id は get_post に渡せる',
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
    async ({ terms, limit, cursor }, mm) => {
      // Marked here rather than on search_posts' cursor: that one is used more, and its cursors issued before a deploy would stop working.
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50), files: z.literal(true) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      const search = (t: string, perPageOf: number) => mm.call<FileList>(uid, 'POST', '/files/search', {
        terms: t, is_or_search: false, include_deleted_channels: false, time_zone_offset: JST_OFFSET_SEC, page: 0, per_page: perPageOf,
      }).catch((e) => {
        if (e instanceof MmError && e.status === 501 && e.id === 'store.sql_file_info.search.disabled') throw new InputError(FILE_SEARCH_OFF);
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
      const r = await search(q.terms, MM_SEARCH_CAP);
      const all = r.order.map((id) => r.file_infos[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [`ファイルの検索: ${terms}`];
      if (shown.length) {
        const channels = new Map((await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x]));
        const teams = await myTeams(mm, uid);
        const teamName = new Map(teams.map((t) => [t.id, t.name]));
        // Not looking up the uploader of a channel bookmark file: its user_id is the fixed string "bookmark".
        const ids = [...new Set(shown.filter((f) => f.post_id).map((f) => f.user_id))];
        const users = ids.length ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', ids)).map((u) => [u.id, u.username])) : new Map<string, string>();
        for (const f of shown) {
          const ch = channels.get(f.channel_id);
          const team = ch?.team_id ? teamName.get(ch.team_id) : undefined;
          const who = users.get(f.user_id);
          lines.push(
            `--- ${fileLine(f)}`,
            `${f.post_id ? (who ? `@${who}` : `user_id: ${f.user_id}`) : 'チャンネルのブックマークのファイル（投稿なし）'} | ${formatTime(f.create_at)}`,
            ch ? channelLines({ id: ch.id, name: ch.name, displayName: ch.display_name, teamId: ch.team_id, teamName: team ?? '' }).join(' | ') : `channel_id: ${f.channel_id}`,
            ...(f.post_id ? [`post_id: ${f.post_id}`, `${base}/${team ?? teams[0]?.name ?? ''}/pl/${f.post_id}`] : []),
          );
        }
      } else lines.push('一致するファイルはありません。');
      const more = all.length > (page + 1) * per;
      return render({ lines, notes: [...q.notes, ...capNote(all.length, 'これより古い一致')], next: more ? { page: page + 1, per_page: per, files: true } : undefined });
    });

  tool('read_channel', 'チャンネルの投稿を読む。既定は新しい順。from: "unread" なら未読の先頭から古い順に読み、スレッドの折りたたみ（CRT）が有効ならルート投稿だけを返す。読むだけで、既読にはしない。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。since を渡すと、その時刻から until（省くと最新）の前までを古い順に読み、返信も含む',
    {
      channel: z.string().min(1),
      from: z.enum(['latest', 'unread']).optional().describe('latest（既定）は最新から新しい順、unread は未読の先頭から古い順。cursor を渡したときは無視する'),
      since: z.string().optional().describe('範囲の始まり（この時刻を含む）。YYYY-MM-DDTHH:mm の形（秒、タイムゾーンは任意。タイムゾーンが無ければ JST）。from とは同時に指定できない。cursor を渡したときは無視する'),
      until: z.string().optional().describe('範囲の終わり（この時刻を含まない）。形は since と同じ。省くと最新まで。since と一緒に指定する。cursor を渡したときは無視する'),
      limit: limitArg(30, 100),
      cursor: cursorArg,
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
      const ch = await resolveChannel(mm, uid, channel);
      const GONE = '（カーソルの起点かその続きの投稿が削除されたか、同じミリ秒の投稿が多かったため、続きを取りこぼしている可能性があります。';
      const renderPage = async (head: string[], all: MmPost[], next: (last: MmPost) => object, none: string, gone: string) => {
        const shown = all.slice(0, all.length > per ? tieStart(all.slice(0, per + 1)) || per : per);
        const users = await usernames(mm, uid, shown);
        const lines = [...channelLines(ch), ...head, ...shown.map((p) => formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users }))];
        // Not asking Mattermost whether the cursor's post is gone: GET /posts answers 404 for soft and hard deletes alike, and a cursor is only given while posts remain past it.
        if (!shown.length) lines.push(none, ...(c ? [GONE + gone] : []));
        return render({ lines, posts: shown, next: shown.length < all.length ? next(shown[shown.length - 1]) : undefined });
      };
      const sinceAgain = '前のページの最後の投稿の時刻を since に渡すと、その位置から古い順に読み直せます。その時刻の投稿は重ねて出ることがあり、返信も含みます';
      const unreadPage = (crt: boolean, r: PostList) => renderPage(
        [crt
          ? '未読の先頭から古い順（スレッドの折りたたみ（CRT）が有効なため、ルート投稿だけです。返信は get_unreads の未読のスレッドと read_thread で読めます）'
          : '未読の先頭から古い順（返信も含みます）'],
        r.order.map((id) => r.posts[id]).filter(Boolean).sort(oldestFirst),
        (last) => ({ channel_id: ch.id, after: last.id, per_page: per, crt }),
        c ? '投稿はありません。' : '未読はありません。',
        `${sinceAgain}）`,
      );
      if (range) {
        if (rc && rc.channel_id !== ch.id) throw new InputError(BAD_CURSOR);
        const inRange = (p: MmPost) => p.create_at >= range.since && (range.until === undefined || p.create_at < range.until);
        const posts = async (q: Record<string, string>) => {
          const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${new URLSearchParams({ ...q, skipFetchThreads: 'true' })}`);
          return r.order.map((id) => r.posts[id]).filter(Boolean);
        };
        const forward = async (after: string | undefined, got: MmPost[]) => {
          for (let at = after; at && got.length <= per;) {
            // Not taking per+1 as for a page shown: the posts of the last millisecond are left to the next fetch, which would then always be needed.
            const page = (await posts({ after: at, per_page: String(per + 2) })).sort(oldestFirst);
            const done = page.length <= per + 1 || page.some((p) => range.until !== undefined && p.create_at >= range.until);
            const n = done ? page.length : tieStart(page) || page.length;
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
        const to = range.until === undefined ? '最新まで' : `${formatTime(range.until)} の前まで`;
        return renderPage(
          [`範囲: ${formatTime(range.since)} から ${to}、古い順（返信も含みます）`],
          all,
          (last) => ({ channel_id: ch.id, after: last.id, since: range.since, until: range.until, per_page: per }),
          'この範囲に投稿はありません。',
          `${sinceAgain}${range.until === undefined ? '' : '。until は前と同じ値を渡してください'}）`,
        );
      }
      let head: string[] = [];
      if (c && 'crt' in c) {
        if (c.channel_id !== ch.id) throw new InputError(BAD_CURSOR);
        const q = new URLSearchParams({ after: c.after, per_page: String(per + 1), collapsedThreads: String(c.crt), skipFetchThreads: 'true' });
        return unreadPage(c.crt, await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${q}`));
      }
      if (!c && from === 'unread') {
        const me = await mm.call<{ last_viewed_at: number }>(uid, 'GET', `/channels/${ch.id}/members/me`).catch((e) => {
          // Not reading only 404 as not joined: a public channel the user has not joined is refused with 403 before the membership lookup.
          if (e instanceof MmError && (e.status === 403 || e.status === 404)) throw new InputError('このチャンネルに参加していないため、未読の位置がありません。from: "latest" で読んでください。');
          throw e;
        });
        // Falling back to newest first rather than walking back to the first post: a channel never opened counts its whole history as unread, with no bound on the walk.
        if (!me.last_viewed_at) head = ['既読の位置が記録されていない（参加してから一度も開いていない）ため、すべてが未読の扱いです。未読の先頭からは読めないので、新しい順に読んでいます。'];
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
      return renderPage(head, r.order.map((id) => r.posts[id]).filter(Boolean), (last) => ({ before: last.id, per_page: per }), '投稿はありません。', 'cursor を渡さずに呼ぶと、最新から読み直せます）');
    });

  tool('read_thread', 'スレッドの親投稿と返信を古い順に読む。post_id はスレッド内のどの投稿でもよい。親投稿は最初のページにだけ含める',
    { post_id: z.string().regex(/^[A-Za-z0-9]{26}$/), limit: limitArg(50, 200), cursor: cursorArg },
    async ({ post_id, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ from_post: z.string().regex(/^[A-Za-z0-9]{26}$/), from_create_at: z.number().int(), per_page: perPage(200) }), cursor);
      const per = c?.per_page ?? limit ?? 50;
      const p = await mm.call<MmPost>(uid, 'GET', `/posts/${post_id}`);
      const rootId = p.root_id || p.id;
      const raw = await mm.call<MmChannel>(uid, 'GET', `/channels/${p.channel_id}`);
      const ch: ChannelRef = { id: raw.id, name: raw.name, displayName: raw.display_name, teamId: raw.team_id, teamName: await teamNameOf(mm, uid, raw.team_id) };
      // Asking for one more than needed and dropping the root: Mattermost counts the root in perPage on the first page only.
      const q = new URLSearchParams({ perPage: String(per + 1), direction: 'down', ...(c ? { fromPost: c.from_post, fromCreateAt: String(c.from_create_at) } : {}) });
      const r = await mm.call<PostList>(uid, 'GET', `/posts/${rootId}/thread?${q}`);
      const replies = r.order.map((id) => r.posts[id]).filter((x) => x && x.id !== rootId)
        .sort((a, b) => a.create_at - b.create_at || (a.id < b.id ? -1 : 1));
      const shown = [...(c ? [] : [r.posts[rootId]].filter(Boolean)), ...replies.slice(0, per)];
      const users = await usernames(mm, uid, shown);
      const last = replies.slice(0, per).at(-1);
      const more = last !== undefined && (replies.length > per || r.has_next === true);
      return render({
        lines: [...channelLines(ch), `スレッド: 親 post_id: ${rootId}`, ...shown.map((x) => formatPost(x, { baseUrl: base, teamName: ch.teamName, usernames: users }))],
        posts: shown,
        next: more ? { from_post: last.id, from_create_at: last.create_at, per_page: per } : undefined,
      });
    });

  tool('get_post', '1 件の投稿を読む。post は post_id か、パーマリンクの URL（…/<チーム名>/pl/<post_id>）。本文は各行を 2 文字字下げし、4000 文字を超える本文は切って出す（edit_message で書き換えるときは字下げを外し、切った投稿は出力を元に書き換えない）',
    { post: z.string().min(1) },
    async ({ post }, mm) => {
      const id = parsePostRef(post, base);
      const p = await mm.call<MmPost & { reply_count?: number }>(uid, 'GET', `/posts/${id}`).catch((e) => {
        if (e instanceof MmError && e.status === 403) throw new InputError('この投稿を見る権限がありません（参加していない非公開チャンネルなど）');
        if (e instanceof MmError && e.status === 404) throw new InputError('投稿が見つかりません（削除されたか、存在しません）');
        throw e;
      });
      const raw = await mm.call<MmChannel>(uid, 'GET', `/channels/${p.channel_id}`);
      const ch: ChannelRef = { id: raw.id, name: raw.name, displayName: raw.display_name, teamId: raw.team_id, teamName: await teamNameOf(mm, uid, raw.team_id) };
      const users = await usernames(mm, uid, [p]);
      const replies = p.reply_count ?? 0;
      // Not using render(): its "no more pages" line means nothing for a single post.
      return [
        ...channelLines(ch),
        formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users }),
        `返信数: ${replies}`,
        ...(p.root_id ? [`スレッド内の返信です。親 post_id: ${p.root_id}。read_thread でスレッド全体を読めます。`]
          : replies ? [`返信があります。read_thread に post_id: ${p.id} を渡すと、スレッド全体を読めます。`] : []),
        // Not noting cut message attachments again: formatPost already says where it cut them.
        ...(truncate(p.message).truncated ? ['（本文を 4000 文字で切りました）'] : []),
      ].join('\n');
    });

  tool('get_file', `投稿に添付されたファイルを読む。画像なら縮小版（プレビュー）を画像として返す。テキスト（UTF-8、または拡張子が csv・tsv・txt・log の Shift_JIS か EUC-JP）なら中身を先頭の ${TEXT_MAX_CHARS} 文字まで返す。それ以外（PDF など）は名前・種類・大きさだけを返す。file_id は投稿の「添付:」の行にある`,
    { file_id: z.string().regex(/^[A-Za-z0-9]{26}$/) },
    async ({ file_id }, mm) => {
      const f = await worded(mm.call<MmFileInfo>(uid, 'GET', `/files/${file_id}/info`), FILE_WORDING);
      const about = `ファイル: ${fileLine(f)}`;
      // Not filtering on mime_type or has_preview_image: Mattermost decodes by content, and a GIF has a preview despite has_preview_image false.
      if (!f.width || !f.height) return fileText(mm, uid, file_id, f, about);
      const w = Math.min(f.width, PREVIEW_MAX_WIDTH);
      if (Math.max(w, Math.round((f.height * w) / f.width)) > IMAGE_MAX_SIDE) {
        return `${about}\n縦横が大きすぎるため画像は返しません（プレビューの長い辺が ${IMAGE_MAX_SIDE}px を超えます）。`;
      }
      const b = await worded(mm.callBytes(uid, `/files/${file_id}/preview`), FILE_WORDING).catch((e) => {
        if (e instanceof MmError && e.status === 400 && e.id === 'api.file.get_file_preview.no_preview.app_error') return undefined;
        throw e;
      });
      if (!b) return `${about}\nMattermost がプレビューを作らない形式のため、画像は返しません。`;
      const mimeType = imageType(b);
      if (!mimeType) return `${about}\nプレビューの形式を判定できないため、画像は返しません。`;
      if (b.length > IMAGE_MAX_BYTES) return `${about}\n画像が大きすぎるため返しません（プレビューが ${b.length} バイト）。`;
      return { content: [{ type: 'text', text: about }, { type: 'image', data: Buffer.from(b).toString('base64'), mimeType }] };
    });

  tool('search_channels', '名前でチャンネルを探す（公開チャンネル、参加している非公開チャンネル、DM、グループ DM）',
    { query: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
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
      const partners = dms.length
        ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', [...new Set(dms.map((x) => x.name.split('__').find((id) => id !== uid) ?? uid))]))
          .map((u) => [u.id, u.username]))
        : new Map<string, string>();
      for (const x of mine) {
        if (x.type === 'D') {
          const other = partners.get(x.name.split('__').find((id) => id !== uid) ?? uid);
          if (other?.toLowerCase().includes(q)) found.set(x.id, { ...x, label: `@${other}` });
        } else if (x.name.toLowerCase().includes(q) || x.display_name.toLowerCase().includes(q)) found.set(x.id, x);
      }
      const kind: Record<string, string> = { O: '公開', P: '非公開', D: 'DM', G: 'グループ DM' };
      const all = [...found.values()].sort((a, b) =>
        (teamName.get(a.team_id) ?? '').localeCompare(teamName.get(b.team_id) ?? '') || a.name.localeCompare(b.name));
      const { shown, next } = listed(all, c, limit ?? 20);
      const lines = [`チャンネルの検索: ${query}`, ...shown.map((x) => {
        const team = teamName.get(x.team_id);
        const where = team ? `${team}/${x.name}` : (x.label ?? x.display_name ?? x.name);
        return `- ${where}（表示名: ${x.display_name || x.label || x.name}、種類: ${kind[x.type] ?? x.type}、channel_id: ${x.id}${team ? `、team_id: ${x.team_id}` : ''}）`;
      })];
      if (!shown.length) lines.push('一致するチャンネルはありません。');
      return render({ lines, next, notes: capNote(capped, 'ほかの公開チャンネル') });
    });

  tool('list_my_channels', '参加しているチャンネル（公開、非公開、DM、グループ DM）を、最終投稿の新しい順に一覧する。アーカイブ済みは含まない',
    {
      types: channelKinds.optional().describe('種類で絞る（省略すると全部）。cursor を渡したときは無視する'),
      limit: limitArg(50, 200),
      cursor: cursorArg,
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
      const partners = dms.length
        ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', [...new Set(dms.map(other))])).map((u) => [u.id, u.username]))
        : new Map<string, string>();
      const kind: Record<string, string> = { O: '公開', P: '非公開', D: 'DM', G: 'グループ DM' };
      const line = (x: (typeof shown)[number]) => {
        const team = teamName.get(x.team_id);
        const label = x.type === 'D' ? `@${partners.get(other(x)) ?? other(x)}` : x.display_name || x.name;
        const where = team ? `${team}/${x.name}` : x.type === 'D' || x.type === 'G' ? label : x.name;
        return `- ${where}（表示名: ${label}、種類: ${kind[x.type] ?? x.type}、channel_id: ${x.id}${x.team_id ? `、team_id: ${x.team_id}` : ''}、最終投稿: ${x.last_post_at ? formatTime(x.last_post_at) : '投稿なし'}）`;
      };
      const lines = [
        '参加しているチャンネル（最終投稿の新しい順）',
        ...(p.updated.length ? ['前のページの後に更新されたチャンネル（前のページまでに出したものを含むことがあります）:', ...p.updated.map(line)] : []),
        ...(p.updated.length && p.body.length ? ['続き:'] : []),
        ...p.body.map(line),
      ];
      if (!shown.length && !c) lines.push('参加しているチャンネルはありません。');
      // Not ending with render()'s "no more pages": the listing is not finished, it has to start over.
      if (p.rest) return [...lines, `（更新されたチャンネルがほかに ${p.rest} 件あり、このページに収まりませんでした。cursor を付けずに最初のページから取り直してください）`].join('\n');
      return render({ lines, next: p.next && { ...p.next, per_page: per, types: kinds } });
    });

  tool('get_channel', 'チャンネルの情報（種類、目的、ヘッダー、メンバー数、ピン留めされた投稿）を読む。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。ピン留めは新しい順',
    { channel: z.string().min(1), pinned_limit: limitArg(10, 50), cursor: cursorArg },
    async ({ channel, pinned_limit, cursor }, mm) => {
      const c = cursorOf(z.object({ channel_id: z.string(), create_at: z.number().int(), id: z.string(), per_page: perPage(50) }), cursor);
      const per = c?.per_page ?? pinned_limit ?? 10;
      const ch = await resolveChannel(mm, uid, channel).catch(channelError);
      if (c && c.channel_id !== ch.id) throw new InputError(BAD_CURSOR);
      const kind: Record<string, string> = { O: '公開', P: '非公開', D: 'DM', G: 'グループ DM' };
      const lines = channelLines(ch);
      if (!c) {
        const stats = await mm.call<{ member_count: number }>(uid, 'GET', `/channels/${ch.id}/stats?exclude_files_count=true`).catch((e) => {
          if (e instanceof MmError && e.status === 403) return undefined;
          throw e;
        });
        lines.push(
          `種類: ${kind[ch.raw.type] ?? ch.raw.type}`,
          `目的: ${ch.raw.purpose || 'なし'}`,
          `ヘッダー: ${ch.raw.header || 'なし'}`,
          `メンバー数: ${stats ? stats.member_count : '取得できません（参加していないか、一時的な障害）'}`,
        );
      }
      // Sorting here rather than asking Mattermost for a page: /pinned has neither a limit nor paging.
      const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/pinned`);
      const all = r.order.map((id) => r.posts[id]).filter(Boolean)
        .sort((a, b) => b.create_at - a.create_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const rest = c ? all.filter((p) => p.create_at < c.create_at || (p.create_at === c.create_at && p.id > c.id)) : all;
      const shown = rest.slice(0, per);
      const users = await usernames(mm, uid, shown);
      lines.push(c ? 'ピン留め（続き）:' : `ピン留め: ${all.length} 件`, ...shown.map((p) => formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users })));
      if (!all.length) lines.push('ピン留めされた投稿はありません。');
      const last = shown.at(-1);
      return render({ lines, posts: shown, next: rest.length > per && last ? { channel_id: ch.id, create_at: last.create_at, id: last.id, per_page: per } : undefined });
    });

  tool('list_channel_members', 'チャンネルのメンバーをユーザー名の順に一覧する。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。無効化されたユーザーは含まない。参加していないチャンネルのメンバーは、公開チャンネルでも見られない（システム管理者など、チャンネルを読む権限を別に持つ場合を除く）。在席状況は get_user で読める',
    { channel: z.string().min(1), limit: limitArg(50, 200), cursor: cursorArg },
    async ({ channel, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ channel_id: z.string(), page: z.number().int().min(0), per_page: perPage(200) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 50;
      const page = c?.page ?? 0;
      const ch = await resolveChannel(mm, uid, channel).catch(channelError);
      if (c && c.channel_id !== ch.id) throw new InputError(BAD_CURSOR);
      // Not joining /channels/{id}/members with the users: /users?in_channel gives the profiles in one call.
      const q = new URLSearchParams({ in_channel: ch.id, active: 'true', page: String(page), per_page: String(per) });
      // Not rewording the 403 of /users alone: the user may leave the channel before /stats.
      const refused = (e: unknown): never => {
        if (e instanceof MmError && e.status === 403) throw new InputError('このチャンネルのメンバーを見る権限がありません。参加していないチャンネルのメンバーは、公開チャンネルでも見られません。参加しているはずなら、Mattermost の一時的な障害の可能性があります。少し待ってから再試行してください。');
        throw e;
      };
      const users = await mm.call<UserRef[]>(uid, 'GET', `/users?${q}`).catch(refused);
      const lines = channelLines(ch);
      if (!c) lines.push(`メンバー数: ${(await mm.call<{ member_count: number }>(uid, 'GET', `/channels/${ch.id}/stats?exclude_files_count=true`).catch(refused)).member_count}`);
      lines.push(...users.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        return `- @${u.username}（${[name && `名前: ${name}`, u.nickname && `ニックネーム: ${u.nickname}`, u.position && `役職: ${u.position}`, u.is_bot && 'Bot アカウント', `user_id: ${u.id}`].filter(Boolean).join('、')}）`;
      }));
      if (!users.length && !c) lines.push('メンバーはいません。');
      // Not asking for one more row to tell the last page: Mattermost pages by page * per_page, so a full last page is followed by an empty one.
      return render({ lines, next: users.length === per ? { channel_id: ch.id, page: page + 1, per_page: per } : undefined });
    });

  tool('get_unreads', '自分の未読を一覧する。未読のあるチャンネル（未読数とメンション数）と、スレッドの折りたたみ（CRT）が有効なら未読の返信があるスレッド。メンションのあるチャンネルが先。読むだけで、既読にはしない',
    { limit: limitArg(30, 100), cursor: cursorArg },
    async ({ limit, cursor }, mm) => {
      const startedAt = Date.now();
      const c = cursorOf(pageCursor(z.object({ s: z.number().int(), m: z.number().int(), t: z.number().int(), id: z.string() })).extend({ per_page: perPage(100), crt: z.boolean() }), cursor);
      const per = c?.per_page ?? limit ?? 30;
      const crt = await collapsedThreads(mm, uid);
      // Refusing rather than carrying on: the channel's update time switches between last_root_post_at and last_post_at, so the cursor's position no longer means the same row.
      if (c && c.crt !== crt.on) throw new InputError('スレッドの折りたたみ（CRT）の判定がページの合間に変わりました。cursor を付けずに最初のページから取り直してください。');
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
          notes.push(`（未読のスレッドを取得できませんでした（Mattermost のエラー ${e.status}: ${e.message}）。チャンネルの未読だけを出しています）`);
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
      const userIds = [...new Set(shown.flatMap((r) => (r.kind === 'thread' ? [...postUserIds(r.th.post), ...dmOf(r.th.post.channel_id)] : dmOf(r.ch.id))))];
      const users = userIds.length
        ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', userIds)).map((u) => [u.id, u.username]))
        : new Map<string, string>();
      const where = (x: MmChannel) => {
        const label = x.type === 'D' ? `@${users.get(other(x)) ?? other(x)}` : x.display_name || x.name;
        const team = teamName.get(x.team_id);
        return { label, path: team ? `${team}/${x.name}` : x.type === 'D' || x.type === 'G' ? label : x.name };
      };
      const posts: MmPost[] = [];
      const line = (r: (typeof rows)[number]): string => {
        if (r.kind === 'channel') {
          const w = where(r.ch);
          return `- ${w.path}（表示名: ${w.label}、channel_id: ${r.ch.id}${r.ch.team_id ? `、team_id: ${r.ch.team_id}` : ''}）未読: ${r.count}、メンション: ${r.mentions}、${crt.on ? '最終のルート投稿' : '最終投稿'}: ${formatTime(r.updatedAt)}`;
        }
        const ch = channels.get(r.th.post.channel_id);
        const team = ch && teamName.get(ch.team_id);
        const at = ch ? channelLines({ id: ch.id, name: ch.name, displayName: where(ch).label, teamId: ch.team_id, teamName: team ?? '' }).join(' | ') : `channel_id: ${r.th.post.channel_id}`;
        posts.push(r.th.post);
        return [
          formatPost(r.th.post, { baseUrl: base, teamName: team ?? r.th.teamName, usernames: users, channel: at }),
          `未読の返信: ${r.th.unread_replies}、未読のメンション: ${r.th.unread_mentions}、最終返信: ${formatTime(r.th.last_reply_at)}`,
        ].join('\n');
      };
      const lines = [
        `スレッドの折りたたみ（CRT）: ${crt.on ? '有効' : '無効'}（${crt.label}）`,
        `未読のあるチャンネル: ${unread.length} 件${crt.on ? `、未読のスレッド: ${threadsFailed ? '取得できませんでした' : `${threads.size} 件`}` : '（返信も数えています）'}`,
        ...(p.updated.length ? ['前のページの後に更新されたチャンネルとスレッド（前のページまでに出したものを含むことがあります）:', ...p.updated.map(line)] : []),
      ];
      const bodyChannels = p.body.filter((r) => r.kind === 'channel');
      const bodyThreads = p.body.filter((r) => r.kind === 'thread');
      if (bodyChannels.length) lines.push('未読のあるチャンネル（メンションのあるものが先、その中で更新の新しい順）:', ...bodyChannels.map(line));
      if (bodyThreads.length) lines.push('未読の返信があるスレッド（最終返信の新しい順）:', ...bodyThreads.map(line));
      if (!rows.length) lines.push('未読はありません。');
      if (p.rest) return [...lines, ...notes, `（更新されたチャンネルとスレッドがほかに ${p.rest} 件あり、このページに収まりませんでした。cursor を付けずに最初のページから取り直してください）`].join('\n');
      return render({ lines, posts, notes, next: p.next && { ...p.next, per_page: per, crt: crt.on } });
    });

  tool('get_mentions', '自分へのメンション（@ユーザー名、通知の設定にあるキーワード）を新しい順に一覧する。全チームと DM が対象。読むだけで、既読にはしない。unread_only なら未読のメンションだけを出す。メッセージ添付の中と @channel・@all・@here は数えず、DM とグループ DM では Mattermost がすべての投稿をメンションに数えるため、get_unreads のメンション数と合わないことがある',
    {
      unread_only: z.boolean().optional().describe('true なら未読のメンションだけ（チャンネルの既読の位置、CRT が有効なら返信はスレッドの既読の位置より後）。cursor を渡したときは無視する'),
      limit: limitArg(20, 50),
      cursor: cursorArg,
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
        if (!chans.size && !threads.size) return render({ lines: ['自分への未読のメンション（新しい順）', UNREAD_RULE, '未読のメンションはありません。'], notes });
        isUnread = (p) => {
          // Not leaving out the user's own webhook posts: Mattermost counts a webhook's mention of the user who made it.
          if (p.user_id === uid && p.props?.from_webhook !== 'true') return false;
          const at = crt && p.root_id ? threads.get(p.root_id)?.last_viewed_at : chans.get(p.channel_id);
          return at !== undefined && p.create_at > at;
        };
        // Not taking a read position of 0 as the floor: a channel never viewed or a thread first mentioned in a reply has 0, though nothing in it predates the channel or the root post.
        const floors = [...[...chans].map(([id, at]) => at || created.get(id)!), ...[...threads.values()].map((t) => Math.max(t.last_viewed_at, t.post.create_at))];
        unreadAfter = ` after:${prevDay(jstDay(Math.min(...floors)))}`;
      }
      let before = c?.before;
      let last = c?.last;
      const shown: MmPost[] = [];
      let next: object | undefined;
      for (let round = 1; ; round++) {
        // Not paging Mattermost's search: its database search returns nothing for page > 0, so older hits are reached by moving before: back a day at a time.
        const r = await mm.call<PostList>(uid, 'POST', '/posts/search', {
          terms: `${terms}${unreadAfter}${before ? ` before:${before}` : ''}`, is_or_search: true, include_deleted_channels: false, time_zone_offset: JST_OFFSET_SEC, page: 0, per_page: MM_SEARCH_CAP,
        });
        const all = r.order.map((id) => r.posts[id]).filter(Boolean).sort(newestFirst);
        const full = all.length >= MM_SEARCH_CAP;
        const d = full ? jstDay(all.at(-1)!.create_at) : '';
        const oneDay = full && jstDay(all[0].create_at) === d;
        // Not showing day D's hits when the 100 are full: D's older posts may lie beyond the 100, so D is searched again in full next time.
        const rest = (full && !oneDay ? all.filter((p) => jstDay(p.create_at) > d) : all)
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
        if (oneDay) notes.push(`（${d} のメンションは 1 日で ${MM_SEARCH_CAP} 件を超えるため、新しい ${MM_SEARCH_CAP} 件だけを照合しました。この日のより古いメンションは出していません）`);
        before = oneDay ? d : nextDay(d);
        if (take.length || round === 3) {
          if (!take.length) notes.push('（この範囲には照合に当たる投稿がありませんでした。next_cursor で、さらに前の日を探せます）');
          next = { before, last, unread: unread || undefined, per_page: per };
          break;
        }
      }
      const lines = [
        `自分への${unread ? '未読の' : ''}メンション（新しい順）。検索した語: ${terms}`,
        ...(unread ? [UNREAD_RULE] : []),
        ...(shown.length ? await withChannels(mm, shown) : next ? [] : [unread ? '未読のメンションはありません。' : 'メンションはありません。']),
      ];
      return render({ lines, posts: shown, notes, next });
    });

  tool('search_users', '名前やユーザー名でユーザーを探す',
    { query: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
    async ({ query, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ offset: z.number().int().min(0), per_page: perPage(50) }), cursor);
      const all = await mm.call<UserRef[]>(uid, 'POST', '/users/search', { term: query, limit: MM_SEARCH_CAP });
      const { shown, next } = listed(all, c, limit ?? 20);
      const lines = [`ユーザーの検索: ${query}`, ...shown.map((u) => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
        return `- @${u.username}（${[name && `名前: ${name}`, u.nickname && `ニックネーム: ${u.nickname}`, `user_id: ${u.id}`].filter(Boolean).join('、')}）`;
      })];
      if (!shown.length) lines.push('一致するユーザーはいません。');
      return render({ lines, next, notes: capNote(all.length, 'ほかのユーザー') });
    });

  tool('get_user', 'ユーザーのプロフィールを読む。user はユーザー ID か @ユーザー名',
    { user: z.string().min(1) },
    async ({ user }, mm) => {
      const u = await resolveUser(mm, uid, user);
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      return [
        `username: @${u.username}`,
        `user_id: ${u.id}`,
        ...(name ? [`名前: ${name}`] : []),
        ...(u.nickname ? [`ニックネーム: ${u.nickname}`] : []),
        ...(u.position ? [`役職: ${u.position}`] : []),
        ...(u.email ? [`メール: ${u.email}`] : []),
        ...(u.is_bot ? ['Bot アカウント'] : []),
        ...(u.delete_at ? ['無効化されたアカウント'] : []),
        ...timeZoneLines(u.timezone),
        `在席: ${await presence(mm, uid, u.id)}`,
      ].join('\n');
    });
}

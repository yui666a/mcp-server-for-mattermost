import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError, type MmClient } from '../mattermost/client.ts';
import { BAD_CURSOR, decodeCursor, encodeCursor, fileLine, formatPost, formatTime, InputError, localTime, truncate, type MmFileInfo, type MmPost } from './format.ts';
import { pageCursor, paginate } from './paging.ts';
import { mentionsMe, mentionTerms, type MentionUser } from './mentions.ts';
import { parsePostRef } from './permalink.ts';
import { ChannelFetchError, myTeams, resolveChannel, resolveUser, teamNameOf, type ChannelRef, type Mm, type MmChannel, type MmTeam, type UserRef } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { worded, type Wording } from './tools-send.ts';

type PostList = { order: string[]; posts: Record<string, MmPost>; has_next?: boolean | null };
type Page = { lines: string[]; next?: object; posts?: MmPost[]; notes?: string[] };

type ReadMm = Mm & Pick<MmClient, 'callBytes'>;

const MM_SEARCH_CAP = 100;
const JST_OFFSET_SEC = 9 * 3600;
const DAY_MS = 86_400_000;
const PREVIEW_MAX_WIDTH = 1920;
const IMAGE_MAX_SIDE = 3000;
// Decimal MB rather than MiB: base64 of 3.75e6 bytes is 5e6, inside a 5MB request limit whichever unit it means.
const IMAGE_MAX_BYTES = 3_750_000;
const FILE_WORDING: Wording = {
  id: [[404, 'app.file_info.get.app_error', 'ファイルが見つかりません（投稿が削除されたか、存在しません）']],
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

const jstDay = (ms: number) => new Date(ms + JST_OFFSET_SEC * 1000).toISOString().slice(0, 10);
const nextDay = (day: string) => new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);
const newestFirst = (a: MmPost, b: MmPost) => b.create_at - a.create_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const limitArg = (def: number, max: number) => z.number().int().min(1).max(max).optional()
  .describe(`件数（既定 ${def}、最大 ${max}）。cursor を渡したときは無視する`);
const cursorArg = z.string().optional().describe('前回の出力の next_cursor');
const perPage = (max: number) => z.number().int().min(1).max(max);
const channelKinds = z.array(z.enum(['public', 'private', 'dm', 'group_dm'])).min(1);

function cursorOf<S extends z.ZodType>(schema: S, cursor: string | undefined): z.infer<S> | undefined {
  if (cursor === undefined) return undefined;
  const r = schema.safeParse(decodeCursor(cursor));
  if (!r.success) throw new InputError(BAD_CURSOR);
  return r.data;
}

function render({ lines, next, posts = [], notes = [] }: Page): string {
  return [
    ...lines,
    ...notes,
    ...(posts.some((p) => truncate(p.message).truncated) ? ['（本文を 4000 文字で切った投稿があります）'] : []),
    next ? `next_cursor: ${encodeCursor(next)}` : '（続きはありません）',
  ].join('\n');
}

function channelLines(c: ChannelRef): string[] {
  return [
    `チャンネル: ${c.displayName || c.name}（name: ${c.name}、channel_id: ${c.id}）`,
    c.teamId ? `チーム: ${c.teamName}（team_id: ${c.teamId}）` : 'チーム: なし（DM またはグループ DM）',
  ];
}

async function usernames(mm: Mm, uid: string, posts: MmPost[]): Promise<Map<string, string>> {
  const ids = [...new Set(posts.map((p) => p.user_id))];
  if (!ids.length) return new Map();
  const users = await mm.call<UserRef[]>(uid, 'POST', '/users/ids', ids);
  return new Map(users.map((u) => [u.id, u.username]));
}

const capNote = (n: number, what: string) => (n >= MM_SEARCH_CAP
  ? [`（Mattermost の検索は ${MM_SEARCH_CAP} 件までしか返さないため、${what}は出ていない可能性があります。条件を絞ってください）`]
  : []);

const listed = <T>(all: T[], c: { offset: number; per_page: number } | undefined, limit: number) => {
  const per = c?.per_page ?? limit;
  const offset = c?.offset ?? 0;
  const end = offset + per;
  return { shown: all.slice(offset, end), next: all.length > end ? { offset: end, per_page: per } : undefined };
};

const PRESENCE: Record<string, string> = { online: 'オンライン', away: '離席', dnd: '取り込み中', offline: 'オフライン', ooo: '不在' };

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
type Member = { channel_id: string; msg_count: number; msg_count_root: number; mention_count: number; mention_count_root: number; notify_props?: { mark_unread?: string } };
type Thread = { id: string; last_reply_at: number; unread_replies: number; unread_mentions: number; post: MmPost };
type ThreadList = { total_unread_threads: number; threads: Thread[] | null };
type UnreadKey = { s: number; m: number; t: number; id: string };

const THREAD_PAGE = 50;
const THREAD_PAGES = 4;
const MEMBER_PAGE = 200;
const CRT_PREF = '/users/me/preferences/display_settings/name/collapsed_reply_threads';

const byUnreadKey = (a: UnreadKey, b: UnreadKey) => a.s - b.s || a.m - b.m || b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function collapsedThreads(mm: Mm, uid: string): Promise<{ on: boolean; label: string }> {
  const server = (await mm.call<{ CollapsedThreads?: string }>(uid, 'GET', '/config/client?format=old')).CollapsedThreads ?? '';
  if (server !== 'default_on' && server !== 'default_off') return { on: server === 'always_on', label: `サーバー設定: ${server}` };
  const pref = await mm.call<{ value: string }>(uid, 'GET', CRT_PREF).catch((e) => {
    // A 400 rather than 404 is how Mattermost answers for a user who never saved the preference.
    if (e instanceof MmError && e.status === 400 && e.id === 'app.preference.get.app_error') return undefined;
    throw e;
  });
  return { on: pref ? pref.value === 'on' : server === 'default_on', label: `サーバー設定: ${server}、利用者の設定: ${pref?.value ?? 'なし'}` };
}

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const base = ctx.cfg.mmBrowserUrl;

  function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>, mm: ReadMm) => Promise<string | CallToolResult>) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } },
      guarded(ctx, name, async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
        const mm: ReadMm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal), callBytes: (u, p) => ctx.mm.callBytes(u, p, extra.signal) };
        const r = await fn(args, mm);
        return typeof r === 'string' ? text(r) : r;
      // Cast rather than typed directly: the SDK's callback type is a conditional type TypeScript cannot resolve for a generic shape.
      }) as unknown as ToolCallback<S>);
  }

  async function withChannels(mm: Mm, shown: MmPost[]): Promise<string[]> {
    const channels = new Map((await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x]));
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

  tool('search_posts', '参加しているチームのメッセージを検索する。Mattermost の検索構文（from:、in:、before:、after:、on: など）をそのまま使える。日付は日本時間（JST）で解釈する。新しい順',
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
    async ({ terms, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50) }), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      // Not passing the cursor's page to Mattermost: its database search ignores per_page and returns nothing for page > 0.
      const r = await mm.call<PostList>(uid, 'POST', '/posts/search', { terms, is_or_search: false, include_deleted_channels: false, time_zone_offset: JST_OFFSET_SEC, page: 0, per_page: MM_SEARCH_CAP });
      const all = r.order.map((id) => r.posts[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [`検索: ${terms}`, ...(shown.length ? await withChannels(mm, shown) : ['一致する投稿はありません。'])];
      const more = all.length > (page + 1) * per;
      return render({ lines, posts: shown, next: more ? { page: page + 1, per_page: per } : undefined, notes: capNote(all.length, 'これより古い一致') });
    });

  tool('read_channel', 'チャンネルの投稿を新しい順に読む。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか',
    { channel: z.string().min(1), limit: limitArg(30, 100), cursor: cursorArg },
    async ({ channel, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ before: z.string().regex(/^[A-Za-z0-9]{26}$/), per_page: perPage(100) }), cursor);
      const per = c?.per_page ?? limit ?? 30;
      const ch = await resolveChannel(mm, uid, channel);
      // Paging with before=<post_id> rather than page numbers: new posts arriving between calls would shift pages.
      const q = new URLSearchParams({ per_page: String(per + 1), ...(c ? { before: c.before } : {}) });
      const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?${q}`);
      const all = r.order.map((id) => r.posts[id]).filter(Boolean);
      const shown = all.slice(0, per);
      const users = await usernames(mm, uid, shown);
      const lines = [...channelLines(ch), ...shown.map((p) => formatPost(p, { baseUrl: base, teamName: ch.teamName, usernames: users }))];
      if (!shown.length) lines.push('投稿はありません。');
      return render({ lines, posts: shown, next: all.length > per ? { before: shown[shown.length - 1].id, per_page: per } : undefined });
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

  tool('get_post', '1 件の投稿を読む。post は post_id か、パーマリンクの URL（…/<チーム名>/pl/<post_id>）',
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
        ...(truncate(p.message).truncated ? ['（本文を 4000 文字で切りました）'] : []),
      ].join('\n');
    });

  tool('get_file', '投稿に添付されたファイルを読む。画像なら縮小版（プレビュー）を画像として返し、画像でなければ名前・種類・大きさだけを返す。file_id は投稿の「添付:」の行にある',
    { file_id: z.string().regex(/^[A-Za-z0-9]{26}$/) },
    async ({ file_id }, mm) => {
      const f = await worded(mm.call<MmFileInfo>(uid, 'GET', `/files/${file_id}/info`), FILE_WORDING);
      const about = `ファイル: ${fileLine(f)}`;
      // Not filtering on mime_type or has_preview_image: Mattermost decodes by content, and a GIF has a preview despite has_preview_image false.
      if (!f.width || !f.height) return about;
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

  tool('get_channel', 'チャンネルの情報（種類、目的、ヘッダー、メンバー数、ピン留めされた投稿）を読む。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか。ピン留めは新しい順',
    { channel: z.string().min(1), pinned_limit: limitArg(10, 50), cursor: cursorArg },
    async ({ channel, pinned_limit, cursor }, mm) => {
      const c = cursorOf(z.object({ channel_id: z.string(), create_at: z.number().int(), id: z.string(), per_page: perPage(50) }), cursor);
      const per = c?.per_page ?? pinned_limit ?? 10;
      const ch = await resolveChannel(mm, uid, channel).catch((e) => {
        // Not converting a missing team: /teams/name/{team}/channels/name/{channel} answers it with 404 too.
        if (e instanceof ChannelFetchError && e.id !== 'app.team.get_by_name.missing.app_error') {
          if (e.status === 403) throw new InputError('このチャンネルを見る権限がありません（参加していない非公開チャンネルなど）');
          if (e.status === 404) throw new InputError('チャンネルが見つかりません（参加していない非公開チャンネルを名前で指定した場合も、Mattermost はこの結果を返します）');
        }
        throw e;
      });
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
          `メンバー数: ${stats ? stats.member_count : '参加していないため取得できません'}`,
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
      const members: Member[] = [];
      for (let page = 0; ; page++) {
        const got = await mm.call<Member[]>(uid, 'GET', `/users/me/channel_members?page=${page}&per_page=${MEMBER_PAGE}`);
        members.push(...got);
        if (got.length < MEMBER_PAGE) break;
      }
      const teams = await myTeams(mm, uid);
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      const threads = new Map<string, Thread & { teamName: string }>();
      const notes: string[] = [];
      let threadsFailed = false;
      if (crt.on) {
        try {
          for (const [i, t] of teams.entries()) {
            let before: string | undefined;
            for (let n = 1; ; n++) {
              // Not taking DM and group DM threads from every team: each team's list repeats them.
              const q = new URLSearchParams({ unread: 'true', per_page: String(THREAD_PAGE), ...(i ? { excludeDirect: 'true' } : {}), ...(before ? { before } : {}) });
              const r = await mm.call<ThreadList>(uid, 'GET', `/users/${uid}/teams/${t.id}/threads?${q}`);
              const got = r.threads ?? [];
              // Not keeping threads the threads API returns for archived channels: the channel list leaves those channels out, and nothing can mark such a thread read.
              for (const x of got) if (channels.has(x.post.channel_id) && !threads.has(x.id)) threads.set(x.id, { ...x, teamName: t.name });
              if (got.length < THREAD_PAGE) break;
              if (n === THREAD_PAGES) {
                notes.push(`（${t.name} の未読スレッドは ${THREAD_PAGE * THREAD_PAGES} 件までしか取得していません（total_unread_threads: ${r.total_unread_threads}））`);
                break;
              }
              before = got.at(-1)!.id;
            }
          }
        } catch (e) {
          if (!(e instanceof MmError)) throw e;
          threads.clear();
          threadsFailed = true;
          notes.length = 0;
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
      const userIds = [...new Set(shown.flatMap((r) => (r.kind === 'thread' ? [r.th.post.user_id, ...dmOf(r.th.post.channel_id)] : dmOf(r.ch.id))))];
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

  tool('get_mentions', '自分へのメンション（@ユーザー名、通知の設定にあるキーワード）を新しい順に一覧する。全チームと DM が対象。読むだけで、既読にはしない',
    { limit: limitArg(20, 50), cursor: cursorArg },
    async ({ limit, cursor }, mm) => {
      const c = cursorOf(z.object({
        before: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(),
        last: z.object({ create_at: z.number().int(), id: z.string() }).optional(),
        per_page: perPage(50),
      }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const me = await mm.call<MentionUser>(uid, 'GET', '/users/me');
      const terms = mentionTerms(me).map((t) => `"${t}"`).join(' ');
      let before = c?.before;
      let last = c?.last;
      const shown: MmPost[] = [];
      const notes: string[] = [];
      let next: object | undefined;
      for (let round = 1; ; round++) {
        // Not paging Mattermost's search: its database search returns nothing for page > 0, so older hits are reached by moving before: back a day at a time.
        const r = await mm.call<PostList>(uid, 'POST', '/posts/search', {
          terms: before ? `${terms} before:${before}` : terms, is_or_search: true, include_deleted_channels: false, time_zone_offset: JST_OFFSET_SEC, page: 0, per_page: MM_SEARCH_CAP,
        });
        const all = r.order.map((id) => r.posts[id]).filter(Boolean).sort(newestFirst);
        const full = all.length >= MM_SEARCH_CAP;
        const d = full ? jstDay(all.at(-1)!.create_at) : '';
        const oneDay = full && jstDay(all[0].create_at) === d;
        // Not showing day D's hits when the 100 are full: D's older posts may lie beyond the 100, so D is searched again in full next time.
        const rest = (full && !oneDay ? all.filter((p) => jstDay(p.create_at) > d) : all)
          .filter((p) => !last || p.create_at < last.create_at || (p.create_at === last.create_at && p.id > last.id))
          .filter((p) => mentionsMe(p.message, me));
        const take = rest.slice(0, per);
        shown.push(...take);
        if (take.length) last = { create_at: take.at(-1)!.create_at, id: take.at(-1)!.id };
        if (rest.length > per) {
          next = { before, last, per_page: per };
          break;
        }
        if (!full) break;
        if (oneDay) notes.push(`（${d} のメンションは 1 日で ${MM_SEARCH_CAP} 件を超えるため、新しい ${MM_SEARCH_CAP} 件だけを照合しました。この日のより古いメンションは出していません）`);
        before = oneDay ? d : nextDay(d);
        if (take.length || round === 3) {
          if (!take.length) notes.push('（この範囲には照合に当たる投稿がありませんでした。next_cursor で、さらに前の日を探せます）');
          next = { before, last, per_page: per };
          break;
        }
      }
      const lines = [`自分へのメンション（新しい順）。検索した語: ${terms}`, ...(shown.length ? await withChannels(mm, shown) : next ? [] : ['メンションはありません。'])];
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

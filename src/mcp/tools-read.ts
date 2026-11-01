import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BAD_CURSOR, decodeCursor, encodeCursor, formatPost, InputError, truncate, type MmPost } from './format.ts';
import { myTeams, resolveChannel, resolveUser, teamNameOf, type ChannelRef, type Mm, type MmChannel, type MmTeam, type UserRef } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';

type PostList = { order: string[]; posts: Record<string, MmPost>; has_next?: boolean | null };
type Page = { lines: string[]; next?: object; posts?: MmPost[]; notes?: string[] };

const MM_SEARCH_CAP = 100;

const limitArg = (def: number, max: number) => z.number().int().min(1).max(max).optional()
  .describe(`件数（既定 ${def}、最大 ${max}）。cursor を渡したときは無視する`);
const cursorArg = z.string().optional().describe('前回の出力の next_cursor');
const perPage = (max: number) => z.number().int().min(1).max(max);

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
  ? [`（Mattermost の検索は ${MM_SEARCH_CAP} 件までしか返さないため、これより後の${what}は出ていない可能性があります。条件を絞ってください）`]
  : []);

const listed = <T>(all: T[], c: { offset: number; per_page: number } | undefined, limit: number) => {
  const per = c?.per_page ?? limit;
  const offset = c?.offset ?? 0;
  const end = offset + per;
  return { shown: all.slice(offset, end), next: all.length > end ? { offset: end, per_page: per } : undefined };
};

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const base = ctx.cfg.mmBrowserUrl;

  function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>, mm: Mm) => Promise<string>) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } },
      guarded(ctx, name, async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
        const mm: Mm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) };
        return text(await fn(args, mm));
      // Cast rather than typed directly: the SDK's callback type is a conditional type TypeScript cannot resolve for a generic shape.
      }) as unknown as ToolCallback<S>);
  }

  tool('search_posts', '参加しているチームのメッセージを検索する。Mattermost の検索構文（from:、in:、before:、after: など）をそのまま使える。新しい順',
    { terms: z.string().min(1), limit: limitArg(20, 50), cursor: cursorArg },
    async ({ terms, limit, cursor }, mm) => {
      const c = cursorOf(z.object({ page: z.number().int().min(0), per_page: perPage(50) }), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const page = c?.page ?? 0;
      // Not passing the cursor's page to Mattermost: its database search ignores per_page and returns nothing for page > 0.
      const r = await mm.call<PostList>(uid, 'POST', '/posts/search', { terms, is_or_search: false, include_deleted_channels: false, page: 0, per_page: MM_SEARCH_CAP });
      const all = r.order.map((id) => r.posts[id]).filter(Boolean);
      const shown = all.slice(page * per, (page + 1) * per);
      const lines = [`検索: ${terms}`];
      if (shown.length) {
        const channels = new Map((await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x]));
        const teams = await myTeams(mm, uid);
        const teamName = new Map(teams.map((t) => [t.id, t.name]));
        const users = await usernames(mm, uid, shown);
        for (const p of shown) {
          const ch = channels.get(p.channel_id);
          const team = ch?.team_id ? teamName.get(ch.team_id) : undefined;
          const where = ch
            ? `チャンネル: ${ch.display_name || ch.name}（channel_id: ${ch.id}）| ${team ? `チーム: ${team}（team_id: ${ch.team_id}）` : 'チーム: なし（DM またはグループ DM）'}`
            : `channel_id: ${p.channel_id}`;
          lines.push(formatPost(p, { baseUrl: base, teamName: team ?? teams[0]?.name ?? '', usernames: users, channel: where }));
        }
      } else lines.push('一致する投稿はありません。');
      const more = all.length > (page + 1) * per;
      return render({ lines, posts: shown, next: more ? { page: page + 1, per_page: per } : undefined, notes: capNote(all.length, '一致') });
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
      return render({ lines, next, notes: capNote(capped, '公開チャンネル') });
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
      return render({ lines, next, notes: capNote(all.length, 'ユーザー') });
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
      ].join('\n');
    });
}

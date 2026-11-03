import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError } from '../mattermost/client.ts';
import { formatPost, formatTime, InputError, postUserIds, type MmPost } from './format.ts';
import { pageCursor, paginate } from './paging.ts';
import { myTeams, type Mm, type MmChannel, type UserRef } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { channelLines, collapsedThreads, cursorArg, cursorOf, limitArg, perPage, render } from './tools-read.ts';

type FollowedThread = { id: string; reply_count: number; last_reply_at: number; unread_replies: number; unread_mentions: number; post: MmPost };
type ThreadList = { total: number; threads: FollowedThread[] | null };
type Key = { t: number; id: string };

// Not following before= across pages: its strict < on last_reply_at skips threads that share the boundary's time. One page of Mattermost's maximum per team instead.
const THREAD_PAGE = 200;

const CRT_OFF = 'スレッドの折りたたみ（CRT）が無効なため、スレッドのフォローは画面にも通知にも効きません。返信の通知はスレッドごとには止められず、Mattermost の通知の設定（すべてのスレッドに効く）で変えます。';

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/).describe('スレッドの親投稿か、スレッド内の投稿の post_id');
const missing = (e: unknown) => e instanceof MmError && (e.status === 403 || e.status === 404);
// Idempotent for follow too: it skips the PUT when the thread is already followed.
const followAnnotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

const newestReplyFirst = (a: Key, b: Key) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function registerThreadTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const base = ctx.cfg.mmBrowserUrl;

  function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, annotations: ToolAnnotations, fn: (args: z.infer<z.ZodObject<S>>, mm: Mm) => Promise<string | CallToolResult>) {
    server.registerTool(name, { description, inputSchema, annotations },
      guarded(ctx, name, async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
        const r = await fn(args, { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) });
        return typeof r === 'string' ? text(r) : r;
      // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for a generic shape.
      }) as unknown as ToolCallback<S>);
  }

  tool('list_followed_threads', 'フォロー中のスレッドを、最終返信の新しい順に一覧する。全チームと DM、グループ DM が対象。アーカイブ済みのチャンネルのスレッドも含む（そのチャンネルは channel_id だけを出す）。返信がまだないルート投稿は、フォローしていても最初の返信まで出ない。スレッドの折りたたみ（CRT）が無効な利用者には使えない。読むだけで、既読にはしない',
    { limit: limitArg(20, 50), cursor: cursorArg }, { readOnlyHint: true },
    async ({ limit, cursor }, mm) => {
      const startedAt = Date.now();
      const c = cursorOf(pageCursor(z.object({ t: z.number().int(), id: z.string() }).strict()).extend({ per_page: perPage(50) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const crt = await collapsedThreads(mm, uid);
      if (!crt.on) return text(CRT_OFF, true);
      const teams = await myTeams(mm, uid);
      if (!teams.length) throw new InputError('所属しているチームがないため、フォロー中のスレッドを一覧できません（DM のスレッドもチームを指定して引く API のため）。');
      const channels = new Map((await mm.call<MmChannel[]>(uid, 'GET', '/users/me/channels')).map((x) => [x.id, x]));
      const teamName = new Map(teams.map((t) => [t.id, t.name]));
      const threads: (FollowedThread & { teamName: string })[] = [];
      const notes: string[] = [];
      let total = 0;
      for (const [i, t] of teams.entries()) {
        // Not taking DM and group DM threads from every team: each team's list repeats them.
        const q = new URLSearchParams({ per_page: String(THREAD_PAGE), ...(i ? { excludeDirect: 'true' } : {}) });
        const r = await mm.call<ThreadList>(uid, 'GET', `/users/${uid}/teams/${t.id}/threads?${q}`);
        const got = r.threads ?? [];
        threads.push(...got.map((x) => ({ ...x, teamName: t.name })));
        total += r.total;
        if (r.total > got.length && got.length) {
          notes.push(`（${t.name}${i ? '' : ' と DM、グループ DM'} のフォロー中のスレッドは、最終返信の新しい ${got.length} 件だけを取得しています（total: ${r.total}）。最終返信が ${formatTime(got.at(-1)!.last_reply_at)} 以前のスレッドは出ていないことがあります）`);
        }
      }
      const rows = threads.map((th) => ({ th, updatedAt: th.last_reply_at, key: { t: th.last_reply_at, id: th.id } }));
      const p = paginate(rows, newestReplyFirst, c, per, startedAt);
      const shown = [...p.updated, ...p.body];
      const other = (x: MmChannel) => x.name.split('__').find((id) => id !== uid) ?? uid;
      const dmOf = (id: string) => {
        const ch = channels.get(id);
        return ch?.type === 'D' ? [other(ch)] : [];
      };
      const userIds = [...new Set(shown.flatMap((r) => [...postUserIds(r.th.post), ...dmOf(r.th.post.channel_id)]))];
      const users = userIds.length
        ? new Map((await mm.call<UserRef[]>(uid, 'POST', '/users/ids', userIds)).map((u) => [u.id, u.username]))
        : new Map<string, string>();
      const posts: MmPost[] = [];
      const line = ({ th }: (typeof rows)[number]): string => {
        const ch = channels.get(th.post.channel_id);
        const team = ch && teamName.get(ch.team_id);
        const label = ch && (ch.type === 'D' ? `@${users.get(other(ch)) ?? other(ch)}` : ch.display_name || ch.name);
        const at = ch ? channelLines({ id: ch.id, name: ch.name, displayName: label ?? '', teamId: ch.team_id, teamName: team ?? '' }).join(' | ') : `channel_id: ${th.post.channel_id}`;
        posts.push(th.post);
        return [
          formatPost(th.post, { baseUrl: base, teamName: team ?? th.teamName, usernames: users, channel: at }),
          `返信: ${th.reply_count}、未読の返信: ${th.unread_replies}、未読のメンション: ${th.unread_mentions}、最終返信: ${formatTime(th.last_reply_at)}`,
        ].join('\n');
      };
      const lines = [
        `スレッドの折りたたみ（CRT）: 有効（${crt.label}）`,
        `フォロー中のスレッド: ${total} 件`,
        ...(p.updated.length ? ['前のページの後に返信があったスレッド（前のページまでに出したものを含むことがあります）:', ...p.updated.map(line)] : []),
        ...(p.body.length ? ['フォロー中のスレッド（最終返信の新しい順）:', ...p.body.map(line)] : []),
        ...(rows.length ? [] : ['フォロー中のスレッドはありません。']),
      ];
      if (p.rest) return [...lines, ...notes, `（前のページの後に返信があったスレッドがほかに ${p.rest} 件あり、このページに収まりませんでした。cursor を付けずに最初のページから取り直してください）`].join('\n');
      return render({ lines, posts, notes, next: p.next && { ...p.next, per_page: per } });
    });

  async function rootOf(mm: Mm, postId: string): Promise<{ root: string; channelId: string; replies: number } | CallToolResult> {
    if (!(await collapsedThreads(mm, uid)).on) return text(CRT_OFF, true);
    const p = await mm.call<MmPost & { reply_count?: number }>(uid, 'GET', `/posts/${postId}`).catch((e) => {
      if (missing(e)) throw new InputError('投稿が見つかりません（削除されたか、見る権限がありません）。');
      throw e;
    });
    return { root: p.root_id || p.id, channelId: p.channel_id, replies: p.reply_count ?? 0 };
  }

  // Not looking for the team the user has open: the follow API checks no team, which only names where Mattermost sends the change event.
  async function teamOf(mm: Mm, channelId: string): Promise<string> {
    const ch = await mm.call<{ team_id: string }>(uid, 'GET', `/channels/${channelId}`);
    const team = ch.team_id || (await myTeams(mm, uid))[0]?.id;
    if (!team) throw new InputError('所属しているチームがないため、スレッドのフォローを変えられません。');
    return team;
  }

  tool('follow_thread', 'スレッドをフォローする。フォロー中のスレッドの返信は、スレッドの通知の設定に従って通知され、list_followed_threads に出る。post_id はスレッド内のどの投稿でもよい。フォローすると、その時点までの返信が既読になる（Mattermost の動作）。すでにフォロー中なら何もしない。返信がまだないルート投稿は、最初の返信まで list_followed_threads に出ない。参加していないチャンネルのスレッドはフォローできない',
    { post_id: POST_ID }, followAnnotations,
    async ({ post_id }, mm) => {
      const r = await rootOf(mm, post_id);
      if ('content' in r) return r;
      await mm.call(uid, 'GET', `/channels/${r.channelId}/members/me`).catch((e) => {
        if (missing(e)) throw new InputError('このチャンネルに参加していません。参加していないチャンネルのスレッドは、フォローしても一覧にも通知にも出ません。');
        throw e;
      });
      const team = await teamOf(mm, r.channelId);
      const label = `スレッド（親 post_id: ${r.root}）`;
      const following = await mm.call(uid, 'GET', `/users/${uid}/teams/${team}/threads/${r.root}`).then(() => true, (e) => {
        if (e instanceof MmError && e.status === 404) return false;
        throw e;
      });
      // Not calling PUT for a followed thread: Mattermost marks the thread read on every follow, which would drop unread replies the user has not seen.
      if (following) return `${label}はすでにフォローしています。`;
      await mm.call(uid, 'PUT', `/users/${uid}/teams/${team}/threads/${r.root}/following`);
      return [
        `${label}をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。`,
        ...(r.replies ? [] : ['返信がまだないため、最初の返信があるまで list_followed_threads には出ません。']),
      ].join('\n');
    });

  tool('unfollow_thread', 'スレッドのフォローを外し、返信の通知を止める。post_id はスレッド内のどの投稿でもよい。メンションの通知は届き、メンションされるか自分が返信すると、Mattermost は再びフォローする。フォローしていなくても成功する',
    { post_id: POST_ID }, followAnnotations,
    async ({ post_id }, mm) => {
      const r = await rootOf(mm, post_id);
      if ('content' in r) return r;
      const team = await teamOf(mm, r.channelId);
      await mm.call(uid, 'DELETE', `/users/${uid}/teams/${team}/threads/${r.root}/following`);
      return `スレッド（親 post_id: ${r.root}）のフォローを外しました。このスレッドの返信の通知は届かなくなります。ただし、メンションの通知は届き、メンションされるか自分が返信すると、Mattermost は再びフォローします。`;
    });
}

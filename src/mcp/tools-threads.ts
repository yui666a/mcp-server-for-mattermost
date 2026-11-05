import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError } from '../mattermost/client.ts';
import { formatPost, formatTime, InputError, postUserIds, type MmPost } from './format.ts';
import { pageCursor, paginate } from './paging.ts';
import { myTeams, type Mm, type MmChannel } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { POST_WORDING } from './tools-save-pin.ts';
import { worded } from './tools-send.ts';
import { channelLines, collapsedThreads, cursorArg, cursorOf, limitArg, perPage, render, usernamesOf } from './tools-read.ts';

type FollowedThread = { id: string; reply_count: number; last_reply_at: number; unread_replies: number; unread_mentions: number; post: MmPost };
type ThreadList = { total: number; threads: FollowedThread[] | null };
type Key = { t: number; id: string };

// Not following before= across pages: every call refetches and re-sorts all teams' lists, so paging would repeat the per-team fetches on each call for a team past 200. One page of Mattermost's maximum per team instead, with a note where it stops.
const THREAD_PAGE = 200;

const CRT_OFF = 'スレッドの折りたたみ（CRT）が無効なため、スレッドのフォローは画面にも通知にも効きません。返信の通知はスレッドごとには止められず、Mattermost の通知の設定（すべてのスレッドに効く）で変えます。';

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/).describe('スレッドの親投稿か、スレッド内の投稿の post_id');
export const missing = (e: unknown) => e instanceof MmError && (e.status === 403 || e.status === 404);
const followAnnotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

// Not looking for the team the user has open: no API tells which one is open, and neither the follow API nor the read API checks the team, which only names where Mattermost sends the change event.
export async function threadTeam(mm: Mm, uid: string, channelId: string, firstTeam = async () => (await myTeams(mm, uid))[0]?.id): Promise<{ team: string | undefined; direct: boolean }> {
  const ch = await mm.call<{ team_id: string; type: string }>(uid, 'GET', `/channels/${channelId}`);
  return { team: ch.team_id || await firstTeam(), direct: ch.type === 'D' || ch.type === 'G' };
}

const newestReplyFirst = (a: Key, b: Key) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function registerThreadTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const base = ctx.cfg.mmBrowserUrl;

  function tool<S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, annotations: ToolAnnotations, fn: (args: z.infer<z.ZodObject<S>>, mm: Mm) => Promise<string>) {
    server.registerTool(name, { description, inputSchema, annotations },
      guarded(ctx, name, async (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => {
        return text(await fn(args, { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) }));
      // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for a generic shape.
      }) as unknown as ToolCallback<S>);
  }

  tool('list_followed_threads', 'フォロー中のスレッドを、最終返信の新しい順に一覧する。全チームと DM、グループ DM が対象。アーカイブ済みのチャンネルのスレッドも含む（チャンネル名に「アーカイブ済み」と付ける）。返信がまだないルート投稿は、フォローしていても最初の返信まで出ない。スレッドの折りたたみ（CRT）が無効な利用者には使えない。読むだけで、既読にはしない',
    { limit: limitArg(20, 50), cursor: cursorArg }, { readOnlyHint: true },
    async ({ limit, cursor }, mm) => {
      const startedAt = Date.now();
      const c = cursorOf(pageCursor(z.object({ t: z.number().int(), id: z.string() }).strict()).extend({ per_page: perPage(50) }).strict(), cursor);
      const per = c?.per_page ?? limit ?? 20;
      const crt = await collapsedThreads(mm, uid);
      if (!crt.on) throw new InputError(CRT_OFF);
      const teams = await myTeams(mm, uid);
      if (!teams.length) throw new InputError('所属しているチームがないため、フォロー中のスレッドを一覧できません（DM のスレッドもチームを指定して引く API のため）。');
      const channels = new Map((await mm.call<(MmChannel & { delete_at: number })[]>(uid, 'GET', '/users/me/channels?include_deleted=true')).map((x) => [x.id, x]));
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
      const userIds = shown.flatMap((r) => [...postUserIds(r.th.post), ...dmOf(r.th.post.channel_id)]);
      const users = await usernamesOf(mm, uid, userIds);
      const posts: MmPost[] = [];
      const line = ({ th }: (typeof rows)[number]): string => {
        const ch = channels.get(th.post.channel_id);
        const team = ch && teamName.get(ch.team_id);
        const label = ch && (ch.type === 'D' ? `@${users.get(other(ch)) ?? other(ch)}` : ch.display_name || ch.name) + (ch.delete_at ? '（アーカイブ済み）' : '');
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

  async function rootOf(mm: Mm, postId: string): Promise<{ root: string; channelId: string; replies: number }> {
    if (!(await collapsedThreads(mm, uid)).on) throw new InputError(CRT_OFF);
    const p = await worded(mm.call<MmPost & { reply_count?: number }>(uid, 'GET', `/posts/${postId}`), POST_WORDING);
    return { root: p.root_id || p.id, channelId: p.channel_id, replies: p.reply_count ?? 0 };
  }

  async function channelOf(mm: Mm, channelId: string): Promise<{ team: string; direct: boolean }> {
    const { team, direct } = await threadTeam(mm, uid, channelId);
    if (!team) throw new InputError('所属しているチームがないため、スレッドのフォローを変えられません。');
    return { team, direct };
  }

  tool('follow_thread', 'スレッドをフォローする。フォロー中のスレッドの返信は、スレッドの通知の設定に従って通知され、list_followed_threads に出る。post_id はスレッド内のどの投稿でもよい。フォローすると、その時点までの返信が既読になる（Mattermost の動作）。すでにフォロー中なら何もしない。返信がまだないルート投稿は、最初の返信まで list_followed_threads に出ない。参加していないチャンネルのスレッドはフォローできない',
    { post_id: POST_ID }, followAnnotations,
    async ({ post_id }, mm) => {
      const r = await rootOf(mm, post_id);
      await mm.call(uid, 'GET', `/channels/${r.channelId}/members/me`).catch((e) => {
        // Not saying a 403 means not joined: Mattermost also answers 403 when its permission check fails on a transient error.
        if (e instanceof MmError && e.status === 403) throw new InputError('このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。参加していないチャンネルのスレッドは、フォローしても一覧にも通知にも出ません。参加しているはずなら、少し待ってから再試行してください。');
        if (e instanceof MmError && e.status === 404) throw new InputError('このチャンネルに参加していません。参加していないチャンネルのスレッドは、フォローしても一覧にも通知にも出ません。');
        throw e;
      });
      const { team } = await channelOf(mm, r.channelId);
      const label = `スレッド（親 post_id: ${r.root}）`;
      const noReplies = '返信がまだないため、最初の返信があるまで list_followed_threads には出ません。';
      let following = await mm.call(uid, 'GET', `/users/${uid}/teams/${team}/threads/${r.root}`).then(() => true, (e) => {
        if (e instanceof MmError && e.status === 404) return false;
        throw e;
      });
      // Not taking the thread state's 404 as unfollowed for a root post without replies: Mattermost has no thread state until the first reply, followed or not.
      // Not keying the note on reply_count alone: a followed thread whose replies were all deleted keeps its thread state and shows in the list.
      const stateless = !following && !r.replies;
      if (stateless) {
        const t = await mm.call<{ posts: Record<string, { is_following?: boolean }> }>(uid, 'GET', `/posts/${r.root}/thread?collapsedThreads=true`);
        following = t.posts[r.root]?.is_following === true;
      }
      // Not calling PUT for a followed thread: Mattermost marks the thread read on every follow, which would drop unread replies the user has not seen.
      if (following) return [`${label}はすでにフォローしています。`, ...(stateless ? [noReplies] : [])].join('\n');
      await mm.call(uid, 'PUT', `/users/${uid}/teams/${team}/threads/${r.root}/following`);
      // Not trusting reply_count alone after following: a thread whose replies were all deleted keeps its thread state, so it is listed once followed.
      // Not failing the call when this check fails: the follow is done, and the check only decides the note.
      const waits = stateless && await mm.call(uid, 'GET', `/users/${uid}/teams/${team}/threads/${r.root}`).then(() => false, (e) => e instanceof MmError && e.status === 404);
      return [
        `${label}をフォローしました。フォローした時点までの返信は既読になります（Mattermost の動作）。`,
        ...(waits ? [noReplies] : []),
      ].join('\n');
    });

  tool('unfollow_thread', 'スレッドのフォローを外し、返信の通知を止める。post_id はスレッド内のどの投稿でもよい。メンションの通知は届き、メンションされるか自分が返信すると、Mattermost は再びフォローする。DM とグループ DM のスレッドは、相手が返信するたびに Mattermost が再びフォローするので、通知を止められない（出力でそう伝える）。フォローしていなくても成功する',
    { post_id: POST_ID }, followAnnotations,
    async ({ post_id }, mm) => {
      const r = await rootOf(mm, post_id);
      const { team, direct } = await channelOf(mm, r.channelId);
      await mm.call(uid, 'DELETE', `/users/${uid}/teams/${team}/threads/${r.root}/following`);
      const label = `スレッド（親 post_id: ${r.root}）のフォローを外しました。`;
      // Not refusing a DM or group DM thread: the unfollow still takes it off list_followed_threads until the next reply.
      return direct
        ? `${label}ただし、DM とグループ DM のスレッドでは、Mattermost は相手の返信をすべて自分へのメンションとして扱い、相手が返信するたびに再びフォローして通知します。このスレッドの通知は、外しても止まりません。`
        : `${label}このスレッドの返信の通知は届かなくなります。ただし、メンションの通知は届き、メンションされるか自分が返信すると、Mattermost は再びフォローします。`;
    });
}

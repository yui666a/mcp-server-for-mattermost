import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError } from '../mattermost/client.ts';
import { InputError, type MmPost } from './format.ts';
import { myTeams, resolveChannel, type Mm } from './resolve.ts';
import { failureText, guarded, text, type ToolContext } from './server.ts';
import { collapsedThreads } from './tools-read.ts';

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/);
const MAX_ITEMS = 20;
const AFTER_PAGE = 200;

// Not dropping unknown keys of an item as the SDK does: a misspelled last_post_id would be dropped and the item marked read up to the newest post, which only the user can undo, item by item, in the Mattermost UI.
const item = <T extends z.ZodRawShape>(shape: T, keys: string) =>
  z.strictObject(shape, { error: (iss) => iss.code === 'unrecognized_keys' ? `受けない引数です: ${iss.keys.join(', ')}。${keys}` : undefined });

const schema = {
  channels: z.array(item({
    channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか'),
    last_post_id: POST_ID.optional().describe('このチャンネルで読んだ投稿のうち最も新しいものの post_id'),
  }, 'channels の要素に渡せるのは channel と last_post_id だけです。')).max(MAX_ITEMS).optional(),
  threads: z.array(item({
    post_id: POST_ID.describe('スレッドの親投稿か、スレッド内の投稿の post_id'),
    last_post_id: POST_ID.optional().describe('このスレッドで読んだ投稿のうち最も新しいものの post_id'),
  }, 'threads の要素に渡せるのは post_id と last_post_id だけです。')).max(MAX_ITEMS).optional(),
};
type Args = z.infer<z.ZodObject<typeof schema>>;

type Post = MmPost & { props?: { from_webhook?: string; from_bot?: string } };
// Not treating these as unread posts: Mattermost leaves them out of the unread count (Post.IsJoinLeaveMessage).
const JOIN_LEAVE = new Set([
  'system_join_leave', 'system_add_remove', 'system_join_channel', 'system_leave_channel', 'system_join_team',
  'system_leave_team', 'system_add_to_channel', 'system_remove_from_channel', 'system_add_to_team', 'system_remove_from_team',
]);
type Counts = { total_msg_count: number; total_msg_count_root: number };
type Member = { msg_count: number; msg_count_root: number; mention_count: number; mention_count_root: number };
type ThreadState = { last_viewed_at: number; last_reply_at: number; unread_replies: number; unread_mentions: number };
type Result = { line: string; ok: boolean };

const missing = (e: unknown) => e instanceof MmError && (e.status === 403 || e.status === 404);

function lastPost(mm: Mm, uid: string, id: string, reread: string): Promise<Post> {
  return mm.call<Post>(uid, 'GET', `/posts/${id}`).catch((e) => {
    if (missing(e)) throw new InputError(`last_post_id ${id} の投稿が見つかりません（削除されたか、見る権限がありません）。${reread} で読み直して、読んだ投稿のうち最も新しいものの post_id を渡してください。`);
    throw e;
  });
}

// Per item rather than failing the call: one bad item should not keep the others unread. Anything else (re-login, 429, outage) concerns every item.
function itemFailure(e: unknown): string {
  if (e instanceof InputError || e instanceof MmError) return failureText(e);
  throw e;
}

export async function markAsRead(mm: Mm, uid: string, args: Args): Promise<CallToolResult> {
  const channels = args.channels ?? [];
  const threads = args.threads ?? [];
  const n = channels.length + threads.length;
  if (!n || n > MAX_ITEMS) throw new InputError(`channels と threads を合わせて 1〜${MAX_ITEMS} 件を指定してください。`);
  const crt = (await collapsedThreads(mm, uid)).on;
  const results: Result[] = [];
  const seen = new Set<string>();

  for (const item of channels) {
    let label = `チャンネル「${item.channel}」`;
    try {
      const ch = await resolveChannel(mm, uid, item.channel);
      label = `チャンネル ${ch.displayName || ch.name}（channel_id: ${ch.id}）`;
      if (seen.has(ch.id)) throw new InputError('同じチャンネルがほかの項目と重なっています。1 件にまとめてください。');
      seen.add(ch.id);
      const me = await mm.call<Member>(uid, 'GET', `/channels/${ch.id}/members/me`).catch((e) => {
        if (missing(e)) throw new InputError('このチャンネルに参加していません。');
        throw e;
      });
      const raw = ch.raw as unknown as Counts;
      const unread = crt ? raw.total_msg_count_root - me.msg_count_root : raw.total_msg_count - me.msg_count;
      if (unread <= 0 && !(crt ? me.mention_count_root : me.mention_count)) {
        results.push({ line: `- ${label}: すでに既読です。`, ok: true });
        continue;
      }
      if (item.last_post_id) {
        const last = await lastPost(mm, uid, item.last_post_id, 'read_channel');
        if (last.channel_id !== ch.id) throw new InputError(`last_post_id ${last.id} の投稿はこのチャンネルにありません。`);
        // Not comparing with the channel's last_post_at: editing or pinning moves it forward and deleting never moves it back.
        const q = new URLSearchParams({ after: last.id, per_page: String(AFTER_PAGE), collapsedThreads: String(crt), skipFetchThreads: 'true' });
        const r = await mm.call<{ order: string[]; posts: Record<string, Post> }>(uid, 'GET', `/channels/${ch.id}/posts?${q}`);
        const after = r.order.map((id) => r.posts[id]).filter(Boolean);
        const mine = (p: Post) => p.user_id === uid && !p.props?.from_webhook && !p.props?.from_bot;
        if (after.some((p) => !mine(p) && !JOIN_LEAVE.has(p.type ?? ''))) {
          results.push({ line: `- ${label}: last_post_id より後に、読んでいない投稿があります。既読にしていません。read_channel の from: "unread" で最後まで読んでから、読んだ中で最も新しい投稿を渡してください。`, ok: false });
          continue;
        }
        if (after.length >= AFTER_PAGE) {
          results.push({ line: `- ${label}: last_post_id より後に自分の投稿（と参加・退出の通知）が ${AFTER_PAGE} 件以上あり、その先を確かめられないため既読にしていません。`, ok: false });
          continue;
        }
      }
      // Not using /channels/members/{id}/view: it also switches the user's active channel, which changes what they are notified about.
      // Not batching every channel into one mark_read after all the checks: the gap between a channel's check and its marking would grow to the whole run.
      await mm.call(uid, 'POST', `/channels/members/${uid}/mark_read`, [ch.id]);
      results.push({ line: `- ${label}: ${item.last_post_id ? '既読にしました。' : '呼んだ時点までのすべてを既読にしました。'}`, ok: true });
    } catch (e) {
      results.push({ line: `- ${label}: 既読にできませんでした。${itemFailure(e)}`, ok: false });
    }
  }

  let anyTeam: string | undefined;
  for (const item of threads) {
    let label = `スレッド（post_id: ${item.post_id}）`;
    try {
      if (!crt) throw new InputError('スレッドの折りたたみ（CRT）が無効なため、スレッドの既読は画面に出ません。チャンネルを既読にすれば足ります。');
      const p = await mm.call<Post & { reply_count?: number }>(uid, 'GET', `/posts/${item.post_id}`).catch((e) => {
        if (missing(e)) throw new InputError('投稿が見つかりません（削除されたか、見る権限がありません）。');
        throw e;
      });
      const root = p.root_id || p.id;
      label = `スレッド（親 post_id: ${root}）`;
      const ch = await mm.call<{ team_id: string }>(uid, 'GET', `/channels/${p.channel_id}`);
      // Not looking for the team the user has open: for a DM or group DM thread the team only tells clients which team's thread counts to update, and no API tells which one is open.
      const team = ch.team_id || (anyTeam ??= (await myTeams(mm, uid))[0]?.id);
      if (!team) throw new InputError('所属しているチームがないため、スレッドを既読にできません。');
      const state = await mm.call<ThreadState>(uid, 'GET', `/users/${uid}/teams/${team}/threads/${root}`).catch((e) => {
        if (!(e instanceof MmError && e.status === 404)) throw e;
        // Not pointing a root post without replies to follow_thread: Mattermost has no thread state for it until the first reply, followed or not.
        if (!p.root_id && !p.reply_count) throw new InputError('このスレッドには返信が無いため、既読にするものがありません。');
        throw new InputError('このスレッドはフォローしていないため、既読の状態がありません（フォローしていないスレッドの返信は未読に数えられません）。フォローするなら follow_thread を使ってください（フォローした時点までの返信が既読になります）。');
      });
      let at = state.last_reply_at;
      if (item.last_post_id) {
        const last = await lastPost(mm, uid, item.last_post_id, 'read_thread');
        if (last.id !== root && last.root_id !== root) throw new InputError(`last_post_id ${last.id} の投稿はこのスレッドにありません。`);
        at = last.create_at;
      }
      const upTo = item.last_post_id ? 'last_post_id までは' : 'すでに';
      const put = (ts: number) => mm.call<ThreadState>(uid, 'PUT', `/users/${uid}/teams/${team}/threads/${root}/read/${ts}`);
      // Not writing the read post's own time: Mattermost counts unread replies after the position but mentions from it, so a mention on that post would stay.
      // Not writing a position before the current one: the threads API moves it backwards too, which would unread what the user has read since.
      const to = Math.max(at + 1, state.last_viewed_at);
      let done: string;
      if (to === state.last_viewed_at) {
        // Not rewriting the position while replies after it are unread: the mention count would not change, and the user may read further meanwhile.
        if (!state.unread_mentions || state.unread_replies) {
          results.push({ line: `- ${label}: ${upTo}既読です。`, ok: true });
          continue;
        }
        // Not rewriting the same position for a mention with no unread reply: Mattermost counts mentions from the position, so one on a reply at it would stay. No reply is after it, so one millisecond on reads none.
        const r = await put(to + 1);
        done = `${upTo}既読です${r.unread_mentions ? '' : '（残っていたメンションを消しました）'}。`;
      } else {
        const r = await put(to);
        // Not leaving a mention with no unread reply: it is on a reply at the position, which already counts as read.
        if (r.unread_mentions && !r.unread_replies) await put(to + 1);
        done = item.last_post_id ? '既読にしました。' : '呼んだ時点の最終返信までを既読にしました。';
      }
      results.push({ line: `- ${label}: ${done}`, ok: true });
    } catch (e) {
      results.push({ line: `- ${label}: 既読にできませんでした。${itemFailure(e)}`, ok: false });
    }
  }
  return text(['既読にした結果:', ...results.map((r) => r.line)].join('\n'), !results.some((r) => r.ok));
}

export function registerMarkReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('mark_as_read', {
    description: '本人のチャンネルとスレッドを既読にする（合わせて 20 件まで）。last_post_id には、そのチャンネルやスレッドで読んだ投稿のうち最も新しいものの post_id を渡す。チャンネルは、それより後に自分以外の投稿があれば既読にしないが、それより前の投稿はすべて既読にするので、未読を片付けるときは read_channel の from: "unread" で未読を最後まで読んでから渡すこと。スレッドは、その投稿までを既読にする。last_post_id を省くと呼んだ時点までのすべてが既読になるので、利用者がすべての既読を求めたときだけ省くこと。last_post_id を付けた呼び出しは、失敗したらそのまま再実行してよい',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'mark_as_read', async (args: Args, extra: { signal: AbortSignal }) =>
    markAsRead({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) }, ctx.mmUserId, args),
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for this shape.
  ) as unknown as ToolCallback<typeof schema>);
}

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

const schema = {
  channels: z.array(z.object({
    channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか'),
    last_post_id: POST_ID.optional().describe('このチャンネルで最後に読んだ投稿の post_id'),
  })).max(MAX_ITEMS).optional(),
  threads: z.array(z.object({
    post_id: POST_ID.describe('スレッドの親投稿か、スレッド内の投稿の post_id'),
    last_post_id: POST_ID.optional().describe('このスレッドで最後に読んだ投稿の post_id'),
  })).max(MAX_ITEMS).optional(),
};
type Args = z.infer<z.ZodObject<typeof schema>>;

type Post = MmPost & { type?: string; props?: { from_webhook?: string; from_bot?: string } };
// Not treating these as unread posts: Mattermost leaves them out of the unread count (Post.IsJoinLeaveMessage).
const JOIN_LEAVE = new Set([
  'system_join_leave', 'system_add_remove', 'system_join_channel', 'system_leave_channel', 'system_join_team',
  'system_leave_team', 'system_add_to_channel', 'system_remove_from_channel', 'system_add_to_team', 'system_remove_from_team',
]);
type Counts = { total_msg_count: number; total_msg_count_root: number };
type Member = { msg_count: number; msg_count_root: number; mention_count: number; mention_count_root: number };
type Result = { line: string; ok: boolean };

const missing = (e: unknown) => e instanceof MmError && (e.status === 403 || e.status === 404);

function lastPost(mm: Mm, uid: string, id: string, reread: string): Promise<Post> {
  return mm.call<Post>(uid, 'GET', `/posts/${id}`).catch((e) => {
    if (missing(e)) throw new InputError(`last_post_id ${id} の投稿が見つかりません（削除されたか、見る権限がありません）。${reread} で読み直して、最後に読んだ投稿の post_id を渡してください。`);
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
  const toMark: { id: string; label: string; at: number }[] = [];

  for (const item of channels) {
    let label = `チャンネル「${item.channel}」`;
    try {
      const ch = await resolveChannel(mm, uid, item.channel);
      label = `チャンネル ${ch.displayName || ch.name}（channel_id: ${ch.id}）`;
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
          results.push({ line: `- ${label}: last_post_id より後に、読んでいない投稿があります。既読にしていません。read_channel で読み直してから、最後に読んだ投稿を渡してください。`, ok: false });
          continue;
        }
        if (after.length >= AFTER_PAGE) {
          results.push({ line: `- ${label}: last_post_id より後に自分の投稿（と参加・退出の通知）が ${AFTER_PAGE} 件以上あり、その先を確かめられないため既読にしていません。`, ok: false });
          continue;
        }
      }
      toMark.push({ id: ch.id, label, at: results.length });
      results.push({ line: '', ok: false });
    } catch (e) {
      results.push({ line: `- ${label}: 既読にできませんでした。${itemFailure(e)}`, ok: false });
    }
  }
  if (toMark.length) {
    // Not using /channels/members/{id}/view: it also switches the user's active channel, which changes what they are notified about.
    const failed = await mm.call(uid, 'POST', `/channels/members/${uid}/mark_read`, toMark.map((x) => x.id)).then(() => undefined, itemFailure);
    for (const x of toMark) results[x.at] = failed ? { line: `- ${x.label}: 既読にできませんでした。${failed}`, ok: false } : { line: `- ${x.label}: 既読にしました。`, ok: true };
  }

  let anyTeam: string | undefined;
  for (const item of threads) {
    let label = `スレッド（post_id: ${item.post_id}）`;
    try {
      if (!crt) throw new InputError('スレッドの折りたたみ（CRT）が無効なため、スレッドの既読は画面に出ません。チャンネルを既読にすれば足ります。');
      const p = await mm.call<Post>(uid, 'GET', `/posts/${item.post_id}`).catch((e) => {
        if (missing(e)) throw new InputError('投稿が見つかりません（削除されたか、見る権限がありません）。');
        throw e;
      });
      const root = p.root_id || p.id;
      label = `スレッド（親 post_id: ${root}）`;
      const ch = await mm.call<{ team_id: string }>(uid, 'GET', `/channels/${p.channel_id}`);
      // Not looking for the team the user has open: for a DM or group DM thread the team only tells clients which team's thread counts to update, and no API tells which one is open.
      const team = ch.team_id || (anyTeam ??= (await myTeams(mm, uid))[0]?.id);
      if (!team) throw new InputError('所属しているチームがないため、スレッドを既読にできません。');
      const state = await mm.call<{ last_viewed_at: number; last_reply_at: number }>(uid, 'GET', `/users/${uid}/teams/${team}/threads/${root}`).catch((e) => {
        if (e instanceof MmError && e.status === 404) throw new InputError('このスレッドには既読の状態がありません（スレッドに参加もフォローもしていません）。');
        throw e;
      });
      let at = state.last_reply_at;
      if (item.last_post_id) {
        const last = await lastPost(mm, uid, item.last_post_id, 'read_thread');
        if (last.id !== root && last.root_id !== root) throw new InputError(`last_post_id ${last.id} の投稿はこのスレッドにありません。`);
        at = last.create_at;
      }
      // Not writing a position at or before the current one: the threads API moves it backwards too, which would unread what the user has read since.
      if (at <= state.last_viewed_at) {
        results.push({ line: `- ${label}: すでに既読です。`, ok: true });
        continue;
      }
      await mm.call(uid, 'PUT', `/users/${uid}/teams/${team}/threads/${root}/read/${at}`);
      results.push({ line: `- ${label}: 既読にしました。`, ok: true });
    } catch (e) {
      results.push({ line: `- ${label}: 既読にできませんでした。${itemFailure(e)}`, ok: false });
    }
  }
  return text(['既読にした結果:', ...results.map((r) => r.line)].join('\n'), !results.some((r) => r.ok));
}

export function registerMarkReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool('mark_as_read', {
    description: '本人のチャンネルとスレッドを既読にする（合わせて 20 件まで）。last_post_id には、そのチャンネルやスレッドで最後に読んだ投稿の post_id を渡す。チャンネルは、それより後に自分以外の投稿があれば既読にしない。スレッドは、その投稿までを既読にする。last_post_id を省くと呼んだ時点までのすべてが既読になるので、利用者がすべての既読を求めたときだけ省くこと。失敗したら、そのまま再実行してよい',
    inputSchema: schema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, guarded(ctx, 'mark_as_read', async (args: Args, extra: { signal: AbortSignal }) =>
    markAsRead({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) }, ctx.mmUserId, args),
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for this shape.
  ) as unknown as ToolCallback<typeof schema>);
}

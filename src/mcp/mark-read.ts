import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MmError, RateLimited } from '../mattermost/client.ts';
import { strictArgs } from './args.ts';
import { InputError, type MmPost } from './format.ts';
import { myTeams, resolveChannel, type Mm } from './resolve.ts';
import { log } from '../log.ts';
import { failure, failureText, guarded, text, type ToolContext } from './server.ts';
import { collapsedThreads } from './tools-read.ts';
import { POST_WORDING } from './tools-save-pin.ts';
import { worded } from './tools-send.ts';
import { missing, threadTeam } from './tools-threads.ts';

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/);
const MAX_ITEMS = 20;
const AFTER_PAGE = 200;

// Not leaving the items of channels and threads to zod's z.object, which drops unknown keys: a misspelled last_post_id would mark the item read up to the newest post, which only the user can undo, item by item, in the Mattermost UI.
const schema = {
  channels: z.array(strictArgs({
    channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか'),
    last_post_id: POST_ID.optional().describe('このチャンネルで読んだ投稿のうち最も新しいものの post_id'),
  })).max(MAX_ITEMS).optional(),
  threads: z.array(strictArgs({
    post_id: POST_ID.describe('スレッドの親投稿か、スレッド内の投稿の post_id'),
    last_post_id: POST_ID.optional().describe('このスレッドで読んだ投稿のうち最も新しいものの post_id'),
  })).max(MAX_ITEMS).optional(),
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

function lastPost(mm: Mm, uid: string, id: string, reread: string): Promise<Post> {
  return mm.call<Post>(uid, 'GET', `/posts/${id}`).catch((e) => {
    if (missing(e)) throw new InputError(`last_post_id ${id} の投稿が見つかりません（削除されたか、見る権限がありません）。${reread} で読み直して、読んだ投稿のうち最も新しいものの post_id を渡してください。`);
    throw e;
  });
}

const itemError = (e: unknown): e is InputError | MmError => e instanceof InputError || e instanceof MmError;

class Interrupted extends Error {
  readonly line: string;
  readonly changed: boolean;
  readonly reason: unknown;
  constructor(line: string, changed: boolean, reason: unknown) {
    super('interrupted');
    this.line = line;
    this.changed = changed;
    this.reason = reason;
  }
}

export async function markAsRead(mm: Mm, uid: string, args: Args): Promise<CallToolResult> {
  const channels = args.channels ?? [];
  const threads = args.threads ?? [];
  const n = channels.length + threads.length;
  if (!n || n > MAX_ITEMS) throw new InputError(`channels と threads を合わせて 1〜${MAX_ITEMS} 件を指定してください。`);
  const crt = (await collapsedThreads(mm, uid)).on;
  const results: Result[] = [];
  const pending = [...channels.map((c) => `チャンネル「${c.channel}」`), ...threads.map((t) => `スレッド（post_id: ${t.post_id}）`)];
  let started = 0;
  let writing = false;
  // Per item rather than failing the call: one bad item should not keep the others unread. Anything else (re-login, 429, outage, a bug) concerns every item, so the run stops there.
  const failed = (label: string, e: unknown): Result => {
    if (e instanceof Interrupted) throw e;
    if (itemError(e)) return { line: `- ${label}: 既読にできませんでした。${failureText(e)}`, ok: false };
    // Not saying the item stayed unread once its write was sent: it may have reached Mattermost before the timeout or the 5xx. A rate limit, or a failure known to be raised before sending, left it unread.
    const maybe = writing && !(e instanceof RateLimited) && (e as { sent?: boolean }).sent !== false;
    throw new Interrupted(`- ${label}: 処理中に中断しました（${maybe ? '既読になったかは分かりません' : '既読にしていません'}）。`, maybe, e);
  };
  try {
    await markItems();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    if (!results.length && !e.changed) throw e.reason;
    const f = failure(e.reason);
    log('tool_interrupted', { mm_user_id: uid, tool: 'mark_as_read', outcome: f.outcome });
    const rest = pending.slice(started);
    // Not pointing to a plain retry of the whole call: items without last_post_id would also mark read what arrived meanwhile.
    return text([
      '既読にした結果:', ...results.map((r) => r.line), e.line,
      `ここで中断しました。${(f.result.content[0] as { text: string }).text}${rest.length ? `次の ${rest.length} 件は処理していません: ${rest.join('、')}。` : ''}再実行するときは、中断した項目と処理していない項目だけを渡してください。利用者がすべての既読を求めたのでなければ、last_post_id を省いた項目は、渡し直す前に読んで last_post_id を付けてください。`,
    ].join('\n'), true);
  }
  return text(['既読にした結果:', ...results.map((r) => r.line)].join('\n'), !results.some((r) => r.ok));

  async function markItems(): Promise<void> {
    const seen = new Set<string>();

    for (const item of channels) {
      started++;
      writing = false;
      let label = `チャンネル「${item.channel}」`;
      try {
        const ch = await resolveChannel(mm, uid, item.channel);
        label = `チャンネル ${ch.displayName || ch.name}（channel_id: ${ch.id}）`;
        if (seen.has(ch.id)) throw new InputError('同じチャンネルがほかの項目と重なっています。1 件にまとめてください。');
        seen.add(ch.id);
        const me = await mm.call<Member>(uid, 'GET', `/channels/${ch.id}/members/me`).catch((e) => {
          // Not saying a 403 means not joined: Mattermost also answers 403 when its permission check fails on a transient error.
          if (e instanceof MmError && e.status === 403) throw new InputError('このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。参加しているはずなら、少し待ってから再試行してください。');
          if (e instanceof MmError && e.status === 404) throw new InputError('このチャンネルに参加していません。');
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
        writing = true;
        await mm.call(uid, 'POST', `/channels/members/${uid}/mark_read`, [ch.id]);
        results.push({ line: `- ${label}: ${item.last_post_id ? '既読にしました。' : '呼んだ時点までのすべてを既読にしました。'}`, ok: true });
      } catch (e) {
        results.push(failed(label, e));
      }
    }

    let anyTeam: string | undefined;
    const firstTeam = async () => (anyTeam ??= (await myTeams(mm, uid))[0]?.id);
    for (const item of threads) {
      started++;
      writing = false;
      let label = `スレッド（post_id: ${item.post_id}）`;
      try {
        if (!crt) throw new InputError('スレッドの折りたたみ（CRT）が無効なため、スレッドの既読は画面に出ません。チャンネルを既読にすれば足ります。');
        const p = await worded(mm.call<Post & { reply_count?: number }>(uid, 'GET', `/posts/${item.post_id}`), POST_WORDING);
        const root = p.root_id || p.id;
        label = `スレッド（親 post_id: ${root}）`;
        const { team } = await threadTeam(mm, uid, p.channel_id, firstTeam);
        if (!team) throw new InputError('所属しているチームがないため、スレッドを既読にできません。');
        const state = await mm.call<ThreadState>(uid, 'GET', `/users/${uid}/teams/${team}/threads/${root}`).catch(async (e) => {
          if (!(e instanceof MmError && e.status === 404)) throw e;
          // Not pointing a root post without replies to follow_thread: Mattermost has no thread state for it until the first reply, followed or not.
          if (!p.root_id && !p.reply_count) throw new InputError('このスレッドには返信が無いため、既読にするものがありません。');
          // Not pointing a thread of a channel the user has not joined to follow_thread: follow_thread refuses it. A public channel's posts are readable without joining, so the 404 alone does not tell.
          await mm.call(uid, 'GET', `/channels/${p.channel_id}/members/me`).catch((m) => {
            if (m instanceof MmError && m.status === 403) throw new InputError('このスレッドのチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。参加していないなら、既読にするものはありません。参加しているはずなら、少し待ってから再試行してください。');
            if (m instanceof MmError && m.status === 404) throw new InputError('このスレッドのチャンネルに参加していません。参加していないチャンネルのスレッドは未読に数えられないので、既読にするものがありません。');
            throw m;
          });
          throw new InputError('このスレッドはフォローしていないため、既読の状態がありません（フォローしていないスレッドの返信は未読に数えられません）。フォローするなら follow_thread を使ってください（フォローした時点までの返信が既読になります）。');
        });
        let at = state.last_reply_at;
        if (item.last_post_id) {
          const last = await lastPost(mm, uid, item.last_post_id, 'read_thread');
          if (last.id !== root && last.root_id !== root) throw new InputError(`last_post_id ${last.id} の投稿はこのスレッドにありません。`);
          at = last.create_at;
        }
        const upTo = item.last_post_id ? 'last_post_id までは' : 'すでに';
        const put = (ts: number) => {
          writing = true;
          return mm.call<ThreadState>(uid, 'PUT', `/users/${uid}/teams/${team}/threads/${root}/read/${ts}`);
        };
        // Not failing the item when only clearing the mention fails: the position already stands at or past the one to write, so the thread is read.
        // Not pointing a call without last_post_id to a plain retry: it would also mark read the replies that arrived meanwhile.
        const retry = item.last_post_id ? 'このスレッドを同じ last_post_id で再実行すると消せることがあります。' : 'このスレッドを read_thread で読み、読んだ最終返信を last_post_id に渡して再実行すると消せることがあります。';
        const clearing = (ts: number, read: string) => put(ts).catch((e) => {
          if (!itemError(e)) throw new Interrupted(`- ${label}: ${read}ただし、位置ちょうどの返信のメンションを消す前に中断しました。${retry}`, true, e);
          const why = failureText(e);
          return `ただし、位置ちょうどの返信のメンションは消せませんでした。${why}${why.endsWith('。') ? '' : '。'}${retry}`;
        });
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
          const r = await clearing(to + 1, `${upTo}既読です。`);
          done = typeof r === 'string' ? `${upTo}既読です。${r}` : `${upTo}既読です${r.unread_mentions ? '' : '（残っていたメンションを消しました）'}。`;
        } else {
          const r = await put(to);
          // Not leaving a mention with no unread reply: it is on a reply at the position, which already counts as read.
          const read = item.last_post_id ? '既読にしました。' : '呼んだ時点の最終返信までを既読にしました。';
          const left = r.unread_mentions && !r.unread_replies ? await clearing(to + 1, read) : undefined;
          done = read + (typeof left === 'string' ? left : '');
        }
        results.push({ line: `- ${label}: ${done}`, ok: true });
      } catch (e) {
        results.push(failed(label, e));
      }
    }
  }
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

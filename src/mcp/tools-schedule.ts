import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FileHeld, MAX_PENDING_SCHEDULED, type Scheduled, type ScheduledStatus, type Store } from '../store.ts';
import { strictArgs } from './args.ts';
import { encodeCursor, formatTime, InputError, lines, truncate } from './format.ts';
import { dmLabel, type Mm, type MmChannel, teamNameOf } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { cursorArg, cursorOf, limitArg, perPage } from './tools-read.ts';
import { checkRoot, checkUnposted, checkUploaded, createsDirect, heldError, MAX_UPLOAD_FILES, resolveTarget } from './tools-send.ts';
import { parseWhen } from './when.ts';

const MIN_AHEAD = 60_000;
const MAX_AHEAD = 30 * 24 * 3600_000;
const STATUS: Record<ScheduledStatus, string> = { pending: '待機中', sending: '投稿中', posted: '投稿済み', failed: '失敗' };
const STATUSES = ['pending', 'sending', 'posted', 'failed'] as const;
const AT_LIMIT = `待機中の予約が上限の ${MAX_PENDING_SCHEDULED} 件に達しています。不要な予約を cancel_scheduled_message で取り消してください。`;
const NOT_CHANGEABLE = '予約が見つかりません。または、投稿中か、投稿を試みた後で結果を確かめている途中か、終了済みのため変えられません。';

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/);
const MESSAGE = z.string().min(1).max(16383);
const AT = z.string().describe('予定時刻。ISO 8601 の YYYY-MM-DDTHH:mm（秒は任意）。タイムゾーン（Z、+09:00 など）が無ければ JST。今から 1 分後から 30 日後まで');
const ID = z.string().min(1).max(100).describe('予約 ID');

function when(at: string): number {
  const ms = parseWhen(at);
  const now = Date.now();
  if (ms < now + MIN_AHEAD || ms > now + MAX_AHEAD) throw new InputError(`予約できるのは、今から 1 分後から 30 日後までです。指定された時刻: ${formatTime(ms)}`);
  return ms;
}

const scheduleShape = {
  channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。DM とグループ DM は無ければ作る'),
  message: MESSAGE,
  root_id: POST_ID.optional().describe('返信にするときの、スレッドの親投稿の post_id'),
  at: AT,
  file_ids: z.array(z.string().regex(/^[A-Za-z0-9]{26}$/)).min(1).max(MAX_UPLOAD_FILES).optional()
    .describe('prepare_upload で、投稿先と同じチャンネルへ 24 時間以内にアップロードした file_id（1〜5 件）'),
};
const scheduleSchema = strictArgs(scheduleShape, {
  files: 'files は予約では使えません。中身を読めて合計 128KiB に収まるファイルを今すぐ送るなら send_message の files を、それ以外や予約では prepare_upload でアップロードし、その file_id を file_ids に渡してください。',
});
type ScheduleArgs = { channel: string; message: string; root_id?: string; at: string; file_ids?: string[] };

export async function scheduleMessage(mm: Mm, store: Store, uid: string, args: ScheduleArgs): Promise<CallToolResult> {
  const at = when(args.at);
  const fileIds = args.file_ids ?? [];
  // Not left to createScheduled alone when resolving may create a DM: failing after that leaves it empty. A schedule added or put back to pending between the two checks still does.
  // Not checked first for other targets: a wrong channel name or file is the error the caller can act on, and the limit is checked again when the row is made.
  const mayCreate = args.channel.trim().startsWith('@') && createsDirect(args.root_id, fileIds);
  if (mayCreate && store.pendingScheduledCount(uid) >= MAX_PENDING_SCHEDULED) throw new InputError(AT_LIMIT);
  const ch = await resolveTarget(mm, store, uid, args.channel, args.root_id, fileIds);
  if (args.root_id) await checkRoot(mm, uid, args.root_id, ch);
  checkUploaded(store, uid, ch.id, fileIds);
  checkUnposted(store, uid, fileIds);
  let id: string | undefined;
  try {
    id = store.createScheduled({ mmUserId: uid, channelId: ch.id, rootId: args.root_id, message: args.message, scheduledAt: at, fileIds }, Date.now());
  } catch (e) {
    if (e instanceof FileHeld) throw heldError(e.held);
    throw e;
  }
  if (!id) throw new InputError(AT_LIMIT);
  return text([
    '予約しました。',
    `予約 ID: ${id}`,
    `投稿先: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${args.root_id ? `、返信先 post_id: ${args.root_id}` : ''}`,
    `予定時刻: ${formatTime(at)}`,
    ...(fileIds.length ? [`添付: ${fileIds.join(', ')}`] : []),
    '結果は list_scheduled_messages で確かめられます。',
  ].join('\n'));
}

const listCursor = z.object({ at: z.number().int(), id: z.string(), per_page: perPage(50), status: z.enum(STATUSES).optional() }).strict();

type ListArgs = { id?: string; status?: ScheduledStatus; limit?: number; cursor?: string };

export async function listScheduledMessages(mm: Mm, store: Store, uid: string, baseUrl: string, args: ListArgs): Promise<CallToolResult> {
  // Not reading the cursor before the id: a stale cursor left in the call must not block fetching one schedule.
  const one = args.id === undefined ? undefined : store.getScheduled(uid, args.id);
  if (args.id !== undefined && !one) throw new InputError('予約が見つかりません。予約 ID は list_scheduled_messages（id を渡さずに）で確かめてください。');
  const c = one ? undefined : cursorOf(listCursor, args.cursor);
  const per = c?.per_page ?? args.limit ?? 20;
  const status = c ? c.status : args.status;
  const rows = one ? [one] : store.listScheduled(uid, { status, after: c && { at: c.at, id: c.id }, limit: per + 1 });
  const shown = rows.slice(0, per);
  if (!shown.length && !c) return text('予約はありません。');
  // Not failing the list on any of these lookups: it is the only place a user learns a schedule failed, and a channel they have left answers 403.
  const channels = new Map<string, { label: string; ch?: MmChannel }>();
  const channelOf = async (id: string) => {
    if (!channels.has(id)) {
      let v: { label: string; ch?: MmChannel } = { label: `channel_id: ${id}` };
      try {
        const ch = await mm.call<MmChannel>(uid, 'GET', `/channels/${id}`);
        // Not a name of its own for a DM or group DM: resolveChannel's is what the other outputs show, and two forms would read as two destinations.
        // Not letting its re-login or rate limit drop the row's channel and permalink: the name is only for display, and Mattermost's name still names it.
        const name = (await dmLabel(mm, uid, ch).catch(() => undefined)) ?? (ch.display_name || ch.name);
        v = { label: `${name}（channel_id: ${id}）`, ch };
      } catch {}
      channels.set(id, v);
    }
    return channels.get(id)!;
  };
  const teams = new Map<string, string | undefined>();
  const teamOf = async (id: string) => {
    if (!teams.has(id)) {
      const { ch } = await channelOf(id);
      let name: string | undefined;
      try {
        name = ch && (await teamNameOf(mm, uid, ch.team_id));
      } catch {}
      // Not building a permalink from an empty team name: /<team>/pl/<id> needs one, and //pl/ opens nothing.
      teams.set(id, name || undefined);
    }
    return teams.get(id);
  };
  const out: string[] = [];
  for (const s of shown) out.push(...await row(s, (await channelOf(s.channelId)).label, teamOf, baseUrl, !!one));
  // Not ending a single schedule with the paging line: its body comes last so that everything after its heading is the body.
  if (one) return text(out.join('\n'));
  const last = shown.at(-1);
  out.push(rows.length > per && last ? `next_cursor: ${encodeCursor({ at: last.scheduledAt, id: last.id, per_page: per, ...(status ? { status } : {}) })}` : '（続きはありません）');
  return text(out.join('\n'));
}

async function row(s: Scheduled, where: string, teamOf: (channelId: string) => Promise<string | undefined>, baseUrl: string, full: boolean): Promise<string[]> {
  const out = [
    `--- 予約 ID: ${s.id}`,
    `状態: ${STATUS[s.status]}`,
    `投稿先: ${where}${s.rootId ? `、返信先 post_id: ${s.rootId}` : ''}`,
    `予定時刻: ${formatTime(s.scheduledAt)}`,
  ];
  const head = s.message === undefined ? undefined : truncate(s.message, 200);
  // Not leaving the body's later lines at the margin: one could pass for a heading or a field of the list, so they are indented as formatPost does.
  if (!full) out.push(head ? `本文（先頭 200 文字）: ${lines(head.text).join('\n  ')}` : '本文: （復号できません）');
  // Not on the body line itself: a copied body would carry the hint into the post.
  if (!full && head?.truncated) out.push('（本文を先頭 200 文字で切りました。全文は list_scheduled_messages に id を渡すと出ます）');
  if (s.fileIds.length) out.push(`添付: ${s.fileIds.join(', ')}`);
  // Not saving the re-upload hint with the reason: rows fail on several paths (the tick, the late sweep, invalidate-scheduled), and this covers them all.
  if (s.error) out.push(s.status === 'posted' ? `注意: ${s.error}` : `失敗の理由: ${s.error}${s.fileIds.length ? ' ファイルを付けて送り直すときは、prepare_upload からアップロードし直してください。' : ''}`);
  if (s.postId) {
    out.push(`post_id: ${s.postId}`);
    const team = s.status === 'posted' ? await teamOf(s.channelId) : undefined;
    if (team !== undefined) out.push(`${baseUrl}/${team}/pl/${s.postId}`);
  }
  // Not in the middle as in the list: the body may span lines, and last is the only place where it ends unambiguously.
  // Not pointing a schedule that is no longer pending to update or cancel: both refuse it.
  if (full) out.push(s.message !== undefined ? `本文（この行の次から末尾まで）:\n${s.message}`
    : s.status === 'pending' ? '本文: （復号できません。本文を直すには、update_scheduled_message に新しい本文全体を渡すか、取り消して予約し直してください）'
      : '本文: （復号できません）');
  return out;
}

const UNCHANGEABLE = '投稿先と添付は変えられません。cancel_scheduled_message で取り消して予約し直してください。';
const updateSchema = strictArgs({ id: ID, message: MESSAGE.optional().describe('新しい本文（全体を置き換える）'), at: AT.optional() },
  { file_ids: UNCHANGEABLE, files: UNCHANGEABLE, channel: UNCHANGEABLE, root_id: UNCHANGEABLE });

export function updateScheduledMessage(store: Store, uid: string, args: { id: string; message?: string; at?: string }): CallToolResult {
  if (args.message === undefined && args.at === undefined) throw new InputError('message か at のどちらかを指定してください。');
  const at = args.at === undefined ? undefined : when(args.at);
  const s = store.updateScheduled(uid, args.id, { message: args.message, scheduledAt: at }, Date.now());
  if (!s) throw new InputError(NOT_CHANGEABLE);
  return text(['予約を変更しました。', `予約 ID: ${s.id}`, `予定時刻: ${formatTime(s.scheduledAt)}`,
    ...(args.message === undefined ? [] : ['本文は list_scheduled_messages に id を渡すと確かめられます。'])].join('\n'));
}

export function cancelScheduledMessage(store: Store, uid: string, args: { id: string }): CallToolResult {
  if (!store.cancelScheduled(uid, args.id)) throw new InputError(NOT_CHANGEABLE);
  return text(`予約を取り消しました。\n予約 ID: ${args.id}`);
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('schedule_message', {
    description: '指定した時刻にチャンネルへ投稿するよう予約する。root_id を渡すとスレッドへの返信になる。投稿先は予約の時点で固定する。待機中の予約は 1 人 20 件まで。添付は file_ids（prepare_upload の結果）だけ。結果は list_scheduled_messages で確かめる',
    inputSchema: scheduleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'schedule_message', async (args: ScheduleArgs, extra: { signal: AbortSignal }) => scheduleMessage(mmOf(extra.signal), ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof scheduleSchema>);

  const listSchema = {
    id: ID.optional().describe('この予約 ID の 1 件だけを、本文を切らずに返す。update_scheduled_message で本文を直す前に全文を得るのに使う。status、limit、cursor は値を見ずに無視する（型や範囲が不正ならエラー）'),
    status: z.enum(STATUSES).optional().describe('状態で絞る（pending: 待機中、sending: 投稿中、posted: 投稿済み、failed: 失敗）。cursor を渡したときは無視する'),
    limit: limitArg(20, 50),
    cursor: cursorArg,
  };
  server.registerTool('list_scheduled_messages', {
    description: '本人の予約投稿を、予定時刻の順に返す。状態、失敗の理由、添付するファイル（あるとき）、投稿済みなら post_id とパーマリンクを出す。投稿済みと失敗の予約は 7 日で消える',
    inputSchema: listSchema,
    annotations: { readOnlyHint: true },
  }, guarded(ctx, 'list_scheduled_messages', async (args: ListArgs, extra: { signal: AbortSignal }) =>
    listScheduledMessages(mmOf(extra.signal), ctx.store, uid, ctx.cfg.mmBrowserUrl, args),
  ) as unknown as ToolCallback<typeof listSchema>);

  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  server.registerTool('update_scheduled_message', {
    description: '待機中の本人の予約の本文か予定時刻を変える。message は本文全体を置き換える。書き換える前は、常に list_scheduled_messages に id を渡して全文を得る（一覧の本文は先頭 200 文字までで、後ろに別の行が続く）。投稿先と添付ファイルは変えられない（変えるときは取り消して予約し直す）。投稿中や投稿を試みた後の予約は変えられない',
    inputSchema: updateSchema,
    annotations: destructive,
  }, guarded(ctx, 'update_scheduled_message', async (args: { id: string; message?: string; at?: string }) => updateScheduledMessage(ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof updateSchema>);

  const cancelSchema = { id: ID };
  server.registerTool('cancel_scheduled_message', {
    description: '待機中の本人の予約を取り消す。取り消した予約は一覧からも消える。投稿中や投稿を試みた後の予約は取り消せない',
    inputSchema: cancelSchema,
    annotations: destructive,
  }, guarded(ctx, 'cancel_scheduled_message', async (args: { id: string }) => cancelScheduledMessage(ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof cancelSchema>);
}

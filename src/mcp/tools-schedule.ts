import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CallAborted } from '../mattermost/client.ts';
import { msg } from '../i18n/index.ts';
import { FileHeld, MAX_PENDING_SCHEDULED, type Scheduled, type ScheduledStatus, type Store } from '../store.ts';
import { idArg, strictArgs } from './args.ts';
import { encodeCursor, formatTime, indented, InputError, oneLine, truncate, unformat } from './format.ts';
import { dmLabel, type Mm, type MmChannel, teamNameOf } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { cursorArg, cursorOf, limitArg, perPage } from './tools-read.ts';
import { checkRoot, checkUnposted, checkUploaded, heldError, MAX_FILES_BYTES, MAX_UPLOAD_FILES, mayCreateDirect, resolveTarget } from './tools-send.ts';
import { parseWhen, whenForm } from './when.ts';

const MIN_AHEAD = 60_000;
const MAX_AHEAD = 30 * 24 * 3600_000;
const STATUSES = ['pending', 'sending', 'posted', 'failed'] as const;

const POST_ID = idArg;
const MESSAGE = z.string().min(1).max(16383);
const at = () => z.string().describe(msg().descriptions.scheduleAt(whenForm()));
const idArgOf = () => z.string().overwrite(unformat).min(1).max(100).describe(msg().descriptions.scheduleId);

function when(at: string): number {
  const ms = parseWhen(at);
  const now = Date.now();
  if (ms < now + MIN_AHEAD || ms > now + MAX_AHEAD) throw new InputError(msg().schedule.outOfRange(formatTime(ms)));
  return ms;
}

const scheduleArgs = () => strictArgs({
  channel: z.string().min(1).describe(msg().descriptions.draftChannel),
  message: MESSAGE,
  root_id: POST_ID.optional().describe(msg().descriptions.scheduleRootId),
  at: at(),
  file_ids: z.array(idArg).min(1).max(MAX_UPLOAD_FILES).optional()
    .describe(msg().descriptions.fileIds),
}, {
  files: msg().schedule.filesHint(MAX_FILES_BYTES / 1024, MAX_UPLOAD_FILES),
});
type ScheduleArgs = { channel: string; message: string; root_id?: string; at: string; file_ids?: string[] };

export async function scheduleMessage(mm: Mm, store: Store, uid: string, args: ScheduleArgs): Promise<CallToolResult> {
  const at = when(args.at);
  const fileIds = args.file_ids ?? [];
  // Not left to createScheduled alone when resolving may create a DM: failing after that leaves it empty. A schedule added or put back to pending between the two checks still does.
  // Not checked first for other targets: a wrong channel name or file is the error the caller can act on, and the limit is checked again when the row is made.
  const mayCreate = mayCreateDirect(args.channel, args.root_id, fileIds);
  if (mayCreate && store.pendingScheduledCount(uid) >= MAX_PENDING_SCHEDULED) throw new InputError(msg().schedule.atLimit(MAX_PENDING_SCHEDULED));
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
  if (!id) throw new InputError(msg().schedule.atLimit(MAX_PENDING_SCHEDULED));
  const t = msg().schedule;
  return text([
    t.scheduled,
    t.idLine(id),
    t.destination(ch.id, args.root_id, oneLine(ch.displayName || ch.name)),
    t.time(formatTime(at)),
    ...(fileIds.length ? [t.files(fileIds.join(', '))] : []),
    t.checkResult,
  ].join('\n'));
}

const listCursor = z.object({ at: z.number().int(), id: z.string(), per_page: perPage(50), status: z.enum(STATUSES).optional() }).strict();

type ListArgs = { id?: string; status?: ScheduledStatus; limit?: number; cursor?: string };

export async function listScheduledMessages(mm: Mm, store: Store, uid: string, baseUrl: string, args: ListArgs): Promise<CallToolResult> {
  // Not reading the cursor before the id: a stale cursor left in the call must not block fetching one schedule.
  const one = args.id === undefined ? undefined : store.getScheduled(uid, args.id);
  if (args.id !== undefined && !one) throw new InputError(msg().schedule.notFound);
  const c = one ? undefined : cursorOf(listCursor, args.cursor);
  const per = c?.per_page ?? args.limit ?? 20;
  const status = c ? c.status : args.status;
  const rows = one ? [one] : store.listScheduled(uid, { status, after: c && { at: c.at, id: c.id }, limit: per + 1 });
  const shown = rows.slice(0, per);
  if (!shown.length && !c) return text(msg().schedule.none);
  // Not failing the list on any of these lookups: it is the only place a user learns a schedule failed, and a channel they have left answers 403.
  const channels = new Map<string, { name?: string; ch?: MmChannel }>();
  const channelOf = async (id: string) => {
    if (!channels.has(id)) {
      let v: { name?: string; ch?: MmChannel } = {};
      try {
        const ch = await mm.call<MmChannel>(uid, 'GET', `/channels/${id}`);
        // Not a name of its own for a DM or group DM: resolveChannel's is what the other outputs show, and two forms would read as two destinations.
        // Not letting its re-login or rate limit drop the row's channel and permalink: the name is only for display, and Mattermost's name still names it.
        const name = (await dmLabel(mm, uid, ch).catch((e) => {
          if (e instanceof CallAborted) throw e;
          return undefined;
        })) ?? oneLine(ch.display_name || ch.name);
        v = { name, ch };
      } catch (e) {
        // Not going on to the other rows once the caller aborted: no one is left to read the list.
        if (e instanceof CallAborted) throw e;
      }
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
      } catch (e) {
        if (e instanceof CallAborted) throw e;
      }
      // Not building a permalink from an empty team name: /<team>/pl/<id> needs one, and //pl/ opens nothing.
      teams.set(id, name || undefined);
    }
    return teams.get(id);
  };
  const out: string[] = [];
  for (const s of shown) out.push(...await row(s, (await channelOf(s.channelId)).name, teamOf, baseUrl, !!one));
  // Not ending a single schedule with the paging line: its body comes last so that everything after its heading is the body.
  if (one) return text(out.join('\n'));
  const last = shown.at(-1);
  out.push(rows.length > per && last ? `next_cursor: ${encodeCursor({ at: last.scheduledAt, id: last.id, per_page: per, ...(status ? { status } : {}) })}` : msg().read.noMore);
  return text(out.join('\n'));
}

async function row(s: Scheduled, name: string | undefined, teamOf: (channelId: string) => Promise<string | undefined>, baseUrl: string, full: boolean): Promise<string[]> {
  const t = msg().schedule;
  const out = [
    `--- ${t.idLine(s.id)}`,
    t.status(t.statuses[s.status]),
    // Not the display name first: one written as "（channel_id: …）" would then come before the real id.
    t.destination(s.channelId, s.rootId, name || undefined),
    t.time(formatTime(s.scheduledAt)),
  ];
  const head = s.message === undefined ? undefined : truncate(s.message, 200);
  // Not leaving the body's later lines at the margin: one could pass for a heading or a field of the list, so they are indented as the reason is.
  if (!full) out.push(...(head ? indented(head.truncated ? t.bodyFirst : t.bodyFull, head.text) : [t.bodyUndecryptable]));
  // Not on the body line itself: a copied body would carry the hint into the post.
  if (!full && head?.truncated) out.push(t.bodyCut);
  if (s.fileIds.length) out.push(t.files(s.fileIds.join(', ')));
  // Not saving the re-upload hint with the reason: rows fail on several paths (the tick, the late sweep, invalidate-scheduled), and this covers them all.
  // Not at the margin: a reason can quote Mattermost's error text, whose later lines could pass for a field of the list.
  if (s.error) out.push(...indented(s.status === 'posted' ? t.note : t.failureReason, s.error));
  // Not on the reason's last line: a multi-line reason would make the hint read as part of the quoted error.
  if (s.error && s.status !== 'posted' && s.fileIds.length) out.push(t.reupload);
  if (s.postId) {
    out.push(`post_id: ${s.postId}`);
    const team = s.status === 'posted' ? await teamOf(s.channelId) : undefined;
    if (team !== undefined) out.push(`${baseUrl}/${team}/pl/${s.postId}`);
  }
  // Not in the middle as in the list: the body may span lines, and last is the only place where it ends unambiguously.
  // Not pointing a schedule that is no longer pending to update or cancel: both refuse it.
  if (full) out.push(s.message !== undefined ? t.bodyToEnd(s.message)
    : s.status === 'pending' ? t.bodyUndecryptablePending
      : t.bodyUndecryptable);
  return out;
}

const updateArgs = () => {
  const unchangeable = msg().schedule.unchangeable;
  return strictArgs({ id: idArgOf(), message: MESSAGE.optional().describe(msg().descriptions.updateMessage), at: at().optional() },
    { file_ids: unchangeable, files: unchangeable, channel: unchangeable, root_id: unchangeable });
};

export function updateScheduledMessage(store: Store, uid: string, args: { id: string; message?: string; at?: string }): CallToolResult {
  if (args.message === undefined && args.at === undefined) throw new InputError(msg().schedule.specifyOne);
  const at = args.at === undefined ? undefined : when(args.at);
  const s = store.updateScheduled(uid, args.id, { message: args.message, scheduledAt: at }, Date.now());
  if (!s) throw new InputError(msg().schedule.notChangeable);
  const t = msg().schedule;
  return text([t.updated, t.idLine(s.id), t.time(formatTime(s.scheduledAt)), ...(args.message === undefined ? [] : [t.checkBody])].join('\n'));
}

export function cancelScheduledMessage(store: Store, uid: string, args: { id: string }): CallToolResult {
  if (!store.cancelScheduled(uid, args.id)) throw new InputError(msg().schedule.notChangeable);
  return text(`${msg().schedule.cancelled}\n${msg().schedule.idLine(args.id)}`);
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });
  const scheduleSchema = scheduleArgs();
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('schedule_message', {
    description: msg().descriptions.scheduleMessage,
    inputSchema: scheduleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'schedule_message', async (args: ScheduleArgs, extra: { signal: AbortSignal }) => scheduleMessage(mmOf(extra.signal), ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof scheduleSchema>);

  const listSchema = {
    id: idArgOf().optional().describe(msg().descriptions.listScheduledId),
    status: z.enum(STATUSES).optional(),
    limit: limitArg(20, 50),
    cursor: cursorArg(),
  };
  server.registerTool('list_scheduled_messages', {
    description: msg().descriptions.listScheduled,
    inputSchema: listSchema,
    annotations: { readOnlyHint: true },
  }, guarded(ctx, 'list_scheduled_messages', async (args: ListArgs, extra: { signal: AbortSignal }) =>
    listScheduledMessages(mmOf(extra.signal), ctx.store, uid, ctx.cfg.mmBrowserUrl, args),
  ) as unknown as ToolCallback<typeof listSchema>);

  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  const updateSchema = updateArgs();
  server.registerTool('update_scheduled_message', {
    description: msg().descriptions.updateScheduled,
    inputSchema: updateSchema,
    annotations: destructive,
  }, guarded(ctx, 'update_scheduled_message', async (args: { id: string; message?: string; at?: string }) => updateScheduledMessage(ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof updateSchema>);

  const cancelSchema = { id: idArgOf() };
  server.registerTool('cancel_scheduled_message', {
    description: msg().descriptions.cancelScheduled,
    inputSchema: cancelSchema,
    annotations: destructive,
  }, guarded(ctx, 'cancel_scheduled_message', async (args: { id: string }) => cancelScheduledMessage(ctx.store, uid, args),
  ) as unknown as ToolCallback<typeof cancelSchema>);
}

import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { msg } from '../i18n/index.ts';
import { formatTime, InputError } from './format.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { presenceName } from './tools-read.ts';
import { worded, type Wording } from './tools-send.ts';
import { parseWhen, whenForm } from './when.ts';

const MIN_AHEAD = 60_000;
const STATUSES = ['online', 'away', 'dnd', 'offline'] as const;
type Status = (typeof STATUSES)[number];
const disabled = (): Wording => ({ id: [[501, 'api.custom_status.disabled', msg().status.customDisabled]] });

function future(s: string, name: string): number {
  const ms = parseWhen(s, name);
  // Not leaving the lower bound to Mattermost: it floors the DND end to the minute and checks expiry on its own clock.
  if (ms < Date.now() + MIN_AHEAD) throw new InputError(msg().status.tooSoon(name, formatTime(ms)));
  return ms;
}

type StatusArgs = { status: Status; dnd_until?: string };

export async function setStatus(mm: Mm, uid: string, args: StatusArgs): Promise<CallToolResult> {
  if (args.dnd_until !== undefined && args.status !== 'dnd') throw new InputError(msg().status.dndUntilOnly);
  const end = args.dnd_until === undefined ? 0 : Math.floor(future(args.dnd_until, 'dnd_until') / 1000);
  const s = await worded(mm.call<{ status: string; dnd_end_time: number }>(uid, 'PUT', `/users/${uid}/status`, { user_id: uid, status: args.status, dnd_end_time: end }), {
    // With user statuses disabled, Mattermost skips the change and then fails to read the status back.
    id: [[404, 'api.status.user_not_found.app_error', msg().status.presenceDisabled]],
  });
  const until = s.status !== 'dnd' ? '' : s.dnd_end_time > 0 ? msg().read.presenceDndEnd(formatTime(s.dnd_end_time * 1000)) : msg().status.noEnd;
  return text(msg().status.statusChanged(presenceName(s.status), until, s.status === 'online'));
}

type CustomArgs = { emoji?: string; text?: string; until?: string };

export async function setCustomStatus(mm: Mm, uid: string, args: CustomArgs): Promise<CallToolResult> {
  // Not checking the name's characters as add_reaction does: it goes into the body, not a path, and Mattermost rejects unknown names itself.
  const emoji = args.emoji?.trim().replace(/^:/, '').replace(/:$/, '').trim() ?? '';
  const message = args.text?.trim() ?? '';
  if (!emoji && !message) throw new InputError(msg().status.needEmojiOrText);
  const until = args.until === undefined ? undefined : future(args.until, 'until');
  await worded(mm.call(uid, 'PUT', `/users/${uid}/status/custom`, {
    emoji, text: message, duration: until ? 'date_and_time' : '', ...(until ? { expires_at: new Date(until).toISOString() } : {}),
  }), {
    id: [
      [400, 'api.custom_status.set_custom_statuses.emoji_not_found',
        msg().status.emojiNotFound(emoji)],
      ...disabled().id!,
    ],
  });
  return text(msg().status.customSet(emoji, message, until ? formatTime(until) : undefined));
}

export async function clearCustomStatus(mm: Mm, uid: string): Promise<CallToolResult> {
  await worded(mm.call(uid, 'DELETE', `/users/${uid}/status/custom`), disabled());
  return text(msg().status.customCleared);
}

export function registerStatusTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });

  const statusSchema = {
    status: z.enum(STATUSES),
    dnd_until: z.string().optional().describe(msg().descriptions.dndUntil(whenForm())),
  };
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('set_status', {
    description: msg().descriptions.setStatus,
    inputSchema: statusSchema,
    // Destructive: leaving ooo turns off the auto-responder, which no tool here turns back on.
    // Not idempotent: setting dnd again makes dnd the status it returns to when it ends.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, guarded(ctx, 'set_status', async (args: StatusArgs, extra: { signal: AbortSignal }) => setStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof statusSchema>);

  const replaces = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  const customSchema = {
    emoji: z.string().min(1).max(100).optional().describe(msg().descriptions.customEmoji),
    text: z.string().min(1).max(100).optional(),
    until: z.string().optional().describe(msg().descriptions.customUntil(whenForm())),
  };
  server.registerTool('set_custom_status', {
    description: msg().descriptions.setCustomStatus,
    inputSchema: customSchema,
    annotations: replaces,
  }, guarded(ctx, 'set_custom_status', async (args: CustomArgs, extra: { signal: AbortSignal }) => setCustomStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof customSchema>);

  server.registerTool('clear_custom_status', {
    description: msg().descriptions.clearCustomStatus,
    inputSchema: {},
    annotations: replaces,
  }, guarded(ctx, 'clear_custom_status', async (_args: Record<string, never>, extra: { signal: AbortSignal }) => clearCustomStatus(mmOf(extra.signal), uid),
  ) as unknown as ToolCallback<{}>);
}

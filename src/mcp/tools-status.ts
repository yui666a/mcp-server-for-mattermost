import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatTime, InputError } from './format.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { PRESENCE } from './tools-read.ts';
import { worded, type Wording } from './tools-send.ts';
import { parseWhen } from './when.ts';

const MIN_AHEAD = 60_000;
const STATUSES = ['online', 'away', 'dnd', 'offline'] as const;
type Status = (typeof STATUSES)[number];
const DISABLED: Wording = { id: [[501, 'api.custom_status.disabled', 'この Mattermost ではカスタムステータスが無効です。']] };
const TIME = ', YYYY-MM-DDTHH:mm (JST if no offset)';

function future(s: string, name: string): number {
  const ms = parseWhen(s, name);
  // Not leaving the lower bound to Mattermost: it floors the DND end to the minute and checks expiry on its own clock.
  if (ms < Date.now() + MIN_AHEAD) throw new InputError(`${name} は今から 1 分後以降の時刻にしてください。指定された時刻: ${formatTime(ms)}`);
  return ms;
}

type StatusArgs = { status: Status; dnd_until?: string };

export async function setStatus(mm: Mm, uid: string, args: StatusArgs): Promise<CallToolResult> {
  if (args.dnd_until !== undefined && args.status !== 'dnd') throw new InputError('dnd_until は status が dnd のときだけ指定できます。');
  const end = args.dnd_until === undefined ? 0 : Math.floor(future(args.dnd_until, 'dnd_until') / 1000);
  const s = await worded(mm.call<{ status: string; dnd_end_time: number }>(uid, 'PUT', `/users/${uid}/status`, { user_id: uid, status: args.status, dnd_end_time: end }), {
    // With user statuses disabled, Mattermost skips the change and then fails to read the status back.
    id: [[404, 'api.status.user_not_found.app_error', 'この Mattermost では在席状況の機能が無効なため、在席状況を変えられません。']],
  });
  const until = s.status !== 'dnd' ? '' : s.dnd_end_time > 0 ? `（終了: ${formatTime(s.dnd_end_time * 1000)}）` : '（終了時刻なし）';
  return text(`在席状況を「${PRESENCE[s.status]}」${until}にしました。${s.status === 'online' ? '手動の設定を外し、自動の判定に戻りました。' : ''}`);
}

type CustomArgs = { emoji?: string; text?: string; until?: string };

export async function setCustomStatus(mm: Mm, uid: string, args: CustomArgs): Promise<CallToolResult> {
  // Not checking the name's characters as add_reaction does: it goes into the body, not a path, and Mattermost rejects unknown names itself.
  const emoji = args.emoji?.trim().replace(/^:/, '').replace(/:$/, '').trim() ?? '';
  const message = args.text?.trim() ?? '';
  if (!emoji && !message) throw new InputError('emoji か text のどちらかを指定してください。');
  const until = args.until === undefined ? undefined : future(args.until, 'until');
  await worded(mm.call(uid, 'PUT', `/users/${uid}/status/custom`, {
    emoji, text: message, duration: until ? 'date_and_time' : '', ...(until ? { expires_at: new Date(until).toISOString() } : {}),
  }), {
    id: [
      [400, 'api.custom_status.set_custom_statuses.emoji_not_found',
        `絵文字「${emoji}」がありません。標準の絵文字名（例: calendar、palm_tree）か、search_emoji で調べたカスタム絵文字名を指定してください。`],
      ...DISABLED.id!,
    ],
  });
  return text([
    'カスタムステータスを設定しました。',
    `絵文字: ${emoji ? `:${emoji}:` : 'なし'}`,
    `文言: ${message || 'なし'}`,
    `期限: ${until ? formatTime(until) : '期限なし'}`,
  ].join('\n'));
}

export async function clearCustomStatus(mm: Mm, uid: string): Promise<CallToolResult> {
  await worded(mm.call(uid, 'DELETE', `/users/${uid}/status/custom`), DISABLED);
  return text('カスタムステータスを消しました。');
}

export function registerStatusTools(server: McpServer, ctx: ToolContext): void {
  const uid = ctx.mmUserId;
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });

  const statusSchema = {
    status: z.enum(STATUSES),
    dnd_until: z.string().optional().describe(`End of dnd${TIME}. Omit to stay dnd until changed.`),
  };
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('set_status', {
    description: 'Change your availability. When dnd ends, the previous status returns; if you set dnd while already dnd, it returns to dnd. online clears the manual setting and returns to automatic. Out of office cannot be set, and changing the status while out of office stops the auto-reply.',
    inputSchema: statusSchema,
    // Destructive: leaving ooo turns off the auto-responder, which no tool here turns back on.
    // Not idempotent: setting dnd again makes dnd the status it returns to when it ends.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, guarded(ctx, 'set_status', async (args: StatusArgs, extra: { signal: AbortSignal }) => setStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof statusSchema>);

  const replaces = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  const customSchema = {
    emoji: z.string().min(1).max(100).optional().describe('Emoji name (e.g. calendar). Look up custom emoji names with search_emoji.'),
    text: z.string().min(1).max(100).optional(),
    until: z.string().optional().describe(`Expiry${TIME}. Omit for no expiry.`),
  };
  server.registerTool('set_custom_status', {
    description: 'Set your custom status (emoji and text). Replaces the whole current status: passing only emoji clears the text. Needs emoji or text.',
    inputSchema: customSchema,
    annotations: replaces,
  }, guarded(ctx, 'set_custom_status', async (args: CustomArgs, extra: { signal: AbortSignal }) => setCustomStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof customSchema>);

  server.registerTool('clear_custom_status', {
    description: 'Clear your custom status.',
    inputSchema: {},
    annotations: replaces,
  }, guarded(ctx, 'clear_custom_status', async (_args: Record<string, never>, extra: { signal: AbortSignal }) => clearCustomStatus(mmOf(extra.signal), uid),
  ) as unknown as ToolCallback<{}>);
}

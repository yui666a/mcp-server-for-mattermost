import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatTime, InputError } from './format.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { PRESENCE } from './tools-read.ts';
import { worded, type Wording } from './tools-send.ts';
import { parseWhen } from './when.ts';

const MIN_AHEAD = 60_000;
const STATUSES = ['online', 'away', 'dnd', 'offline'] as const;
type Status = (typeof STATUSES)[number];
const DISABLED: Wording = { id: [[501, 'api.custom_status.disabled', 'この Mattermost ではカスタムステータスが無効です。']] };
const TIME = '。ISO 8601 の YYYY-MM-DDTHH:mm（秒は任意）。タイムゾーン（Z、+09:00 など）が無ければ JST。今から 1 分後以降';

function future(s: string, name: string): number {
  let ms: number;
  try {
    ms = parseWhen(s);
  } catch (e) {
    // Rewording rather than letting the error through: parseWhen names the argument `at`, which these tools do not have.
    if (e instanceof InputError) throw new InputError(e.message.replace(/^at「/, `${name}「`));
    throw e;
  }
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
  const emoji = args.emoji?.trim().replace(/^:/, '').replace(/:$/, '') ?? '';
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
    status: z.enum(STATUSES).describe('online: オンライン、away: 離席、dnd: 取り込み中、offline: オフライン'),
    dnd_until: z.string().optional().describe(`dnd の終了時刻（status が dnd のときだけ）${TIME}。省略すると自分で変えるまで dnd のまま`),
  };
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('set_status', {
    description: '自分の在席状況を変える。dnd は終了時刻を指定でき、過ぎると dnd にする前の在席状況に戻る（既に dnd のときに設定すると dnd のまま）。Mattermost は終了時刻を分に切り捨てる。online にすると手動の設定を外し、自動の判定に戻る。他人の在席状況は変えられない。不在（ooo）は設定できず、不在のときに変えると自動返信が止まる',
    inputSchema: statusSchema,
    // Destructive: leaving ooo turns off the auto-responder, which no tool here turns back on.
    // Not idempotent: setting dnd again makes dnd the status it returns to when it ends.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, guarded(ctx, 'set_status', async (args: StatusArgs, extra: { signal: AbortSignal }) => setStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof statusSchema>);

  const replaces = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  const customSchema = {
    emoji: z.string().min(1).max(100).optional().describe('絵文字名（例: calendar、palm_tree）。前後のコロンは付けても付けなくてもよい。カスタム絵文字の名前は search_emoji で調べる'),
    text: z.string().min(1).max(100).optional().describe('文言（100 文字まで）'),
    until: z.string().optional().describe(`期限${TIME}。省略すると期限なし`),
  };
  server.registerTool('set_custom_status', {
    description: '自分のカスタムステータス（絵文字と文言）を設定する。今のカスタムステータスは置き換わる。emoji か text の少なくとも一方が要る。期限を過ぎると Mattermost の画面に出なくなる',
    inputSchema: customSchema,
    annotations: replaces,
  }, guarded(ctx, 'set_custom_status', async (args: CustomArgs, extra: { signal: AbortSignal }) => setCustomStatus(mmOf(extra.signal), uid, args),
  ) as unknown as ToolCallback<typeof customSchema>);

  server.registerTool('clear_custom_status', {
    description: '自分のカスタムステータスを消す。設定されていなくても成功する',
    inputSchema: {},
    annotations: replaces,
  }, guarded(ctx, 'clear_custom_status', async (_args: Record<string, never>, extra: { signal: AbortSignal }) => clearCustomStatus(mmOf(extra.signal), uid),
  ) as unknown as ToolCallback<{}>);
}

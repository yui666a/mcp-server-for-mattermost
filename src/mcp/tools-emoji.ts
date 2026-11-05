import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { InputError } from './format.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';
import { worded } from './tools-send.ts';

// Mattermost's fixed cap for /emoji/search (web.PerPageMaximum); the endpoint takes no page, so a full page cannot be continued.
const SEARCH_MAX = 200;

export async function searchEmoji(mm: Mm, uid: string, args: { name: string }): Promise<CallToolResult> {
  // Not lowercasing: names made through the API may contain capitals, and Mattermost matches case-sensitively.
  const term = args.name.trim().replace(/^:/, '').replace(/:$/, '').trim();
  if (!term) throw new InputError('name に絵文字名の一部を指定してください。');
  if (term.length > 64) throw new InputError('name は 64 文字までにしてください（絵文字名の上限）。');
  const found = await worded(mm.call<{ name: string }[]>(uid, 'POST', '/emoji/search', { term, prefix_only: false }), {
    id: [[403, 'api.emoji.disabled.app_error', 'この Mattermost ではカスタム絵文字が無効です。']],
  });
  if (!found.length) return text(`「${term}」を名前に含むカスタム絵文字はありません。標準の絵文字は対象外です。`);
  return text([
    ...found.map((e) => `:${e.name}:`),
    ...(found.length >= SEARCH_MAX ? [`（${SEARCH_MAX} 件までを出しました。名前をもっと絞ってください）`] : []),
  ].join('\n'));
}

export function registerEmojiTools(server: McpServer, ctx: ToolContext): void {
  const schema = { name: z.string().min(1).max(100).describe('探す絵文字名の一部（例: party）。前後のコロンは付けても付けなくてもよい。大文字と小文字は区別する') };
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('search_emoji', {
    description: `add_reaction や set_custom_status に渡すカスタム絵文字の名前を、名前の一部で探す。名前の順に最大 ${SEARCH_MAX} 件。標準の絵文字（white_check_mark、+1 など）は含まない`,
    inputSchema: schema,
    annotations: { readOnlyHint: true },
  }, guarded(ctx, 'search_emoji', async (args: { name: string }, extra: { signal: AbortSignal }) =>
    searchEmoji({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) }, ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof schema>);
}

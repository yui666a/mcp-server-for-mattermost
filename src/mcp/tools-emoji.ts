import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { msg } from '../i18n/index.ts';
import { InputError } from './format.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { worded } from './tools-send.ts';

// Mattermost's fixed cap for /emoji/search (web.PerPageMaximum); the endpoint takes no page, so a full page cannot be continued.
const SEARCH_MAX = 200;

export async function searchEmoji(mm: Mm, uid: string, args: { name: string }): Promise<CallToolResult> {
  // Not lowercasing: names made through the API may contain capitals, and Mattermost matches case-sensitively.
  const term = args.name.trim().replace(/^:/, '').replace(/:$/, '').trim();
  if (!term) throw new InputError(msg().emoji.nameEmpty);
  if (term.length > 64) throw new InputError(msg().emoji.nameTooLong);
  const found = await worded(mm.call<{ name: string }[]>(uid, 'POST', '/emoji/search', { term, prefix_only: false }), {
    id: [[403, 'api.emoji.disabled.app_error', msg().emoji.disabled]],
  });
  if (!found.length) return text(msg().emoji.noneFound(term));
  return text([
    ...found.map((e) => `:${e.name}:`),
    ...(found.length >= SEARCH_MAX ? [msg().emoji.capped(SEARCH_MAX)] : []),
  ].join('\n'));
}

export function registerEmojiTools(server: McpServer, ctx: ToolContext): void {
  const schema = { name: z.string().min(1).max(100).describe(msg().descriptions.emojiName) };
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for these shapes.
  server.registerTool('search_emoji', {
    description: msg().descriptions.searchEmoji,
    inputSchema: schema,
    annotations: { readOnlyHint: true },
  }, guarded(ctx, 'search_emoji', async (args: { name: string }, extra: { signal: AbortSignal }) =>
    searchEmoji({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) }, ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof schema>);
}

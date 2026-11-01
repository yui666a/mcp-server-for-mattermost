import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import type { Store } from '../store.ts';
import { InputError } from './format.ts';
import { registerReadTools } from './tools-read.ts';
import { registerScheduleTools } from './tools-schedule.ts';
import { registerSendTools } from './tools-send.ts';

export type ToolContext = { mm: MmClient; mmUserId: string; cfg: Config; store: Store };

export const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

// SDK's Streamable HTTP has already committed 200 by the time a tool runs, so failures surface as tool results.
function failure(e: unknown): { outcome: string; result: CallToolResult } {
  if (e instanceof InputError) return { outcome: 'input_error', result: text(e.message, true) };
  if (e instanceof Reauthorize) {
    return { outcome: 'reauthorize', result: text('Mattermost への再ログインが必要です。コネクタを再接続してください。', true) };
  }
  if (e instanceof RateLimited) {
    return { outcome: 'rate_limited', result: text(`呼び出しが多すぎます。${e.retryAfterSec} 秒後に再試行してください。`, true) };
  }
  if (e instanceof UpstreamUnavailable) {
    return { outcome: 'upstream_unavailable', result: text('Mattermost に一時的に接続できません。しばらくしてから再試行してください。', true) };
  }
  if (e instanceof MmError) {
    return { outcome: 'mm_error', result: text(`Mattermost がエラーを返しました（${e.status}）: ${e.message}`, true) };
  }
  log('tool_unhandled_error', { name: (e as Error)?.name });
  return { outcome: 'error', result: text('ツールの実行中に予期しないエラーが発生しました。', true) };
}

export function guarded<A extends unknown[]>(ctx: ToolContext, tool: string, fn: (...args: A) => Promise<CallToolResult>) {
  return async (...args: A): Promise<CallToolResult> => {
    const started = Date.now();
    let outcome = 'ok';
    try {
      const r = await fn(...args);
      if (r.isError) outcome = 'tool_error';
      return r;
    } catch (e) {
      const f = failure(e);
      outcome = f.outcome;
      return f.result;
    } finally {
      log('tool_call', { mm_user_id: ctx.mmUserId, tool, outcome, ms: Date.now() - started });
    }
  };
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'mattermost-mcp', version: '0.1.0' });
  registerReadTools(server, ctx);
  registerSendTools(server, ctx);
  registerScheduleTools(server, ctx);
  return server;
}

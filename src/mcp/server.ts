import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import type { Store } from '../store.ts';
import { InputError } from './format.ts';
import { registerMarkReadTool } from './mark-read.ts';
import { registerReadTools } from './tools-read.ts';
import { registerSavePinTools } from './tools-save-pin.ts';
import { registerScheduleTools } from './tools-schedule.ts';
import { registerSendTools } from './tools-send.ts';

export type ToolContext = { mm: MmClient; mmUserId: string; cfg: Config; store: Store };

export const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

const UNEXPECTED = 'ツールの実行中に予期しないエラーが発生しました。';

function classify(e: unknown): [outcome: string, text: string] | undefined {
  if (e instanceof InputError) return ['input_error', e.message];
  if (e instanceof Reauthorize) return ['reauthorize', 'Mattermost への再ログインが必要です。コネクタを再接続してください。'];
  if (e instanceof RateLimited) return ['rate_limited', `呼び出しが多すぎます。${e.retryAfterSec} 秒後に再試行してください。`];
  if (e instanceof UpstreamUnavailable) return ['upstream_unavailable', 'Mattermost に一時的に接続できません。しばらくしてから再試行してください。'];
  if (e instanceof MmError) return ['mm_error', `Mattermost がエラーを返しました（${e.status}）: ${e.message}`];
  return undefined;
}

export const failureText = (e: unknown): string => classify(e)?.[1] ?? UNEXPECTED;

// SDK's Streamable HTTP has already committed 200 by the time a tool runs, so failures surface as tool results.
export function failure(e: unknown): { outcome: string; result: CallToolResult } {
  const c = classify(e);
  if (!c) log('tool_unhandled_error', { name: (e as Error)?.name });
  const [outcome, t] = c ?? ['error', UNEXPECTED];
  return { outcome, result: text(t, true) };
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
  const server = new McpServer({ name: 'mcp-server-for-mattermost', version: '0.1.0' });
  registerReadTools(server, ctx);
  registerSendTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerMarkReadTool(server, ctx);
  registerSavePinTools(server, ctx);
  return server;
}

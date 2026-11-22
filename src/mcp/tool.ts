import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable, type MmClient } from '../mattermost/client.ts';
import type { Store } from '../store.ts';
import { msg } from '../i18n/index.ts';
import { InputError } from './format.ts';

// Apart from server.ts: the tool modules (and post.ts and upload.ts) use these, and server.ts imports every tool module to register it.
export type ToolContext = { mm: MmClient; mmUserId: string; cfg: Config; store: Store };

export const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

function classify(e: unknown): [outcome: string, text: string] | undefined {
  if (e instanceof InputError) return ['input_error', e.message];
  if (e instanceof Reauthorize) return ['reauthorize', msg().common.reauthorize];
  if (e instanceof RateLimited) return ['rate_limited', msg().common.rateLimited(e.retryAfterSec)];
  if (e instanceof UpstreamUnavailable) return ['upstream_unavailable', msg().common.upstreamUnavailable];
  // Not a bare colon when Mattermost sends no message: the sentence would end in ": " in lines that go on after it.
  if (e instanceof MmError) return ['mm_error', e.message.trim() ? msg().common.mmErrorWith(e.status, e.message) : msg().common.mmError(e.status)];
  return undefined;
}

export const failureText = (e: unknown): string => classify(e)?.[1] ?? msg().common.unexpected;

// SDK's Streamable HTTP has already committed 200 by the time a tool runs, so failures surface as tool results.
export function failure(e: unknown): { outcome: string; result: CallToolResult } {
  const c = classify(e);
  if (!c) log('tool_unhandled_error', { name: (e as Error)?.name });
  const [outcome, t] = c ?? ['error', msg().common.unexpected];
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

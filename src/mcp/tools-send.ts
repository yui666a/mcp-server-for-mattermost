import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomToken, sha256 } from '../crypto.ts';
import { MmError, RateLimited } from '../mattermost/client.ts';
import type { Store } from '../store.ts';
import { InputError, type MmPost } from './format.ts';
import { resolveChannel, type Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';

type Args = { channel: string; message: string; root_id?: string; allow_duplicate?: boolean };
type PostList = { order: string[]; posts: Record<string, MmPost & { delete_at?: number }> };

const inputSchema = {
  channel: z.string().min(1),
  message: z.string().min(1),
  root_id: z.string().regex(/^[A-Za-z0-9]{26}$/).optional().describe('返信先のスレッドの親投稿の post_id'),
  allow_duplicate: z.boolean().optional().describe('同じ本文を意図して繰り返し投稿するときに true'),
};

export async function sendMessage(mm: Mm, store: Store, uid: string, baseUrl: string, args: Args): Promise<CallToolResult> {
  const ch = await resolveChannel(mm, uid, args.channel);
  const rootId = args.root_id;
  if (rootId) {
    const root = await mm.call<MmPost>(uid, 'GET', `/posts/${rootId}`);
    if (root.channel_id !== ch.id) throw new InputError(`root_id ${rootId} の投稿はチャンネル「${ch.name}」にありません。`);
  }
  const where = `チャンネル: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${rootId ? `、返信先 post_id: ${rootId}` : ''}`;
  const done = (postId: string, note: string) => text([note, `post_id: ${postId}`, where, `${baseUrl}/${ch.teamName}/pl/${postId}`].join('\n'));
  const body = { channel_id: ch.id, message: args.message, ...(rootId ? { root_id: rootId } : {}) };

  if (args.allow_duplicate) return done((await mm.call<MmPost>(uid, 'POST', '/posts', { ...body, pending_post_id: randomToken() })).id, '投稿しました。');

  const claim = store.claimPost({ mmUserId: uid, channelId: ch.id, rootId, bodyHash: sha256(args.message) });
  if (claim.kind === 'done') return done(claim.postId, '同じ本文を直前に投稿済みのため、やり直しとみなして投稿していません。');
  if (claim.kind === 'inflight') {
    return text('同じ投稿を処理中です。少し待ってから read_channel などで投稿されたかを確かめてください。', true);
  }
  if (claim.kind === 'retry') {
    // Not dropping the claim if this lookup fails: the earlier attempt's outcome is still unknown.
    const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?since=${claim.createdAt - 1}`);
    const prev = Object.values(r.posts).find((p) =>
      p.user_id === uid && (p.root_id || undefined) === rootId && p.message === args.message && !p.delete_at && p.create_at >= claim.createdAt);
    if (prev) {
      store.completePost(claim.id, prev.id);
      return done(prev.id, '同じ本文の投稿が既にあったため、やり直しとみなして投稿していません。');
    }
  }
  let post: MmPost;
  try {
    post = await mm.call<MmPost>(uid, 'POST', '/posts', { ...body, pending_post_id: claim.pendingPostId });
  } catch (e) {
    if (e instanceof MmError || e instanceof RateLimited || (e as { sent?: boolean })?.sent === false) store.dropPost(claim.id, claim.claimedAt);
    throw e;
  }
  store.completePost(claim.id, post.id);
  return done(post.id, '投稿しました。');
}

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('send_message', {
    description: 'チャンネルへ投稿する。root_id を渡すとスレッドへの返信になる。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか。同じ投稿先へ同じ本文を 10 分以内に送ると、やり直しとみなして投稿しない',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'send_message', async (args: Args, extra: { signal: AbortSignal }) => {
    const mm: Mm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) };
    return sendMessage(mm, ctx.store, ctx.mmUserId, ctx.cfg.mmBrowserUrl, args);
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for this shape.
  }) as unknown as ToolCallback<typeof inputSchema>);
}

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

type Wording = { id?: [status: number, id: string, text: string][]; status?: [status: number, text: string][] };

// Not matching on status first: one status (403, 404) covers causes that need different wording, told apart only by the id.
// Not matching on the id alone: Mattermost reuses an id across statuses (app.post.get.app_error is also a 400 from UpdatePost and DeletePost).
// Not an object keyed by id: an id such as "constructor" would hit Object.prototype.
async function worded<T>(p: Promise<T>, w: Wording): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const m = e instanceof MmError
      ? (w.id?.find(([s, id]) => s === e.status && id === e.id)?.[2] ?? w.status?.find(([s]) => s === e.status)?.[1])
      : undefined;
    throw m ? new InputError(m) : e;
  }
}

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/);
const reactionSchema = {
  post_id: POST_ID.describe('投稿の post_id'),
  // Not a zod regex: a Unicode emoji such as ✅ would get the SDK's generic validation error instead of the emoji-name hint.
  emoji: z.string().min(1).max(100).describe('Mattermost の絵文字名（例: white_check_mark、+1）。前後のコロンは付けても付けなくてもよい'),
};
type ReactionArgs = { post_id: string; emoji: string };

const emojiHint = (name: string) => `絵文字「${name}」がありません。Mattermost の絵文字名で指定してください（例: white_check_mark、+1）。`;
// Checked rather than encoded: the name goes into a path, where "." and ".." survive encoding and fetch would normalise them into another endpoint.
function emojiName(raw: string): string {
  const name = raw.trim().replace(/^:/, '').replace(/:$/, '');
  if (!/^[A-Za-z0-9_+-]{1,64}$/.test(name)) throw new InputError(emojiHint(name));
  return name;
}
const reactionWording = (name: string, archived: string): Wording => ({
  id: [
    [404, 'app.emoji.get_by_name.no_result', emojiHint(name)],
    [404, 'app.post.get.app_error', '投稿が見つかりません（削除されたか、存在しません）。'],
    [403, archived, 'アーカイブ済みのチャンネルの投稿のリアクションは変えられません。'],
  ],
  status: [[403, 'この投稿にリアクションできません（見られない投稿、存在しない投稿、アーカイブ済みチャンネルの投稿）。']],
});

export async function addReaction(mm: Mm, uid: string, args: ReactionArgs): Promise<CallToolResult> {
  const name = emojiName(args.emoji);
  await worded(mm.call(uid, 'POST', '/reactions', { user_id: uid, post_id: args.post_id, emoji_name: name }),
    reactionWording(name, 'api.reaction.save.archived_channel.app_error'));
  return text(`リアクション :${name}: を付けました。\npost_id: ${args.post_id}`);
}

export async function removeReaction(mm: Mm, uid: string, args: ReactionArgs): Promise<CallToolResult> {
  const name = emojiName(args.emoji);
  // Not reporting whether a reaction was there: Mattermost answers 200 either way, even for an unknown emoji name.
  await worded(mm.call(uid, 'DELETE', `/users/${uid}/posts/${args.post_id}/reactions/${name}`),
    reactionWording(name, 'api.reaction.delete.archived_channel.app_error'));
  return text(`リアクション :${name}: が付いていれば外しました。\npost_id: ${args.post_id}`);
}

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });
  const reactionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  server.registerTool('add_reaction', {
    description: '投稿に自分のリアクション（絵文字）を付ける。「確認しました」の意味で white_check_mark を付けるなど、本文を投稿するより軽い返事に使う。付いていても成功する',
    inputSchema: reactionSchema,
    annotations: reactionAnnotations,
  }, guarded(ctx, 'add_reaction', async (args: ReactionArgs, extra: { signal: AbortSignal }) => addReaction(mmOf(extra.signal), ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof reactionSchema>);
  server.registerTool('remove_reaction', {
    description: '投稿から自分が付けたリアクションを外す。他人のリアクションは外さない。付いていなくても成功する',
    inputSchema: reactionSchema,
    annotations: reactionAnnotations,
  }, guarded(ctx, 'remove_reaction', async (args: ReactionArgs, extra: { signal: AbortSignal }) => removeReaction(mmOf(extra.signal), ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof reactionSchema>);

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

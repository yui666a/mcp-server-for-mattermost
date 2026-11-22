import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { idArg } from './args.ts';
import { msg } from '../i18n/index.ts';
import type { Mm } from './resolve.ts';
import { guarded, text, type ToolContext } from './tool.ts';
import { worded, type Wording } from './tools-send.ts';

const POST_ID = idArg;
const schema = { post_id: POST_ID };
type Args = { post_id: string };

const GONE = '投稿が見つかりません（削除されたか、存在しません）。';
const PERMISSION = 'api.context.permissions.app_error';
// A getter rather than a constant: the text is looked up when the error happens, in the locale then set.
export const POST_WORDING: Wording = { id: [[404, 'app.post.get.app_error', GONE]], get status(): [number, string][] { return [[403, msg().common.postForbidden]]; } };

// Not leaving the membership to Mattermost: it saves and pins posts of public channels the user has not joined,
// and such a saved post never shows in list_saved_posts.
async function readPost(mm: Mm, uid: string, postId: string, notMember: string): Promise<{ channel_id: string; is_pinned?: boolean }> {
  const post = await worded(mm.call<{ channel_id: string; is_pinned?: boolean }>(uid, 'GET', `/posts/${postId}`), POST_WORDING);
  // Not saying a 403 means not joined: Mattermost also answers 403 when its permission check fails on a transient error.
  await worded(mm.call(uid, 'GET', `/channels/${post.channel_id}/members/me`), {
    status: [[403, `このチャンネルに参加しているかを確かめられませんでした（参加していないか、Mattermost の一時的な障害）。${notMember}${msg().common.retrySoon}${msg().common.askAdmin}`], [404, notMember]],
  });
  return post;
}

async function savePost(mm: Mm, uid: string, args: Args): Promise<CallToolResult> {
  await readPost(mm, uid, args.post_id, '参加していないチャンネルの投稿は保存できません。');
  await worded(mm.call(uid, 'PUT', `/users/${uid}/preferences`, [{ user_id: uid, category: 'flagged_post', name: args.post_id, value: 'true' }]), {
    id: [[400, 'api.context.invalid_body_param.app_error', GONE], [403, PERMISSION, msg().common.postForbidden]],
  });
  return text(`投稿を保存しました。list_saved_posts で一覧できます。\npost_id: ${args.post_id}`);
}

async function unsavePost(mm: Mm, uid: string, args: Args): Promise<CallToolResult> {
  // Not reading the post first: a save left behind after leaving the channel has to be removable too.
  await mm.call(uid, 'POST', `/users/${uid}/preferences/delete`, [{ user_id: uid, category: 'flagged_post', name: args.post_id, value: 'true' }]);
  return text(`投稿を保存していれば、保存した投稿から外しました。\npost_id: ${args.post_id}`);
}

const pinWording: Wording = {
  id: [
    [400, 'api.post.update_post.system_message.app_error', 'システムメッセージはピン留めできません。'],
    [400, 'api.post.patch_post.can_not_update_post_in_deleted.error', 'アーカイブ済みのチャンネルの投稿のピン留めは変えられません。'],
    [400, 'api.post.update_post.permissions_time_limit.app_error', 'このサーバーでは、投稿から時間が経った投稿のピン留めは変えられません（編集の期限の設定による）。'],
  ],
  get status(): [number, string][] { return [[403, `この投稿のピン留めを変えられません（投稿を確かめた直後に削除されたか、見る権限が無くなったか、Mattermost の一時的な障害）。削除されたなら、変えるものはありません。${msg().common.retrySoon}${msg().common.askAdmin}`]]; },
};

async function setPinned(mm: Mm, uid: string, args: Args, pinned: boolean): Promise<CallToolResult> {
  const post = await readPost(mm, uid, args.post_id, pinned ? '参加していないチャンネルの投稿はピン留めできません。' : '参加していないチャンネルの投稿のピン留めは外せません。');
  await worded(mm.call(uid, 'POST', `/posts/${args.post_id}/${pinned ? 'pin' : 'unpin'}`), pinWording);
  const was = Boolean(post.is_pinned);
  const head = pinned
    ? (was ? '投稿は既にピン留めされています。' : '投稿をピン留めしました。')
    : (was ? '投稿のピン留めを外しました。' : '投稿はピン留めされていません。');
  return text(`${head}\npost_id: ${args.post_id}\nchannel_id: ${post.channel_id}`);
}

export function registerSavePinTools(server: McpServer, ctx: ToolContext): void {
  const mmOf = (signal: AbortSignal): Mm => ({ call: (u, m, p, b) => ctx.mm.call(u, m, p, b, signal) });
  const tools: [name: string, description: string, fn: (mm: Mm, uid: string, args: Args) => Promise<CallToolResult>][] = [
    ['save_post', 'Add a post to your saved posts.', savePost],
    ['unsave_post', 'Remove a post from your saved posts.', unsavePost],
    ['pin_post', 'Pin a post to its channel (visible to everyone in it).', (mm, uid, args) => setPinned(mm, uid, args, true)],
    ['unpin_post', 'Unpin a post, even one pinned by someone else.', (mm, uid, args) => setPinned(mm, uid, args, false)],
  ];
  for (const [name, description, fn] of tools) {
    server.registerTool(name, {
      description,
      inputSchema: schema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, guarded(ctx, name, async (args: Args, extra: { signal: AbortSignal }) => fn(mmOf(extra.signal), ctx.mmUserId, args),
    ) as unknown as ToolCallback<typeof schema>);
  }
}

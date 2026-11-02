import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomToken, sha256 } from '../crypto.ts';
import { MmError, RateLimited } from '../mattermost/client.ts';
import type { Store } from '../store.ts';
import { InputError, type MmPost } from './format.ts';
import { myTeams, resolveChannel, teamNameOf, type Mm, type MmChannel } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';

type FileArg = { name: string; content_text?: string; content_base64?: string };
type Args = { channel: string; message: string; root_id?: string; allow_duplicate?: boolean; files?: FileArg[] };
type PostList = { order: string[]; posts: Record<string, MmPost & { delete_at?: number }> };
type Upload = { name: string; bytes: Buffer<ArrayBuffer> };

const MAX_MESSAGE = 16383;
// Not higher: the MCP path's nginx takes 1 MB per request, and 128KiB of text JSON-escaped up to 6x plus the longest message just fits.
const MAX_FILES_BYTES = 128 * 1024;
const FILE_NAME = z.string().min(1).max(100).regex(/^[^/\\\p{Cc}]+$/u, 'ファイル名に / や \\、制御文字は使えません');
const inputSchema = {
  channel: z.string().min(1),
  message: z.string().min(1).max(MAX_MESSAGE),
  root_id: z.string().regex(/^[A-Za-z0-9]{26}$/).optional().describe('返信先のスレッドの親投稿の post_id'),
  allow_duplicate: z.boolean().optional().describe('同じ本文を意図して繰り返し投稿するときに true'),
  files: z.array(z.union([
    z.strictObject({ name: FILE_NAME, content_text: z.string().min(1).describe('UTF-8 のテキストとしてそのまま添付する中身') }),
    z.strictObject({ name: FILE_NAME, content_base64: z.string().min(1).describe('バイナリの中身の base64（data URL の接頭辞や改行は付けない）') }),
  ])).min(1).max(5).optional()
    .describe('添付ファイル（1〜5 件、中身の合計 128KiB まで）。各要素は name と、content_text か content_base64 のどちらか一方'),
};

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function decodeFiles(files: FileArg[]): Upload[] {
  const out = files.map((f) => {
    if (f.content_text !== undefined) return { name: f.name, bytes: Buffer.from(f.content_text, 'utf8') };
    const b = f.content_base64!;
    const bytes = Buffer.from(b, 'base64');
    // Not trusting Buffer.from alone: it skips characters it cannot read and stops at the first "=", so a data URL or a cut string would upload garbage.
    if (!B64.test(b) || b.length % 4 !== 0 || bytes.toString('base64') !== b) {
      throw new InputError(`ファイル「${f.name}」の content_base64 を base64 として読めません。data URL の接頭辞（data:...;base64,）や改行を付けずに渡してください。`);
    }
    return { name: f.name, bytes };
  });
  const total = out.reduce((n, f) => n + f.bytes.length, 0);
  if (total > MAX_FILES_BYTES) throw new InputError(`添付ファイルの中身の合計が ${total} バイトで、上限の ${MAX_FILES_BYTES} バイト（128KiB）を超えています。`);
  return out;
}

// Not joining the parts with a separator: moving text between the message, a name and a content must not give the same hash.
const bodyHash = (message: string, files: Upload[]) =>
  files.length ? sha256(JSON.stringify([message, files.map((f) => [f.name, sha256(f.bytes)])])) : sha256(message);

async function upload(mm: Mm, uid: string, channelId: string, f: Upload): Promise<string> {
  const r = await worded(
    mm.call<{ file_infos: { id: string }[] }>(uid, 'POST', `/files?channel_id=${channelId}&filename=${encodeURIComponent(f.name)}`,
      new Blob([f.bytes], { type: 'application/octet-stream' })),
    {
      id: [
        [400, 'api.file.upload_file.large_image_detailed.app_error', `ファイル「${f.name}」は画像の画素数が大きすぎるため添付できません。`],
        [413, 'api.file.upload_file.too_large_detailed.app_error', `ファイル「${f.name}」は大きすぎるため添付できません。`],
        [403, 'api.file.attachments.disabled.app_error', 'このサーバーではファイルの添付が無効です。'],
      ],
    },
  );
  return r.file_infos[0].id;
}

const INFLIGHT = '同じ投稿を処理中です。少し待ってから read_channel などで投稿されたかを確かめてください。';

export async function sendMessage(mm: Mm, store: Store, uid: string, baseUrl: string, args: Args): Promise<CallToolResult> {
  const files = decodeFiles(args.files ?? []);
  const ch = await resolveChannel(mm, uid, args.channel);
  const rootId = args.root_id;
  if (rootId) {
    const root = await mm.call<MmPost>(uid, 'GET', `/posts/${rootId}`);
    if (root.channel_id !== ch.id) throw new InputError(`root_id ${rootId} の投稿はチャンネル「${ch.name}」にありません。`);
  }
  const where = `チャンネル: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${rootId ? `、返信先 post_id: ${rootId}` : ''}`;
  const done = (postId: string, note: string) => text([note, `post_id: ${postId}`, where, `${baseUrl}/${ch.teamName}/pl/${postId}`].join('\n'));
  const body = { channel_id: ch.id, message: args.message, ...(rootId ? { root_id: rootId } : {}) };
  const withFiles = (ids: string[]) => (ids.length ? { ...body, file_ids: ids } : body);
  const posted = (post: MmPost) => {
    const got = post.file_ids?.length ?? 0;
    if (!files.length) return '投稿しました。';
    if (got === files.length) return `投稿しました。ファイル ${files.length} 件を添付しました。`;
    return `投稿しました。ただし、添付した ${files.length} 件のうち ${files.length - got} 件を Mattermost が外したため、投稿に付いていません。`;
  };
  const uploadAll = async () => {
    const ids: string[] = [];
    for (const f of files) ids.push(await upload(mm, uid, ch.id, f));
    return ids;
  };

  if (args.allow_duplicate) {
    const ids = await uploadAll();
    const post = await mm.call<MmPost>(uid, 'POST', '/posts', { ...withFiles(ids), pending_post_id: randomToken() });
    return done(post.id, posted(post));
  }

  const claim = store.claimPost({ mmUserId: uid, channelId: ch.id, rootId, bodyHash: bodyHash(args.message, files) });
  if (claim.kind === 'done') return done(claim.postId, '同じ本文を直前に投稿済みのため、やり直しとみなして投稿していません。');
  if (claim.kind === 'inflight') return text(INFLIGHT, true);
  if (claim.kind === 'retry') {
    // Not dropping the claim if this lookup fails: the earlier attempt's outcome is still unknown.
    const r = await mm.call<PostList>(uid, 'GET', `/channels/${ch.id}/posts?since=${claim.createdAt - 1}`);
    const prev = Object.values(r.posts).find((p) =>
      p.user_id === uid && (p.root_id || undefined) === rootId && p.message === args.message && (p.file_ids?.length ?? 0) === files.length
      && !p.delete_at && p.create_at >= claim.createdAt);
    if (prev) {
      store.completePost(claim.id, prev.id);
      return done(prev.id, '同じ本文の投稿が既にあったため、やり直しとみなして投稿していません。');
    }
  }
  let claimedAt = claim.claimedAt;
  let post: MmPost;
  try {
    const ids = await uploadAll();
    // Not posting on the claim taken before the uploads: they can outlast the in-flight grace, and a resend that took the claim over meanwhile posts too.
    const again = store.reclaimPost(claim.id, claimedAt);
    if (again === undefined) return text(INFLIGHT, true);
    claimedAt = again;
    post = await mm.call<MmPost>(uid, 'POST', '/posts', { ...withFiles(ids), pending_post_id: claim.pendingPostId });
  } catch (e) {
    // Not leaving out InputError: here it can only be an upload that Mattermost refused, so nothing was posted.
    if (e instanceof MmError || e instanceof InputError || e instanceof RateLimited || (e as { sent?: boolean })?.sent === false) store.dropPost(claim.id, claimedAt);
    throw e;
  }
  store.completePost(claim.id, post.id);
  return done(post.id, posted(post));
}

export type Wording = { id?: [status: number, id: string, text: string][]; status?: [status: number, text: string][] };

// Not matching on status first: one status (403, 404) covers causes that need different wording, told apart only by the id.
// Not matching on the id alone: Mattermost reuses an id across statuses (app.post.get.app_error is also a 400 from UpdatePost and DeletePost).
// Not an object keyed by id: an id such as "constructor" would hit Object.prototype.
export async function worded<T>(p: Promise<T>, w: Wording): Promise<T> {
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

type OwnPost = MmPost & { type: string; props?: Record<string, unknown>; reply_count?: number };
type Where = { line: string; teamName: string };
const GONE = '投稿が見つかりません。直前の呼び出しで削除済みの可能性があります。';
const goneWording: Wording = { id: [[404, 'app.post.get.app_error', GONE]] };

// Not forgetting before DELETE: if Mattermost refused the delete, the post would stay while a resend posted it twice.
async function forgetIfGone<T>(p: Promise<T>, store: Store, uid: string, postId: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof MmError && e.status === 404 && e.id === 'app.post.get.app_error') store.forgetPost(uid, postId);
    throw e;
  }
}

// Not trusting user_id alone: a webhook post carries its creator's user_id, and Mattermost would let that creator edit or delete it.
// Not refusing from_oauth_app or from_plugin: this MCP's own send_message posts carry from_oauth_app.
async function ownPost(mm: Mm, store: Store, uid: string, postId: string): Promise<OwnPost> {
  const post = await worded(forgetIfGone(mm.call<OwnPost>(uid, 'GET', `/posts/${postId}`), store, uid, postId), goneWording);
  if (post.user_id !== uid) throw new InputError('本人の投稿ではありません。この MCP からは本人の投稿だけを編集・削除できます。');
  if (post.props?.from_webhook || post.props?.from_bot) throw new InputError('webhook や Bot が投稿したものは扱えません。');
  if (post.type) throw new InputError(`この種類の投稿は扱えません（type: ${post.type}）。`);
  return post;
}

// Looked up before the write rather than after: once DELETE has succeeded, a failing lookup would report an irreversible success as an error.
async function whereOf(mm: Mm, uid: string, post: OwnPost): Promise<Where> {
  const ch = await mm.call<MmChannel>(uid, 'GET', `/channels/${post.channel_id}`);
  return { line: `チャンネル: ${ch.display_name || ch.name}（channel_id: ${ch.id}）`, teamName: await teamNameOf(mm, uid, ch.team_id) };
}

const editSchema = {
  post_id: POST_ID.describe('編集する、本人の投稿の post_id'),
  message: z.string().min(1).max(MAX_MESSAGE).describe('新しい本文（全体を置き換える）'),
};
type EditArgs = { post_id: string; message: string };

export async function editMessage(mm: Mm, store: Store, uid: string, baseUrl: string, args: EditArgs): Promise<CallToolResult> {
  if (!args.message.trim()) throw new InputError('本文が空白だけです。投稿を消したいときは delete_message を使ってください。');
  const where = await whereOf(mm, uid, await ownPost(mm, store, uid, args.post_id));
  // Not PUT /posts/{id}: it clears is_pinned when the field is left out.
  await worded(mm.call(uid, 'PUT', `/posts/${args.post_id}/patch`, { message: args.message }), {
    id: [
      [400, 'api.post.update_post.permissions_time_limit.app_error', '編集できる期間を過ぎています。'],
      [400, 'api.post.patch_post.can_not_update_post_in_deleted.error', 'アーカイブ済みのチャンネルの投稿は編集できません。'],
    ],
  });
  store.forgetPost(uid, args.post_id);
  return text(['編集しました。編集で足したメンションは通知されません。', `post_id: ${args.post_id}`, where.line, `${baseUrl}/${where.teamName}/pl/${args.post_id}`].join('\n'));
}

export async function deleteMessage(mm: Mm, store: Store, uid: string, args: { post_id: string }): Promise<CallToolResult> {
  const post = await ownPost(mm, store, uid, args.post_id);
  // Not using reply_count alone: Mattermost puts the whole thread's count on replies too, which would block deleting a reply.
  // Not defaulting a missing reply_count to 0: the delete cannot be undone, so an unknown count is treated as having replies.
  // Not closing the race with a reply posted after this check: Mattermost has no conditional delete.
  if (!post.root_id && post.reply_count !== 0) {
    throw new InputError('返信のあるスレッドの親投稿は消せません。消すとほかの人の返信も消えるためです。消す場合は Mattermost の画面から操作してください。');
  }
  const where = await whereOf(mm, uid, post);
  await worded(forgetIfGone(mm.call(uid, 'DELETE', `/posts/${args.post_id}`), store, uid, args.post_id), {
    id: [
      ...goneWording.id!,
      [400, 'api.post.delete_post.can_not_delete_post_in_deleted.error', 'アーカイブ済みのチャンネルの投稿は削除できません。'],
    ],
  });
  store.forgetPost(uid, args.post_id);
  return text(['削除しました。', `post_id: ${args.post_id}`, where.line].join('\n'));
}

const draftSchema = {
  channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか'),
  // Not counting code points: zod counts UTF-16 units, which can only be stricter than Mattermost's limit.
  message: z.string().min(1).max(MAX_MESSAGE),
  root_id: POST_ID.optional().describe('返信の下書きにするときの、スレッドの親投稿の post_id'),
  overwrite: z.boolean().optional().describe('同じ投稿先に本文の違う下書きがあるときに、上書きするなら true。元の本文に加えて添付ファイルと優先度も失われ、取り消せない'),
};
type DraftArgs = { channel: string; message: string; root_id?: string; overwrite?: boolean };
type Draft = { channel_id: string; root_id: string; message: string };
const LEFT_BEHIND = 'この下書きを send_message で送っても下書きは消えず、残った下書きをそのまま送ると同じ投稿が 2 回になります。';
const DISABLED: [number, string, string] = [501, 'api.drafts.disabled.app_error', 'このサーバーでは下書きの同期が無効です。'];

// Refused rather than saved: with sync off the webapp neither loads the draft nor shows its own unsent text to the check below.
async function syncDraftsOff(mm: Mm, uid: string): Promise<boolean> {
  try {
    return (await mm.call<{ value: string }>(uid, 'GET', '/users/me/preferences/advanced_settings/name/sync_drafts')).value === 'false';
  } catch (e) {
    if (e instanceof MmError && e.status === 400 && e.id === 'app.preference.get.app_error') return false;
    throw e;
  }
}

export async function saveDraft(mm: Mm, uid: string, args: DraftArgs): Promise<CallToolResult> {
  const ch = await resolveChannel(mm, uid, args.channel);
  const rootId = args.root_id ?? '';
  // Checked here rather than left to Mattermost: it saves a draft on any root_id, and one on a reply never shows in any thread.
  if (rootId) {
    const root = await worded(mm.call<MmPost>(uid, 'GET', `/posts/${rootId}`), {
      status: [[404, `root_id ${rootId} の投稿が見つかりません。`], [403, `root_id ${rootId} の投稿を見られません。`]],
    });
    if (root.channel_id !== ch.id) throw new InputError(`root_id ${rootId} の投稿はチャンネル「${ch.name}」にありません。`);
    if (root.root_id) throw new InputError(`root_id ${rootId} は返信です。スレッドの親投稿の post_id を指定してください。`);
  }
  if (await syncDraftsOff(mm, uid)) {
    throw new InputError('下書きの同期を切っているため保存していません。保存しても画面に届かないか、書きかけの下書きを上書きするおそれがあります。「設定 > 詳細設定」で下書きの同期を入れてください。');
  }
  const teamId = ch.teamId || (await myTeams(mm, uid))[0]?.id;
  if (!teamId) throw new InputError('所属しているチームがないため、既存の下書きを確かめられません。');
  const list = await worded(mm.call<Draft[] | null>(uid, 'GET', `/users/${uid}/teams/${teamId}/drafts`), { id: [DISABLED] });
  const where = `チャンネル: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${rootId ? `、返信先 post_id: ${rootId}` : ''}`;
  const existing = (list ?? []).find((d) => d.channel_id === ch.id && (d.root_id || '') === rootId);
  if (existing?.message === args.message) return text(`同じ下書きがあります。保存し直していません。\n${where}\n${LEFT_BEHIND}`);
  if (existing && !args.overwrite) {
    const head = [...existing.message].slice(0, 200).join('');
    throw new InputError([
      '同じ投稿先に、本文の違う下書きがあります。上書きしていません。上書きするときは overwrite: true を付けてください（添付ファイルと優先度も失われます）。',
      where,
      `既存の下書き（先頭 200 文字）: ${head}`,
    ].join('\n'));
  }
  await worded(mm.call(uid, 'POST', '/drafts', { channel_id: ch.id, root_id: rootId, message: args.message }), {
    id: [DISABLED, [400, 'api.draft.create_draft.can_not_draft_to_deleted.error', 'アーカイブ済みのチャンネルには下書きを保存できません。']],
    status: [[403, 'このチャンネルに下書きを保存する権限がありません。']],
  });
  // Not claiming the input box for a reply: only channel drafts were checked in the webapp.
  return text(rootId
    ? ['下書きとして保存しました。送信は本人が行ってください。', where, LEFT_BEHIND].join('\n')
    : [
      'Mattermost の下書きとして保存しました。そのチャンネルの入力欄に入っています。送信は本人が行ってください。',
      where,
      '保存したときにそのチャンネルを開いていた場合は、チャンネルを開き直してから編集してください。開き直さずに書くと、この下書きは置き換わります。',
      LEFT_BEHIND,
    ].join('\n'));
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

  const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
  server.registerTool('edit_message', {
    description: '本人の投稿の本文を書き換える。他人、webhook、Bot の投稿とシステムメッセージは扱わない。元の本文は上書きされる。編集で足したメンションは通知されない',
    inputSchema: editSchema,
    annotations: destructive,
  }, guarded(ctx, 'edit_message', async (args: EditArgs, extra: { signal: AbortSignal }) => editMessage(mmOf(extra.signal), ctx.store, ctx.mmUserId, ctx.cfg.mmBrowserUrl, args),
  ) as unknown as ToolCallback<typeof editSchema>);
  const deleteSchema = { post_id: POST_ID.describe('削除する、本人の投稿の post_id') };
  server.registerTool('delete_message', {
    description: '本人の投稿を削除する。削除は取り消せない。実行の前に利用者に確認すること。他人、webhook、Bot の投稿とシステムメッセージ、返信のあるスレッドの親投稿は消さない',
    inputSchema: deleteSchema,
    annotations: destructive,
  }, guarded(ctx, 'delete_message', async (args: { post_id: string }, extra: { signal: AbortSignal }) => deleteMessage(mmOf(extra.signal), ctx.store, ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof deleteSchema>);

  server.registerTool('save_draft', {
    description: '投稿せずに、本人の Mattermost の下書きとして保存する。送信は本人が画面で行う。root_id を渡すとスレッドへの返信の下書きになる。同じ投稿先に本文の違う下書きがあれば、overwrite: true が無い限り上書きしない。下書きの同期を切っている利用者には保存しない。この下書きを send_message で送っても下書きは残り、本人がそれをそのまま送ると同じ投稿が 2 回になる',
    inputSchema: draftSchema,
    annotations: destructive,
  }, guarded(ctx, 'save_draft', async (args: DraftArgs, extra: { signal: AbortSignal }) => saveDraft(mmOf(extra.signal), ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof draftSchema>);

  server.registerTool('send_message', {
    description: 'チャンネルへ投稿する。root_id を渡すとスレッドへの返信になる。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）のどれか。files でファイルを添付できる（1〜5 件、合計 128KiB まで。SVG、CSV、Markdown、コードなどのテキストは content_text、小さなバイナリは content_base64）。同じ投稿先へ同じ本文と添付を 10 分以内に送ると、やり直しとみなして投稿しない',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'send_message', async (args: Args, extra: { signal: AbortSignal }) => {
    const mm: Mm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, extra.signal) };
    return sendMessage(mm, ctx.store, ctx.mmUserId, ctx.cfg.mmBrowserUrl, args);
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for this shape.
  }) as unknown as ToolCallback<typeof inputSchema>);
}

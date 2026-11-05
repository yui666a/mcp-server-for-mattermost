import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { randomToken, sha256 } from '../crypto.ts';
import { log } from '../log.ts';
import { MmError, RateLimited, Reauthorize } from '../mattermost/client.ts';
import { MAX_OPEN_UPLOAD_URLS, type HeldFile, type Store } from '../store.ts';
import { BODY_CUT_NOTE, InputError, type MmPost } from './format.ts';
import { findPosted, postOnce } from './post.ts';
import { myTeams, NoDirectChannel, resolveChannel, teamNameOf, type ChannelRef, type Mm, type MmChannel, type ResolvedChannel } from './resolve.ts';
import { guarded, text, type ToolContext } from './server.ts';

type FileArg = { name: string; content_text?: string; content_base64?: string };
type Args = { channel: string; message: string; root_id?: string; allow_duplicate?: boolean; files?: FileArg[]; file_ids?: string[] };
type Upload = { name: string; bytes: Buffer<ArrayBuffer> };

const MAX_MESSAGE = 16383;
export const MAX_UPLOAD_FILES = 5;
// Not higher: the MCP path's nginx takes 1 MB per request, and 128KiB of text JSON-escaped up to 6x plus the longest message just fits.
const MAX_FILES_BYTES = 128 * 1024;
export const FILE_NAME = z.string().min(1).max(100).regex(/^[^/\\\p{Cc}]+$/u, 'ファイル名に / や \\、制御文字は使えません');
const inputSchema = {
  channel: z.string().min(1),
  message: z.string().min(1).max(MAX_MESSAGE),
  root_id: z.string().regex(/^[A-Za-z0-9]{26}$/).optional().describe('返信先のスレッドの親投稿の post_id'),
  allow_duplicate: z.boolean().optional().describe('同じ本文を意図して繰り返し投稿するときに true'),
  files: z.array(z.union([
    z.strictObject({ name: FILE_NAME, content_text: z.string().min(1).describe('UTF-8 のテキストとしてそのまま添付する中身') }),
    z.strictObject({ name: FILE_NAME, content_base64: z.string().min(1).describe('バイナリの中身の base64（data URL の接頭辞や改行は付けない）') }),
  ])).min(1).max(5).optional()
    .describe('添付ファイル（1〜5 件、中身の合計 128KiB まで）。各要素は name と、content_text（SVG、CSV、Markdown、コードなどのテキスト）か content_base64（小さなバイナリ）のどちらか一方。中身を読めて合計 128KiB に収まるファイルだけを渡す。チャットに添付されたファイルは、コード実行で中身を読めるときだけ content_base64 で送れる。読めないファイル、収まらないファイル、利用者の PC にあるファイルは、prepare_upload の説明の案内に従う'),
  file_ids: z.array(z.string().regex(/^[A-Za-z0-9]{26}$/)).min(1).max(5).optional()
    .describe('prepare_upload で、投稿先と同じチャンネルへ 24 時間以内にアップロードした file_id（1〜5 件）'),
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
  if (total > MAX_FILES_BYTES) throw new InputError(`添付ファイルの中身の合計が ${total} バイトで、上限の ${MAX_FILES_BYTES} バイト（128KiB）を超えています。合計がこの大きさになる添付は files では送れないので、prepare_upload の説明の案内に従ってください。`);
  return out;
}

// Not joining the parts with a separator: moving text between the message, a name and a content must not give the same hash.
// Not adding file_ids when there are none: a claim taken before file_ids existed would stop matching its own retry.
const bodyHash = (message: string, files: Upload[], fileIds: string[]) => {
  const parts: unknown[] = [message, files.map((f) => [f.name, sha256(f.bytes)])];
  if (fileIds.length) return sha256(JSON.stringify([...parts, fileIds]));
  return files.length ? sha256(JSON.stringify(parts)) : sha256(message);
};

export async function uploadFile(mm: Mm, uid: string, channelId: string, name: string, body: Blob): Promise<string> {
  const r = await worded(
    mm.call<{ file_infos: { id: string }[] }>(uid, 'POST', `/files?channel_id=${channelId}&filename=${encodeURIComponent(name)}`, body),
    {
      id: [
        [400, 'api.file.upload_file.large_image_detailed.app_error', `ファイル「${name}」は画像の画素数が大きすぎるため添付できません。`],
        [413, 'api.file.upload_file.too_large_detailed.app_error', tooLarge(name)],
        [403, 'api.file.attachments.disabled.app_error', ATTACHMENTS_OFF],
      ],
    },
  );
  return r.file_infos[0].id;
}

const ATTACHMENTS_OFF = 'このサーバーではファイルの添付が無効です。';
const tooLarge = (name: string) => `ファイル「${name}」は大きすぎるため添付できません。`;

// Not left to the upload alone when the DM is about to be created: a refused upload would leave the new DM empty, and Mattermost cannot delete a DM.
// Not checking the image size in pixels, permissions, restricted DMs or plugins: the client config does not tell them, so those refusals can still leave an empty DM.
async function checkFilesAccepted(mm: Mm, uid: string, files: Upload[]): Promise<void> {
  const c = await mm.call<{ EnableFileAttachments?: string; MaxFileSize?: string }>(uid, 'GET', '/config/client?format=old');
  if (c.EnableFileAttachments === 'false') throw new InputError(ATTACHMENTS_OFF);
  // Not validated with Number(): it reads "" as 0, which would refuse every file.
  if (!/^\d+$/.test(c.MaxFileSize ?? '')) return;
  const big = files.find((f) => f.bytes.length > Number(c.MaxFileSize));
  if (big) throw new InputError(tooLarge(big.name));
}

const upload = (mm: Mm, uid: string, channelId: string, f: Upload) =>
  uploadFile(mm, uid, channelId, f.name, new Blob([f.bytes], { type: 'application/octet-stream' }));

// Checked against this MCP's own record rather than Mattermost's file info: it tells apart a file of another channel, one already posted, and one not uploaded through prepare_upload.
export function checkUploaded(store: Store, uid: string, channelId: string, fileIds: string[]): void {
  if (new Set(fileIds).size !== fileIds.length) throw new InputError('file_ids に同じ file_id が重なっています。');
  const known = new Map(store.uploadedFiles(uid, fileIds).map((f) => [f.fileId, f]));
  for (const id of fileIds) {
    const f = known.get(id);
    if (!f) throw new InputError(`file_id ${id} は、本人が prepare_upload の URL で 24 時間以内にアップロードしたファイルではありません。`);
    if (f.channelId !== channelId) throw new InputError(`file_id ${id} は別のチャンネル（channel_id: ${f.channelId}）へアップロードしたファイルです。投稿先のチャンネルで prepare_upload からやり直してください。`);
  }
}

// Not reserving the files until the post: two different messages racing for one file_id end with Mattermost keeping it on the first, which the second reports as a dropped file.
// Not checking the schedules first: a file a posted schedule holds is already posted, and that is the reason to give.
export function checkUnposted(store: Store, uid: string, fileIds: string[]): void {
  const used = store.uploadedFiles(uid, fileIds).find((f) => f.postId);
  if (used) throw new InputError(`file_id ${used.fileId} は既に投稿（post_id: ${used.postId}）に使われています。同じファイルをもう一度送るときは、prepare_upload からアップロードし直してください。`);
  const [held] = store.heldScheduledFiles(uid, fileIds);
  if (held) throw heldError(held);
}

// Not creating the DM with root_id or file_ids: a DM not opened yet holds neither, and the call would fail right after leaving an empty DM.
export const createsDirect = (rootId: string | undefined, fileIds: string[]): boolean => !rootId && !fileIds.length;

// Not reporting only the missing DM when file_ids are given: none of them can belong to a DM not opened yet, so the file is the real mistake.
// Not reading the client config for a DM that is already there: nothing can be left empty then, and a retry of a send that created it must reach the duplicate guard.
// Not catching InputError: a user not found must be told as it is, without reading the config or creating anything.
// Not creating in one resolve with the check before it: a wrong destination must be told before a refused attachment. A refusal found only when creating (a deactivated user, no permission) still comes after the check.
async function resolveCreatingAfter(mm: Mm, uid: string, channel: string, check: () => Promise<void>): Promise<ResolvedChannel> {
  try {
    return await resolveChannel(mm, uid, channel, { create: false });
  } catch (e) {
    if (!(e instanceof NoDirectChannel)) throw e;
  }
  await check();
  return resolveChannel(mm, uid, channel, { create: true });
}

export async function resolveTarget(mm: Mm, store: Store, uid: string, channel: string, rootId: string | undefined, fileIds: string[]): Promise<ResolvedChannel> {
  try {
    return await resolveChannel(mm, uid, channel, { create: createsDirect(rootId, fileIds) });
  } catch (e) {
    if (e instanceof NoDirectChannel && fileIds.length) checkUploaded(store, uid, '', fileIds);
    throw e;
  }
}

export const heldError = (h: HeldFile) =>
  new InputError(`file_id ${h.fileId} は予約（予約 ID: ${h.scheduledId}）の添付に使われています。投稿を試みる前の待機中の予約なら、cancel_scheduled_message で取り消すと使えます。同じファイルを別に送るときは、prepare_upload からアップロードし直してください。`);

const INFLIGHT = '同じ投稿を処理中です。少し待ってから read_channel などで投稿されたかを確かめてください。';

export async function sendMessage(mm: Mm, store: Store, uid: string, baseUrl: string, args: Args, client?: AbortSignal): Promise<CallToolResult> {
  const files = decodeFiles(args.files ?? []);
  const fileIds = args.file_ids ?? [];
  const ch = files.length && args.channel.trim().startsWith('@') && !args.root_id && !fileIds.length
    ? await resolveCreatingAfter(mm, uid, args.channel, () => checkFilesAccepted(mm, uid, files))
    : await resolveTarget(mm, store, uid, args.channel, args.root_id, fileIds);
  checkUploaded(store, uid, ch.id, fileIds);
  const rootId = args.root_id;
  if (rootId) await checkRoot(mm, uid, rootId, ch);
  const where = `チャンネル: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${rootId ? `、返信先 post_id: ${rootId}` : ''}`;
  // Not only after a fresh post: an earlier attempt's cleanup may have failed, and a resend that did not post can retry it.
  const done = async (postId: string, note: string) => {
    const cleared = await clearSentDraft(mm, uid, ch, rootId ?? '', args.message, client);
    return text([note, ...(cleared ? [cleared] : []), `post_id: ${postId}`, where, `${baseUrl}/${ch.teamName}/pl/${postId}`].join('\n'));
  };
  const spec = { channelId: ch.id, message: args.message, rootId };
  const attached = files.length + fileIds.length;
  // Only the files the post kept: a dropped one may sit on another post, and one left unmarked would pass checkUnposted and be dropped again in silence.
  // Not the response's file_ids when Mattermost hid them (ABAC denies the user the download): it empties them and counts the attached files instead, so which ones were dropped is unknown, and marking them all is the safe side.
  const posted = (r: { postId: string; fileIds: string[]; redactedFileCount: number }) => {
    const hidden = r.redactedFileCount > 0 && !r.fileIds.length;
    const got = hidden ? r.redactedFileCount : r.fileIds.length;
    store.markFilesPosted(uid, hidden ? fileIds : fileIds.filter((id) => r.fileIds.includes(id)), r.postId);
    if (!attached) return '投稿しました。';
    if (got === attached) return `投稿しました。ファイル ${attached} 件を添付しました。`;
    return `投稿しました。ただし、添付した ${attached} 件のうち ${attached - got} 件を Mattermost が外したため、投稿に付いていません${hidden ? '（ファイルをダウンロードする権限が無いため、どれが外れたかは分かりません）' : ''}。`;
  };
  const uploadAll = async () => {
    const ids: string[] = [];
    for (const f of files) ids.push(await upload(mm, uid, ch.id, f));
    return [...ids, ...fileIds];
  };

  if (args.allow_duplicate) {
    checkUnposted(store, uid, fileIds);
    const r = await postOnce(mm, uid, { ...spec, fileIds: await uploadAll() }, randomToken());
    if (r.kind !== 'posted') throw r.error;
    return done(r.postId, posted(r));
  }

  const claim = store.claimPost({ mmUserId: uid, channelId: ch.id, rootId, bodyHash: bodyHash(args.message, files, fileIds) });
  if (claim.kind === 'done') return done(claim.postId, '同じ本文を直前に投稿済みのため、やり直しとみなして投稿していません。');
  if (claim.kind === 'inflight') return text(INFLIGHT, true);
  if (claim.kind === 'retry') {
    // Not dropping the claim if this lookup fails: the earlier attempt's outcome is still unknown.
    const [prev] = await findPosted(mm, uid, { ...spec, fileCount: attached, fileIds }, claim.createdAt);
    if (prev) {
      store.completePost(claim.id, prev);
      store.markFilesPosted(uid, fileIds, prev);
      return done(prev, '同じ本文の投稿が既にあったため、やり直しとみなして投稿していません。');
    }
  }
  let claimedAt = claim.claimedAt;
  let res: Parameters<typeof posted>[0];
  try {
    checkUnposted(store, uid, fileIds);
    const ids = await uploadAll();
    // Not posting on the claim taken before the uploads: they can outlast the in-flight grace, and a resend that took the claim over meanwhile posts too.
    const again = store.reclaimPost(claim.id, claimedAt);
    if (again === undefined) return text(INFLIGHT, true);
    claimedAt = again;
    const r = await postOnce(mm, uid, { ...spec, fileIds: ids }, claim.pendingPostId);
    if (r.kind !== 'posted') throw r.error;
    res = r;
  } catch (e) {
    // Not leaving out InputError: here it can only be a file refused before the post or an upload that Mattermost refused, so nothing was posted.
    if (e instanceof MmError || e instanceof InputError || e instanceof RateLimited || (e as { sent?: boolean })?.sent === false) store.dropPost(claim.id, claimedAt);
    throw e;
  }
  store.completePost(claim.id, res.postId);
  return done(res.postId, posted(res));
}

export type Wording = { id?: [status: number, id: string, text: string][]; status?: [status: number, text: string][] };

// Not matching on status first: one status (403, 404) covers causes that need different wording, told apart only by the id.
// Not matching on the id alone: Mattermost reuses an id across statuses (app.post.get.app_error is also a 400 from UpdatePost and DeletePost).
// Not an object keyed by id: an id such as "constructor" would hit Object.prototype.
export const wordOf = (e: unknown, w: Wording): string | undefined => e instanceof MmError
  ? (w.id?.find(([s, id]) => s === e.status && id === e.id)?.[2] ?? w.status?.find(([s]) => s === e.status)?.[1])
  : undefined;

export async function worded<T>(p: Promise<T>, w: Wording): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const m = wordOf(e, w);
    throw m ? new InputError(m) : e;
  }
}

const POST_ID = z.string().regex(/^[A-Za-z0-9]{26}$/);
const reactionSchema = {
  post_id: POST_ID.describe('投稿の post_id'),
  // Not a zod regex: a Unicode emoji such as ✅ would get the SDK's generic validation error instead of the emoji-name hint.
  emoji: z.string().min(1).max(100).describe('Mattermost の絵文字名（例: white_check_mark、+1）。前後のコロンは付けても付けなくてもよい。カスタム絵文字の名前は search_emoji で調べる'),
};
type ReactionArgs = { post_id: string; emoji: string };

const emojiHint = (name: string) => `絵文字「${name}」がありません。標準の絵文字名（例: white_check_mark、+1）か、search_emoji で調べたカスタム絵文字名を指定してください。`;
// Checked rather than encoded: the name goes into a path, where "." and ".." survive encoding and fetch would normalise them into another endpoint.
function emojiName(raw: string): string {
  const name = raw.trim().replace(/^:/, '').replace(/:$/, '').trim();
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
  message: z.string().min(1).max(MAX_MESSAGE).describe(`新しい本文（全体を置き換える）。一覧のツール（read_channel など）の出力を元に書き換えるときは、先に get_post で読み直す。出力の本文は各行が 2 文字字下げされているので、各行の先頭の 2 文字の空白を外す。出力では CRLF や CR の改行を LF にそろえ、垂直タブや U+2028 などの区切りも改行として出すので、書き写すと改行の種類が LF になり、改行が増えることもある。get_post に「${BODY_CUT_NOTE}」とあれば、出力を元に書き換えない（切られた後ろが消える）。出力を元に書き換えたいときは、その投稿は Mattermost の画面で編集するよう利用者に伝える（利用者が新しい本文全体を渡したときは置き換えてよい）`),
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
  channel: z.string().min(1).describe('チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。DM とグループ DM は無ければ作る'),
  // Not counting code points: zod counts UTF-16 units, which can only be stricter than Mattermost's limit.
  message: z.string().min(1).max(MAX_MESSAGE),
  root_id: POST_ID.optional().describe('返信の下書きにするときの、スレッドの親投稿の post_id'),
  overwrite: z.boolean().optional().describe('同じ投稿先に本文の違う下書きがあるときに、上書きするなら true。元の本文に加えて添付ファイル、優先度、burn-on-read（読まれた後に消える設定）も失われ、取り消せない'),
};
type DraftArgs = { channel: string; message: string; root_id?: string; overwrite?: boolean };
type Draft = {
  channel_id: string; root_id: string; message: string; type?: string; file_ids?: string[];
  priority?: { priority?: string; requested_ack?: boolean; persistent_notifications?: boolean };
};
const LEFT_BEHIND = 'この下書きと同じ本文を send_message で送ると、投稿の後にこの下書きを消します（画面で添付を付けた場合は消しません）。';
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

export async function checkRoot(mm: Mm, uid: string, rootId: string, ch: { id: string; name: string; displayName: string }): Promise<void> {
  const root = await worded(mm.call<MmPost>(uid, 'GET', `/posts/${rootId}`), {
    status: [[404, `root_id ${rootId} の投稿が見つかりません。`], [403, `root_id ${rootId} の投稿を見られません。`]],
  });
  if (root.channel_id !== ch.id) throw new InputError(`root_id ${rootId} の投稿はチャンネル「${ch.displayName || ch.name}」（channel_id: ${ch.id}）にありません。`);
  if (root.root_id) throw new InputError(`root_id ${rootId} は返信です。スレッドの親投稿の post_id を指定してください。`);
}

// Not throwing when the caller has no team: send_message's cleanup has nothing to do then, since drafts are listed per team and a DM draft shows nowhere.
async function draftsOf(mm: Mm, uid: string, ch: Pick<ChannelRef, 'teamId'>): Promise<Draft[] | undefined> {
  const teamId = ch.teamId || (await myTeams(mm, uid))[0]?.id;
  if (!teamId) return undefined;
  return (await mm.call<Draft[] | null>(uid, 'GET', `/users/${uid}/teams/${teamId}/drafts`)) ?? [];
}

const CLEANUP_MS = 5000;
// ponytail: a guess at what one DELETE needs; a slow Mattermost can still be cut off mid-DELETE, and the lock then let go while it runs on.
const DELETE_MARGIN_MS = 1000;

class TooLateToDelete extends Error {
  name = 'TimeoutError';
}

// Not kept on the server or ctx: app.ts builds a server per request, and a lock there would never be shared between two calls.
// Not one lock per user: the race is only between the list and the write of one draft, so sends to other channels or threads need not wait.
const draftLocks = new Map<string, Promise<void>>();

// Not freeing the place in line when giving up: a later caller would then run alongside the earlier one still holding it.
async function withDraftLock<T>(uid: string, channelId: string, rootId: string, fn: () => Promise<T>, giveUp?: AbortSignal): Promise<T> {
  const key = `${uid}\n${channelId}\n${rootId}`;
  const prev = draftLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => { release = r; }));
  draftLocks.set(key, tail);
  try {
    if (giveUp) {
      // Not left to the race alone: an already aborted signal fires no abort event, so stop would never settle and fn would run once prev does.
      giveUp.throwIfAborted();
      const stop = new Promise<never>((_, reject) => {
        giveUp.addEventListener('abort', () => reject(giveUp.reason), { once: true });
      });
      stop.catch(() => {});
      await Promise.race([prev, stop]);
    } else {
      await prev;
    }
    return await fn();
  } finally {
    void prev.then(() => {
      release();
      if (draftLocks.get(key) === tail) draftLocks.delete(key);
    });
  }
}

// Not deleting only when the text still matches: Mattermost has no conditional delete, so an edit saved between the list and the DELETE is lost.
// Not left running past the deadline: a late DELETE could remove a draft the user rewrote after reading that it was not cleared. A DELETE already sent still completes on Mattermost.
async function clearSentDraft(mm: Mm, uid: string, ch: ChannelRef, rootId: string, message: string, client?: AbortSignal): Promise<string> {
  const deadline = AbortSignal.timeout(CLEANUP_MS);
  // Not Date.now: the deadline runs on a timer, which a wall clock set back or forward would not match.
  const until = performance.now() + CLEANUP_MS;
  const quick: Mm = { call: (u, m, p, b) => mm.call(u, m, p, b, deadline) };
  try {
    return await withDraftLock(uid, ch.id, rootId, () => clearLocked(quick, uid, ch, rootId, message, until), client ? AbortSignal.any([deadline, client]) : deadline);
  } catch (e) {
    if (e instanceof MmError && e.status === 501 && e.id === DISABLED[1]) return '';
    // Not logged when the client gave up: the request was cancelled, not the cleanup broken.
    if (client?.aborted) return '';
    log('draft_cleanup_failed', { mm_user_id: uid, channel_id: ch.id, name: (e as Error)?.name, ...(e instanceof TooLateToDelete ? { skipped: 'delete' } : {}), ...(e instanceof MmError ? { status: e.status, id: e.id } : {}) });
    if (e instanceof Reauthorize) return '投稿の後で Mattermost への再ログインが必要になったため、同じ本文の下書きを確かめられませんでした。コネクタを再接続してください。下書きが残っていれば、そのまま送ると同じ投稿が 2 回になります。';
    return '同じ本文の下書きを確かめられなかったか、消せませんでした。下書きが残っていれば、そのまま送ると同じ投稿が 2 回になります。';
  }
}

async function clearLocked(quick: Mm, uid: string, ch: ChannelRef, rootId: string, message: string, until: number): Promise<string> {
  const d = (await draftsOf(quick, uid, ch))?.find((x) => x.channel_id === ch.id && (x.root_id || '') === rootId && x.message === message);
  if (!d) return '';
  if (d.file_ids?.length) return '同じ本文の下書きがありますが、添付ファイルが付いているため消していません。そのまま送ると、同じ本文がもう一度投稿されます。';
  // Not deleting with sync off: the webapp clears its stored draft on draft_deleted whatever the setting, wiping unsynced text kept only in the browser.
  if (await syncDraftsOff(quick, uid)) return '同じ本文の下書きがありますが、下書きの同期を切っているため消していません。同期を入れ直すと画面に出るので、送らずに消してください。';
  // Not sending a DELETE the deadline may cut off: the lock would be let go while Mattermost still runs it, and a save behind could be the draft it deletes.
  if (until - performance.now() < DELETE_MARGIN_MS) throw new TooLateToDelete('too little time left to delete the draft');
  await quick.call(uid, 'DELETE', `/users/${uid}/channels/${ch.id}/drafts${rootId ? `/${rootId}` : ''}`);
  const p = d.priority;
  return [
    // Not claiming the input box is empty: an open editor keeps its own copy until the user switches channel or thread.
    `同じ本文の下書きを消しました。${rootId ? 'そのスレッド' : 'そのチャンネル'}を画面で開いている場合は、入力欄に本文が残っているので、送らずに消してください。`,
    ...(p?.priority || p?.requested_ack || p?.persistent_notifications ? ['下書きに付いていた優先度は、この投稿には付いていません。'] : []),
    // Not keeping the draft for it: sending it from the UI would post the same text twice, the same reason priority is not kept.
    ...(d.type === 'burn_on_read' ? ['下書きに付いていた burn-on-read（読まれた後に消える設定）は、この投稿には付いていません。投稿は消えずに残ります。'] : []),
  ].join('\n');
}

export async function saveDraft(mm: Mm, uid: string, args: DraftArgs): Promise<CallToolResult> {
  // Checked before resolving rather than after: resolving may create the DM, and with sync off the call fails anyway.
  if (await syncDraftsOff(mm, uid)) {
    throw new InputError('下書きの同期を切っているため保存していません。保存しても画面に届かないか、書きかけの下書きを上書きするおそれがあります。「設定 > 詳細設定」で下書きの同期を入れてください。');
  }
  const rootId = args.root_id ?? '';
  // Not listing only after resolving a DM it may create: with drafts disabled on the server the call then fails leaving it empty. A DM's drafts are listed on the first team, the same team as after resolving.
  // Not listing early with root_id: no DM is created then, and a wrong root_id is the mistake to report first.
  // Not judging by this list: it is taken outside the lock, and a delete by send_message's cleanup in between would be missed, reporting as already saved a draft that is gone. The save lists again under the lock.
  if (args.channel.trim().startsWith('@') && !rootId) await listDrafts(mm, uid, { teamId: '' });
  // Not creating the DM with root_id: a DM not opened yet holds no root post, and the call would fail right after leaving an empty DM.
  const ch = await resolveChannel(mm, uid, args.channel, { create: !rootId });
  // Checked here rather than left to Mattermost: it saves a draft on any root_id, and one on a reply never shows in any thread.
  if (rootId) await checkRoot(mm, uid, rootId, ch);
  const where = `チャンネル: ${ch.displayName || ch.name}（channel_id: ${ch.id}）${rootId ? `、返信先 post_id: ${rootId}` : ''}`;
  // Not locking the resolving above: one call may take tens of seconds, and a send_message cleanup waiting behind it would always run out of time.
  // Not leaving the list and the save unlocked: a save made between the cleanup's list and its DELETE would be the draft it deletes.
  const same = await withDraftLock(uid, ch.id, rootId, () => saveLocked(mm, uid, ch, rootId, args, where));
  if (same) return same;
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

async function listDrafts(mm: Mm, uid: string, ch: Pick<ChannelRef, 'teamId'>): Promise<Draft[]> {
  const list = await worded(draftsOf(mm, uid, ch), { id: [DISABLED] });
  if (!list) throw new InputError('所属しているチームがないため、既存の下書きを確かめられません。');
  return list;
}

async function saveLocked(mm: Mm, uid: string, ch: ChannelRef, rootId: string, args: DraftArgs, where: string): Promise<CallToolResult | undefined> {
  const list = await listDrafts(mm, uid, ch);
  const existing = list.find((d) => d.channel_id === ch.id && (d.root_id || '') === rootId);
  if (existing?.message === args.message) return text(`同じ下書きがあります。保存し直していません。\n${where}\n${LEFT_BEHIND}`);
  if (existing && !args.overwrite) {
    const head = [...existing.message].slice(0, 200).join('');
    throw new InputError([
      '同じ投稿先に、本文の違う下書きがあります。上書きしていません。上書きするときは overwrite: true を付けてください（添付ファイル、優先度、burn-on-read も失われます）。',
      where,
      `既存の下書き（先頭 200 文字）: ${head}`,
    ].join('\n'));
  }
  await worded(mm.call(uid, 'POST', '/drafts', { channel_id: ch.id, root_id: rootId, message: args.message }), {
    id: [DISABLED, [400, 'api.draft.create_draft.can_not_draft_to_deleted.error', 'アーカイブ済みのチャンネルには下書きを保存できません。']],
    status: [[403, 'このチャンネルに下書きを保存する権限がありません。']],
  });
  return undefined;
}

const prepareSchema = { channel: z.string().min(1).describe('投稿先。チャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。DM とグループ DM は無ければ作る') };
type PrepareArgs = { channel: string };
const MiB = 1024 * 1024;

export async function prepareUpload(mm: Mm, store: Store, uid: string, publicUrl: string, maxBytes: number, args: PrepareArgs): Promise<CallToolResult> {
  const full = () => new InputError(`使われていないアップロード URL が ${MAX_OPEN_UPLOAD_URLS} 件あります。それを使うか、10 分の期限が切れるのを待ってください。`);
  // Not left to createUploadUrl alone: resolving may create the DM first, and failing after that leaves it empty. A URL issued or released between the two checks still does.
  if (store.openUploadUrlCount(uid) >= MAX_OPEN_UPLOAD_URLS) throw full();
  const ch = args.channel.trim().startsWith('@')
    ? await resolveCreatingAfter(mm, uid, args.channel, () => checkFilesAccepted(mm, uid, []))
    : await resolveChannel(mm, uid, args.channel, { create: true });
  const token = store.createUploadUrl({ mmUserId: uid, channelId: ch.id });
  if (!token) throw full();
  const limit = maxBytes % MiB ? `${maxBytes} バイト` : `${maxBytes / MiB}MiB`;
  return text([
    `アップロード用の URL を発行しました。10 分間、1 回だけ使えます（1 回で ${MAX_UPLOAD_FILES} 件まで、送る本文は multipart の枠を含めて ${limit} まで）。`,
    `投稿先: ${ch.displayName || ch.name}（channel_id: ${ch.id}）`,
    '実行する前に、送るファイルのパスと投稿先を利用者に示して、確認を取ってください。',
    '',
    `curl -sS -F 'file=@<ファイルのパス>' ${publicUrl}/mcp/upload/${token}`,
    '',
    '複数のファイルは -F \'file=@<パス>\' を繰り返します。返ってきた file_id を send_message の file_ids に渡して、同じチャンネルへ投稿してください。予約するときは schedule_message の file_ids に渡します。',
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
    description: '投稿せずに、本人の Mattermost の下書きとして保存する。送信は本人が画面で行う。root_id を渡すとスレッドへの返信の下書きになる。同じ投稿先に本文の違う下書きがあれば、overwrite: true が無い限り上書きしない。下書きの同期を切っている利用者には保存しない。この下書きと同じ本文を send_message で送ると、投稿の後に下書きを消す（添付の付いた下書きは消さない）',
    inputSchema: draftSchema,
    annotations: destructive,
  }, guarded(ctx, 'save_draft', async (args: DraftArgs, extra: { signal: AbortSignal }) => saveDraft(mmOf(extra.signal), ctx.mmUserId, args),
  ) as unknown as ToolCallback<typeof draftSchema>);

  server.registerTool('prepare_upload', {
    description: '利用者の PC にあるファイル（スクリーンショット、PDF など）を添付するための、使い捨てのアップロード URL と curl のコマンドを返す。PC でコマンドを実行できるクライアント（Claude Code、Codex CLI など）向けで、パスの分からないファイル（Claude Code に貼り付けた画像など）は利用者にパスを聞き、無ければ末尾の案内に従う。curl を実行する前に、送るファイルのパスと投稿先を利用者に示して確認を取ること。PC でコマンドを実行できないクライアント（claude.ai など）とパスの無いファイルでは、save_draft で本文を下書きにし、ファイルは Mattermost の画面から添付するよう案内する',
    inputSchema: prepareSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'prepare_upload', async (args: PrepareArgs, extra: { signal: AbortSignal }) =>
    prepareUpload(mmOf(extra.signal), ctx.store, ctx.mmUserId, ctx.cfg.publicUrl, ctx.cfg.uploadMaxBytes, args),
  ) as unknown as ToolCallback<typeof prepareSchema>);

  server.registerTool('send_message', {
    description: 'チャンネルへ投稿する。root_id を渡すとスレッドへの返信になる。channel はチャンネル ID、「チーム名/チャンネル名」、チャンネル名、@ユーザー名（DM）、@a,b（グループ DM）のどれか。DM とグループ DM は無ければ作る。添付は files（中身を直接渡す）か file_ids（prepare_upload の結果）。同じ投稿先へ同じ本文と添付を 10 分以内に送ると、やり直しとみなして投稿しない。同じ投稿先に本文の同じ下書きがあれば、投稿の後に消す（添付の付いた下書きは消さない）',
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, guarded(ctx, 'send_message', async (args: Args, extra: { signal: AbortSignal }) => {
    const mm: Mm = { call: (u, m, p, b, s) => ctx.mm.call(u, m, p, b, s ? AbortSignal.any([extra.signal, s]) : extra.signal) };
    return sendMessage(mm, ctx.store, ctx.mmUserId, ctx.cfg.mmBrowserUrl, args, extra.signal);
  // Cast for the same reason as in tools-read.ts: the SDK's callback type does not resolve for this shape.
  }) as unknown as ToolCallback<typeof inputSchema>);
}

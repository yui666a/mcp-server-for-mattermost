import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../mattermost/client.ts';
import type { MmPost } from './format.ts';
import type { Mm } from './resolve.ts';
import { failureText } from './server.ts';

export type PostSpec = { channelId: string; rootId?: string; message: string };
// Not dropping error: send_message rethrows it to keep the wording its callers already see.
export type Posting =
  | { kind: 'posted'; postId: string; fileCount: number; fileIds: string[]; redactedFileCount: number }
  | { kind: 'retryable'; sent: boolean; error: unknown }
  | { kind: 'failed'; reason: string; error: unknown };

type ListedPost = MmPost & { delete_at?: number; edit_at?: number; metadata?: { redacted_file_count?: number } };
type PostList = { order: string[]; posts: Record<string, ListedPost> };

// Not taking a claim or a lookup here: send_message uploads files between its lookup and its post, and the scheduler keys retries on its own row.
export async function postOnce(mm: Mm, uid: string, s: PostSpec & { fileIds: string[] }, pendingPostId: string): Promise<Posting> {
  const body = {
    channel_id: s.channelId, message: s.message,
    ...(s.rootId ? { root_id: s.rootId } : {}), ...(s.fileIds.length ? { file_ids: s.fileIds } : {}),
    pending_post_id: pendingPostId,
  };
  try {
    // Not in MmPost: only this module reads it, and Mattermost leaves it out when nothing was hidden.
    const post = await mm.call<MmPost & { metadata?: { redacted_file_count?: number } }>(uid, 'POST', '/posts', body);
    return { kind: 'posted', postId: post.id, fileCount: post.file_ids?.length ?? 0, fileIds: post.file_ids ?? [], redactedFileCount: post.metadata?.redacted_file_count ?? 0 };
  } catch (e) {
    if (e instanceof MmError || e instanceof Reauthorize) return { kind: 'failed', reason: failureText(e), error: e };
    // Not passing RateLimited.sent on: a 429 means Mattermost refused this request. Only an earlier request of the call (doubt) may have posted.
    if (e instanceof RateLimited) return { kind: 'retryable', sent: e.doubt, error: e };
    if (e instanceof UpstreamUnavailable) return { kind: 'retryable', sent: e.sent, error: e };
    throw e;
  }
}

// Every match rather than the first: the scheduler skips posts that other rows already own.
// Not classifying failures: callers differ on what an unknown lookup means.
export async function findPosted(mm: Mm, uid: string, s: PostSpec & { fileCount: number; fileIds?: string[] }, since: number): Promise<string[]> {
  return (await lookPosted(mm, uid, s, since)).found;
}

// Deleted posts are listed apart rather than matched: Mattermost empties their message and file_ids in since, so they cannot be told apart by text.
// Edited posts are listed apart for the same reason: the text Mattermost returns is the edited one, not the one that was posted.
// fileIds are the ones known before posting (uploaded through prepare_upload); a post with the same text and count but other files is a different post.
// Posts with the same text but other files are listed apart rather than skipped: one may be the earlier attempt with files Mattermost dropped.
export async function lookPosted(mm: Mm, uid: string, s: PostSpec & { fileCount: number; fileIds?: string[] }, since: number): Promise<{ found: string[]; deleted: string[]; edited: string[]; mismatched: string[] }> {
  const r = await mm.call<PostList>(uid, 'GET', `/channels/${s.channelId}/posts?since=${since - 1}`);
  const mine = Object.values(r.posts).filter((p) => p.user_id === uid && (p.root_id || '') === (s.rootId || '') && p.create_at >= since);
  const same = mine.filter((p) => !p.delete_at && p.message === s.message);
  // Not giving up on a post whose files Mattermost hid (ABAC denies the user the download): it empties file_ids and counts the attached files, so only the count can be matched.
  const filesMatch = (p: ListedPost) => {
    const hidden = p.metadata?.redacted_file_count ?? 0;
    if (hidden && !p.file_ids?.length) return hidden === s.fileCount;
    return (p.file_ids?.length ?? 0) === s.fileCount && (s.fileIds ?? []).every((id) => p.file_ids?.includes(id));
  };
  return {
    found: same.filter(filesMatch).map((p) => p.id),
    deleted: mine.filter((p) => p.delete_at).map((p) => p.id),
    edited: mine.filter((p) => !p.delete_at && (p.edit_at ?? 0) > 0 && p.message !== s.message).map((p) => p.id),
    mismatched: same.filter((p) => !filesMatch(p)).map((p) => p.id),
  };
}

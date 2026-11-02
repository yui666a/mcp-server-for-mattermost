import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../mattermost/client.ts';
import type { MmPost } from './format.ts';
import type { Mm } from './resolve.ts';
import { failureText } from './server.ts';

export type PostSpec = { channelId: string; rootId?: string; message: string };
// Not dropping error: send_message rethrows it to keep the wording its callers already see.
export type Posting =
  | { kind: 'posted'; postId: string; fileCount: number }
  | { kind: 'retryable'; sent: boolean; error: unknown }
  | { kind: 'failed'; reason: string; error: unknown };

type PostList = { order: string[]; posts: Record<string, MmPost & { delete_at?: number; edit_at?: number }> };

// Not taking a claim or a lookup here: send_message uploads files between its lookup and its post, and the scheduler keys retries on its own row.
export async function postOnce(mm: Mm, uid: string, s: PostSpec & { fileIds: string[] }, pendingPostId: string): Promise<Posting> {
  const body = {
    channel_id: s.channelId, message: s.message,
    ...(s.rootId ? { root_id: s.rootId } : {}), ...(s.fileIds.length ? { file_ids: s.fileIds } : {}),
    pending_post_id: pendingPostId,
  };
  try {
    const post = await mm.call<MmPost>(uid, 'POST', '/posts', body);
    return { kind: 'posted', postId: post.id, fileCount: post.file_ids?.length ?? 0 };
  } catch (e) {
    if (e instanceof MmError || e instanceof Reauthorize) return { kind: 'failed', reason: failureText(e), error: e };
    // Not passing RateLimited.sent on: a 429 means Mattermost refused this request, so nothing was posted by it.
    // ponytail: after a 401 whose refreshed pair lost the save, the check POST can time out or get a 5xx after posting and the resend then gets the 429; that post is reported as unsent (design doc, known limits).
    if (e instanceof RateLimited) return { kind: 'retryable', sent: false, error: e };
    if (e instanceof UpstreamUnavailable) return { kind: 'retryable', sent: e.sent, error: e };
    throw e;
  }
}

// Every match rather than the first: the scheduler skips posts that other rows already own.
// Not classifying failures: callers differ on what an unknown lookup means.
export async function findPosted(mm: Mm, uid: string, s: PostSpec & { fileCount: number }, since: number): Promise<string[]> {
  return (await lookPosted(mm, uid, s, since)).found;
}

// Deleted posts are listed apart rather than matched: Mattermost empties their message and file_ids in since, so they cannot be told apart by text.
// Edited posts are listed apart for the same reason: the text Mattermost returns is the edited one, not the one that was posted.
export async function lookPosted(mm: Mm, uid: string, s: PostSpec & { fileCount: number }, since: number): Promise<{ found: string[]; deleted: string[]; edited: string[] }> {
  const r = await mm.call<PostList>(uid, 'GET', `/channels/${s.channelId}/posts?since=${since - 1}`);
  const mine = Object.values(r.posts).filter((p) => p.user_id === uid && (p.root_id || '') === (s.rootId || '') && p.create_at >= since);
  return {
    found: mine.filter((p) => !p.delete_at && p.message === s.message && (p.file_ids?.length ?? 0) === s.fileCount).map((p) => p.id),
    deleted: mine.filter((p) => p.delete_at).map((p) => p.id),
    edited: mine.filter((p) => !p.delete_at && (p.edit_at ?? 0) > 0 && p.message !== s.message).map((p) => p.id),
  };
}

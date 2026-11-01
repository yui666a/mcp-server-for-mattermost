import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../mattermost/client.ts';
import type { MmPost } from './format.ts';
import type { Mm } from './resolve.ts';
import { failure } from './server.ts';

export type PostSpec = { channelId: string; rootId?: string; message: string };
// Not dropping error: send_message rethrows it to keep the wording its callers already see.
export type Posting =
  | { kind: 'posted'; postId: string; fileCount: number }
  | { kind: 'retryable'; sent: boolean; error: unknown }
  | { kind: 'failed'; reason: string; error: unknown };

type PostList = { order: string[]; posts: Record<string, MmPost & { delete_at?: number }> };

const reason = (e: unknown) => (failure(e).result.content[0] as { text: string }).text;

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
    if (e instanceof MmError || e instanceof Reauthorize) return { kind: 'failed', reason: reason(e), error: e };
    // Not passing RateLimited.sent on: a 429 reached Mattermost but was refused, so sent=false keeps meaning "certainly not posted".
    if (e instanceof RateLimited) return { kind: 'retryable', sent: false, error: e };
    if (e instanceof UpstreamUnavailable) return { kind: 'retryable', sent: e.sent, error: e };
    throw e;
  }
}

// Every match rather than the first: the scheduler skips posts that other rows already own.
// Not classifying failures: callers differ on what an unknown lookup means.
export async function findPosted(mm: Mm, uid: string, s: PostSpec & { fileCount: number }, since: number): Promise<string[]> {
  const r = await mm.call<PostList>(uid, 'GET', `/channels/${s.channelId}/posts?since=${since - 1}`);
  return Object.values(r.posts).filter((p) =>
    p.user_id === uid && (p.root_id || '') === (s.rootId || '') && p.message === s.message && (p.file_ids?.length ?? 0) === s.fileCount
    && !p.delete_at && p.create_at >= since).map((p) => p.id);
}

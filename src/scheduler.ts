import { log } from './log.ts';
import { RateLimited, Reauthorize, UpstreamUnavailable } from './mattermost/client.ts';
import { lookPosted, postOnce } from './mcp/post.ts';
import type { Mm } from './mcp/resolve.ts';
import { wordOf, type Wording } from './mcp/tools-send.ts';
import type { ClaimedScheduled, ScheduledOutcome, Store } from './store.ts';

const PER_TICK = 20;
const LATE_AFTER = 3600_000;
const UNKNOWN = '投稿されたか不明です。Mattermost の画面で確かめてください。';
const LATE = '予定時刻を 1 時間過ぎたため投稿していません。';
const UNSEALED = '本文を復号できないため投稿していません。予約を入れ直してください。';
const POST_WORDING: Wording = {
  id: [
    [400, 'api.post.create_post.can_not_post_to_deleted.error', 'チャンネルがアーカイブされたため投稿していません。'],
    [403, 'api.context.permissions.app_error', 'このチャンネルに投稿する権限がありません（チャンネルから抜けた、権限が変わった、など）。'],
    [400, 'api.post.create_post.root_id.app_error', '返信先のスレッドの親投稿が削除されたため投稿していません。'],
  ],
};
// Not the plain wording for a post with files: Mattermost also checks the upload permission then, and answers the same 403 for either.
const FILE_POST_WORDING: Wording = {
  id: POST_WORDING.id!.map(([status, id, text]) => [status, id,
    id === 'api.context.permissions.app_error' ? 'このチャンネルに投稿する権限か、ファイルを添付する権限がありません（チャンネルから抜けた、権限が変わった、など）。' : text]),
};

const failed = (error: string): ScheduledOutcome => ({ status: 'failed', error });

export async function tick(store: Store, mm: Mm, now: number): Promise<void> {
  store.resetSendingScheduled(now);
  store.failUnattemptedScheduled(now - LATE_AFTER, LATE, now);
  for (const id of store.dueScheduled(now, PER_TICK)) {
    // Not the tick's now for the attempt: findPosted passes it to Mattermost as since, which must not be ahead of Mattermost's clock.
    const s = store.claimScheduled(id, now, Date.now());
    if (!s) continue;
    let o: ScheduledOutcome;
    try {
      o = await attempt(store, mm, s, now);
    } catch (e) {
      log('scheduled_post_error', { name: (e as Error)?.name });
      // Not "not posted" for an error before the post: nothing that can throw runs before postOnce, and the lookups of a retry catch their own errors.
      o = failed(UNKNOWN);
    }
    store.settleScheduled(id, now, o);
    log('scheduled_post', { mm_user_id: s.mmUserId, outcome: o.status });
  }
}

async function attempt(store: Store, mm: Mm, s: ClaimedScheduled, now: number): Promise<ScheduledOutcome> {
  // Not "not posted" for an attempted row: the earlier attempt may have posted before the key was made again.
  if (s.message === undefined) return failed(s.firstAttemptAt === null ? UNSEALED : UNKNOWN);
  const spec = { channelId: s.channelId, rootId: s.rootId, message: s.message };
  const fileIds = s.fileIds;
  const late = s.scheduledAt < now - LATE_AFTER;
  if (s.retry) {
    let found: string | undefined;
    let touched = false;
    try {
      const owned = store.otherScheduledPostIds(s.mmUserId, s.id);
      const r = await lookPosted(mm, s.mmUserId, { ...spec, fileCount: fileIds.length, fileIds }, s.firstAttemptAt!);
      found = r.found.find((p) => !owned.has(p));
      touched = [...r.deleted, ...r.edited, ...r.mismatched].some((p) => !owned.has(p));
    } catch (e) {
      // Not posting without a lookup: the earlier attempt may have posted, and a new post would be a second one.
      if (!late && (e instanceof RateLimited || e instanceof UpstreamUnavailable)) return { status: 'pending', forgetAttempt: false };
      return failed(UNKNOWN);
    }
    // Not the found post's own file_ids: the lookup only matches posts that carry every file of the schedule, so those are the kept ones.
    if (found) return { status: 'posted', postId: found, fileIds };
    // Not posting again: a deleted or edited post may be this schedule's, changed by the user, and its text can no longer be compared; a post with other files may be the earlier attempt with files Mattermost dropped.
    if (touched) return failed(UNKNOWN);
  }
  if (late) return failed(LATE);
  const r = await postOnce(mm, s.mmUserId, { ...spec, fileIds }, s.pendingPostId!);
  if (r.kind === 'posted') {
    const kept = fileIds.filter((id) => r.fileIds.includes(id));
    const dropped = fileIds.filter((id) => !kept.includes(id));
    const note = dropped.length ? `添付した ${fileIds.length} 件のうち ${dropped.length} 件（${dropped.join(', ')}）を Mattermost が外したため、投稿に付いていません。` : undefined;
    return { status: 'posted', postId: r.postId, fileIds: kept, note };
  }
  // Not forgetting a retry's attempt: the next retry would then skip the lookup and post under a new pending_post_id.
  if (r.kind === 'retryable') return { status: 'pending', forgetAttempt: !r.sent && !s.retry };
  if (r.error instanceof Reauthorize && r.error.sent) return failed(UNKNOWN);
  // Not forgetting a retry's attempt: the earlier attempt may have posted, and this refusal does not say otherwise.
  return { status: 'failed', error: wordOf(r.error, fileIds.length ? FILE_POST_WORDING : POST_WORDING) ?? r.reason, forgetAttempt: !s.retry };
}

// Not setInterval: a tick slower than the interval would overlap the next one and claim rows the first is still posting.
export function every(ms: number, run: () => Promise<void>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const next = () => {
    timer = setTimeout(loop, ms);
    timer.unref();
  };
  const loop = async () => {
    try {
      await run();
    } catch (e) {
      log('scheduler_failed', { name: (e as Error)?.name });
    } finally {
      if (!stopped) next();
    }
  };
  next();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

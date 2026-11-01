import { log } from './log.ts';
import { RateLimited, Reauthorize, UpstreamUnavailable } from './mattermost/client.ts';
import { findPosted, postOnce } from './mcp/post.ts';
import type { Mm } from './mcp/resolve.ts';
import { wordOf, type Wording } from './mcp/tools-send.ts';
import type { ClaimedScheduled, ScheduledOutcome, Store } from './store.ts';

const PER_TICK = 20;
const LATE_AFTER = 3600_000;
const UNKNOWN = '投稿されたか不明です。Mattermost の画面で確かめてください。';
const LATE = '予定時刻を 1 時間過ぎたため投稿していません。';
const INTERNAL = '内部エラーのため投稿していません。';
const POST_WORDING: Wording = {
  id: [
    [400, 'api.post.create_post.can_not_post_to_deleted.error', 'チャンネルがアーカイブされたため投稿していません。'],
    [403, 'api.context.permissions.app_error', 'このチャンネルに投稿する権限がありません（チャンネルから抜けた、権限が変わった、など）。'],
    [400, 'api.post.create_post.root_id.app_error', '返信先のスレッドの親投稿が削除されたため投稿していません。'],
  ],
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
      o = failed(s.firstAttemptAt === null ? INTERNAL : UNKNOWN);
    }
    store.settleScheduled(id, now, o);
    log('scheduled_post', { mm_user_id: s.mmUserId, outcome: o.status });
  }
}

async function attempt(store: Store, mm: Mm, s: ClaimedScheduled, now: number): Promise<ScheduledOutcome> {
  if (s.message === undefined) throw new Error('scheduled message cannot be opened');
  const spec = { channelId: s.channelId, rootId: s.rootId, message: s.message };
  const late = s.scheduledAt < now - LATE_AFTER;
  if (s.retry) {
    let found: string | undefined;
    try {
      const owned = store.otherScheduledPostIds(s.mmUserId, s.id);
      found = (await findPosted(mm, s.mmUserId, { ...spec, fileCount: 0 }, s.firstAttemptAt!)).find((p) => !owned.has(p));
    } catch (e) {
      // Not posting without a lookup: the earlier attempt may have posted, and a new post would be a second one.
      if (!late && (e instanceof RateLimited || e instanceof UpstreamUnavailable)) return { status: 'pending', forgetAttempt: false };
      return failed(UNKNOWN);
    }
    if (found) return { status: 'posted', postId: found };
  }
  if (late) return failed(LATE);
  const r = await postOnce(mm, s.mmUserId, { ...spec, fileIds: [] }, s.pendingPostId!);
  if (r.kind === 'posted') return { status: 'posted', postId: r.postId };
  // Not forgetting a retry's attempt: the next retry would then skip the lookup and post under a new pending_post_id.
  if (r.kind === 'retryable') return { status: 'pending', forgetAttempt: !r.sent && !s.retry };
  if (r.error instanceof Reauthorize && r.error.sent) return failed(UNKNOWN);
  return failed(wordOf(r.error, POST_WORDING) ?? r.reason);
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

import { describe, expect, test } from 'vitest';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../../src/mattermost/client.ts';
import type { MmPost } from '../../src/mcp/format.ts';
import { findPosted, lookPosted, postOnce } from '../../src/mcp/post.ts';
import type { Mm } from '../../src/mcp/resolve.ts';

const UID = 'u'.repeat(26);
const OTHER_USER = 'x'.repeat(26);
const CH = 'c'.repeat(26);
const ROOT = 'r'.repeat(26);
const PENDING = 'pending-1';

type Call = { method: string; path: string; body?: unknown };
function fake(answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const mm: Mm = {
    call: (async (_u: string, method: string, path: string, body?: unknown) => {
      const c = { method, path, body };
      calls.push(c);
      return answer(c);
    }) as Mm['call'],
  };
  return { mm, calls };
}
const fails = (e: unknown) => fake(() => { throw e; }).mm;

describe('postOnce は 1 回だけ投稿し、結果を構造で返す', () => {
  test('pending_post_id を付けて投稿し、post_id と付いたファイルを返す', async () => {
    const { mm, calls } = fake(() => ({ id: 'p1', file_ids: ['f1'] }));
    const r = await postOnce(mm, UID, { channelId: CH, rootId: ROOT, message: 'hi', fileIds: ['f1', 'f2'] }, PENDING);
    expect(r).toEqual({ kind: 'posted', postId: 'p1', fileCount: 1, fileIds: ['f1'], redactedFileCount: 0 });
    expect(calls).toEqual([{
      method: 'POST', path: '/posts',
      body: { channel_id: CH, message: 'hi', root_id: ROOT, file_ids: ['f1', 'f2'], pending_post_id: PENDING },
    }]);
  });

  test('返信先とファイルが無ければ、root_id と file_ids を送らない', async () => {
    const { mm, calls } = fake(() => ({ id: 'p1' }));
    const r = await postOnce(mm, UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING);
    expect(r).toEqual({ kind: 'posted', postId: 'p1', fileCount: 0, fileIds: [], redactedFileCount: 0 });
    expect(calls[0].body).toEqual({ channel_id: CH, message: 'hi', pending_post_id: PENDING });
  });

  test('ABAC でファイルを隠した応答は、隠した件数を返す', async () => {
    const { mm } = fake(() => ({ id: 'p1', file_ids: [], metadata: { redacted_file_count: 2 } }));
    const r = await postOnce(mm, UID, { channelId: CH, message: 'hi', fileIds: ['f1', 'f2'] }, PENDING);
    expect(r).toEqual({ kind: 'posted', postId: 'p1', fileCount: 0, fileIds: [], redactedFileCount: 2 });
  });

  test('Mattermost の 4xx は、やり直さない失敗として理由を返す', async () => {
    const e = new MmError(403, 'api.context.permissions.app_error', 'no permission');
    const r = await postOnce(fails(e), UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('403'), error: e });
  });

  test('再ログインが必要なときは、やり直さない失敗として再ログインの理由を返す', async () => {
    const e = new Reauthorize(true);
    const r = await postOnce(fails(e), UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING);
    expect(r).toEqual({ kind: 'failed', reason: expect.stringContaining('Mattermost への再ログインが必要'), error: e });
  });

  test('レート制限は、Mattermost の 429 でも Limiter でも、投稿されていないやり直しにする', async () => {
    for (const sent of [true, false]) {
      const e = new RateLimited(3, sent);
      expect(await postOnce(fails(e), UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING))
        .toEqual({ kind: 'retryable', sent: false, error: e });
    }
  });

  test('接続できない失敗は、届いたかどうかを sent に持たせてやり直しにする', async () => {
    for (const sent of [true, false]) {
      const e = new UpstreamUnavailable('Mattermost unreachable', sent);
      expect(await postOnce(fails(e), UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING))
        .toEqual({ kind: 'retryable', sent, error: e });
    }
  });

  test('想定していない例外は、分類せずにそのまま投げる', async () => {
    const e = new TypeError('boom');
    await expect(postOnce(fails(e), UID, { channelId: CH, message: 'hi', fileIds: [] }, PENDING)).rejects.toBe(e);
  });
});

describe('findPosted は、since より後の同じ投稿を探す', () => {
  const SINCE = 5000;
  const base = { user_id: UID, channel_id: CH, root_id: ROOT, message: 'hi', create_at: SINCE, file_ids: ['f1'] };
  const posts: (MmPost & { delete_at?: number })[] = [
    { ...base, id: 'match1' },
    { ...base, id: 'other-user', user_id: OTHER_USER },
    { ...base, id: 'other-root', root_id: '' },
    { ...base, id: 'other-text', message: 'hello' },
    { ...base, id: 'other-files', file_ids: [] },
    { ...base, id: 'deleted', delete_at: 1 },
    { ...base, id: 'too-early', create_at: SINCE - 1 },
    { ...base, id: 'match2', create_at: SINCE + 10 },
  ];

  test('本人・同じ返信先・同じ本文・同じファイルの数・削除されていない・since 以降の投稿の id を返す', async () => {
    const { mm, calls } = fake(() => ({ order: posts.map((p) => p.id), posts: Object.fromEntries(posts.map((p) => [p.id, p])) }));
    const ids = await findPosted(mm, UID, { channelId: CH, rootId: ROOT, message: 'hi', fileCount: 1 }, SINCE);
    expect(ids).toEqual(['match1', 'match2']);
    expect(calls).toEqual([{ method: 'GET', path: `/channels/${CH}/posts?since=${SINCE - 1}`, body: undefined }]);
  });

  test('返信先が無ければ、root_id が空の投稿を同じとみなす', async () => {
    const top = { ...base, id: 'top', root_id: '', file_ids: undefined };
    const { mm } = fake(() => ({ order: ['top'], posts: { top } }));
    expect(await findPosted(mm, UID, { channelId: CH, message: 'hi', fileCount: 0 }, SINCE)).toEqual(['top']);
  });

  test('ファイルを隠された投稿（ABAC）は、件数が一致すれば同じとみなし、違えばファイルの違う投稿に分ける', async () => {
    const hidden = (id: string, count: number) => ({ ...base, id, file_ids: [], metadata: { redacted_file_count: count } });
    const list = [hidden('same-count', 2), hidden('fewer', 1)];
    const { mm } = fake(() => ({ order: list.map((p) => p.id), posts: Object.fromEntries(list.map((p) => [p.id, p])) }));
    const r = await lookPosted(mm, UID, { channelId: CH, rootId: ROOT, message: 'hi', fileCount: 2, fileIds: ['f1', 'f2'] }, SINCE);
    expect(r.found).toEqual(['same-count']);
    expect(r.mismatched).toEqual(['fewer']);
    const noFiles = await lookPosted(mm, UID, { channelId: CH, rootId: ROOT, message: 'hi', fileCount: 0 }, SINCE);
    expect(noFiles.found).toEqual([]);
    expect(noFiles.mismatched).toEqual(['same-count', 'fewer']);
    const inlineOnly = await lookPosted(mm, UID, { channelId: CH, rootId: ROOT, message: 'hi', fileCount: 2 }, SINCE);
    expect(inlineOnly.found).toEqual(['same-count']);
  });

  test('探すことに失敗したら、そのまま投げる', async () => {
    const e = new UpstreamUnavailable('Mattermost unreachable', true);
    await expect(findPosted(fails(e), UID, { channelId: CH, message: 'hi', fileCount: 0 }, SINCE)).rejects.toBe(e);
  });
});

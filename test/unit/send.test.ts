import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.ts';
import { CALL_DEADLINE_MS, MmError, RateLimited, UpstreamUnavailable } from '../../src/mattermost/client.ts';
import type { MmPost } from '../../src/mcp/format.ts';
import type { Mm } from '../../src/mcp/resolve.ts';
import { sendMessage } from '../../src/mcp/tools-send.ts';
import { INFLIGHT_GRACE, Store } from '../../src/store.ts';

const UID = 'u'.repeat(26);
const CH = 'c'.repeat(26);
const OTHER = 'o'.repeat(26);
const BASE = 'https://mm.example';
const id = (n: number) => `p${String(n).padStart(25, '0')}`;

type Mode = 'before' | 'after' | 'lost' | 'reject' | 'rate429' | undefined;

type Upload = { query: URLSearchParams; type: string; bytes: Uint8Array };
type FakeOpts = {
  failPost?: () => Mode; postDelay?: Promise<void>; failSearch?: () => boolean;
  onUpload?: (n: number) => Promise<void> | void; failUpload?: (n: number) => Mode; keepFiles?: (ids: string[]) => string[];
};

function fakeMm(opts: FakeOpts = {}) {
  let now = 1_000_000;
  const store = new Store(openDb(':memory:'), randomBytes(32), () => now);
  const posts: MmPost[] = [{ id: id(0), user_id: UID, channel_id: OTHER, root_id: '', message: 'root elsewhere', create_at: 0 }];
  const created: unknown[] = [];
  const byPending = new Map<string, MmPost>();
  const uploads: Upload[] = [];
  const mm: Mm = {
    call: (async (_u: string, method: string, path: string, body?: any) => {
      const p = path.split('?')[0];
      if (method === 'GET' && p === '/users/me/teams') return [{ id: 'ta', name: 'team-a' }, { id: 'tb', name: 'team-b' }];
      if (method === 'GET' && p === '/teams/ta/channels/name/dup') return { id: CH, name: 'dup', display_name: 'Dup', team_id: 'ta', type: 'O' };
      if (method === 'GET' && p === '/teams/tb/channels/name/dup') return { id: OTHER, name: 'dup', display_name: 'Dup', team_id: 'tb', type: 'O' };
      if (method === 'GET' && p === '/teams/name/team-a/channels/name/dup') return { id: CH, name: 'dup', display_name: 'Dup', team_id: 'ta', type: 'O' };
      if (method === 'GET' && p.startsWith('/posts/')) {
        const found = posts.find((x) => x.id === p.slice('/posts/'.length));
        if (!found) throw new MmError(404, 'not_found', 'not found');
        return found;
      }
      if (method === 'GET' && p === `/channels/${CH}/posts`) {
        if (opts.failSearch?.()) throw new UpstreamUnavailable('Mattermost unreachable', true);
        const since = Number(new URLSearchParams(path.split('?')[1]).get('since'));
        // Strict like Mattermost's GetPostsSince (UpdateAt > since); posts here are never edited, so update_at = create_at.
        const hit = posts.filter((x) => x.channel_id === CH && x.create_at > since);
        return { order: hit.map((x) => x.id), posts: Object.fromEntries(hit.map((x) => [x.id, x])) };
      }
      if (method === 'POST' && p === '/files') {
        const n = uploads.length;
        await opts.onUpload?.(n);
        const mode = opts.failUpload?.(n);
        if (mode === 'before') throw new RateLimited(5, false);
        uploads.push({ query: new URLSearchParams(path.split('?')[1]), type: (body as Blob).type, bytes: new Uint8Array(await (body as Blob).arrayBuffer()) });
        if (mode === 'reject') throw new MmError(400, 'api.file.upload_file.large_image_detailed.app_error', 'too big');
        if (mode === 'lost') throw new UpstreamUnavailable('Mattermost unreachable', true);
        return { file_infos: [{ id: `f${String(n).padStart(25, '0')}` }] };
      }
      if (method === 'POST' && p === '/posts') {
        await opts.postDelay;
        const mode = opts.failPost?.();
        if (mode === 'before') throw new RateLimited(5, false);
        created.push(body);
        if (mode === 'reject') throw new MmError(400, 'bad_request', 'bad');
        if (mode === 'rate429') throw new RateLimited(5, true);
        if (mode === 'lost') throw new UpstreamUnavailable('Mattermost unreachable', true);
        const dup = body.pending_post_id ? byPending.get(body.pending_post_id) : undefined;
        const kept = body.file_ids && (opts.keepFiles?.(body.file_ids) ?? body.file_ids);
        const post = dup ?? {
          id: id(posts.length), user_id: UID, channel_id: body.channel_id, root_id: body.root_id ?? '', message: body.message, create_at: now,
          ...(kept?.length ? { file_ids: kept } : {}),
        };
        if (!dup) {
          posts.push(post);
          if (body.pending_post_id) byPending.set(body.pending_post_id, post);
        }
        if (mode === 'after') throw new UpstreamUnavailable('Mattermost unreachable', true);
        return post;
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as Mm['call'],
  };
  const send = (args: Parameters<typeof sendMessage>[4]) => sendMessage(mm, store, UID, BASE, args);
  return { send, store, created, uploads, posts, advance: (ms: number) => { now += ms; } };
}

const textOf = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

test('a Mattermost call always ends before an in-flight claim is treated as abandoned', () => {
  expect(CALL_DEADLINE_MS).toBeLessThan(INFLIGHT_GRACE);
});

test('ambiguous channel name is rejected for send_message', async () => {
  const f = fakeMm();
  await expect(f.send({ channel: 'dup', message: 'hi' })).rejects.toMatchObject({ name: 'Ambiguous' });
  expect(f.created).toHaveLength(0);
});

test('root_id in another channel is rejected', async () => {
  const f = fakeMm();
  await expect(f.send({ channel: 'team-a/dup', message: 'hi', root_id: id(0) })).rejects.toMatchObject({ name: 'InputError' });
  expect(f.created).toHaveLength(0);
});

test('retry after a lost response does not double post', async () => {
  let first = true;
  const f = fakeMm({ failPost: () => (first ? ((first = false), 'after') : undefined) });
  await expect(f.send({ channel: 'team-a/dup', message: 'hello' })).rejects.toBeInstanceOf(UpstreamUnavailable);
  expect(f.created).toHaveLength(1);
  f.advance(31_000);
  const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
  expect(r.isError).toBeFalsy();
  expect(f.created).toHaveLength(1);
  expect(textOf(r)).toContain(id(1));
  expect(textOf(r)).toContain(`${BASE}/team-a/pl/${id(1)}`);
  const again = await f.send({ channel: 'team-a/dup', message: 'hello' });
  expect(textOf(again)).toContain(id(1));
  expect(f.created).toHaveLength(1);
});

test('retry within the grace period is reported as in progress without posting', async () => {
  const f = fakeMm({ failPost: () => 'after' });
  await expect(f.send({ channel: 'team-a/dup', message: 'hello' })).rejects.toBeInstanceOf(UpstreamUnavailable);
  f.advance(10_000);
  const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('処理中');
  expect(f.created).toHaveLength(1);
});

test('retry that finds no earlier post posts with the same pending_post_id', async () => {
  let first = true;
  const f = fakeMm({ failPost: () => (first ? ((first = false), 'lost') : undefined) });
  await expect(f.send({ channel: 'team-a/dup', message: 'x' })).rejects.toBeInstanceOf(UpstreamUnavailable);
  f.advance(31_000);
  expect((await f.send({ channel: 'team-a/dup', message: 'x' })).isError).toBeFalsy();
  const created = f.created as { pending_post_id: string }[];
  expect(created).toHaveLength(2);
  expect(created[1].pending_post_id).toBe(created[0].pending_post_id);
});

test('concurrent identical calls post once', async () => {
  let release!: () => void;
  const f = fakeMm({ postDelay: new Promise<void>((r) => { release = r; }) });
  const a = f.send({ channel: 'team-a/dup', message: 'same' });
  const b = f.send({ channel: 'team-a/dup', message: 'same' });
  const rb = await b;
  release();
  const ra = await a;
  expect(ra.isError).toBeFalsy();
  expect(rb.isError).toBe(true);
  expect(textOf(rb)).toContain('処理中');
  expect(f.created).toHaveLength(1);
});

test('allow_duplicate posts again', async () => {
  const f = fakeMm();
  await f.send({ channel: 'team-a/dup', message: 'again' });
  const r = await f.send({ channel: 'team-a/dup', message: 'again', allow_duplicate: true });
  await f.send({ channel: 'team-a/dup', message: 'again', allow_duplicate: true });
  expect(r.isError).toBeFalsy();
  const created = f.created as { pending_post_id?: string }[];
  expect(created).toHaveLength(3);
  expect(created.every((c) => typeof c.pending_post_id === 'string')).toBe(true);
  expect(new Set(created.map((c) => c.pending_post_id)).size).toBe(3);
});

test('rate limited before sending drops the claim so an immediate retry is not blocked', async () => {
  let first = true;
  const f = fakeMm({ failPost: () => (first ? ((first = false), 'before') : undefined) });
  await expect(f.send({ channel: 'team-a/dup', message: 'rl' })).rejects.toBeInstanceOf(RateLimited);
  const r = await f.send({ channel: 'team-a/dup', message: 'rl' });
  expect(r.isError).toBeFalsy();
  expect(f.created).toHaveLength(1);
});

test('a 4xx rejection drops the claim', async () => {
  let first = true;
  const f = fakeMm({ failPost: () => (first ? ((first = false), 'reject') : undefined) });
  await expect(f.send({ channel: 'team-a/dup', message: 'bad' })).rejects.toBeInstanceOf(MmError);
  expect((await f.send({ channel: 'team-a/dup', message: 'bad' })).isError).toBeFalsy();
});

test('a 429 from Mattermost drops the claim', async () => {
  let first = true;
  const f = fakeMm({ failPost: () => (first ? ((first = false), 'rate429') : undefined) });
  await expect(f.send({ channel: 'team-a/dup', message: '429' })).rejects.toBeInstanceOf(RateLimited);
  expect((await f.send({ channel: 'team-a/dup', message: '429' })).isError).toBeFalsy();
});

test('a failed lookup on the retry path keeps the claim', async () => {
  let search = true;
  const f = fakeMm({ failPost: () => 'after', failSearch: () => search });
  await expect(f.send({ channel: 'team-a/dup', message: 'look' })).rejects.toBeInstanceOf(UpstreamUnavailable);
  f.advance(31_000);
  await expect(f.send({ channel: 'team-a/dup', message: 'look' })).rejects.toBeInstanceOf(UpstreamUnavailable);
  search = false;
  const r = await f.send({ channel: 'team-a/dup', message: 'look' });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain('処理中');
  expect(f.created).toHaveLength(1);
});

describe('send_message with files', () => {
  const txt = (name: string, content_text: string) => ({ name, content_text });
  const b64 = (name: string, bytes: number[]) => ({ name, content_base64: Buffer.from(bytes).toString('base64') });
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test('uploads each file in order to the channel, then posts once with their file_ids', async () => {
    const f = fakeMm();
    const r = await f.send({ channel: 'team-a/dup', message: 'with files', files: [txt('a.md', '# 見出し'), b64('b.png', PNG)] });
    expect(r.isError).toBeFalsy();
    expect(f.uploads.map((u) => [u.query.get('channel_id'), u.query.get('filename'), [...u.bytes]])).toEqual([
      [CH, 'a.md', [...Buffer.from('# 見出し', 'utf8')]],
      [CH, 'b.png', PNG],
    ]);
    expect(f.created).toEqual([expect.objectContaining({ message: 'with files', file_ids: [`f${'0'.repeat(24)}0`, `f${'0'.repeat(24)}1`] })]);
    expect(textOf(r)).toContain('2 件');
  });

  test('the same message and files within 10 minutes count as the same post and are neither uploaded nor posted again', async () => {
    const f = fakeMm();
    const args = { channel: 'team-a/dup', message: 'same', files: [txt('a.txt', 'x')] };
    await f.send(args);
    const r = await f.send(args);
    expect(textOf(r)).toContain('投稿していません');
    expect(f.uploads).toHaveLength(1);
    expect(f.created).toHaveLength(1);
  });

  test.each([
    ['different contents', [txt('a.txt', 'x')], [txt('a.txt', 'y')]],
    ['different names', [txt('a.txt', 'x')], [txt('b.txt', 'x')]],
    ['a different order', [txt('a.txt', 'x'), txt('b.txt', 'y')], [txt('b.txt', 'y'), txt('a.txt', 'x')]],
    ['no files against files', [], [txt('a.txt', 'x')]],
  ])('the same message with %s is a different post', async (_, one, two) => {
    const f = fakeMm();
    await f.send({ channel: 'team-a/dup', message: 'm', ...(one.length ? { files: one } : {}) });
    await f.send({ channel: 'team-a/dup', message: 'm', files: two });
    expect(f.created).toHaveLength(2);
  });

  test('inputs that only move the boundary between the message, a name and a content are different posts', async () => {
    const f = fakeMm();
    await f.send({ channel: 'team-a/dup', message: 'ab', files: [txt('c', 'd')] });
    await f.send({ channel: 'team-a/dup', message: 'a', files: [txt('bc', 'd')] });
    await f.send({ channel: 'team-a/dup', message: 'a', files: [txt('b', 'cd')] });
    await f.send({ channel: 'team-a/dup', message: 'a', files: [txt('b', 'c'), txt('d', 'x')] });
    expect(f.created).toHaveLength(4);
  });

  test('a second identical call arriving while the first is still uploading past the 30 s grace leaves only one POST /posts', async () => {
    let second: Promise<unknown> | undefined;
    const f = fakeMm({
      onUpload: async () => {
        if (second) return;
        f.advance(31_000);
        second = f.send({ channel: 'team-a/dup', message: 'slow', files: [txt('a.txt', 'x')] });
        await second;
      },
    });
    const first = await f.send({ channel: 'team-a/dup', message: 'slow', files: [txt('a.txt', 'x')] });
    const results = [first, await second] as { isError?: boolean; content: unknown[] }[];
    expect(f.created).toHaveLength(1);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    expect(textOf(results.find((r) => r.isError)!)).toContain('処理中');
  });

  test('a retry that finds the earlier post with the same message and number of files neither uploads nor posts', async () => {
    let first = true;
    const f = fakeMm({ failPost: () => (first ? ((first = false), 'after') : undefined) });
    const args = { channel: 'team-a/dup', message: 'lost', files: [txt('a.txt', 'x')] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    f.advance(31_000);
    const r = await f.send(args);
    expect(textOf(r)).toContain('既にあったため');
    expect(f.uploads).toHaveLength(1);
    expect(f.created).toHaveLength(1);
  });

  test('a retry does not take an earlier post with the same message but a different number of files for its own', async () => {
    let first = true;
    const f = fakeMm({ failPost: () => (first ? ((first = false), 'lost') : undefined) });
    const args = { channel: 'team-a/dup', message: 'count', files: [txt('a.txt', 'x')] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    f.posts.push({ id: id(99), user_id: UID, channel_id: CH, root_id: '', message: 'count', create_at: 1_000_000 });
    f.advance(31_000);
    const r = await f.send(args);
    expect(textOf(r)).toContain('投稿しました');
    expect(f.created).toHaveLength(2);
  });

  test.each([
    ['refused (4xx)', 'reject'],
    ['rate limited before sending', 'before'],
  ] as const)('an upload %s drops the claim and does not post, so sending again uploads and posts', async (_, mode) => {
    let first = true;
    const f = fakeMm({ failUpload: () => (first ? ((first = false), mode) : undefined) });
    const args = { channel: 'team-a/dup', message: 'up', files: [txt('a.txt', 'x')] };
    await expect(f.send(args)).rejects.toThrow();
    expect(f.created).toHaveLength(0);
    expect((await f.send(args)).isError).toBeFalsy();
    expect(f.created).toHaveLength(1);
  });

  test('a lost upload response keeps the claim, so an immediate resend is reported as in progress', async () => {
    let first = true;
    const f = fakeMm({ failUpload: () => (first ? ((first = false), 'lost') : undefined) });
    const args = { channel: 'team-a/dup', message: 'up', files: [txt('a.txt', 'x')] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(textOf(await f.send(args))).toContain('処理中');
    expect(f.created).toHaveLength(0);
  });

  test('says so when Mattermost silently dropped some of the uploaded files from the post', async () => {
    const f = fakeMm({ keepFiles: (ids) => ids.slice(0, 1) });
    const r = await f.send({ channel: 'team-a/dup', message: 'dropped', files: [txt('a.txt', 'x'), txt('b.txt', 'y')] });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('投稿しました');
    expect(textOf(r)).toContain('2 件のうち 1 件');
  });

  test('allow_duplicate uploads the files again and posts them', async () => {
    const f = fakeMm();
    const args = { channel: 'team-a/dup', message: 'dup', files: [txt('a.txt', 'x')], allow_duplicate: true };
    await f.send(args);
    await f.send(args);
    expect(f.uploads).toHaveLength(2);
    expect(f.created).toEqual([expect.objectContaining({ file_ids: [expect.any(String)] }), expect.objectContaining({ file_ids: [expect.any(String)] })]);
  });
});

describe('send_message with file_ids from prepare_upload', () => {
  const F1 = 'a'.repeat(26);
  const F2 = 'b'.repeat(26);
  const uploaded = (f: ReturnType<typeof fakeMm>, ids: string[], channelId = CH) => {
    for (const i of ids) f.store.recordUploadedFile({ mmUserId: UID, channelId }, i);
  };

  test('posts with the given file_ids after the files sent inline, and marks them as posted', async () => {
    const f = fakeMm();
    uploaded(f, [F1, F2]);
    const r = await f.send({ channel: 'team-a/dup', message: 'pc files', files: [{ name: 'a.txt', content_text: 'x' }], file_ids: [F1, F2] });
    expect(textOf(r)).toContain('ファイル 3 件を添付しました');
    expect(f.created).toEqual([expect.objectContaining({ file_ids: [`f${'0'.repeat(25)}`, F1, F2] })]);
    expect(f.store.uploadedFiles(UID, [F1, F2]).map((x) => x.postId)).toEqual([id(1), id(1)]);
  });

  test.each([
    ['a file_id this MCP did not record', () => {}, 'prepare_upload の URL で 24 時間以内にアップロードしたファイルではありません'],
    ['a file uploaded for another channel', (f: ReturnType<typeof fakeMm>) => uploaded(f, [F1], OTHER), '別のチャンネル'],
  ])('refuses %s without posting', async (_, arrange, message) => {
    const f = fakeMm();
    arrange(f);
    await expect(f.send({ channel: 'team-a/dup', message: 'x', file_ids: [F1] })).rejects.toThrow(message);
    expect(f.created).toHaveLength(0);
  });

  test('refuses the same file_id twice in one call', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    await expect(f.send({ channel: 'team-a/dup', message: 'x', file_ids: [F1, F1] })).rejects.toThrow('重なっています');
  });

  test('refuses a file already used by another post, and a later send of the same message is not blocked by a claim', async () => {
    const f = fakeMm();
    uploaded(f, [F1, F2]);
    await f.send({ channel: 'team-a/dup', message: 'first', file_ids: [F1] });
    await expect(f.send({ channel: 'team-a/dup', message: 'second', file_ids: [F1] })).rejects.toThrow('既に投稿');
    expect(f.created).toHaveLength(1);
    expect((await f.send({ channel: 'team-a/dup', message: 'second', file_ids: [F2] })).isError).toBeFalsy();
  });

  test('marks only the files the post kept when Mattermost dropped some of them', async () => {
    const f = fakeMm({ keepFiles: (ids) => ids.slice(0, 1) });
    uploaded(f, [F1, F2]);
    const r = await f.send({ channel: 'team-a/dup', message: 'dropped', file_ids: [F1, F2] });
    expect(textOf(r)).toContain('2 件のうち 1 件');
    expect(f.store.uploadedFiles(UID, [F1, F2]).map((x) => x.postId)).toEqual([id(1), null]);
  });

  test('marks the kept file by identity, not by position, when Mattermost dropped the first one', async () => {
    const f = fakeMm({ keepFiles: (ids) => ids.slice(1) });
    uploaded(f, [F1, F2]);
    await f.send({ channel: 'team-a/dup', message: 'dropped first', file_ids: [F1, F2] });
    expect(f.store.uploadedFiles(UID, [F1, F2]).map((x) => x.postId)).toEqual([null, id(1)]);
  });

  test('allow_duplicate posts with the file_ids and marks them as posted', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    const r = await f.send({ channel: 'team-a/dup', message: 'again', file_ids: [F1], allow_duplicate: true });
    expect(textOf(r)).toContain('ファイル 1 件を添付しました');
    expect(f.created).toEqual([expect.objectContaining({ file_ids: [F1] })]);
    expect(f.store.uploadedFiles(UID, [F1])[0].postId).toBe(id(1));
  });

  test('a retry does not take a post with the same message and number of files but other file_ids for its own', async () => {
    let first = true;
    const f = fakeMm({ failPost: () => (first ? ((first = false), 'lost') : undefined) });
    uploaded(f, [F1, F2]);
    const args = { channel: 'team-a/dup', message: 'look alike', file_ids: [F1] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    await f.send({ ...args, file_ids: [F2], allow_duplicate: true });
    f.advance(31_000);
    const r = await f.send(args);
    expect(textOf(r)).toContain('投稿しました');
    expect(f.store.uploadedFiles(UID, [F1, F2]).map((x) => x.postId)).toEqual([id(2), id(1)]);
  });

  test('allow_duplicate also refuses a file already used by another post', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    await f.send({ channel: 'team-a/dup', message: 'once', file_ids: [F1] });
    await expect(f.send({ channel: 'team-a/dup', message: 'once', file_ids: [F1], allow_duplicate: true })).rejects.toThrow('既に投稿');
  });

  test('sending the same message and file_ids again within 10 minutes is reported as already posted', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    const args = { channel: 'team-a/dup', message: 'same', file_ids: [F1] };
    await f.send(args);
    expect(textOf(await f.send(args))).toContain('投稿していません');
    expect(f.created).toHaveLength(1);
  });

  test('the same message with different file_ids is a different post', async () => {
    const f = fakeMm();
    uploaded(f, [F1, F2]);
    await f.send({ channel: 'team-a/dup', message: 'm', file_ids: [F1] });
    await f.send({ channel: 'team-a/dup', message: 'm', file_ids: [F2] });
    expect(f.created).toHaveLength(2);
  });

  const holdBySchedule = (f: ReturnType<typeof fakeMm>, fileIds: string[]) =>
    f.store.createScheduled({ mmUserId: UID, channelId: CH, message: 'scheduled', scheduledAt: Date.now() + 3600_000, fileIds }, Date.now())!;

  test('a file a pending schedule holds is refused with the schedule\'s id, and nothing is posted', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    const sid = holdBySchedule(f, [F1]);
    await expect(f.send({ channel: 'team-a/dup', message: 'x', file_ids: [F1] })).rejects.toThrow(`予約（予約 ID: ${sid}）の添付に使われています`);
    expect(f.created).toHaveLength(0);
  });

  test('a file that a posted schedule holds is refused as already posted', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    holdBySchedule(f, [F1]);
    f.store.markFilesPosted(UID, [F1], 'p'.repeat(26));
    await expect(f.send({ channel: 'team-a/dup', message: 'x', file_ids: [F1] })).rejects.toThrow('既に投稿');
  });

  test('allow_duplicate also refuses a file a schedule holds', async () => {
    const f = fakeMm();
    uploaded(f, [F1]);
    holdBySchedule(f, [F1]);
    await expect(f.send({ channel: 'team-a/dup', message: 'x', file_ids: [F1], allow_duplicate: true })).rejects.toThrow('添付に使われています');
    expect(f.created).toHaveLength(0);
  });

  test('a retry that finds its earlier post is not refused for a file a schedule took since', async () => {
    let first = true;
    const f = fakeMm({ failPost: () => (first ? ((first = false), 'after') : undefined) });
    uploaded(f, [F1]);
    const args = { channel: 'team-a/dup', message: 'lost', file_ids: [F1] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    holdBySchedule(f, [F1]);
    f.advance(31_000);
    expect(textOf(await f.send(args))).toContain('既にあったため');
    expect(f.created).toHaveLength(1);
  });

  test('a retry that finds the earlier post counts the file_ids, marks them as posted and does not post', async () => {
    let first = true;
    const f = fakeMm({ failPost: () => (first ? ((first = false), 'after') : undefined) });
    uploaded(f, [F1]);
    const args = { channel: 'team-a/dup', message: 'lost', file_ids: [F1] };
    await expect(f.send(args)).rejects.toBeInstanceOf(UpstreamUnavailable);
    f.advance(31_000);
    expect(textOf(await f.send(args))).toContain('既にあったため');
    expect(f.created).toHaveLength(1);
    expect(f.store.uploadedFiles(UID, [F1])[0].postId).toBe(id(1));
  });
});

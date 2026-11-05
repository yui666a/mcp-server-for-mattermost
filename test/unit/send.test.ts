import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb } from '../../src/db.ts';
import { CALL_DEADLINE_MS, MmError, RateLimited, Reauthorize, UpstreamUnavailable } from '../../src/mattermost/client.ts';
import type { MmPost } from '../../src/mcp/format.ts';
import type { Mm } from '../../src/mcp/resolve.ts';
import { sendMessage } from '../../src/mcp/tools-send.ts';
import { INFLIGHT_GRACE, Store } from '../../src/store.ts';

const UID = 'u'.repeat(26);
const CH = 'c'.repeat(26);
const OTHER = 'o'.repeat(26);
const DM = 'd'.repeat(26);
const BASE = 'https://mm.example';
const id = (n: number) => `p${String(n).padStart(25, '0')}`;

type Mode = 'before' | 'after' | 'lost' | 'reject' | 'rate429' | undefined;

type Upload = { query: URLSearchParams; type: string; bytes: Uint8Array };
type FakeOpts = {
  failPost?: () => Mode; postDelay?: Promise<void>; failSearch?: () => boolean;
  onUpload?: (n: number) => Promise<void> | void; failUpload?: (n: number) => Mode; keepFiles?: (ids: string[]) => string[];
  drafts?: (signal?: AbortSignal) => unknown; hiddenPost?: string; syncOff?: boolean | (() => unknown); failDelete?: () => Error | undefined; teams?: { id: string; name: string }[];
};

function fakeMm(opts: FakeOpts = {}) {
  let now = 1_000_000;
  const store = new Store(openDb(':memory:'), randomBytes(32), () => now);
  const posts: MmPost[] = [{ id: id(0), user_id: UID, channel_id: OTHER, root_id: '', message: 'root elsewhere', create_at: 0 }];
  const created: unknown[] = [];
  const byPending = new Map<string, MmPost>();
  const uploads: Upload[] = [];
  const calls: { method: string; path: string; signal?: AbortSignal }[] = [];
  const mm: Mm = {
    call: (async (_u: string, method: string, path: string, body?: any, signal?: AbortSignal) => {
      const p = path.split('?')[0];
      calls.push({ method, path: p, signal });
      if (method === 'GET' && p === '/users/me/teams') return opts.teams ?? [{ id: 'ta', name: 'team-a' }, { id: 'tb', name: 'team-b' }];
      if (method === 'GET' && p === `/channels/${DM}`) return { id: DM, name: `${UID}__${OTHER}`, display_name: '', team_id: '', type: 'D' };
      if (method === 'GET' && /^\/users\/[^/]+\/teams\/[^/]+\/drafts$/.test(p)) return opts.drafts ? opts.drafts(signal) : [];
      if (method === 'GET' && p === '/users/me/preferences/advanced_settings/name/sync_drafts') {
        if (typeof opts.syncOff === 'function') return opts.syncOff();
        if (opts.syncOff) return { value: 'false' };
        throw new MmError(400, 'app.preference.get.app_error', 'not found');
      }
      if (method === 'DELETE' && p.startsWith(`/users/${UID}/channels/`)) {
        const e = opts.failDelete?.();
        if (e) throw e;
        return { status: 'OK' };
      }
      if (method === 'GET' && p === '/teams/ta/channels/name/dup') return { id: CH, name: 'dup', display_name: 'Dup', team_id: 'ta', type: 'O' };
      if (method === 'GET' && p === '/teams/tb/channels/name/dup') return { id: OTHER, name: 'dup', display_name: 'Dup', team_id: 'tb', type: 'O' };
      if (method === 'GET' && p === '/teams/name/team-a/channels/name/dup') return { id: CH, name: 'dup', display_name: 'Dup', team_id: 'ta', type: 'O' };
      if (method === 'GET' && p.startsWith('/posts/')) {
        if (p.slice('/posts/'.length) === opts.hiddenPost) throw new MmError(403, 'api.context.permissions.app_error', 'forbidden');
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
  const send = (args: Parameters<typeof sendMessage>[4], client?: AbortSignal) => sendMessage(mm, store, UID, BASE, args, client);
  return { send, store, created, uploads, posts, calls, advance: (ms: number) => { now += ms; } };
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

describe('root_id', () => {
  const ROOT = id(7);
  const REPLY = id(8);
  const withRoots = (opts: FakeOpts = {}) => {
    const f = fakeMm(opts);
    f.posts.push({ id: ROOT, user_id: UID, channel_id: CH, root_id: '', message: 'root', create_at: 0 });
    f.posts.push({ id: REPLY, user_id: UID, channel_id: CH, root_id: ROOT, message: 'reply', create_at: 0 });
    return f;
  };

  test.each([
    ['missing', id(9), {}, `root_id ${id(9)} の投稿が見つかりません。`],
    ['not visible', id(9), { hiddenPost: id(9) }, `root_id ${id(9)} の投稿を見られません。`],
    ['a reply', REPLY, {}, `root_id ${REPLY} は返信です。スレッドの親投稿の post_id を指定してください。`],
  ])('a root_id that is %s is refused with its reason, posting nothing', async (_, rootId, opts, msg) => {
    const f = withRoots(opts);
    await expect(f.send({ channel: 'team-a/dup', message: 'hi', root_id: rootId })).rejects.toMatchObject({ name: 'InputError', message: msg });
    expect(f.created).toHaveLength(0);
  });

  test('a refused root_id leaves no duplicate-guard record, so the same send posts once the root can be seen', async () => {
    const opts: FakeOpts = { hiddenPost: ROOT };
    const f = withRoots(opts);
    await expect(f.send({ channel: 'team-a/dup', message: 'hi', root_id: ROOT })).rejects.toMatchObject({ name: 'InputError' });
    opts.hiddenPost = undefined;
    const r = await f.send({ channel: 'team-a/dup', message: 'hi', root_id: ROOT });
    expect(textOf(r)).toContain('投稿しました。');
    expect(f.created).toHaveLength(1);
  });

  test('a root_id in another channel than a DM given by its channel_id names the DM by its internal name, which is all Mattermost gives', async () => {
    const f = fakeMm();
    await expect(f.send({ channel: DM, message: 'hi', root_id: id(0) })).rejects.toMatchObject({
      message: `root_id ${id(0)} の投稿はチャンネル「${UID}__${OTHER}」（channel_id: ${DM}）にありません。`,
    });
    expect(f.created).toHaveLength(0);
  });

  test('a reply in another channel is refused as being in another channel, which is checked before whether it is a reply', async () => {
    const f = withRoots();
    f.posts.push({ id: id(6), user_id: UID, channel_id: OTHER, root_id: id(0), message: 'reply elsewhere', create_at: 0 });
    await expect(f.send({ channel: 'team-a/dup', message: 'hi', root_id: id(6) })).rejects.toMatchObject({
      message: `root_id ${id(6)} の投稿はチャンネル「Dup」（channel_id: ${CH}）にありません。`,
    });
    expect(f.created).toHaveLength(0);
  });
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

  test('a file already recorded as posted that a schedule also holds is refused as already posted', async () => {
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

describe('a draft with the sent message is cleared after the post', () => {
  const ROOT = id(9);
  const LIST = `/users/${UID}/teams/ta/drafts`;
  const PREF = '/users/me/preferences/advanced_settings/name/sync_drafts';
  const draft = (over: Record<string, unknown> = {}) => ({ user_id: UID, channel_id: CH, root_id: '', message: 'hello', ...over });
  const paths = (f: ReturnType<typeof fakeMm>) => f.calls.map((c) => `${c.method} ${c.path}`);
  const deletes = (f: ReturnType<typeof fakeMm>) => paths(f).filter((c) => c.startsWith('DELETE '));
  const CLEARED = '同じ本文の下書きを消しました';
  const FAILED = '同じ本文の下書きを確かめられなかったか、消せませんでした。下書きが残っていれば、そのまま送ると同じ投稿が 2 回になります。';
  let logged: string[];
  beforeEach(() => {
    logged = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((line) => (logged.push(String(line)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  test('a channel draft with the same message is deleted, telling the user to empty the input box if the channel is open', async () => {
    const f = fakeMm({ drafts: () => [draft()] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(deletes(f)).toEqual([`DELETE /users/${UID}/channels/${CH}/drafts`]);
    expect(textOf(r)).toContain(`${CLEARED}。そのチャンネルを画面で開いている場合は、入力欄に本文が残っているので、送らずに消してください。`);
    expect(textOf(r)).not.toContain('優先度');
  });

  test('a reply draft with the same message is deleted by its root_id', async () => {
    const f = fakeMm({ drafts: () => [draft({ root_id: ROOT })] });
    f.posts.push({ id: ROOT, user_id: UID, channel_id: CH, root_id: '', message: 'root', create_at: 0 });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello', root_id: ROOT });
    expect(deletes(f)).toEqual([`DELETE /users/${UID}/channels/${CH}/drafts/${ROOT}`]);
    expect(textOf(r)).toContain(`${CLEARED}。そのスレッドを画面で開いている場合は`);
  });

  test.each([
    ['a different message', draft({ message: 'hello!' })],
    ['another channel', draft({ channel_id: OTHER })],
    ['another thread', draft({ root_id: ROOT })],
  ])('a draft with %s is kept without reading the sync setting, and nothing is added to the output', async (_, d) => {
    const f = fakeMm({ drafts: () => [d] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(paths(f)).toContain(`GET ${LIST}`);
    expect(paths(f)).not.toContain(`GET ${PREF}`);
    expect(deletes(f)).toEqual([]);
    expect(textOf(r)).not.toContain('下書き');
  });

  test('no drafts at all (null) adds nothing and reads no sync setting', async () => {
    const f = fakeMm({ drafts: () => null });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(paths(f)).not.toContain(`GET ${PREF}`);
    expect(textOf(r)).not.toContain('下書き');
  });

  test('a matching draft with attachments is kept and the output says why', async () => {
    const f = fakeMm({ drafts: () => [draft({ file_ids: ['f'.repeat(26)] })] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toEqual([]);
    expect(textOf(r)).toContain('同じ本文の下書きがありますが、添付ファイルが付いているため消していません');
  });

  test('a matching draft of a caller with draft sync off is kept and the output says why', async () => {
    const f = fakeMm({ drafts: () => [draft()], syncOff: true });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toEqual([]);
    expect(textOf(r)).toContain('下書きの同期を切っているため消していません');
  });

  test.each([
    ['priority', { priority: 'urgent' }],
    ['requested_ack', { priority: '', requested_ack: true }],
    ['persistent_notifications', { priority: 'urgent', persistent_notifications: true }],
  ])('a matching draft with %s is deleted and the output says the post went without it', async (_, priority) => {
    const f = fakeMm({ drafts: () => [draft({ priority })] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toHaveLength(1);
    expect(textOf(r)).toContain('下書きに付いていた優先度は、この投稿には付いていません。');
  });

  test('a matching burn-on-read draft is deleted and the output says the post was sent without it', async () => {
    const f = fakeMm({ drafts: () => [draft({ type: 'burn_on_read' })] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toHaveLength(1);
    expect(textOf(r)).toContain('下書きに付いていた burn-on-read（読まれた後に消える設定）は、この投稿には付いていません。投稿は消えずに残ります。');
  });

  test('a draft without a type adds no burn-on-read note', async () => {
    const f = fakeMm({ drafts: () => [draft({ type: '' })] });
    expect(textOf(await f.send({ channel: 'team-a/dup', message: 'hello' }))).not.toContain('burn-on-read');
  });

  test('a channel draft with the same message is kept when the message is sent to a thread in that channel', async () => {
    const f = fakeMm({ drafts: () => [draft()] });
    f.posts.push({ id: ROOT, user_id: UID, channel_id: CH, root_id: '', message: 'root', create_at: 0 });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello', root_id: ROOT });
    expect(deletes(f)).toEqual([]);
    expect(textOf(r)).not.toContain('下書き');
  });

  test('when reading the sync setting fails, the post still succeeds and the output says the draft may be left', async () => {
    const f = fakeMm({ drafts: () => [draft()], syncOff: () => { throw new MmError(500, 'app.preference.get.app_error', 'x'); } });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toEqual([]);
    expect(textOf(r)).toContain(FAILED);
  });

  test('a re-login needed during the cleanup is named in the output and logged with the channel', async () => {
    const f = fakeMm({ drafts: () => { throw new Reauthorize(true); } });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('投稿の後で Mattermost への再ログインが必要になったため、同じ本文の下書きを確かめられませんでした。コネクタを再接続してください。');
    expect(logged.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ event: 'draft_cleanup_failed', name: 'Reauthorize', channel_id: CH })]);
  });

  test.each([
    ['less than a second', 4001, false],
    ['exactly a second', 4000, true],
  ])('with %s of the 5 seconds left before the DELETE, the DELETE is sent only when a second is left', async (_, at, sent) => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(at);
    const f = fakeMm({ drafts: () => [draft()] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(deletes(f)).toHaveLength(sent ? 1 : 0);
    if (sent) {
      expect(textOf(r)).toContain(CLEARED);
    } else {
      expect(textOf(r)).toContain(FAILED);
      expect(logged.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ event: 'draft_cleanup_failed', name: 'TimeoutError', skipped: 'delete', channel_id: CH })]);
    }
  });

  test('a cleanup failure is logged with the channel_id', async () => {
    const f = fakeMm({ drafts: () => [draft()], failDelete: () => new MmError(500, 'app.draft.delete.app_error', 'x') });
    await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(logged.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ event: 'draft_cleanup_failed', channel_id: CH, status: 500 })]);
  });

  test('a cleanup cut short by the client cancelling the request is not logged as a failure', async () => {
    const client = new AbortController();
    const f = fakeMm({ drafts: () => { client.abort(); throw new UpstreamUnavailable('call aborted', true); } });
    await f.send({ channel: 'team-a/dup', message: 'hello' }, client.signal);
    expect(logged).toEqual([]);
  });

  test('a cleanup whose client cancels while it waits for the user\'s lock neither calls Mattermost nor logs a failure', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const holder = fakeMm({ drafts: async () => (await gate, []) });
    const holding = holder.send({ channel: 'team-a/dup', message: 'first' });
    await vi.waitFor(() => expect(paths(holder)).toContain(`GET ${LIST}`));
    const client = new AbortController();
    const f = fakeMm({ drafts: () => [draft()] });
    const sending = f.send({ channel: 'team-a/dup', message: 'hello' }, client.signal);
    await vi.waitFor(() => expect(f.created).toHaveLength(1));
    client.abort();
    expect((await sending).isError).toBeFalsy();
    open();
    await holding;
    expect(paths(f).filter((c) => c.endsWith('/drafts'))).toEqual([]);
    expect(logged).toEqual([]);
  });

  test('a cleanup whose client has already cancelled does not call Mattermost even with the lock free', async () => {
    const client = new AbortController();
    client.abort();
    const f = fakeMm({ drafts: () => [draft()] });
    await f.send({ channel: 'team-a/dup', message: 'hello' }, client.signal);
    expect(paths(f).filter((c) => c.endsWith('/drafts'))).toEqual([]);
    expect(logged).toEqual([]);
  });

  test('an empty priority on the draft does not add the priority note', async () => {
    const f = fakeMm({ drafts: () => [draft({ priority: { priority: '', requested_ack: false } })] });
    expect(textOf(await f.send({ channel: 'team-a/dup', message: 'hello' }))).not.toContain('優先度');
  });

  test('drafts disabled on the server (501) adds nothing', async () => {
    const f = fakeMm({ drafts: () => { throw new MmError(501, 'api.drafts.disabled.app_error', 'off'); } });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).not.toContain('下書き');
  });

  test('a DM of a caller with no team does not read any draft list', async () => {
    const f = fakeMm({ teams: [] });
    const r = await f.send({ channel: DM, message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(paths(f).filter((c) => c.endsWith('/drafts'))).toEqual([]);
    expect(textOf(r)).not.toContain('下書き');
  });

  test('a DM draft is looked up in the caller\'s first team\'s list', async () => {
    const f = fakeMm({ drafts: () => [draft({ channel_id: DM })] });
    await f.send({ channel: DM, message: 'hello' });
    expect(paths(f)).toContain(`GET /users/${UID}/teams/ta/drafts`);
    expect(deletes(f)).toEqual([`DELETE /users/${UID}/channels/${DM}/drafts`]);
  });

  test.each([
    ['the list fails', { drafts: () => { throw new MmError(500, 'app.draft.get_drafts.app_error', 'x'); } }],
    ['the list is rate limited', { drafts: () => { throw new RateLimited(5, false); } }],
    ['Mattermost is unreachable', { drafts: () => { throw new UpstreamUnavailable('Mattermost unreachable', true); } }],
    ['the DELETE fails', { drafts: () => [draft()], failDelete: () => new MmError(500, 'app.draft.delete.app_error', 'x') }],
  ])('when %s, the post still succeeds and the output says the draft may be left', async (_, opts) => {
    const f = fakeMm(opts);
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('投稿しました。');
    expect(textOf(r)).toContain(FAILED);
    expect(f.created).toHaveLength(1);
    expect(logged.map((l) => JSON.parse(l).event)).toEqual(['draft_cleanup_failed']);
  });

  test('the cleanup calls share one 5-second deadline, and running past it is reported as a failure without failing the post', async () => {
    const ac = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal);
    const f = fakeMm({
      teams: [{ id: 'ta', name: 'team-a' }],
      drafts: (signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))),
    });
    const sending = f.send({ channel: DM, message: 'hello' });
    await vi.waitFor(() => expect(paths(f)).toContain(`GET /users/${UID}/teams/ta/drafts`));
    ac.abort(new DOMException('timed out', 'TimeoutError'));
    const r = await sending;
    expect(timeout).toHaveBeenCalledWith(5000);
    const cleanup = f.calls.slice(f.calls.findIndex((c) => c.method === 'POST' && c.path === '/posts') + 1);
    expect(cleanup.map((c) => c.path)).toEqual(['/users/me/teams', `/users/${UID}/teams/ta/drafts`]);
    expect(cleanup.every((c) => c.signal === ac.signal)).toBe(true);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(FAILED);
  });

  test('the sync setting and the DELETE get the same deadline signal', async () => {
    const ac = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(ac.signal);
    const f = fakeMm({ drafts: () => [draft()] });
    await f.send({ channel: 'team-a/dup', message: 'hello' });
    const after = f.calls.filter((c) => c.path === PREF || c.method === 'DELETE');
    expect(after.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(after.every((c) => c.signal === ac.signal)).toBe(true);
  });

  test('allow_duplicate posts also clear the draft', async () => {
    const f = fakeMm({ drafts: () => [draft()] });
    const r = await f.send({ channel: 'team-a/dup', message: 'hello', allow_duplicate: true });
    expect(deletes(f)).toHaveLength(1);
    expect(textOf(r)).toContain(CLEARED);
  });

  test('a resend reported as already posted clears a draft left by a failed earlier cleanup', async () => {
    let fail = true;
    const f = fakeMm({ drafts: () => [draft()], failDelete: () => (fail ? new MmError(500, 'app.draft.delete.app_error', 'x') : undefined) });
    expect(textOf(await f.send({ channel: 'team-a/dup', message: 'hello' }))).toContain(FAILED);
    fail = false;
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(textOf(r)).toContain('直前に投稿済み');
    expect(textOf(r)).toContain(CLEARED);
    expect(f.created).toHaveLength(1);
  });

  test('a retry that finds the earlier post clears the draft', async () => {
    let first = true;
    const f = fakeMm({ drafts: () => [draft()], failPost: () => (first ? ((first = false), 'after') : undefined) });
    await expect(f.send({ channel: 'team-a/dup', message: 'hello' })).rejects.toBeInstanceOf(UpstreamUnavailable);
    expect(deletes(f)).toEqual([]);
    f.advance(31_000);
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(textOf(r)).toContain('既にあったため');
    expect(deletes(f)).toHaveLength(1);
  });

  test('a send reported as in progress reads no draft list', async () => {
    const f = fakeMm({ drafts: () => [draft()], failPost: () => 'after' });
    await expect(f.send({ channel: 'team-a/dup', message: 'hello' })).rejects.toBeInstanceOf(UpstreamUnavailable);
    f.advance(10_000);
    const r = await f.send({ channel: 'team-a/dup', message: 'hello' });
    expect(textOf(r)).toContain('処理中');
    expect(paths(f).filter((c) => c.endsWith('/drafts'))).toEqual([]);
  });
});

import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
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

type Mode = 'before' | 'after' | 'lost' | 'reject' | undefined;

function fakeMm(opts: { failPost?: () => Mode; postDelay?: Promise<void> } = {}) {
  let now = 1_000_000;
  const store = new Store(openDb(':memory:'), randomBytes(32), () => now);
  const posts: MmPost[] = [{ id: id(0), user_id: UID, channel_id: OTHER, root_id: '', message: 'root elsewhere', create_at: 0 }];
  const created: unknown[] = [];
  const byPending = new Map<string, MmPost>();
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
        const since = Number(new URLSearchParams(path.split('?')[1]).get('since'));
        const hit = posts.filter((x) => x.channel_id === CH && x.create_at >= since);
        return { order: hit.map((x) => x.id), posts: Object.fromEntries(hit.map((x) => [x.id, x])) };
      }
      if (method === 'POST' && p === '/posts') {
        await opts.postDelay;
        const mode = opts.failPost?.();
        if (mode === 'before') throw new RateLimited(5, false);
        created.push(body);
        if (mode === 'reject') throw new MmError(400, 'bad_request', 'bad');
        if (mode === 'lost') throw new UpstreamUnavailable('Mattermost unreachable', true);
        const dup = body.pending_post_id ? byPending.get(body.pending_post_id) : undefined;
        const post = dup ?? { id: id(posts.length), user_id: UID, channel_id: body.channel_id, root_id: body.root_id ?? '', message: body.message, create_at: now };
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
  const send = (args: { channel: string; message: string; root_id?: string; allow_duplicate?: boolean }) => sendMessage(mm, store, UID, BASE, args);
  return { send, created, advance: (ms: number) => { now += ms; } };
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
  expect(r.isError).toBeFalsy();
  expect(f.created).toHaveLength(2);
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

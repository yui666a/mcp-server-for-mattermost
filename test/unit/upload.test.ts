import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { uploadHandler } from '../../src/upload.ts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeApp } from './helpers.ts';

const UID = 'u'.repeat(26);
const CH = 'c'.repeat(26);
const fileId = (n: number) => `f${String(n).padStart(25, '0')}`;

let out: string[];
let uploads: { query: URLSearchParams; bytes: Uint8Array; auth: string | null }[];
let onUpload: (n: number) => Response | undefined | Promise<Response | undefined>;

beforeEach(() => {
  out = [];
  uploads = [];
  onUpload = () => undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
});
afterEach(() => vi.restoreAllMocks());

function setup(env: Record<string, string> = {}) {
  const ctx = makeApp(env, async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace('/api/v4', '');
    if (req.method === 'POST' && path === '/files') {
      const n = uploads.length;
      const refused = await onUpload(n);
      if (refused) return refused;
      uploads.push({ query: new URL(req.url).searchParams, bytes: new Uint8Array(await req.arrayBuffer()), auth: req.headers.get('authorization') });
      return Response.json({ file_infos: [{ id: fileId(n) }] }, { status: 201 });
    }
    if (req.method === 'GET' && path === `/channels/${CH}`) return Response.json({ id: CH, name: 'town', display_name: 'Town', team_id: 't1', type: 'O', purpose: '', header: '' });
    if (req.method === 'GET' && path === '/teams/t1') return Response.json({ id: 't1', name: 'team-a' });
    return Response.json({ id: 'not_found' }, { status: 404 });
  });
  ctx.store.putMmCred(UID, 'mm-access', 'mm-refresh');
  const url = () => `/mcp/upload/${ctx.store.createUploadUrl({ mmUserId: UID, channelId: CH })}`;
  return { ...ctx, url };
}

const logged = () => out.map((l) => JSON.parse(l)).filter((l) => l.event === 'upload');

describe('POST /mcp/upload/:token', () => {
  test('uploads each file to the channel with the user\'s token, lists their file_ids, and says to pass them to schedule_message\'s file_ids when scheduling', async () => {
    const s = setup();
    const r = await s.req.post(s.url())
      .attach('file', Buffer.from('%PDF-1.7'), 'report.pdf')
      .attach('file', Buffer.from([0x89, 0x50]), 'スクリーンショット.png');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toContain(`file_id: ${fileId(0)}（report.pdf、8 バイト）`);
    expect(r.text).toContain(`file_id: ${fileId(1)}（スクリーンショット.png、2 バイト）`);
    expect(r.text).toContain('予約するときは schedule_message の file_ids に渡します');
    expect(uploads.map((u) => [u.auth, u.query.get('channel_id'), u.query.get('filename'), [...u.bytes]])).toEqual([
      ['Bearer mm-access', CH, 'report.pdf', [...Buffer.from('%PDF-1.7')]],
      ['Bearer mm-access', CH, 'スクリーンショット.png', [0x89, 0x50]],
    ]);
  });

  test('records the uploaded files for the user and channel, as not yet used by a post', async () => {
    const s = setup();
    await s.req.post(s.url()).attach('file', Buffer.from('a'), 'a.txt').attach('file', Buffer.from('b'), 'b.txt');
    expect(s.store.uploadedFiles(UID, [fileId(0), fileId(1)])).toEqual([
      { fileId: fileId(0), channelId: CH, postId: null },
      { fileId: fileId(1), channelId: CH, postId: null },
    ]);
  });

  test('a URL works once', async () => {
    const s = setup();
    const url = s.url();
    await s.req.post(url).attach('file', Buffer.from('x'), 'a.txt');
    const r = await s.req.post(url).attach('file', Buffer.from('x'), 'a.txt');
    expect(r.status).toBe(404);
    expect(r.text).toContain('prepare_upload');
    expect(uploads).toHaveLength(1);
  });

  test.each([
    ['an unknown token', '/mcp/upload/' + 'x'.repeat(43)],
    ['a malformed token', '/mcp/upload/short'],
  ])('%s gets 404 without reading the files', async (_, path) => {
    const s = setup();
    const r = await s.req.post(path).attach('file', Buffer.from('x'), 'a.txt');
    expect(r.status).toBe(404);
    expect(uploads).toHaveLength(0);
  });

  test('other methods get 405', async () => {
    const s = setup();
    const r = await s.req.get(s.url());
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });

  test.each([
    ['a body over UPLOAD_MAX_BYTES', 413, (r: ReturnType<ReturnType<typeof setup>['req']['post']>) => r.attach('file', Buffer.alloc(2048), 'big.bin'), '上限の 1024 バイト'],
    ['no file field', 400, (r: ReturnType<ReturnType<typeof setup>['req']['post']>) => r.field('other', 'x'), 'file という名前のファイルがありません'],
    ['a body that is not multipart', 400, (r: ReturnType<ReturnType<typeof setup>['req']['post']>) => r.set('content-type', 'application/octet-stream').send(Buffer.from('x')), 'multipart/form-data'],
    ['more than 5 files', 400, (r: ReturnType<ReturnType<typeof setup>['req']['post']>) => [0, 1, 2, 3, 4, 5].reduce((q, i) => q.attach('file', Buffer.from('x'), `${i}.txt`), r), '5 件まで'],
  ])('%s is refused with %i and the same URL can be used again', async (_, status, send, message) => {
    const s = setup({ UPLOAD_MAX_BYTES: '1024' });
    const url = s.url();
    const r = await send(s.req.post(url));
    expect(r.status).toBe(status);
    expect(r.text).toContain(message);
    expect(r.text).toContain('同じ URL で');
    expect(uploads).toHaveLength(0);
    expect((await s.req.post(url).attach('file', Buffer.from('x'), 'a.txt')).status).toBe(200);
  });

  test('a file Mattermost refuses as too large is worded and leaves the URL usable', async () => {
    const s = setup();
    onUpload = () => Response.json({ id: 'api.file.upload_file.too_large_detailed.app_error', message: 'm' }, { status: 413 });
    const url = s.url();
    const r = await s.req.post(url).attach('file', Buffer.from('x'), 'a.mov');
    expect(r.status).toBe(400);
    expect(r.text).toContain('ファイル「a.mov」は大きすぎるため添付できません');
    expect(r.text).toContain('同じ URL で');
  });

  test('a failure after some files went to Mattermost lists them and asks for a new URL', async () => {
    const s = setup();
    onUpload = (n) => (n === 1 ? new Response('down', { status: 503 }) : undefined);
    const url = s.url();
    const r = await s.req.post(url).attach('file', Buffer.from('x'), 'a.txt').attach('file', Buffer.from('y'), 'b.txt');
    expect(r.status).toBe(502);
    expect(r.text).toContain('URL を発行し直して');
    expect(r.text).toContain(`file_id: ${fileId(0)}（a.txt、1 バイト）`);
    expect(s.store.uploadedFiles(UID, [fileId(0)])).toHaveLength(1);
    expect((await s.req.post(url).attach('file', Buffer.from('x'), 'a.txt')).status).toBe(404);
  });

  test('a file name with a slash or a control character is refused', async () => {
    const s = setup();
    const r = await s.req.post(s.url()).attach('file', Buffer.from('x'), 'a\u0007b.txt');
    expect(r.status).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  test('the log has the user, the count and the size, but not the file names, contents or the token', async () => {
    const s = setup();
    const url = s.url();
    await s.req.post(url).attach('file', Buffer.from('secret-content'), 'secret-name.txt');
    expect(logged()).toEqual([expect.objectContaining({ mm_user_id: UID, outcome: 'ok', files: 1, bytes: 14 })]);
    const all = out.join('');
    expect(all).not.toContain('secret');
    expect(all).not.toContain(url.split('/').pop()!);
  });
});

// A client that writes the whole body before reading, as a reverse proxy with request buffering does.
function rawPost(port: number, path: string, body: Buffer, opts: { chunked?: boolean; stopAfter?: number; stallAfter?: number } = {}) {
  return new Promise<{ status?: number; text: string; error?: string; connection?: string }>((resolve) => {
    const boundary = 'b0undary';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const all = Buffer.concat([head, body, tail]);
    const req = httpRequest({
      port, path, method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...(opts.chunked ? {} : { 'content-length': all.length }) },
    }, (res) => {
      res.setEncoding('utf8').on('data', (c) => { got.text += c; });
      got.status = res.statusCode;
      got.connection = res.headers.connection;
    });
    // Resolved on close rather than on the response: a write error such as EPIPE can come after the reply has been read.
    const got: { status?: number; text: string; error?: string; connection?: string } = { text: '' };
    req.on('error', (e) => { got.error = (e as NodeJS.ErrnoException).code; });
    req.on('close', () => setTimeout(() => resolve(got), 20));
    if (opts.stallAfter !== undefined) {
      req.write(all.subarray(0, opts.stallAfter));
      return;
    }
    if (opts.stopAfter !== undefined) {
      req.write(all.subarray(0, opts.stopAfter), () => setTimeout(() => req.destroy(), 50));
      return;
    }
    for (let i = 0; i < all.length; i += 64 * 1024) req.write(all.subarray(i, i + 64 * 1024));
    req.end();
  });
}

// Not vitest's 5 s: these send megabytes over a real socket, which takes seconds on a busy machine.
describe('replies before the whole body has arrived', { timeout: 30_000 }, () => {
  let close: () => void;
  afterEach(() => close?.());
  async function listen(env: Record<string, string> = {}) {
    const s = setup(env);
    const server = s.app.listen(0);
    await new Promise((r) => server.once('listening', r));
    close = () => server.close();
    return { ...s, server, port: (server.address() as AddressInfo).port };
  }

  test('an unknown URL reads the body to the end before its 404, so a client still sending gets the reply', async () => {
    const s = await listen();
    const r = await rawPost(s.port, '/mcp/upload/' + 'x'.repeat(43), Buffer.alloc(9 * 1024 * 1024));
    expect([r.status, r.error]).toEqual([404, undefined]);
  });

  test('a second upload while one is in progress gets 429 after its body, and keeps its URL', async () => {
    const s = await listen();
    let release!: () => void;
    const held = new Promise<undefined>((r) => { release = () => r(undefined); });
    let enter!: () => void;
    const entered = new Promise<void>((r) => { enter = r; });
    onUpload = (n) => (n === 0 ? (enter(), held) : undefined);
    const first = rawPost(s.port, s.url(), Buffer.from('first'));
    await entered;
    const url = s.url();
    const second = await rawPost(s.port, url, Buffer.alloc(9 * 1024 * 1024));
    expect([second.status, second.error]).toEqual([429, undefined]);
    release();
    expect((await first).status).toBe(200);
    expect((await rawPost(s.port, url, Buffer.from('again'))).status).toBe(200);
  });

  test('a chunked body over UPLOAD_MAX_BYTES gets the 413 explanation and keeps the URL', async () => {
    const s = await listen({ UPLOAD_MAX_BYTES: String(1024 * 1024) });
    const url = s.url();
    const r = await rawPost(s.port, url, Buffer.alloc(1024 * 1024 + 1000), { chunked: true });
    expect([r.status, r.error]).toEqual([413, undefined]);
    expect(r.text).toContain('同じ URL で');
    expect((await rawPost(s.port, url, Buffer.from('ok'))).status).toBe(200);
  });

  test('the bytes read before a 413 count toward the drain limit, so a body over UPLOAD_MAX_BYTES + 1MiB is not read to its end', async () => {
    const s = await listen({ UPLOAD_MAX_BYTES: String(1024 * 1024) });
    const within = await rawPost(s.port, s.url(), Buffer.alloc(1024 * 1024 + 512 * 1024), { chunked: true });
    expect([within.status, within.connection]).toEqual([413, 'keep-alive']);
    // Not checking what the client got: with the body left unread, its write can fail and drop the connection before it reads the reply.
    let sent: unknown[] = [];
    s.server.on('request', (_, res) => res.on('finish', () => { sent = [res.statusCode, res.getHeader('connection')]; }));
    await rawPost(s.port, s.url(), Buffer.alloc(2 * 1024 * 1024 + 512 * 1024), { chunked: true });
    expect(sent).toEqual([413, 'close']);
  });

  test('a client that goes away mid-body leaves the URL usable and is not logged as an unexpected error', async () => {
    const s = await listen();
    const url = s.url();
    // Not made after rawPost: the log can come before it resolves.
    const loggedOnce = new Promise<void>((r) => vi.spyOn(process.stdout, 'write').mockImplementation((line) => { out.push(String(line)); if (logged().length) r(); return true; }));
    await rawPost(s.port, url, Buffer.alloc(1024 * 1024), { chunked: true, stopAfter: 100_000 });
    await loggedOnce;
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatchObject({ outcome: 'client_gone', files: 0 });
    expect(out.join('')).not.toContain('upload_unhandled_error');
    expect((await rawPost(s.port, url, Buffer.from('ok'))).status).toBe(200);
  });
});

// Not 15 s (BODY_IDLE_MS) or more: the handler must use the idle limit it is given, not its default.
const IDLE_ENDED_WITHIN = 10_000;

describe('a client that stops sending mid-body', { timeout: 30_000 }, () => {
  let close: () => void;
  afterEach(() => close?.());
  async function listen(idleMs: number) {
    const s = setup();
    const app = express().post('/mcp/upload/:token', uploadHandler({ config: s.config, store: s.store, mm: s.mm, deps: { fetch, now: Date.now } }, idleMs));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    close = () => server.close();
    return { ...s, port: (server.address() as AddressInfo).port };
  }

  test('gets 408 once no data has come for the idle limit, leaves the URL usable and frees the slot for others', async () => {
    const s = await listen(200);
    const url = s.url();
    const started = Date.now();
    const r = await rawPost(s.port, url, Buffer.alloc(1024 * 1024), { stallAfter: 100_000 });
    expect(Date.now() - started).toBeLessThan(IDLE_ENDED_WITHIN);
    expect([r.status, r.connection]).toEqual([408, 'close']);
    expect(r.text).toContain('同じ URL で');
    expect(logged()[0]).toMatchObject({ outcome: 'stalled', files: 0 });
    expect((await rawPost(s.port, url, Buffer.from('ok'))).status).toBe(200);
  });

  test('to an unknown URL gets its 404 once no data has come for the idle limit', async () => {
    const s = await listen(200);
    const started = Date.now();
    const r = await rawPost(s.port, '/mcp/upload/' + 'x'.repeat(43), Buffer.alloc(1024 * 1024), { stallAfter: 100_000 });
    expect(Date.now() - started).toBeLessThan(IDLE_ENDED_WITHIN);
    expect(r.status).toBe(404);
  });
});

describe('prepare_upload', () => {
  async function call(s: ReturnType<typeof setup>, args: Record<string, unknown>) {
    const code = s.store.createCode({ mmUserId: UID, clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: s.config.resource, scope: 'mattermost' });
    const rec = s.store.consumeCode(code);
    if (typeof rec !== 'object') throw new Error('code not consumed');
    const { accessToken } = s.store.createGrant({ mmUserId: UID, clientId: 'c1', scope: 'mattermost', resource: s.config.resource, fromCodeHash: rec.codeHash });
    const r = await s.req.post('/mcp').set({ authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prepare_upload', arguments: args } }));
    return { isError: r.body.result.isError ?? false, text: r.body.result.content[0].text as string };
  }

  test('gives a curl command with a URL that uploads to the resolved channel', async () => {
    const s = setup();
    const r = await call(s, { channel: CH });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`Town（channel_id: ${CH}）`);
    expect(r.text).toContain('利用者に示して、確認を取ってください');
    const url = /curl -sS -F 'file=@<ファイルのパス>' (\S+)/.exec(r.text)![1];
    expect(url).toMatch(/^https:\/\/mm\.example\/mcp\/upload\/[A-Za-z0-9_-]{43}$/);
    const up = await s.req.post(new URL(url).pathname).attach('file', Buffer.from('x'), 'a.txt');
    expect(up.status).toBe(200);
    expect(uploads[0].query.get('channel_id')).toBe(CH);
  });

  test('refuses a sixth unused URL', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await call(s, { channel: CH })).isError).toBe(false);
    const r = await call(s, { channel: CH });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('使われていないアップロード URL が 5 件あります');
  });
});

import type express from 'express';
import type { AppContext } from './app.ts';
import { log } from './log.ts';
import { MmError, RateLimited, Reauthorize, UpstreamUnavailable } from './mattermost/client.ts';
import { InputError } from './mcp/format.ts';
import type { Mm } from './mcp/resolve.ts';
import { failureText } from './mcp/server.ts';
import { FILE_NAME, MAX_UPLOAD_FILES, uploadFile } from './mcp/tools-send.ts';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
// Not more: a request holds its body and the parsed files in memory, about 5 times UPLOAD_MAX_BYTES, until Mattermost has them all.
const MAX_CONCURRENT = 1;
// Matches the reverse proxy's limit in docs/deployment.md, which refuses larger bodies itself.
export const DRAIN_SLACK = 1024 * 1024;

class TooLarge extends Error {
  name = 'TooLarge';
}

class ClientGone extends Error {
  name = 'ClientGone';
}

// One iterator per request, shared by readBody and drain: a second one would not see the chunks the first has buffered.
// Not for await: leaving its loop early returns the iterator, which destroys the request and its socket before the reply.
const iterators = new WeakMap<express.Request, AsyncIterator<Buffer>>();
function chunks(req: express.Request): AsyncIterator<Buffer> {
  let it = iterators.get(req);
  if (!it) iterators.set(req, (it = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]()));
  return it;
}

// Not closing the connection with the body unread: a reverse proxy still sending it gets a write error and answers 502 in place of this reply.
async function drain(req: express.Request, max: number): Promise<void> {
  if (req.readableEnded || Number(req.headers['content-length'] ?? 0) > max) return;
  const it = chunks(req);
  let n = 0;
  try {
    for (let r = await it.next(); !r.done; r = await it.next()) {
      n += r.value.length;
      if (n > max) return;
    }
  } catch {
    // The client went away; the reply has nowhere to go either.
  }
}

// Not express.raw: it answers an oversized body with its own error before this handler can release the URL.
async function readBody(req: express.Request, max: number): Promise<Buffer<ArrayBuffer>> {
  if (Number(req.headers['content-length'] ?? 0) > max) throw new TooLarge();
  const parts: Buffer[] = [];
  let n = 0;
  const it = chunks(req);
  for (;;) {
    let r: IteratorResult<Buffer>;
    try {
      r = await it.next();
    } catch {
      throw new ClientGone();
    }
    if (r.done) return Buffer.concat(parts);
    n += r.value.length;
    if (n > max) throw new TooLarge();
    parts.push(r.value);
  }
}

async function filesOf(req: express.Request, body: Buffer<ArrayBuffer>): Promise<File[]> {
  const type = req.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new InputError("multipart/form-data で送ってください（curl -F 'file=@<ファイルのパス>' <URL>）。");
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': type } }).formData();
  } catch {
    throw new InputError('multipart/form-data として読めません。');
  }
  const files = form.getAll('file').filter((v): v is File => typeof v !== 'string');
  if (!files.length) throw new InputError("file という名前のファイルがありません（curl -F 'file=@<ファイルのパス>' <URL>）。");
  if (files.length > MAX_UPLOAD_FILES) throw new InputError(`1 回に送れるファイルは ${MAX_UPLOAD_FILES} 件までです。`);
  for (const f of files) {
    const r = FILE_NAME.safeParse(f.name);
    if (!r.success) throw new InputError(`ファイル名「${f.name}」は使えません。1〜100 文字で、/ や \\、制御文字を含まない名前にしてください（curl なら -F 'file=@<パス>;filename=<名前>'）。`);
  }
  return files;
}

// Not counting a timeout or a reset as unsent: the file may have reached Mattermost, and a resend would upload it twice.
const nothingSent = (e: unknown): boolean => e instanceof TooLarge || e instanceof ClientGone || e instanceof InputError || e instanceof MmError || e instanceof RateLimited
  || (e instanceof UpstreamUnavailable && !e.sent);

const statusOf = (e: unknown): number => {
  if (e instanceof InputError) return 400;
  if (e instanceof Reauthorize) return 401;
  if (e instanceof RateLimited) return 429;
  if (e instanceof MmError || e instanceof UpstreamUnavailable) return 502;
  return 500;
};

export function uploadHandler(ctx: AppContext): express.RequestHandler {
  let active = 0;
  return async (req, res) => {
    const started = Date.now();
    const reply = async (status: number, lines: string[]) => {
      await drain(req, ctx.config.uploadMaxBytes + DRAIN_SLACK);
      // Not keeping the connection: a body too large to drain is left unread.
      if (!req.readableEnded) res.set('Connection', 'close');
      res.status(status).set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }).send(lines.join('\n') + '\n');
    };
    const token = req.params.token as string;
    if (active >= MAX_CONCURRENT) {
      res.set('Retry-After', '5');
      return await reply(429, ['ほかのアップロードを処理中です。5 秒ほど待ってから、同じ URL で送り直してください。']);
    }
    const target = TOKEN.test(token) ? ctx.store.takeUploadUrl(token) : undefined;
    if (!target) return await reply(404, ['この URL は使えません（期限切れ、使用済み、または存在しない）。prepare_upload で URL を発行し直してください。']);

    active++;
    const done: { id: string; name: string; size: number }[] = [];
    let outcome = 'ok';
    let bytes = 0;
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const mm: Mm = { call: (u, m, p, b) => ctx.mm.call(u, m, p, b, abort.signal) };
    try {
      const files = await filesOf(req, await readBody(req, ctx.config.uploadMaxBytes));
      bytes = files.reduce((n, f) => n + f.size, 0);
      for (const f of files) {
        const id = await uploadFile(mm, target.mmUserId, target.channelId, f.name, f);
        ctx.store.recordUploadedFile(target, id);
        done.push({ id, name: f.name, size: f.size });
      }
      await reply(200, [
        `アップロードしました。send_message の file_ids に次の file_id を渡して、チャンネル（channel_id: ${target.channelId}）へ投稿してください。`,
        ...done.map((f) => `file_id: ${f.id}（${f.name}、${f.size} バイト）`),
      ]);
    } catch (e) {
      outcome = e instanceof TooLarge ? 'too_large' : e instanceof ClientGone ? 'client_gone' : (e as Error)?.name ?? 'error';
      // Not releasing once a file has gone to Mattermost: the files that did go are listed below, and a resend would upload them again.
      const reusable = !done.length && nothingSent(e);
      if (reusable) ctx.store.releaseUploadUrl(token);
      const again = reusable ? '同じ URL で' : 'prepare_upload で URL を発行し直して';
      const head = e instanceof TooLarge
        ? `送られた本文（multipart 全体）が上限の ${ctx.config.uploadMaxBytes} バイトを超えています。ファイルを減らすか小さくして、${again}送り直してください。`
        : `${failureText(e)} ${again}送り直してください。`;
      if (statusOf(e) === 500 && !(e instanceof TooLarge) && !(e instanceof ClientGone)) log('upload_unhandled_error', { name: (e as Error)?.name });
      if (e instanceof RateLimited) res.set('Retry-After', String(e.retryAfterSec));
      await reply(e instanceof TooLarge ? 413 : statusOf(e), [
        head,
        ...(done.length ? ['次のファイルはアップロード済みです。file_ids に渡せます。', ...done.map((f) => `file_id: ${f.id}（${f.name}、${f.size} バイト）`)] : []),
      ]);
    } finally {
      active--;
      log('upload', { mm_user_id: target.mmUserId, outcome, files: done.length, bytes, ms: Date.now() - started });
    }
  };
}

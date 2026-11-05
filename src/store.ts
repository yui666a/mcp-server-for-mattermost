import type { DatabaseSync } from 'node:sqlite';
import { open, randomToken, seal, sha256 } from './crypto.ts';

const SEC = 1000;
const CODE_TTL = 60 * SEC;
const AUTH_SESSION_TTL = 600 * SEC;
const REFRESH_IDLE = 90 * 24 * 3600 * SEC;
const UNAUTHORIZED_CLIENT_TTL = 7 * 24 * 3600 * SEC;
const UNAUTHORIZED_CLIENT_CAP = 500;
const POST_DEDUP_WINDOW = 600 * SEC;
export const INFLIGHT_GRACE = 30 * SEC;
const USED_REFRESH_KEEP = 7 * 24 * 3600 * SEC;
const CONSUMED_CODE_KEEP = 24 * 3600 * SEC;
const SCHEDULED_KEEP = 7 * 24 * 3600 * SEC;
export const MAX_PENDING_SCHEDULED = 20;
export const UPLOAD_URL_TTL = 600 * SEC;
export const MAX_OPEN_UPLOAD_URLS = 5;
export const UPLOADED_FILE_KEEP = 24 * 3600 * SEC;

export type ClientMeta = { clientName: string; redirectUris: string[] };
export type Client = ClientMeta & { clientId: string; createdAt: number; authorizedAt: number | null };
export type AuthSessionInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  scope: string;
};
export type AuthSession = AuthSessionInput & { sessionId: string; upstreamVerifier: string };
export type CodeInput = {
  mmUserId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
};
export type CodeRecord = CodeInput & { codeHash: string };
export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: number };
export type PostClaim =
  | { kind: 'new'; id: number; pendingPostId: string; claimedAt: number }
  | { kind: 'done'; postId: string }
  | { kind: 'inflight' }
  | { kind: 'retry'; id: number; pendingPostId: string; createdAt: number; claimedAt: number };

export type UploadTarget = { mmUserId: string; channelId: string };
export type UploadedFile = { fileId: string; channelId: string; postId: string | null };

export type ScheduledStatus = 'pending' | 'sending' | 'posted' | 'failed';
export type Scheduled = {
  id: string; channelId: string; rootId: string; message: string | undefined; scheduledAt: number;
  status: ScheduledStatus; postId: string | null; error: string | null; fileIds: string[];
};
export type HeldFile = { fileId: string; scheduledId: string };

export class FileHeld extends Error {
  held: HeldFile;
  constructor(held: HeldFile) {
    super('file held by a schedule');
    this.held = held;
  }
}

export type ClaimedScheduled = Scheduled & {
  mmUserId: string; message: string | undefined; pendingPostId: string | null; firstAttemptAt: number | null; retry: boolean;
};
export type ScheduledOutcome =
  | { status: 'posted'; postId: string; fileIds: string[]; note?: string }
  | { status: 'failed'; error: string; forgetAttempt?: boolean }
  | { status: 'pending'; forgetAttempt: boolean };

type Row = Record<string, any>;

export class Store {
  private db: DatabaseSync;
  private encKey: Buffer;
  private now: () => number;
  private accessTtlSec: number;

  constructor(db: DatabaseSync, encKey: Buffer, now: () => number = Date.now, accessTtlSec = 3600) {
    this.db = db;
    this.encKey = encKey;
    this.now = now;
    this.accessTtlSec = accessTtlSec;
  }

  // ponytail: nested calls are not supported; every caller below, and every fn passed to transaction(), uses only methods that do not open their own tx.
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  transaction<T>(fn: () => T): T {
    return this.tx(fn);
  }

  private get(sql: string, ...p: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }

  private run(sql: string, ...p: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...p).changes);
  }

  createClient(meta: ClientMeta): Client {
    const c: Client = { ...meta, clientId: randomToken(), createdAt: this.now(), authorizedAt: null };
    this.tx(() => {
      this.run(
        'INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
        c.clientId, c.clientName, JSON.stringify(c.redirectUris), c.createdAt,
      );
      this.run(
        `DELETE FROM clients WHERE authorized_at IS NULL AND rowid NOT IN
           (SELECT rowid FROM clients WHERE authorized_at IS NULL ORDER BY rowid DESC LIMIT ?)`,
        UNAUTHORIZED_CLIENT_CAP,
      );
    });
    return c;
  }

  getClient(id: string): Client | undefined {
    const r = this.get('SELECT * FROM clients WHERE client_id = ?', id);
    return r && {
      clientId: r.client_id,
      clientName: r.client_name,
      redirectUris: JSON.parse(r.redirect_uris),
      createdAt: r.created_at,
      authorizedAt: r.authorized_at,
    };
  }

  countUnauthorizedClients(): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM clients WHERE authorized_at IS NULL')?.n ?? 0);
  }

  markClientAuthorized(id: string): void {
    this.run('UPDATE clients SET authorized_at = ? WHERE client_id = ? AND authorized_at IS NULL', this.now(), id);
  }

  createAuthSession(s: AuthSessionInput): { sessionId: string; cookieSecret: string; csrf: string } {
    const sessionId = randomToken().slice(0, 16);
    const cookieSecret = randomToken();
    const csrf = randomToken();
    this.run(
      `INSERT INTO auth_sessions (session_id, cookie_hash, csrf_hash, client_id, redirect_uri, code_challenge,
         state, resource, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId, sha256(cookieSecret), sha256(csrf), s.clientId, s.redirectUri, s.codeChallenge,
      s.state, s.resource, s.scope, this.now(),
    );
    return { sessionId, cookieSecret, csrf };
  }

  approveAuthSession(sessionId: string, cookieSecret: string, csrf: string) {
    const upstreamState = randomToken();
    const upstreamVerifier = randomToken();
    const n = this.run(
      `UPDATE auth_sessions SET upstream_state_hash = ?, upstream_verifier = ?
       WHERE session_id = ? AND cookie_hash = ? AND csrf_hash = ? AND created_at > ?`,
      sha256(upstreamState), seal(this.encKey, upstreamVerifier), sessionId, sha256(cookieSecret), sha256(csrf),
      this.now() - AUTH_SESSION_TTL,
    );
    return n === 1 ? { upstreamState, upstreamVerifier } : undefined;
  }

  findSessionIdByUpstreamState(upstreamState: string): string | undefined {
    return this.get('SELECT session_id FROM auth_sessions WHERE upstream_state_hash = ?', sha256(upstreamState))
      ?.session_id;
  }

  takeAuthSession(sessionId: string, cookieSecret: string, upstreamState: string): AuthSession | undefined {
    return this.tx(() => {
      const r = this.get(
        `SELECT * FROM auth_sessions WHERE session_id = ? AND cookie_hash = ? AND upstream_state_hash = ?
           AND created_at > ?`,
        sessionId, sha256(cookieSecret), sha256(upstreamState), this.now() - AUTH_SESSION_TTL,
      );
      if (!r) return undefined;
      this.run('DELETE FROM auth_sessions WHERE session_id = ?', sessionId);
      return {
        sessionId,
        clientId: r.client_id,
        redirectUri: r.redirect_uri,
        codeChallenge: r.code_challenge,
        state: r.state,
        resource: r.resource,
        scope: r.scope,
        upstreamVerifier: open(this.encKey, r.upstream_verifier),
      };
    });
  }

  createCode(c: CodeInput): string {
    const code = randomToken();
    this.run(
      `INSERT INTO codes (code_hash, mm_user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sha256(code), c.mmUserId, c.clientId, c.redirectUri, c.codeChallenge, c.resource, c.scope,
      this.now() + CODE_TTL,
    );
    return code;
  }

  consumeCode(code: string): CodeRecord | 'reused' | undefined {
    const codeHash = sha256(code);
    return this.tx(() => {
      const r = this.get('SELECT * FROM codes WHERE code_hash = ?', codeHash);
      if (!r) return undefined;
      if (r.consumed) {
        this.run('DELETE FROM grants WHERE from_code_hash = ?', codeHash);
        return 'reused';
      }
      if (r.expires_at <= this.now()) return undefined;
      this.run('UPDATE codes SET consumed = 1, expires_at = ? WHERE code_hash = ?', this.now() + CONSUMED_CODE_KEEP, codeHash);
      return {
        codeHash,
        mmUserId: r.mm_user_id,
        clientId: r.client_id,
        redirectUri: r.redirect_uri,
        codeChallenge: r.code_challenge,
        resource: r.resource,
        scope: r.scope,
      };
    });
  }

  createGrant(g: { mmUserId: string; clientId: string; scope: string; resource: string; fromCodeHash: string }): TokenPair {
    return this.tx(() => {
      const id = Number(
        this.db.prepare(
          'INSERT INTO grants (mm_user_id, client_id, scope, resource, from_code_hash, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(g.mmUserId, g.clientId, g.scope, g.resource, g.fromCodeHash, this.now()).lastInsertRowid,
      );
      return this.issue(id);
    });
  }

  private issue(grantId: number): TokenPair {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.run('INSERT INTO access_tokens (token_hash, grant_id, expires_at) VALUES (?, ?, ?)',
      sha256(accessToken), grantId, this.now() + this.accessTtlSec * SEC);
    this.run('INSERT INTO refresh_tokens (token_hash, grant_id) VALUES (?, ?)', sha256(refreshToken), grantId);
    return { accessToken, refreshToken, expiresIn: this.accessTtlSec };
  }

  rotateRefresh(refreshToken: string, clientId: string, resource: string): TokenPair | 'reused' | undefined {
    return this.tx(() => {
      const r = this.get(
        `SELECT t.used, g.id, g.client_id, g.resource, g.last_used_at FROM refresh_tokens t
           JOIN grants g ON g.id = t.grant_id WHERE t.token_hash = ?`,
        sha256(refreshToken),
      );
      if (!r || r.client_id !== clientId || r.resource !== resource) return undefined;
      if (this.now() - r.last_used_at > REFRESH_IDLE) return undefined;
      if (r.used) {
        this.run('DELETE FROM grants WHERE id = ?', r.id);
        return 'reused';
      }
      this.run('UPDATE refresh_tokens SET used = 1, used_at = ? WHERE token_hash = ?', this.now(), sha256(refreshToken));
      this.run('UPDATE grants SET last_used_at = ? WHERE id = ?', this.now(), r.id);
      return this.issue(r.id);
    });
  }

  verifyAccess(accessToken: string) {
    const r = this.get(
      `SELECT g.id, g.mm_user_id, g.client_id, g.scope FROM access_tokens t
         JOIN grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.expires_at > ?`,
      sha256(accessToken), this.now(),
    );
    return r && { grantId: r.id as number, mmUserId: r.mm_user_id as string, clientId: r.client_id as string, scope: r.scope as string };
  }

  revokeUser(mmUserId: string): void {
    this.tx(() => {
      this.run('DELETE FROM grants WHERE mm_user_id = ?', mmUserId);
      this.run('DELETE FROM codes WHERE mm_user_id = ?', mmUserId);
      this.run('DELETE FROM mm_creds WHERE mm_user_id = ?', mmUserId);
      this.run('DELETE FROM upload_urls WHERE mm_user_id = ?', mmUserId);
    });
  }

  // Not throwing when the row cannot be opened (TOKEN_ENC_KEY changed): absent sends callers down the re-login path.
  getMmCred(mmUserId: string): { access: string; refresh: string; version: number } | undefined {
    const r = this.get('SELECT * FROM mm_creds WHERE mm_user_id = ?', mmUserId);
    if (!r) return undefined;
    try {
      return { access: open(this.encKey, r.access_sealed), refresh: open(this.encKey, r.refresh_sealed), version: r.version };
    } catch {
      return undefined;
    }
  }

  // A fresh row starts its version at the current time rather than 1, so a CAS held from before revokeUser
  // cannot match the row a re-login inserts. ponytail: assumes a row is bumped fewer times than milliseconds
  // pass before it is re-inserted (each bump costs a Mattermost round trip); a persisted per-user counter if not.
  putMmCred(mmUserId: string, access: string, refresh: string): void {
    this.run(
      `INSERT INTO mm_creds (mm_user_id, access_sealed, refresh_sealed, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (mm_user_id) DO UPDATE SET access_sealed = excluded.access_sealed,
         refresh_sealed = excluded.refresh_sealed, version = version + 1`,
      mmUserId, seal(this.encKey, access), seal(this.encKey, refresh), this.now(),
    );
  }

  // A single conditional UPDATE is already atomic, so no BEGIN around it.
  casMmCred(mmUserId: string, expectedVersion: number, access: string, refresh: string): boolean {
    return this.run(
      `UPDATE mm_creds SET access_sealed = ?, refresh_sealed = ?, version = version + 1
       WHERE mm_user_id = ? AND version = ?`,
      seal(this.encKey, access), seal(this.encKey, refresh), mmUserId, expectedVersion,
    ) === 1;
  }

  claimPost(k: { mmUserId: string; channelId: string; rootId?: string; bodyHash: string }): PostClaim {
    const rootId = k.rootId ?? '';
    return this.tx(() => {
      const now = this.now();
      this.run('DELETE FROM post_claims WHERE created_at <= ?', now - POST_DEDUP_WINDOW);
      const r = this.get(
        'SELECT * FROM post_claims WHERE mm_user_id = ? AND channel_id = ? AND root_id = ? AND body_hash = ?',
        k.mmUserId, k.channelId, rootId, k.bodyHash,
      );
      if (!r) {
        const pendingPostId = randomToken();
        const id = Number(
          this.db.prepare(
            `INSERT INTO post_claims (mm_user_id, channel_id, root_id, body_hash, pending_post_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(k.mmUserId, k.channelId, rootId, k.bodyHash, pendingPostId, now, now).lastInsertRowid,
        );
        return { kind: 'new', id, pendingPostId, claimedAt: now };
      }
      if (r.post_id) return { kind: 'done', postId: r.post_id };
      if (now - r.updated_at < INFLIGHT_GRACE) return { kind: 'inflight' };
      const won = this.run('UPDATE post_claims SET updated_at = ? WHERE id = ? AND updated_at = ?', now, r.id, r.updated_at);
      return won === 1
        ? { kind: 'retry', id: r.id, pendingPostId: r.pending_post_id, createdAt: r.created_at, claimedAt: now }
        : { kind: 'inflight' };
    });
  }

  completePost(id: number, postId: string): void {
    this.run('UPDATE post_claims SET post_id = ?, updated_at = ? WHERE id = ?', postId, this.now(), id);
  }

  reclaimPost(id: number, claimedAt: number): number | undefined {
    const now = this.now();
    return this.run('UPDATE post_claims SET updated_at = ? WHERE id = ? AND updated_at = ?', now, id, claimedAt) === 1 ? now : undefined;
  }

  // claimedAt guards against a slow first request deleting a claim that a retry has since taken over.
  dropPost(id: number, claimedAt: number): void {
    this.run('DELETE FROM post_claims WHERE id = ? AND updated_at = ?', id, claimedAt);
  }

  forgetPost(mmUserId: string, postId: string): void {
    this.run('DELETE FROM post_claims WHERE mm_user_id = ? AND post_id = ?', mmUserId, postId);
  }

  openUploadUrlCount(mmUserId: string): number {
    return Number(this.get('SELECT COUNT(*) AS n FROM upload_urls WHERE mm_user_id = ? AND used_at IS NULL AND expires_at > ?', mmUserId, this.now())?.n ?? 0);
  }

  // Not a COUNT outside the transaction: two requests at the cap would both get in.
  createUploadUrl(t: UploadTarget): string | undefined {
    return this.tx(() => {
      const now = this.now();
      if (this.openUploadUrlCount(t.mmUserId) >= MAX_OPEN_UPLOAD_URLS) return undefined;
      const token = randomToken();
      this.run('INSERT INTO upload_urls (token_hash, mm_user_id, channel_id, expires_at) VALUES (?, ?, ?, ?)',
        sha256(token), t.mmUserId, t.channelId, now + UPLOAD_URL_TTL);
      return token;
    });
  }

  takeUploadUrl(token: string): UploadTarget | undefined {
    const r = this.get(
      'UPDATE upload_urls SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING mm_user_id, channel_id',
      this.now(), sha256(token), this.now(),
    );
    return r && { mmUserId: r.mm_user_id, channelId: r.channel_id };
  }

  // Only for a request that sent nothing to Mattermost, so the same URL can be tried again.
  releaseUploadUrl(token: string): void {
    this.run('UPDATE upload_urls SET used_at = NULL WHERE token_hash = ?', sha256(token));
  }

  recordUploadedFile(t: UploadTarget, fileId: string): void {
    this.run('INSERT OR IGNORE INTO uploaded_files (file_id, mm_user_id, channel_id, created_at) VALUES (?, ?, ?, ?)',
      fileId, t.mmUserId, t.channelId, this.now());
  }

  uploadedFiles(mmUserId: string, fileIds: string[]): UploadedFile[] {
    const stmt = this.db.prepare('SELECT * FROM uploaded_files WHERE file_id = ? AND mm_user_id = ? AND created_at > ?');
    return fileIds.flatMap((id) => {
      const r = stmt.get(id, mmUserId, this.now() - UPLOADED_FILE_KEEP) as Row | undefined;
      return r ? [{ fileId: r.file_id, channelId: r.channel_id, postId: r.post_id }] : [];
    });
  }

  markFilesPosted(mmUserId: string, fileIds: string[], postId: string): void {
    // Not overwriting a post_id already set: Mattermost keeps a file on the first post that took it.
    const stmt = this.db.prepare('UPDATE uploaded_files SET post_id = ? WHERE file_id = ? AND mm_user_id = ? AND post_id IS NULL');
    for (const id of fileIds) stmt.run(postId, id, mmUserId);
  }

  pendingScheduledCount(mmUserId: string): number {
    return Number(this.get("SELECT COUNT(*) AS n FROM scheduled_posts WHERE mm_user_id = ? AND status = 'pending'", mmUserId)?.n ?? 0);
  }

  // Not a COUNT outside the transaction: two requests at the cap would both get in.
  // Not checking the held files outside the transaction either: two schedules taking one file would both get in, and Mattermost gives it to the first only.
  createScheduled(s: { mmUserId: string; channelId: string; rootId?: string; message: string; scheduledAt: number; fileIds?: string[] }, now: number): string | undefined {
    const fileIds = s.fileIds ?? [];
    return this.tx(() => {
      if (this.pendingScheduledCount(s.mmUserId) >= MAX_PENDING_SCHEDULED) return undefined;
      const [held] = this.heldScheduledFiles(s.mmUserId, fileIds);
      if (held) throw new FileHeld(held);
      const id = randomToken();
      this.run(
        `INSERT INTO scheduled_posts (id, mm_user_id, channel_id, root_id, message_sealed, scheduled_at, status, created_at, updated_at, file_ids)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        id, s.mmUserId, s.channelId, s.rootId ?? '', seal(this.encKey, s.message), s.scheduledAt, now, now, JSON.stringify(fileIds),
      );
      return id;
    });
  }

  // Not releasing the files of a failed row that keeps its attempt: it may have been posted, and Mattermost would drop the files from any other post.
  heldScheduledFiles(mmUserId: string, fileIds: string[]): HeldFile[] {
    if (!fileIds.length) return [];
    const rows = this.db.prepare(
      `SELECT f.value AS file_id, s.id FROM scheduled_posts s, json_each(s.file_ids) f
       WHERE s.mm_user_id = ? AND f.value IN (SELECT value FROM json_each(?))
         AND (s.status IN ('pending', 'sending', 'posted') OR (s.status = 'failed' AND s.first_attempt_at IS NOT NULL))
       ORDER BY s.created_at, s.id`,
    ).all(mmUserId, JSON.stringify(fileIds)) as Row[];
    return rows.map((r) => ({ fileId: r.file_id, scheduledId: r.id }));
  }

  private scheduled(r: Row): Scheduled {
    let message: string | undefined;
    // Not throwing: one row sealed under an old TOKEN_ENC_KEY must not hide the rest of the list, which is where failures are reported.
    try {
      message = open(this.encKey, r.message_sealed);
    } catch {
      message = undefined;
    }
    return {
      id: r.id, channelId: r.channel_id, rootId: r.root_id, message, scheduledAt: r.scheduled_at,
      status: r.status, postId: r.post_id, error: r.error, fileIds: JSON.parse(r.file_ids),
    };
  }

  getScheduled(mmUserId: string, id: string): Scheduled | undefined {
    const r = this.get('SELECT * FROM scheduled_posts WHERE id = ? AND mm_user_id = ?', id, mmUserId);
    return r && this.scheduled(r);
  }

  listScheduled(mmUserId: string, q: { status?: ScheduledStatus; after?: { at: number; id: string }; limit: number }): Scheduled[] {
    const rows = this.db.prepare(
      `SELECT * FROM scheduled_posts WHERE mm_user_id = ? AND (? IS NULL OR status = ?)
         AND (? IS NULL OR scheduled_at > ? OR (scheduled_at = ? AND id > ?))
       ORDER BY scheduled_at, id LIMIT ?`,
    ).all(mmUserId, q.status ?? null, q.status ?? null, q.after?.at ?? null, q.after?.at ?? null, q.after?.at ?? null, q.after?.id ?? null, q.limit) as Row[];
    return rows.map((r) => this.scheduled(r));
  }

  // Not changing a row that has been attempted: a retry looks for the post by its old message, and a new one would post a second time.
  updateScheduled(mmUserId: string, id: string, c: { message?: string; scheduledAt?: number }, now: number): Scheduled | undefined {
    const r = this.get(
      `UPDATE scheduled_posts SET message_sealed = COALESCE(?, message_sealed), scheduled_at = COALESCE(?, scheduled_at), updated_at = ?
       WHERE id = ? AND mm_user_id = ? AND status = 'pending' AND first_attempt_at IS NULL RETURNING *`,
      c.message === undefined ? null : seal(this.encKey, c.message), c.scheduledAt ?? null, now, id, mmUserId,
    );
    return r && this.scheduled(r);
  }

  cancelScheduled(mmUserId: string, id: string): boolean {
    return this.run(
      "DELETE FROM scheduled_posts WHERE id = ? AND mm_user_id = ? AND status = 'pending' AND first_attempt_at IS NULL",
      id, mmUserId,
    ) === 1;
  }

  resetSendingScheduled(now: number): void {
    this.run("UPDATE scheduled_posts SET status = 'pending', updated_at = ? WHERE status = 'sending' AND updated_at <= ?", now, now - INFLIGHT_GRACE);
  }

  failUnattemptedScheduled(before: number, error: string, now: number): void {
    this.run(
      "UPDATE scheduled_posts SET status = 'failed', error = ?, updated_at = ? WHERE status = 'pending' AND first_attempt_at IS NULL AND scheduled_at < ?",
      error, now, before,
    );
  }

  // Not ordered by scheduled_at first: rows put back after a temporary failure would take every slot of each tick.
  dueScheduled(now: number, limit: number): string[] {
    return (this.db.prepare("SELECT id FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= ? ORDER BY updated_at, scheduled_at, id LIMIT ?")
      .all(now, limit) as Row[]).map((r) => r.id);
  }

  // Not trusting the row as it was picked: the user can change or cancel it until this UPDATE, so the message comes from its RETURNING.
  // Not marking the attempt when the message cannot be opened: nothing will be sent, and the row should read as never attempted.
  claimScheduled(id: string, now: number, attemptAt: number): ClaimedScheduled | undefined {
    return this.tx(() => {
      const r = this.get(
        "UPDATE scheduled_posts SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'pending' AND scheduled_at <= ? RETURNING *",
        now, id, now,
      );
      if (!r) return undefined;
      const s = { ...this.scheduled(r), mmUserId: r.mm_user_id, pendingPostId: r.pending_post_id, firstAttemptAt: r.first_attempt_at, retry: r.first_attempt_at !== null };
      if (!s.retry && s.message !== undefined) {
        s.pendingPostId = randomToken();
        s.firstAttemptAt = attemptAt;
        this.run('UPDATE scheduled_posts SET pending_post_id = ?, first_attempt_at = ? WHERE id = ?', s.pendingPostId, attemptAt, id);
      }
      return s;
    });
  }

  // Not a second statement after the UPDATE: a crash between them would leave a posted schedule's files unmarked, and send_message would refuse them with the wrong reason.
  settleScheduled(id: string, now: number, o: ScheduledOutcome): void {
    const forget = o.status !== 'posted' && o.forgetAttempt ? 1 : 0;
    const posted = o.status === 'posted';
    const error = o.status === 'failed' ? o.error : o.status === 'posted' ? o.note ?? null : null;
    this.tx(() => {
      const r = this.get(
        `UPDATE scheduled_posts SET status = ?, post_id = ?, error = ?, updated_at = ?,
           first_attempt_at = CASE WHEN ? THEN NULL ELSE first_attempt_at END, pending_post_id = CASE WHEN ? THEN NULL ELSE pending_post_id END,
           file_ids = CASE WHEN ? THEN ? ELSE file_ids END
         WHERE id = ? AND status = 'sending' RETURNING mm_user_id`,
        o.status, posted ? o.postId : null, error, now, forget, forget, posted ? 1 : 0, posted ? JSON.stringify(o.fileIds) : null, id,
      );
      if (r && o.status === 'posted' && o.fileIds.length) this.markFilesPosted(r.mm_user_id, o.fileIds, o.postId);
    });
  }

  otherScheduledPostIds(mmUserId: string, id: string): Set<string> {
    const rows = this.db.prepare('SELECT post_id FROM scheduled_posts WHERE mm_user_id = ? AND id != ? AND post_id IS NOT NULL').all(mmUserId, id) as Row[];
    return new Set(rows.map((r) => r.post_id));
  }

  // Not trusting first_attempt_at alone: a row whose time passed after the snapshot may have been posted from the database that was lost.
  invalidateScheduled(now: number, error: { unattempted: string; unknown: string }): number {
    return this.run(
      `UPDATE scheduled_posts SET status = 'failed', error = CASE WHEN first_attempt_at IS NULL AND scheduled_at > ? THEN ? ELSE ? END, updated_at = ?
       WHERE status IN ('pending', 'sending')`,
      now, error.unattempted, error.unknown, now,
    );
  }

  purgeCredentials(): number {
    return this.tx(() => {
      let n = 0;
      for (const t of ['post_claims', 'upload_urls', 'mm_creds', 'refresh_tokens', 'access_tokens', 'grants', 'codes', 'auth_sessions'])
        n += this.run(`DELETE FROM ${t}`);
      return n;
    });
  }

  listClients(unauthorizedOnly = false): Client[] {
    const rows = this.db
      .prepare(`SELECT client_id FROM clients ${unauthorizedOnly ? 'WHERE authorized_at IS NULL' : ''} ORDER BY created_at`)
      .all() as Row[];
    return rows.map((r) => this.getClient(r.client_id)!);
  }

  // No FK from these tables to clients, so the children are removed here; token tables cascade from grants.
  deleteClient(id: string): boolean {
    return this.tx(() => {
      for (const t of ['grants', 'codes', 'auth_sessions']) this.run(`DELETE FROM ${t} WHERE client_id = ?`, id);
      return this.run('DELETE FROM clients WHERE client_id = ?', id) === 1;
    });
  }

  sweep(): void {
    const now = this.now();
    this.tx(() => {
      this.run('DELETE FROM clients WHERE authorized_at IS NULL AND created_at <= ?', now - UNAUTHORIZED_CLIENT_TTL);
      this.run('DELETE FROM auth_sessions WHERE created_at <= ?', now - AUTH_SESSION_TTL);
      this.run('DELETE FROM codes WHERE expires_at <= ?', now);
      this.run('DELETE FROM access_tokens WHERE expires_at <= ?', now);
      this.run('DELETE FROM grants WHERE last_used_at < ?', now - REFRESH_IDLE);
      this.run('DELETE FROM refresh_tokens WHERE used = 1 AND used_at < ?', now - USED_REFRESH_KEEP);
      this.run('DELETE FROM post_claims WHERE created_at <= ?', now - POST_DEDUP_WINDOW);
      this.run("DELETE FROM scheduled_posts WHERE status IN ('posted', 'failed') AND updated_at <= ?", now - SCHEDULED_KEEP);
      this.run('DELETE FROM upload_urls WHERE expires_at <= ?', now);
      this.run('DELETE FROM uploaded_files WHERE created_at <= ?', now - UPLOADED_FILE_KEEP);
    });
  }
}

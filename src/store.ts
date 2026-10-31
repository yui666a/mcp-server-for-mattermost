import type { DatabaseSync } from 'node:sqlite';
import { open, randomToken, seal, sha256 } from './crypto.ts';

const SEC = 1000;
const CODE_TTL = 60 * SEC;
const AUTH_SESSION_TTL = 600 * SEC;
const REFRESH_IDLE = 90 * 24 * 3600 * SEC;
const UNAUTHORIZED_CLIENT_TTL = 7 * 24 * 3600 * SEC;
const UNAUTHORIZED_CLIENT_CAP = 500;
const POST_DEDUP_WINDOW = 600 * SEC;
const INFLIGHT_GRACE = 30 * SEC;
const CONSUMED_CODE_KEEP = 24 * 3600 * SEC;

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
      this.run('UPDATE refresh_tokens SET used = 1 WHERE token_hash = ?', sha256(refreshToken));
      this.run('DELETE FROM refresh_tokens WHERE grant_id = ? AND used = 1 AND token_hash != ?', r.id, sha256(refreshToken));
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
    });
  }

  getMmCred(mmUserId: string): { access: string; refresh: string; version: number } | undefined {
    const r = this.get('SELECT * FROM mm_creds WHERE mm_user_id = ?', mmUserId);
    return r && {
      access: open(this.encKey, r.access_sealed),
      refresh: open(this.encKey, r.refresh_sealed),
      version: r.version,
    };
  }

  putMmCred(mmUserId: string, access: string, refresh: string): void {
    this.run(
      `INSERT INTO mm_creds (mm_user_id, access_sealed, refresh_sealed, version) VALUES (?, ?, ?, 1)
       ON CONFLICT (mm_user_id) DO UPDATE SET access_sealed = excluded.access_sealed,
         refresh_sealed = excluded.refresh_sealed, version = version + 1`,
      mmUserId, seal(this.encKey, access), seal(this.encKey, refresh),
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

  // claimedAt guards against a slow first request deleting a claim that a retry has since taken over.
  dropPost(id: number, claimedAt: number): void {
    this.run('DELETE FROM post_claims WHERE id = ? AND updated_at = ?', id, claimedAt);
  }

  purgeCredentials(): void {
    this.tx(() => {
      for (const t of ['post_claims', 'mm_creds', 'refresh_tokens', 'access_tokens', 'grants', 'codes', 'auth_sessions'])
        this.run(`DELETE FROM ${t}`);
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
      this.run('DELETE FROM post_claims WHERE created_at <= ?', now - POST_DEDUP_WINDOW);
    });
  }
}

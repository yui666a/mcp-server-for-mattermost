import { randomBytes } from 'node:crypto';
import { beforeEach, expect, test } from 'vitest';
import { openDb } from '../../src/db.ts';
import { sha256 } from '../../src/crypto.ts';
import { Store } from '../../src/store.ts';

const DAY = 24 * 3600 * 1000;
let t: number;
let db: ReturnType<typeof openDb>;
let store: Store;
beforeEach(() => {
  t = 1_000_000;
  db = openDb(':memory:');
  store = new Store(db, randomBytes(32), () => t, 3600);
});

const meta = { clientName: 'c', redirectUris: ['http://localhost:1/cb'] };
const codeInput = { mmUserId: 'u1', clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', resource: 'r', scope: 'mattermost' };
const sessionInput = { clientId: 'c1', redirectUri: 'http://localhost:1/cb', codeChallenge: 'ch', state: 's', resource: 'r', scope: 'mattermost' };

function grant() {
  const rec = store.consumeCode(store.createCode(codeInput));
  if (typeof rec !== 'object') throw new Error('code not consumed');
  const pair = store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
  return pair;
}

test('code is single use and reuse revokes the grant', () => {
  const code = store.createCode(codeInput);
  const rec = store.consumeCode(code);
  expect(rec).toMatchObject({ mmUserId: 'u1', clientId: 'c1', resource: 'r' });
  if (typeof rec !== 'object') throw new Error();
  const g = store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
  expect(store.verifyAccess(g.accessToken)).toMatchObject({ mmUserId: 'u1', clientId: 'c1' });
  expect(store.consumeCode(code)).toBe('reused');
  expect(store.verifyAccess(g.accessToken)).toBeUndefined();
  expect(store.rotateRefresh(g.refreshToken, 'c1', 'r')).toBeUndefined();
});

test('code expires after 60s and unknown code is undefined', () => {
  const code = store.createCode(codeInput);
  t += 60_000;
  expect(store.consumeCode(code)).toBeUndefined();
  expect(store.consumeCode('nope')).toBeUndefined();
});

test('access token expires after the configured ttl', () => {
  const g = grant();
  expect(g.expiresIn).toBe(3600);
  t += 3600_000 - 1;
  expect(store.verifyAccess(g.accessToken)).toBeDefined();
  t += 1;
  expect(store.verifyAccess(g.accessToken)).toBeUndefined();
});

test('refresh rotation detects reuse and revokes the family', () => {
  const g1 = grant();
  const g2 = store.rotateRefresh(g1.refreshToken, 'c1', 'r');
  if (typeof g2 !== 'object') throw new Error();
  expect(store.rotateRefresh(g1.refreshToken, 'c1', 'r')).toBe('reused');
  expect(store.rotateRefresh(g2.refreshToken, 'c1', 'r')).toBeUndefined();
  expect(store.verifyAccess(g2.accessToken)).toBeUndefined();
});

test('refresh with another client or resource is rejected without revoking', () => {
  const g = grant();
  expect(store.rotateRefresh(g.refreshToken, 'other', 'r')).toBeUndefined();
  expect(store.rotateRefresh(g.refreshToken, 'c1', 'other')).toBeUndefined();
  expect(store.rotateRefresh(g.refreshToken, 'c1', 'r')).toMatchObject({ expiresIn: 3600 });
});

test('refresh extends idle expiry and expires after 90 idle days', () => {
  const g = grant();
  t += 89 * DAY;
  const g2 = store.rotateRefresh(g.refreshToken, 'c1', 'r');
  if (typeof g2 !== 'object') throw new Error();
  t += 2 * DAY;
  const g3 = store.rotateRefresh(g2.refreshToken, 'c1', 'r');
  if (typeof g3 !== 'object') throw new Error();
  t += 90 * DAY + 1000;
  expect(store.rotateRefresh(g3.refreshToken, 'c1', 'r')).toBeUndefined();
});

test('auth session is single use and expires after 600s', () => {
  const s = store.createAuthSession(sessionInput);
  expect(s.sessionId).toHaveLength(16);
  expect(store.approveAuthSession(s.sessionId, 'bad', s.csrf)).toBeUndefined();
  expect(store.approveAuthSession(s.sessionId, s.cookieSecret, 'bad')).toBeUndefined();
  const a = store.approveAuthSession(s.sessionId, s.cookieSecret, s.csrf);
  if (!a) throw new Error();
  expect(store.findSessionIdByUpstreamState(a.upstreamState)).toBe(s.sessionId);
  expect(store.takeAuthSession(s.sessionId, 'bad', a.upstreamState)).toBeUndefined();
  expect(store.takeAuthSession(s.sessionId, s.cookieSecret, 'bad')).toBeUndefined();
  expect(store.takeAuthSession(s.sessionId, s.cookieSecret, a.upstreamState)).toMatchObject({
    clientId: 'c1', state: 's', upstreamVerifier: a.upstreamVerifier,
  });
  expect(store.takeAuthSession(s.sessionId, s.cookieSecret, a.upstreamState)).toBeUndefined();

  const s2 = store.createAuthSession(sessionInput);
  const a2 = store.approveAuthSession(s2.sessionId, s2.cookieSecret, s2.csrf)!;
  t += 600_000;
  expect(store.takeAuthSession(s2.sessionId, s2.cookieSecret, a2.upstreamState)).toBeUndefined();
  const s3 = store.createAuthSession(sessionInput);
  t += 600_000;
  expect(store.approveAuthSession(s3.sessionId, s3.cookieSecret, s3.csrf)).toBeUndefined();
});

test('unauthorized clients are evicted oldest-first beyond 500, authorized ones are kept', () => {
  const keep = store.createClient(meta);
  store.markClientAuthorized(keep.clientId);
  const first = store.createClient(meta);
  const rest = Array.from({ length: 500 }, () => store.createClient(meta));
  expect(store.getClient(first.clientId)).toBeUndefined();
  expect(store.getClient(rest[0].clientId)).toBeDefined();
  expect(store.getClient(keep.clientId)?.authorizedAt).toBe(t);
  expect(db.prepare('SELECT count(*) AS n FROM clients').get()).toEqual({ n: 501 });
});

test('sweep removes unauthorized clients older than 7 days but keeps authorized ones', () => {
  const a = store.createClient(meta);
  store.markClientAuthorized(a.clientId);
  const u = store.createClient(meta);
  t += 7 * DAY - 1;
  store.sweep();
  expect(store.getClient(u.clientId)).toBeDefined();
  t += 1;
  store.sweep();
  expect(store.getClient(u.clientId)).toBeUndefined();
  expect(store.getClient(a.clientId)).toBeDefined();
});

test('sweep removes expired codes, access tokens, auth sessions, idle grants and old claims', () => {
  const g = grant();
  store.createCode(codeInput);
  store.createAuthSession(sessionInput);
  store.claimPost({ mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' });
  t += 90 * DAY + 1000;
  store.sweep();
  for (const tbl of ['codes', 'access_tokens', 'auth_sessions', 'grants', 'refresh_tokens', 'post_claims'])
    expect(db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get()).toEqual({ n: 0 });
  expect(store.verifyAccess(g.accessToken)).toBeUndefined();
});

test('casMmCred fails when version changed', () => {
  store.putMmCred('u1', 'a1', 'r1');
  expect(store.getMmCred('u1')).toEqual({ access: 'a1', refresh: 'r1', version: 1 });
  expect(store.casMmCred('u1', 1, 'a2', 'r2')).toBe(true);
  expect(store.casMmCred('u1', 1, 'a3', 'r3')).toBe(false);
  expect(store.getMmCred('u1')).toEqual({ access: 'a2', refresh: 'r2', version: 2 });
  store.putMmCred('u1', 'a4', 'r4');
  expect(store.getMmCred('u1')?.version).toBe(3);
  expect(store.casMmCred('nobody', 1, 'a', 'r')).toBe(false);
});

test('sealed Mattermost tokens are not stored in plain text', () => {
  store.putMmCred('u1', 'plain-access-token', 'plain-refresh-token');
  const raw = JSON.stringify(db.prepare('SELECT * FROM mm_creds').all());
  expect(raw).not.toContain('plain-access-token');
  expect(raw).not.toContain('plain-refresh-token');
});

test('only hashes of codes and tokens are stored', () => {
  const code = store.createCode(codeInput);
  const g = grant();
  const raw = JSON.stringify([db.prepare('SELECT * FROM codes').all(), db.prepare('SELECT * FROM access_tokens').all(), db.prepare('SELECT * FROM refresh_tokens').all()]);
  for (const secret of [code, g.accessToken, g.refreshToken]) expect(raw).not.toContain(secret);
  expect(raw).toContain(sha256(g.accessToken));
});

test('revokeUser removes grants and Mattermost tokens of that user only', () => {
  const g = grant();
  store.putMmCred('u1', 'a', 'r');
  store.putMmCred('u2', 'a', 'r');
  store.revokeUser('u1');
  expect(store.verifyAccess(g.accessToken)).toBeUndefined();
  expect(store.getMmCred('u1')).toBeUndefined();
  expect(store.getMmCred('u2')).toBeDefined();
});

test('claimPost: new → inflight within 30s → retry after 30s (only one claimer) → done', () => {
  const k = { mmUserId: 'u1', channelId: 'ch', rootId: 'root', bodyHash: 'h' };
  const c1 = store.claimPost(k);
  expect(c1.kind).toBe('new');
  if (c1.kind !== 'new') throw new Error();
  t += 29_999;
  expect(store.claimPost(k)).toEqual({ kind: 'inflight' });
  t += 1;
  const r = store.claimPost(k);
  expect(r).toEqual({ kind: 'retry', id: c1.id, pendingPostId: c1.pendingPostId, createdAt: 1_000_000, claimedAt: t });
  expect(store.claimPost(k)).toEqual({ kind: 'inflight' });
  store.completePost(c1.id, 'post1');
  expect(store.claimPost(k)).toEqual({ kind: 'done', postId: 'post1' });
  expect(store.claimPost({ ...k, rootId: undefined })).toMatchObject({ kind: 'new' });
});

test('claimPost: dropped claims can be retaken and claims expire after 600s', () => {
  const k = { mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' };
  const c = store.claimPost(k);
  if (c.kind !== 'new') throw new Error();
  store.dropPost(c.id, c.claimedAt);
  const c2 = store.claimPost(k);
  if (c2.kind !== 'new') throw new Error();
  store.completePost(c2.id, 'p');
  t += 600_000;
  expect(store.claimPost(k).kind).toBe('new');
});

test('purgeCredentials keeps clients', () => {
  const c = store.createClient(meta);
  grant();
  store.putMmCred('u1', 'a', 'r');
  store.createAuthSession(sessionInput);
  store.claimPost({ mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' });
  store.purgeCredentials();
  expect(store.getClient(c.clientId)).toBeDefined();
  for (const tbl of ['codes', 'grants', 'access_tokens', 'refresh_tokens', 'mm_creds', 'auth_sessions', 'post_claims'])
    expect(db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get()).toEqual({ n: 0 });
});

test('revokeUser also invalidates unconsumed codes of that user', () => {
  const code = store.createCode(codeInput);
  store.revokeUser('u1');
  expect(store.consumeCode(code)).toBeUndefined();
});

test('reuse of a consumed code still revokes the grant 10 minutes later, but not after 24 hours', () => {
  const code = store.createCode(codeInput);
  const rec = store.consumeCode(code);
  if (typeof rec !== 'object') throw new Error();
  const g = store.createGrant({ mmUserId: 'u1', clientId: 'c1', scope: 'mattermost', resource: 'r', fromCodeHash: rec.codeHash });
  t += 600_000;
  store.sweep();
  expect(store.consumeCode(code)).toBe('reused');
  expect(store.verifyAccess(g.accessToken)).toBeUndefined();
  t += DAY;
  store.sweep();
  expect(store.consumeCode(code)).toBeUndefined();
});

test('rotation keeps at most two refresh rows per grant and still detects reuse of the previous generation', () => {
  const first = grant();
  let cur = first;
  const olds: string[] = [];
  for (let i = 0; i < 5; i++) {
    olds.push(cur.refreshToken);
    const n = store.rotateRefresh(cur.refreshToken, 'c1', 'r');
    if (typeof n !== 'object') throw new Error();
    cur = n;
  }
  expect(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get()).toEqual({ n: 2 });
  expect(store.rotateRefresh(olds[4], 'c1', 'r')).toBe('reused');
  expect(store.verifyAccess(cur.accessToken)).toBeUndefined();
});

test('a stale dropPost does not delete a claim that a retry has taken over', () => {
  const k = { mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' };
  const c1 = store.claimPost(k);
  if (c1.kind !== 'new') throw new Error();
  t += 30_000;
  const r = store.claimPost(k);
  if (r.kind !== 'retry') throw new Error();
  store.dropPost(c1.id, c1.claimedAt);
  expect(store.claimPost(k)).toEqual({ kind: 'inflight' });
  store.dropPost(r.id, r.claimedAt);
  expect(store.claimPost(k).kind).toBe('new');
});

test('the upstream PKCE verifier is not stored in plain text', () => {
  const s = store.createAuthSession(sessionInput);
  const a = store.approveAuthSession(s.sessionId, s.cookieSecret, s.csrf)!;
  expect(JSON.stringify(db.prepare('SELECT * FROM auth_sessions').all())).not.toContain(a.upstreamVerifier);
});

import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
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
  const v = store.getMmCred('u1')!.version;
  expect(store.getMmCred('u1')).toEqual({ access: 'a1', refresh: 'r1', version: v });
  expect(store.casMmCred('u1', v, 'a2', 'r2')).toBe(true);
  expect(store.casMmCred('u1', v, 'a3', 'r3')).toBe(false);
  expect(store.getMmCred('u1')).toEqual({ access: 'a2', refresh: 'r2', version: v + 1 });
  store.putMmCred('u1', 'a4', 'r4');
  expect(store.getMmCred('u1')?.version).toBe(v + 2);
  expect(store.casMmCred('nobody', v, 'a', 'r')).toBe(false);
});

test('a refresh that started before revoke and re-login cannot overwrite the new credentials', () => {
  store.putMmCred('u1', 'a1', 'r1');
  const stale = store.getMmCred('u1')!.version;
  store.revokeUser('u1');
  t += 1000;
  store.putMmCred('u1', 'a2', 'r2');
  expect(store.casMmCred('u1', stale, 'a-stale', 'r-stale')).toBe(false);
  expect(store.getMmCred('u1')).toMatchObject({ access: 'a2', refresh: 'r2' });
});

test('credentials sealed under another key read as absent', () => {
  new Store(db, randomBytes(32), () => t, 3600).putMmCred('u1', 'a1', 'r1');
  expect(store.getMmCred('u1')).toBeUndefined();
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

test('forgetPost removes only the given user\'s claim on that post, so the same body can be posted again', () => {
  const k = { mmUserId: 'u1', channelId: 'ch', bodyHash: 'h' };
  for (const [uid, postId] of [['u1', 'p1'], ['u1', 'p2'], ['u2', 'p1']]) {
    const c = store.claimPost({ ...k, mmUserId: uid, bodyHash: postId });
    if (c.kind !== 'new') throw new Error();
    store.completePost(c.id, postId);
  }
  store.forgetPost('u1', 'p1');
  expect(store.claimPost({ ...k, bodyHash: 'p1' }).kind).toBe('new');
  expect(store.claimPost({ ...k, bodyHash: 'p2' })).toEqual({ kind: 'done', postId: 'p2' });
  expect(store.claimPost({ ...k, mmUserId: 'u2', bodyHash: 'p1' })).toEqual({ kind: 'done', postId: 'p1' });
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

test('reuse of a refresh token three generations back revokes the family', () => {
  let cur = grant();
  const olds: string[] = [];
  for (let i = 0; i < 4; i++) {
    olds.push(cur.refreshToken);
    const n = store.rotateRefresh(cur.refreshToken, 'c1', 'r');
    if (typeof n !== 'object') throw new Error();
    cur = n;
  }
  expect(store.rotateRefresh(olds[0], 'c1', 'r')).toBe('reused');
  expect(store.verifyAccess(cur.accessToken)).toBeUndefined();
  expect(store.rotateRefresh(cur.refreshToken, 'c1', 'r')).toBeUndefined();
});

test('used refresh rows are kept for 7 days after use, then swept', () => {
  const g1 = grant();
  const g2 = store.rotateRefresh(g1.refreshToken, 'c1', 'r');
  if (typeof g2 !== 'object') throw new Error();
  t += 7 * DAY;
  store.sweep();
  expect(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get()).toEqual({ n: 2 });
  t += 1000;
  store.sweep();
  expect(db.prepare('SELECT count(*) AS n FROM refresh_tokens').get()).toEqual({ n: 1 });
  expect(store.rotateRefresh(g1.refreshToken, 'c1', 'r')).toBeUndefined();
  expect(store.rotateRefresh(g2.refreshToken, 'c1', 'r')).toMatchObject({ expiresIn: 3600 });
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

describe('scheduled posts', () => {
  const MIN = 60_000;
  const at = (n: number) => t + n * MIN;
  const make = (over: Partial<{ mmUserId: string; channelId: string; rootId: string; message: string; scheduledAt: number }> = {}) =>
    store.createScheduled({ mmUserId: 'u1', channelId: 'c1', message: 'hello', scheduledAt: at(10), ...over }, t);
  const setRow = (id: string, sql: string, ...p: (string | number)[]) => db.prepare(`UPDATE scheduled_posts SET ${sql} WHERE id = ?`).run(...p, id);

  test('a new schedule gets an unguessable id and is listed as pending with its own fields', () => {
    const id = make({ rootId: 'r1' })!;
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(make({ scheduledAt: at(20) })).not.toBe(id);
    expect(store.listScheduled('u1', { limit: 10 })[0]).toMatchObject({
      id, channelId: 'c1', rootId: 'r1', message: 'hello', scheduledAt: at(10), status: 'pending', postId: null, error: null,
    });
  });

  test('lists only the owner\'s schedules, earliest first, filtered by status and continued after a key', () => {
    const late = make({ scheduledAt: at(30) })!;
    const early = make({ scheduledAt: at(5) })!;
    const mid = make({ scheduledAt: at(20) })!;
    make({ mmUserId: 'u2', scheduledAt: at(1) });
    setRow(mid, "status = 'failed', error = 'x'");
    expect(store.listScheduled('u1', { limit: 10 }).map((s) => s.id)).toEqual([early, mid, late]);
    expect(store.listScheduled('u1', { status: 'pending', limit: 10 }).map((s) => s.id)).toEqual([early, late]);
    expect(store.listScheduled('u1', { limit: 1, after: { at: at(5), id: early } }).map((s) => s.id)).toEqual([mid]);
  });

  test('ties on the scheduled time are ordered by id so a page boundary neither repeats nor skips', () => {
    const ids = [make(), make(), make()].map((x) => x!).sort();
    const first = store.listScheduled('u1', { limit: 2 });
    expect(first.map((s) => s.id)).toEqual(ids.slice(0, 2));
    expect(store.listScheduled('u1', { limit: 2, after: { at: at(10), id: ids[1] } }).map((s) => s.id)).toEqual([ids[2]]);
  });

  test('a user can hold 20 pending schedules; the 21st is refused, and finished ones do not count', () => {
    const ids = Array.from({ length: 20 }, () => make());
    expect(ids.every(Boolean)).toBe(true);
    expect(make()).toBeUndefined();
    expect(make({ mmUserId: 'u2' })).toBeDefined();
    setRow(ids[0]!, "status = 'posted', post_id = 'p'");
    expect(make()).toBeDefined();
  });

  test('update changes the message and the time of a pending schedule that has not been attempted', () => {
    const id = make()!;
    t += MIN;
    expect(store.updateScheduled('u1', id, { message: 'changed' }, t)).toMatchObject({ message: 'changed', scheduledAt: at(9) });
    expect(store.updateScheduled('u1', id, { scheduledAt: at(60) }, t)).toMatchObject({ message: 'changed', scheduledAt: at(60) });
  });

  test.each([
    ['another user\'s schedule', (id: string) => id, 'u2'],
    ['an unknown id', () => 'nope', 'u1'],
  ])('update and cancel treat %s as missing', (_, idOf, user) => {
    const id = make()!;
    expect(store.updateScheduled(user, idOf(id), { message: 'x' }, t)).toBeUndefined();
    expect(store.cancelScheduled(user, idOf(id))).toBe(false);
    expect(store.listScheduled('u1', { limit: 10 })).toMatchObject([{ id, message: 'hello' }]);
  });

  test.each([
    ["status = 'sending'"],
    ["status = 'posted', post_id = 'p'"],
    ["status = 'failed', error = 'e'"],
    ['first_attempt_at = 1'],
  ])('update and cancel refuse a schedule with %s', (sql) => {
    const id = make()!;
    setRow(id, sql);
    expect(store.updateScheduled('u1', id, { message: 'x' }, t)).toBeUndefined();
    expect(store.cancelScheduled('u1', id)).toBe(false);
    expect(store.listScheduled('u1', { limit: 10 })).toMatchObject([{ id, message: 'hello' }]);
  });

  test('cancel removes the row', () => {
    const id = make()!;
    expect(store.cancelScheduled('u1', id)).toBe(true);
    expect(store.listScheduled('u1', { limit: 10 })).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM scheduled_posts').get()).toEqual({ n: 0 });
  });

  test('the message is not stored in plain text', () => {
    const id = make({ message: 'very secret plan' })!;
    store.updateScheduled('u1', id, { message: 'another secret plan' }, t);
    expect(JSON.stringify(db.prepare('SELECT * FROM scheduled_posts').all())).not.toMatch(/secret/);
  });

  test('a message sealed under another key lists as unreadable rather than failing the list', () => {
    const id = make()!;
    const other = new Store(db, randomBytes(32), () => t, 3600);
    expect(other.listScheduled('u1', { limit: 10 })).toMatchObject([{ id, message: undefined }]);
  });

  test('sweep removes posted and failed schedules 7 days after their last update and keeps the rest', () => {
    const posted = make()!;
    const failed = make()!;
    const pending = make()!;
    setRow(posted, "status = 'posted', post_id = 'p', updated_at = ?", t);
    setRow(failed, "status = 'failed', error = 'e', updated_at = ?", t + 1);
    t += 7 * DAY;
    store.sweep();
    expect(store.listScheduled('u1', { limit: 10 }).map((s) => s.id).sort()).toEqual([failed, pending].sort());
    t += 1;
    store.sweep();
    expect(store.listScheduled('u1', { limit: 10 }).map((s) => s.id)).toEqual([pending]);
  });
});

describe('upload URLs and uploaded files', () => {
  const target = { mmUserId: 'u1', channelId: 'c1' };

  test('an upload URL can be taken once, for the user and channel it was made for', () => {
    const token = store.createUploadUrl(target)!;
    expect(store.takeUploadUrl(token)).toEqual(target);
    expect(store.takeUploadUrl(token)).toBeUndefined();
  });

  test('an upload URL cannot be taken after 10 minutes', () => {
    const token = store.createUploadUrl(target)!;
    t += 600_000;
    expect(store.takeUploadUrl(token)).toBeUndefined();
  });

  test('a released upload URL can be taken again', () => {
    const token = store.createUploadUrl(target)!;
    store.takeUploadUrl(token);
    store.releaseUploadUrl(token);
    expect(store.takeUploadUrl(token)).toEqual(target);
  });

  test('a user can hold at most 5 unused upload URLs; taken or expired ones do not count', () => {
    const tokens = Array.from({ length: 5 }, () => store.createUploadUrl(target)!);
    expect(store.createUploadUrl(target)).toBeUndefined();
    expect(store.createUploadUrl({ mmUserId: 'u2', channelId: 'c1' })).toBeDefined();
    store.takeUploadUrl(tokens[0]);
    expect(store.createUploadUrl(target)).toBeDefined();
    t += 600_000;
    expect(store.createUploadUrl(target)).toBeDefined();
  });

  test('the token is not stored in plain text', () => {
    const token = store.createUploadUrl(target)!;
    expect(JSON.stringify(db.prepare('SELECT * FROM upload_urls').all())).not.toContain(token);
  });

  test('revokeUser and purgeCredentials remove upload URLs', () => {
    const a = store.createUploadUrl(target)!;
    const b = store.createUploadUrl({ mmUserId: 'u2', channelId: 'c1' })!;
    store.revokeUser('u1');
    expect(store.takeUploadUrl(a)).toBeUndefined();
    store.purgeCredentials();
    expect(store.takeUploadUrl(b)).toBeUndefined();
  });

  test('uploaded files are found only for their uploader and only for 24 hours', () => {
    store.recordUploadedFile(target, 'f1');
    expect(store.uploadedFiles('u1', ['f1', 'f2'])).toEqual([{ fileId: 'f1', channelId: 'c1', postId: null }]);
    expect(store.uploadedFiles('u2', ['f1'])).toEqual([]);
    t += DAY;
    expect(store.uploadedFiles('u1', ['f1'])).toEqual([]);
  });

  test('a file marked as posted carries the post_id', () => {
    store.recordUploadedFile(target, 'f1');
    store.markFilesPosted('u1', ['f1'], 'p1');
    expect(store.uploadedFiles('u1', ['f1'])).toEqual([{ fileId: 'f1', channelId: 'c1', postId: 'p1' }]);
  });

  test('a file keeps the post_id it was first marked with', () => {
    store.recordUploadedFile(target, 'f1');
    store.markFilesPosted('u1', ['f1'], 'p1');
    store.markFilesPosted('u1', ['f1'], 'p2');
    expect(store.uploadedFiles('u1', ['f1'])[0].postId).toBe('p1');
  });

  test('sweep removes expired upload URLs and files older than 24 hours', () => {
    store.createUploadUrl(target);
    store.recordUploadedFile(target, 'f1');
    t += DAY;
    store.sweep();
    expect(db.prepare('SELECT COUNT(*) AS n FROM upload_urls').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM uploaded_files').get()).toEqual({ n: 0 });
  });
});

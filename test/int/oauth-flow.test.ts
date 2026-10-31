import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { Store } from '../../src/store.ts';
import { env, mmAuthorizeCode, mmAvailable, mmDeauthorize, mmLoginCookie } from './helpers.ts';

const up = await mmAvailable();
const e = up ? env() : (undefined as never);

const REDIRECT = 'http://127.0.0.1:8123/cb';
const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe.skipIf(!up)('OAuth flow against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let store: Store;
  let resource: string;
  let mmCookie: string;

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // The Mattermost OAuth app only accepts http://localhost:3000/mcp/oauth/callback, so PUBLIC_URL has to match it.
    const config = loadConfig({
      PUBLIC_URL: new URL(e.oauth.callback).origin, TOKEN_ENC_KEY: randomBytes(32).toString('base64'), MM_URL: e.mmUrl,
      MM_OAUTH_CLIENT_ID: e.oauth.clientId, MM_OAUTH_CLIENT_SECRET: e.oauth.clientSecret,
    });
    store = new Store(openDb(':memory:'), config.encKey, Date.now, config.accessTokenTtlSec);
    req = request(createApp({ config, store, deps: { fetch, now: Date.now } }));
    resource = config.resource;
    mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
  });

  afterAll(() => vi.restoreAllMocks());

  test('full flow: register → authorize → consent → Mattermost login → callback → token → refresh', async () => {
    const reg = await req.post('/mcp/oauth/register').send({ client_name: 'int', redirect_uris: [REDIRECT] });
    expect(reg.status).toBe(201);
    const clientId: string = reg.body.client_id;

    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
      code_challenge_method: 'S256', state: 'client-state', resource, scope: 'mattermost',
    });
    const page = await req.get(`/mcp/oauth/authorize?${q}`);
    expect(page.status).toBe(200);
    const cookie = (page.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const field = (n: string) => new RegExp(`name="${n}" value="([^"]*)"`).exec(page.text)![1];

    const consent = await req.post('/mcp/oauth/consent').set('Cookie', cookie).type('form')
      .send({ session_id: field('session_id'), csrf: field('csrf'), decision: 'approve' });
    expect(consent.status).toBe(303);
    const mmAuthz = new URL(consent.headers.location);
    expect(mmAuthz.origin).toBe(e.mmUrl);

    const mmCode = await mmAuthorizeCode(mmCookie, Object.fromEntries(mmAuthz.searchParams));
    const cb = await req.get(`/mcp/oauth/callback?${new URLSearchParams({ code: mmCode, state: mmAuthz.searchParams.get('state')! })}`)
      .set('Cookie', cookie);
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.location);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('client-state');
    const code = back.searchParams.get('code')!;

    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource,
    });
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mattermost' });
    expect(store.verifyAccess(token.body.access_token)?.mmUserId).toBe(e.users.alice.id);

    const refreshed = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: token.body.refresh_token, resource,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(token.body.refresh_token);
    expect(store.verifyAccess(refreshed.body.access_token)?.mmUserId).toBe(e.users.alice.id);
  });
});

import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Store } from '../../src/store.ts';
import { env, intApp, mcpAuthorize, mmAvailable, mmDeauthorize, mmLoginCookie } from './helpers.ts';

const up = await mmAvailable();
const e = up ? env() : (undefined as never);

const REDIRECT = 'http://127.0.0.1:8123/cb';

describe.skipIf(!up)('OAuth flow against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let store: Store;
  let resource: string;
  let mmCookie: string;

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    ({ req, store, config: { resource } } = intApp());
    mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
  });

  afterAll(() => vi.restoreAllMocks());

  test('full flow: register → authorize → consent → Mattermost login → callback → token → refresh', async () => {
    const { clientId, code, verifier } = await mcpAuthorize(req, resource, mmCookie, REDIRECT);

    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource,
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

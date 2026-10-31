import { createHash, timingSafeEqual } from 'node:crypto';
import type { Response, Router } from 'express';
import express, { Router as makeRouter } from 'express';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import type { Store, TokenPair } from '../store.ts';

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function noStore(res: Response) {
  return res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
}

function fail(res: Response, error: string, description: string, status = error === 'invalid_client' ? 401 : 400) {
  noStore(res).status(status).json({ error, error_description: description });
}

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function tokenRouter(ctx: { config: Config; store: Store }): Router {
  const { config, store } = ctx;
  const r = makeRouter();

  const issue = (res: Response, t: TokenPair) =>
    noStore(res).json({
      access_token: t.accessToken, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: 'mattermost',
    });

  r.post('/mcp/oauth/token', express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 20 }), (req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) {
      return fail(res, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
    }
    const b = req.body ?? {};
    const grantType = str(b.grant_type);
    if (!grantType) return fail(res, 'invalid_request', 'grant_type is required');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return fail(res, 'unsupported_grant_type', 'unsupported grant_type');
    }
    if (req.headers.authorization !== undefined || b.client_secret !== undefined) {
      return fail(res, 'invalid_client', 'only public clients are supported (token_endpoint_auth_method none)');
    }
    const clientId = str(b.client_id);
    const client = clientId ? store.getClient(clientId) : undefined;
    if (!client) return fail(res, 'invalid_client', 'unknown client_id');
    if (b.resource !== config.resource) return fail(res, 'invalid_target', 'resource must be the MCP endpoint');

    if (grantType === 'refresh_token') {
      if (b.scope !== undefined && b.scope !== 'mattermost') return fail(res, 'invalid_scope', 'scope cannot be widened');
      const refreshToken = str(b.refresh_token);
      if (!refreshToken) return fail(res, 'invalid_request', 'refresh_token is required');
      // No await between rotateRefresh and the response: reuse detection relies on the store's transaction alone.
      const t = store.rotateRefresh(refreshToken, client.clientId, config.resource);
      if (t === 'reused') {
        log('token_reuse_detected', { client_id: client.clientId });
        return fail(res, 'invalid_grant', 'refresh_token is invalid');
      }
      if (!t) return fail(res, 'invalid_grant', 'refresh_token is invalid');
      log('token_refreshed', { client_id: client.clientId, mm_user_id: store.verifyAccess(t.accessToken)?.mmUserId });
      return issue(res, t);
    }

    const code = str(b.code);
    if (!code) return fail(res, 'invalid_grant', 'code is invalid');
    const rec = store.consumeCode(code);
    if (rec === 'reused') {
      log('token_reuse_detected', { client_id: client.clientId });
      return fail(res, 'invalid_grant', 'code is invalid');
    }
    const verifier = str(b.code_verifier);
    const ok = rec !== undefined
      && rec.clientId === client.clientId
      && b.redirect_uri === rec.redirectUri
      && verifier !== undefined && VERIFIER.test(verifier)
      && equal(createHash('sha256').update(verifier).digest('base64url'), rec.codeChallenge);
    if (!rec || !ok) return fail(res, 'invalid_grant', 'code is invalid');
    // Must stay synchronous with consumeCode: no await may separate them.
    const t = store.createGrant({
      mmUserId: rec.mmUserId, clientId: rec.clientId, scope: rec.scope, resource: rec.resource, fromCodeHash: rec.codeHash,
    });
    log('token_issued', { client_id: rec.clientId, mm_user_id: rec.mmUserId });
    issue(res, t);
  });

  return r;
}

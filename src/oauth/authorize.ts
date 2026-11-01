import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request, Response, Router } from 'express';
import express, { Router as makeRouter } from 'express';
import type { Config } from '../config.ts';
import type { Deps } from '../deps.ts';
import { log } from '../log.ts';
import { authorizeUrl, exchangeCode, UpstreamUnavailable, userId } from '../mattermost/upstream.ts';
import type { Store } from '../store.ts';
import { consentPage, errorPage, setPageHeaders } from './pages.ts';
import { isRegistrable, matchesRegistered } from './redirect.ts';

const CSS = readFileSync(new URL('./consent.css', import.meta.url), 'utf8');
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const cookieName = (sessionId: string) => `__Host-mcp_authz_${sessionId}`;

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function showError(res: Response, status: number, message: string) {
  setPageHeaders(res, ["'none'"]);
  res.status(status).type('html').send(errorPage(message));
}

function redirectToClient(res: Response, cfg: Config, redirectUri: string, status: 302 | 303, params: Record<string, string | null>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: cfg.issuer })) if (v !== null) u.searchParams.set(k, v);
  res.set('Cache-Control', 'no-store').redirect(status, u.href);
}

const clearCookie = (res: Response, sessionId: string) =>
  res.append('Set-Cookie', `${cookieName(sessionId)}=; ${COOKIE_ATTRS}; Max-Age=0`);

const isLoopback = (uri: string) => uri.startsWith('http://') && isRegistrable(uri, []);

export function authorizeRouter(ctx: { config: Config; store: Store; deps: Deps }): Router {
  const { config, store, deps } = ctx;
  const r = makeRouter();

  r.get('/mcp/oauth/consent.css', (_req, res) => {
    res.type('css').set('Cache-Control', 'public, max-age=3600').send(CSS);
  });

  r.get('/mcp/oauth/authorize', (req, res) => {
    const q = req.query;
    const clientId = str(q.client_id);
    const redirectUri = str(q.redirect_uri);
    const client = clientId ? store.getClient(clientId) : undefined;
    if (!client || !redirectUri || !matchesRegistered(redirectUri, client.redirectUris)) {
      return showError(res, 400, 'このアプリの登録情報と要求が一致しません。接続をやり直してください。');
    }

    const state = str(q.state) ?? null;
    const fail = (error: string, description: string) =>
      redirectToClient(res, config, redirectUri, 302, { error, error_description: description, state });
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
    if (q.state !== undefined && state === null) return fail('invalid_request', 'state must be a single value');
    if (q.code_challenge_method !== 'S256' || !S256_CHALLENGE.test(str(q.code_challenge) ?? '')) {
      return fail('invalid_request', 'PKCE with S256 is required');
    }
    if (q.resource !== config.resource) return fail('invalid_target', 'resource must be the MCP endpoint');
    const scope = q.scope ?? 'mattermost';
    if (scope !== 'mattermost') return fail('invalid_scope', 'only the mattermost scope is supported');

    const s = store.createAuthSession({
      clientId: client.clientId, redirectUri, codeChallenge: q.code_challenge as string, state, resource: config.resource, scope,
    });
    const loopback = isLoopback(redirectUri);
    const target = new URL(redirectUri);
    res.append('Set-Cookie', `${cookieName(s.sessionId)}=${s.cookieSecret}; ${COOKIE_ATTRS}; Max-Age=600`);
    setPageHeaders(res, ["'self'", new URL(config.mmBrowserUrl).origin, loopback ? `http://${target.hostname}:*` : target.origin]);
    res.type('html').send(consentPage({ clientName: client.clientName, redirectUri, loopback, sessionId: s.sessionId, csrf: s.csrf }));
  });

  r.post('/mcp/oauth/consent', express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 }), (req, res) => {
    const sessionId = str(req.body?.session_id) ?? '';
    const approved = store.approveAuthSession(sessionId, cookie(req, cookieName(sessionId)), str(req.body?.csrf) ?? '');
    if (!approved) return showError(res, 400, '同意画面の有効期限が切れたか、別のブラウザから送信されました。接続をやり直してください。');

    if (req.body.decision !== 'approve') {
      const s = store.takeAuthSession(sessionId, cookie(req, cookieName(sessionId)), approved.upstreamState);
      if (!s) return showError(res, 400, '同意画面の有効期限が切れました。接続をやり直してください。');
      clearCookie(res, sessionId);
      return redirectToClient(res, config, s.redirectUri, 303, { error: 'access_denied', state: s.state });
    }
    const challenge = createHash('sha256').update(approved.upstreamVerifier).digest('base64url');
    res.set('Cache-Control', 'no-store').redirect(303, authorizeUrl(config, approved.upstreamState, challenge));
  });

  r.get('/mcp/oauth/callback', async (req, res) => {
    const upstreamState = str(req.query.state) ?? '';
    const sessionId = store.findSessionIdByUpstreamState(upstreamState);
    const s = sessionId && store.takeAuthSession(sessionId, cookie(req, cookieName(sessionId)), upstreamState);
    if (!s) return showError(res, 400, '認可の途中の情報が見つかりません。接続をやり直してください。');
    clearCookie(res, s.sessionId);

    const code = str(req.query.code);
    if (req.query.error !== undefined || !code) {
      return redirectToClient(res, config, s.redirectUri, 302, { error: 'access_denied', state: s.state });
    }

    let step = 'exchange';
    let mmUserId: string;
    let tokens: { access: string; refresh: string };
    try {
      tokens = await exchangeCode(config, deps, code, s.upstreamVerifier);
      step = 'users_me';
      mmUserId = await userId(config, deps, tokens.access);
    } catch (e) {
      // UpstreamUnavailable messages carry only the status; anything else could embed request data.
      log('authorize_upstream_failed', { step, name: (e as Error)?.name, message: e instanceof UpstreamUnavailable ? e.message : undefined });
      return showError(res, 502, 'Mattermost との通信に失敗しました。時間をおいて接続をやり直してください。');
    }
    let ourCode: string;
    try {
      ourCode = store.transaction(() => {
        store.putMmCred(mmUserId, tokens.access, tokens.refresh);
        store.markClientAuthorized(s.clientId);
        return store.createCode({
          mmUserId, clientId: s.clientId, redirectUri: s.redirectUri, codeChallenge: s.codeChallenge, resource: s.resource, scope: s.scope,
        });
      });
    } catch (e) {
      log('unhandled_error', { name: (e as Error)?.name, code: (e as { code?: string })?.code });
      return showError(res, 500, 'サーバーで問題が起きました。時間をおいて接続をやり直してください。');
    }
    log('authorize_completed');
    redirectToClient(res, config, s.redirectUri, 302, { code: ourCode, state: s.state });
  });

  return r;
}

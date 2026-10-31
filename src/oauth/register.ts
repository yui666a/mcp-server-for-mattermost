import type { ErrorRequestHandler, Response, Router } from 'express';
import express, { Router as makeRouter } from 'express';
import type { Config } from '../config.ts';
import { log } from '../log.ts';
import type { Store } from '../store.ts';
import { isRegistrable } from './redirect.ts';

const NEAR_LIMIT = 450;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const GRANTS = ['authorization_code', 'refresh_token'];

function fail(res: Response, error: string, description: string) {
  res.status(400).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function registerRouter(ctx: { config: Config; store: Store }): Router {
  const r = makeRouter();
  r.post('/mcp/oauth/register', express.json({ limit: '16kb' }), (req, res) => {
    const b = req.body;
    const bad = (d: string) => fail(res, 'invalid_client_metadata', d);
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return bad('JSON object body required');

    const name = b.client_name ?? 'MCP client';
    if (typeof name !== 'string' || name.length > 100 || CONTROL.test(name)) return bad('invalid client_name');

    const uris = b.redirect_uris;
    if (!strArray(uris) || uris.length < 1 || uris.length > 5) return bad('redirect_uris must be 1 to 5 strings');
    if (uris.some((u) => u.length > 2000 || CONTROL.test(u))) return bad('invalid redirect_uris');

    if (b.grant_types !== undefined && (!strArray(b.grant_types) || !b.grant_types.includes('authorization_code') || b.grant_types.some((g: string) => !GRANTS.includes(g)))) {
      return bad('unsupported grant_types');
    }
    if (b.response_types !== undefined && (!strArray(b.response_types) || !b.response_types.length || b.response_types.some((t: string) => t !== 'code'))) {
      return bad('unsupported response_types');
    }
    if (b.scope !== undefined && b.scope !== 'mattermost') return bad('unsupported scope');

    if (!uris.every((u) => isRegistrable(u, ctx.config.extraRedirectUris))) {
      return fail(res, 'invalid_redirect_uri', 'redirect_uri is not allowed');
    }

    const c = ctx.store.createClient({ clientName: name, redirectUris: uris });
    const pending = ctx.store.countUnauthorizedClients();
    if (pending > NEAR_LIMIT) log('dcr_unauthorized_near_limit', { count: pending });
    log('dcr_registered', { redirectUris: uris.length });
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: c.clientId,
      client_id_issued_at: Math.floor(c.createdAt / 1000),
      client_name: c.clientName,
      redirect_uris: c.redirectUris,
      grant_types: GRANTS,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mattermost',
    });
  });
  const parseError: ErrorRequestHandler = (err, _req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return fail(res, 'invalid_client_metadata', 'invalid request body');
    }
    next(err);
  };
  r.use('/mcp/oauth/register', parseError);
  return r;
}

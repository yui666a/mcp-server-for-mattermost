import type express from 'express';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';

export type McpAuth = { grantId: number; mmUserId: string; clientId: string };

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export function requireBearer(cfg: Config, store: Store): express.RequestHandler {
  const challenge = `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp", scope="mattermost"`;
  return (req, res, next) => {
    const deny = (error?: string) => res.status(401).set({
      'WWW-Authenticate': error ? `${challenge}, error="${error}"` : challenge,
      'Cache-Control': 'no-store',
    }).json({ error: error ?? 'unauthorized' });

    const headers = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization');
    if (headers.length === 0) return deny();
    // Node keeps only the first of repeated Authorization headers, so a repeat is rejected rather than silently ignored.
    const m = headers.length === 1 ? BEARER.exec(req.headers.authorization ?? '') : null;
    const a = m ? store.verifyAccess(m[1]) : undefined;
    if (!a || a.scope !== 'mattermost') return deny('invalid_token');
    res.locals.auth = { grantId: a.grantId, mmUserId: a.mmUserId, clientId: a.clientId } satisfies McpAuth;
    next();
  };
}

export function checkOrigin(allowed: string[]): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.includes(origin)) return res.status(403).json({ error: 'forbidden_origin' });
    next();
  };
}

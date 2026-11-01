import type { Router } from 'express';
import { Router as makeRouter } from 'express';
import type { Config } from '../config.ts';

export function metadataRouter(config: Config): Router {
  const r = makeRouter();
  r.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: ['mattermost'],
      bearer_methods_supported: ['header'],
    });
  });
  r.get('/.well-known/oauth-authorization-server/mcp', (_req, res) => {
    res.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.issuer}/oauth/authorize`,
      token_endpoint: `${config.issuer}/oauth/token`,
      registration_endpoint: `${config.issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mattermost'],
    });
  });
  return r;
}

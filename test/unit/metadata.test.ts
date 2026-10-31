import { expect, test } from 'vitest';
import { makeApp } from './helpers.ts';

const get = (p: string) => makeApp().req.get(p);
test('PRM', async () => { const r = await get('/.well-known/oauth-protected-resource/mcp'); expect(r.body).toEqual({ resource: 'https://mm.example/mcp', authorization_servers: ['https://mm.example/mcp'], scopes_supported: ['mattermost'], bearer_methods_supported: ['header'] }); });
test('AS metadata', async () => { const b = (await get('/.well-known/oauth-authorization-server/mcp')).body;
  expect(b).toMatchObject({ issuer: 'https://mm.example/mcp', authorization_endpoint: 'https://mm.example/mcp/oauth/authorize', token_endpoint: 'https://mm.example/mcp/oauth/token', registration_endpoint: 'https://mm.example/mcp/oauth/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code','refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mattermost'] }); });

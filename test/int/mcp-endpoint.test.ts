import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, requireMm, mmDeauthorize, mmLoginCookie } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';

describe('MCP endpoint against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;

  beforeAll(async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const app = intApp();
    req = app.req;
    const mmCookie = await mmLoginCookie(e.users.alice);
    await mmDeauthorize(mmCookie, e.oauth.clientId);
    const { clientId, code, verifier } = await mcpAuthorize(req, app.config.resource, mmCookie, REDIRECT);
    const token = await req.post('/mcp/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: app.config.resource,
    });
    expect(token.status).toBe(200);
    access = token.body.access_token;
  });

  afterAll(() => vi.restoreAllMocks());

  const rpc = (id: number, method: string, params: unknown) => req.post('/mcp')
    .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
    .send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

  test('initialize, tools/list and get_user over Streamable HTTP with a token from the OAuth flow', async () => {
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'int', version: '0' } });
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toMatch(/^application\/json/);
    expect(init.body.result.serverInfo.name).toBeTruthy();

    const list = await rpc(2, 'tools/list', {});
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain('get_user');

    const who = await rpc(3, 'tools/call', { name: 'get_user', arguments: { user: '@alice' } });
    expect(who.body.result.isError).toBeFalsy();
    expect(who.body.result.content[0].text).toContain('alice');
    expect(who.body.result.content[0].text).toContain(e.users.alice.id);
  });
});

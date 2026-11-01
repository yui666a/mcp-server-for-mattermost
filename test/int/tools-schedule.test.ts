import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { intApp, mcpAuthorize, mmDeauthorize, mmLoginCookie, requireMm } from './helpers.ts';

const e = await requireMm();

const REDIRECT = 'http://127.0.0.1:8123/cb';
const TAG = `zs${randomBytes(6).toString('hex')}`;

type Result = { isError?: boolean; content: { type: string; text: string }[] };

describe('scheduled messages against the local Mattermost', () => {
  let req: ReturnType<typeof request>;
  let access: string;

  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = await req.post('/mcp')
      .set({ authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' })
      .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    expect(r.status).toBe(200);
    return r.body.result;
  };

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

  test('a schedule is listed as pending and can be cancelled', async () => {
    const at = new Date(Date.now() + 3600_000).toISOString().slice(0, 16) + 'Z';
    const made = await call('schedule_message', { channel: 'team-a/town-square', message: `${TAG} later`, at });
    expect(made.isError, made.content[0].text).toBeFalsy();
    const id = /予約 ID: (\S+)/.exec(made.content[0].text)![1];

    const listed = await call('list_scheduled_messages', { status: 'pending' });
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain(`予約 ID: ${id}\n状態: 待機中`);
    expect(listed.content[0].text).toContain(`${TAG} later`);

    const cancelled = await call('cancel_scheduled_message', { id });
    expect(cancelled.isError).toBeFalsy();
    expect((await call('list_scheduled_messages', {})).content[0].text).not.toContain(id);
  });
});

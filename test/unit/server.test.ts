import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../../src/mcp/server.ts';
import { makeApp } from './helpers.ts';

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
});
afterEach(() => vi.restoreAllMocks());

async function connect(extra?: (server: ReturnType<typeof buildServer>) => void) {
  const { config, store, mm } = makeApp();
  const server = buildServer({ mm, mmUserId: 'u1', cfg: config, store });
  extra?.(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

const toolCalls = () => out.map((l) => JSON.parse(l)).filter((l) => l.event === 'tool_call');

test('a plain shape with an argument named _zod is made strict like any other shape', async () => {
  const client = await connect((server) => server.registerTool('zod_named', { inputSchema: { _zod: z.string() } }, async () => ({ content: [{ type: 'text', text: 'ran' }] })));
  const tool = (await client.listTools()).tools.find((t) => t.name === 'zod_named')!;
  expect(tool.inputSchema.additionalProperties).toBe(false);
  const r = await client.callTool({ name: 'zod_named', arguments: { _zod: 'x', other: 1 } });
  expect(r.isError).toBe(true);
  expect((r.content as { text: string }[])[0].text).toContain('受けない引数です: other');
});

test('arguments the check refuses are logged as a tool_call with the outcome invalid_args, and the reply is unchanged', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'get_user', arguments: { user: 'alice', extra: 1 } });
  expect(r.isError).toBe(true);
  expect((r.content as { text: string }[])[0].text).toContain('Input validation error');
  expect(toolCalls()).toEqual([expect.objectContaining({ mm_user_id: 'u1', tool: 'get_user', outcome: 'invalid_args' })]);
  expect(out.join('')).toMatch(/"mm_user_id":"u1","tool":"get_user","outcome":"invalid_args","ms":\d+/);
  expect(out.join('')).not.toContain('alice');
});

test.each([
  ['a missing required argument', {}],
  ['an argument of the wrong type', { user: 1 }],
])('%s is also logged as invalid_args', async (_, args) => {
  const client = await connect();
  expect((await client.callTool({ name: 'get_user', arguments: args })).isError).toBe(true);
  expect(toolCalls()).toEqual([expect.objectContaining({ tool: 'get_user', outcome: 'invalid_args' })]);
});

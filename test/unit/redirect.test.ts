import { expect, test } from 'vitest';
import { isRegistrable, matchesRegistered } from '../../src/oauth/redirect.ts';

test.each(['https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback','http://localhost:5555/callback','http://127.0.0.1:1/x'])('registrable %s', u => expect(isRegistrable(u, [])).toBe(true));
test.each(['http://localhost.evil.com/cb','https://claude.ai/api/mcp/auth_callback/../x','https://claude.ai.evil/api/mcp/auth_callback','http://[::1]:5/cb','https://localhost/cb','javascript:alert(1)','http://localhost:5/../x','http://localhost:5/cb#f','http://localhost/cb','http://localhost:1/%2e%2e/x','http://localhost:1/.%2E/x','http://localhost:1/a\\..\\b','http://localhost:99999/cb','http://localhost:0/cb','http://localhost:65536/cb'])('not registrable %s', u => expect(isRegistrable(u, [])).toBe(false));
test('max port is registrable', () => expect(isRegistrable('http://localhost:65535/cb', [])).toBe(true));
test('extra redirect URIs are exact matches', () => {
  expect(isRegistrable('https://app.example/cb', ['https://app.example/cb'])).toBe(true);
  expect(isRegistrable('https://app.example/cb2', ['https://app.example/cb'])).toBe(false);
});
test('loopback matches with a different port only', () => {
  expect(matchesRegistered('http://127.0.0.1:9999/cb', ['http://127.0.0.1:1234/cb'])).toBe(true);
  expect(matchesRegistered('http://127.0.0.1:9999/cb2', ['http://127.0.0.1:1234/cb'])).toBe(false);
  expect(matchesRegistered('http://localhost:9999/cb', ['http://127.0.0.1:1234/cb'])).toBe(false);
  expect(matchesRegistered('https://claude.ai/api/mcp/auth_callback?x=1', ['https://claude.ai/api/mcp/auth_callback'])).toBe(false);
});

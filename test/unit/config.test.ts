import { expect, test } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const base = {
  PUBLIC_URL: 'https://mm.example',
  MM_OAUTH_CLIENT_ID: 'id',
  MM_OAUTH_CLIENT_SECRET: 's',
  TOKEN_ENC_KEY: Buffer.alloc(32).toString('base64'),
};

test('derives resource and issuer from PUBLIC_URL', () => {
  const c = loadConfig(base);
  expect(c.resource).toBe('https://mm.example/mcp');
  expect(c.issuer).toBe('https://mm.example/mcp');
  expect(c.mmUrl).toBe('https://mm.example');
  expect(c.mmBrowserUrl).toBe('https://mm.example');
});

test('MM_BROWSER_URL falls back to MM_URL', () => {
  const c = loadConfig({ ...base, MM_URL: 'http://mattermost:8065' });
  expect(c.mmUrl).toBe('http://mattermost:8065');
  expect(c.mmBrowserUrl).toBe('http://mattermost:8065');
});

test('applies defaults and parses lists', () => {
  const c = loadConfig({ ...base, EXTRA_REDIRECT_URIS: 'https://a/cb, https://b/cb', EXTRA_ALLOWED_ORIGINS: 'https://a' });
  expect(c).toMatchObject({ dbPath: '/data/mcp.sqlite', port: 3000, accessTokenTtlSec: 3600, uploadMaxBytes: 20 * 1024 * 1024 });
  expect(c.extraRedirectUris).toEqual(['https://a/cb', 'https://b/cb']);
  expect(c.extraOrigins).toEqual(['https://a']);
  expect(c.encKey.length).toBe(32);
});

test('rejects a key that is not 32 bytes', () => {
  expect(() => loadConfig({ ...base, TOKEN_ENC_KEY: 'AAAA' })).toThrow(/TOKEN_ENC_KEY/);
});

test('rejects PUBLIC_URL with trailing slash', () => {
  expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://mm.example/' })).toThrow(/PUBLIC_URL/);
});

test('rejects missing required variables', () => {
  expect(() => loadConfig({ ...base, MM_OAUTH_CLIENT_ID: undefined })).toThrow(/MM_OAUTH_CLIENT_ID/);
});

test('UPLOAD_MAX_BYTES sets the upload limit and must be a positive integer', () => {
  expect(loadConfig({ ...base, UPLOAD_MAX_BYTES: '1048576' }).uploadMaxBytes).toBe(1048576);
  expect(() => loadConfig({ ...base, UPLOAD_MAX_BYTES: '0' })).toThrow(/UPLOAD_MAX_BYTES/);
});

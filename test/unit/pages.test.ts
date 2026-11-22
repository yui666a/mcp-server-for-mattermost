import { afterEach, expect, test } from 'vitest';
import { setLocale } from '../../src/i18n/index.ts';
import { consentPage, errorPage } from '../../src/oauth/pages.ts';

afterEach(() => setLocale('en'));

test('consent page escapes client_name and redirect_uri', () => {
  const html = consentPage({ clientName: '<script>alert(1)</script>"\'&', redirectUri: 'http://127.0.0.1:1/"><img src=x>', loopback: true, sessionId: 's', csrf: 'c' });
  expect(html).not.toContain('<script>alert'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('self-declared by whoever registered the app');  expect(html).toContain('Approve only if you started the Claude Code or Codex connection yourself');
  expect(html).not.toMatch(/<script|\son\w+\s*=/i);
});

test('consent page escapes quotes and ampersands in every interpolated value, including hidden fields', () => {
  const html = consentPage({ clientName: 'a"b\'c&d', redirectUri: 'https://claude.ai/api/mcp/auth_callback', loopback: false, sessionId: '"><x', csrf: "'><y" });
  expect(html).toContain('a&quot;b&#39;c&amp;d');
  expect(html).toContain('value="&quot;&gt;&lt;x"');
  expect(html).toContain('value="&#39;&gt;&lt;y"');
  expect(html).not.toContain('<x'); expect(html).not.toContain('<y');
});

test('consent page shows the redirect URI and the permission, and warns only for loopback', () => {
  const p = { clientName: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback', loopback: false, sessionId: 's', csrf: 'c' };
  const html = consentPage(p);
  expect(html).toContain('https://claude.ai/api/mcp/auth_callback');
  expect(html).toContain('Read and write messages as your Mattermost account');
  expect(html).not.toContain('Approve only if you started the Claude Code or Codex connection yourself');
  expect(html).toContain('name="session_id" value="s"');
  expect(html).toContain('name="csrf" value="c"');
  expect(html).toContain('action="/mcp/oauth/consent"');
  expect(html).toContain('href="/mcp/oauth/consent.css"');
});

test('error page escapes the message and has no script', () => {
  const html = errorPage('<b>bad</b>');
  expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
  expect(html).not.toMatch(/<script|\son\w+\s*=/i);
});

test('the consent page uses the configured language', () => {
  const p = { clientName: 'Claude', redirectUri: 'https://claude.ai/cb', loopback: false, sessionId: 's', csrf: 'c' };
  const en = consentPage(p);
  expect(en).toContain('<html lang="en">'); expect(en).toContain('<h1>Allow access to Mattermost</h1>');
  setLocale('ja');
  const ja = consentPage(p);
  expect(ja).toContain('<html lang="ja">'); expect(ja).toContain('Mattermost へのアクセスの許可');
});

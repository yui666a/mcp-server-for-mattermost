import { expect, test } from 'vitest';
import { consentPage, errorPage } from '../../src/oauth/pages.ts';

test('consent page escapes client_name and redirect_uri', () => {
  const html = consentPage({ clientName: '<script>alert(1)</script>"\'&', redirectUri: 'http://127.0.0.1:1/"><img src=x>', loopback: true, sessionId: 's', csrf: 'c' });
  expect(html).not.toContain('<script>alert'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('名前は登録者の自己申告');  expect(html).toContain('この端末上のアプリ');
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
  expect(html).toContain('あなたの Mattermost アカウントとしてメッセージの読み書きをする');
  expect(html).not.toContain('この端末上のアプリ');
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

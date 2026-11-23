import type { Response } from 'express';
import { locale, msg } from '../i18n/index.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="${locale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/mcp/oauth/consent.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

export function consentPage(p: { clientName: string; redirectUri: string; loopback: boolean; sessionId: string; csrf: string }): string {
  const m = msg().oauth;
  const warning = p.loopback ? `<p class="warning">${esc(m.loopbackWarning)}</p>\n` : '';
  return layout(m.consentTitle, `<h1>${esc(m.consentTitle)}</h1>
<p>${esc(m.consentIntro)}</p>
<p class="redirect">${esc(p.redirectUri)}</p>
${warning}<dl>
<dt>${esc(m.appName)}</dt>
<dd><span class="name">${esc(p.clientName)}</span> <small>${esc(m.nameNotice)}</small></dd>
<dt>${esc(m.grants)}</dt>
<dd>${esc(m.grantsValue)}</dd>
</dl>
<form method="post" action="/mcp/oauth/consent">
<input type="hidden" name="session_id" value="${esc(p.sessionId)}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button type="submit" name="decision" value="approve">${esc(m.approve)}</button>
<button type="submit" name="decision" value="deny" class="secondary">${esc(m.deny)}</button>
</form>`);
}

export function errorPage(message: string): string {
  const m = msg().oauth;
  return layout(m.errorTitle, `<h1>${esc(m.errorHeading)}</h1>\n<p>${esc(message)}</p>`);
}

export function setPageHeaders(res: Response, formAction: string[]): void {
  res.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'self'; base-uri 'none'; form-action ${formAction.join(' ')}; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
}

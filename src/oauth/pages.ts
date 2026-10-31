import type { Response } from 'express';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
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
  const warning = p.loopback
    ? `<p class="warning">この端末上のアプリに権限を渡します。自分で Claude Code や Codex の接続を始めた場合だけ許可してください。</p>\n`
    : '';
  return layout('Mattermost へのアクセスの許可', `<h1>Mattermost へのアクセスの許可</h1>
<p>許可すると、次の宛先に権限が渡ります。</p>
<p class="redirect">${esc(p.redirectUri)}</p>
${warning}<dl>
<dt>アプリの名前</dt>
<dd><span class="name">${esc(p.clientName)}</span> <small>（名前は登録者の自己申告で、確認されていません）</small></dd>
<dt>許可する内容</dt>
<dd>あなたの Mattermost アカウントとしてメッセージの読み書きをする</dd>
</dl>
<form method="post" action="/mcp/oauth/consent">
<input type="hidden" name="session_id" value="${esc(p.sessionId)}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button type="submit" name="decision" value="approve">許可して Mattermost にログイン</button>
<button type="submit" name="decision" value="deny" class="secondary">拒否</button>
</form>`);
}

export function errorPage(message: string): string {
  return layout('エラー', `<h1>認可を続けられません</h1>\n<p>${esc(message)}</p>`);
}

export function setPageHeaders(res: Response, formAction: string[]): void {
  res.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'self'; base-uri 'none'; form-action ${formAction.join(' ')}; frame-ancestors 'none'`,
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
}

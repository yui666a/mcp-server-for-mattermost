const FIXED = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// Raw-string match: URL parsing would normalise "/../" away and hide it.
const LOOPBACK = /^(http:\/\/(?:localhost|127\.0\.0\.1)):\d{1,5}(\/[^#\s]*)?$/;

export function isRegistrable(uri: string, extra: string[]): boolean {
  if (FIXED.includes(uri) || extra.includes(uri)) return true;
  const m = LOOPBACK.exec(uri);
  return !!m && !(m[2] ?? '').split('?')[0].split('/').includes('..');
}

export function matchesRegistered(requested: string, registered: string[]): boolean {
  const strip = (u: string) => u.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1)):\d+/, '$1');
  const loopback = LOOPBACK.test(requested);
  return registered.some((r) => r === requested || (loopback && LOOPBACK.test(r) && strip(r) === strip(requested)));
}

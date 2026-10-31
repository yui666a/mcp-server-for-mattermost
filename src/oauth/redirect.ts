const FIXED = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
// Raw-string match: URL parsing would normalise "/../" away and hide it.
const LOOPBACK = /^(http:\/\/(?:localhost|127\.0\.0\.1)):\d{1,5}(\/[^#\s]*)?$/;

export function isRegistrable(uri: string, extra: string[]): boolean {
  if (FIXED.includes(uri) || extra.includes(uri)) return true;
  const m = LOOPBACK.exec(uri);
  if (!m) return false;
  const port = Number(/:(\d+)/.exec(uri)![1]);
  const path = m[2] ?? '';
  // Rejected rather than decoded and re-checked: WHATWG URL treats %2e as '.' and '\' as '/', so any decoding we do could disagree with the client's.
  if (port < 1 || port > 65535 || /%2e|\\/i.test(path)) return false;
  return !path.split('?')[0].split('/').includes('..');
}

export function matchesRegistered(requested: string, registered: string[]): boolean {
  const strip = (u: string) => u.replace(/^(http:\/\/(?:localhost|127\.0\.0\.1)):\d+/, '$1');
  const loopback = LOOPBACK.test(requested) && isRegistrable(requested, []);
  return registered.some((r) => r === requested || (loopback && LOOPBACK.test(r) && strip(r) === strip(requested)));
}

export class InputError extends Error {
  name = 'InputError';
}

export type MmPost = { id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number };
export type PostCtx = { baseUrl: string; teamName: string; usernames: Map<string, string>; channel?: string };

export const BAD_CURSOR = 'cursor が不正です。前回の出力の next_cursor をそのまま渡してください。';
const JST_MS = 9 * 3600_000;
const segmenter = new Intl.Segmenter();

export function truncate(s: string, max = 4000): { text: string; truncated: boolean } {
  let n = 0;
  for (const { index } of segmenter.segment(s)) {
    if (n++ === max) return { text: s.slice(0, index), truncated: true };
  }
  return { text: s, truncated: false };
}

const iso = (ms: number, offset: number, suffix: string) => new Date(ms + offset).toISOString().slice(0, 19) + suffix;

export function formatPost(p: MmPost, ctx: PostCtx): string {
  const who = ctx.usernames.get(p.user_id);
  return [
    `--- post_id: ${p.id}${p.root_id ? `（返信先 post_id: ${p.root_id}）` : ''}`,
    `${who ? `@${who}` : `user_id: ${p.user_id}`} | ${iso(p.create_at, 0, 'Z')} | ${iso(p.create_at, JST_MS, '+09:00')}`,
    ...(ctx.channel ? [ctx.channel] : []),
    truncate(p.message).text,
    `${ctx.baseUrl}/${ctx.teamName}/pl/${p.id}`,
  ].join('\n');
}

export const encodeCursor = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export function decodeCursor(s: string): object {
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw new InputError(BAD_CURSOR);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new InputError(BAD_CURSOR);
  return o;
}

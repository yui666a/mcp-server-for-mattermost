export class InputError extends Error {
  name = 'InputError';
}

export type MmFileInfo = { id: string; name: string; mime_type: string; size: number; width?: number; height?: number };
export type MmPost = {
  id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number;
  file_ids?: string[]; metadata?: { files?: MmFileInfo[] };
};
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

export const formatTime = (ms: number): string => `${iso(ms, 0, 'Z')} | ${iso(ms, JST_MS, '+09:00')}`;

// Not timeZoneName 'longOffset' alone: it writes UTC as plain "GMT", not "GMT+00:00".
export function localTime(tz: string, nowMs: number): string | undefined {
  if (!tz) return undefined;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
    }).formatToParts(nowMs);
  } catch {
    return undefined;
  }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const offset = p.timeZoneName.replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

export const fileLine = (f: MmFileInfo): string =>
  `${f.name}（file_id: ${f.id}、種類: ${f.mime_type || '不明'}、${f.size} バイト${f.width && f.height ? `、${f.width}x${f.height}` : ''}）`;

function attachmentLines(p: MmPost): string[] {
  if (p.metadata?.files?.length) return p.metadata.files.map((f) => `添付: ${fileLine(f)}`);
  return p.file_ids?.length ? [`添付 ${p.file_ids.length} 件（get_post で確認できます）`] : [];
}

export function formatPost(p: MmPost, ctx: PostCtx): string {
  const who = ctx.usernames.get(p.user_id);
  return [
    `--- post_id: ${p.id}${p.root_id ? `（返信先 post_id: ${p.root_id}）` : ''}`,
    `${who ? `@${who}` : `user_id: ${p.user_id}`} | ${formatTime(p.create_at)}`,
    ...(ctx.channel ? [ctx.channel] : []),
    truncate(p.message).text,
    ...attachmentLines(p),
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

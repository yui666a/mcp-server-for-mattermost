export class InputError extends Error {
  name = 'InputError';
}

export type MmFileInfo = { id: string; name: string; mime_type: string; size: number; width?: number; height?: number };
export type MmReaction = { user_id: string; emoji_name: string; create_at: number };
export type MmPost = {
  id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number;
  type?: string; edit_at?: number; has_reactions?: boolean; props?: Record<string, unknown>;
  file_ids?: string[]; metadata?: { files?: MmFileInfo[]; reactions?: MmReaction[] };
};
export type PostCtx = { baseUrl: string; teamName: string; usernames: Map<string, string>; channel?: string };

export const BAD_CURSOR = 'cursor が不正です。前回の出力の next_cursor をそのまま渡してください。';
const JST_MS = 9 * 3600_000;
const segmenter = new Intl.Segmenter();

export const graphemeCount = (s: string): number => [...segmenter.segment(s)].length;

// Not written out in each tool description: the guidance quoting the note would fall behind when the limit changes.
export const BODY_MAX_CHARS = 4000;
export const BODY_CUT_NOTE = `本文を ${BODY_MAX_CHARS} 文字で切りました`;

export function truncate(s: string, max = BODY_MAX_CHARS): { text: string; truncated: boolean } {
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

const REACTION_NAMES = 10;
const REACTION_MAX_CHARS = BODY_MAX_CHARS;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '');
const records = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isRecord) : []);

export const lines = (s: string): string[] => s.split(/\r\n|[\r\n\v\f\x1c-\x1e\u0085\u2028\u2029]/);

// Indenting every line rather than quoting: attachments are written by whoever posts, and a line at the margin could pass for a post, file or heading line.
function item(label: string, value: string): string[] {
  return lines(`${label}: ${value}`).map((l, i) => `${i ? '    ' : '  '}${l}`);
}

function messageAttachment(a: Record<string, unknown>, n: number, total: number): string[] {
  const title = str(a.title), link = str(a.title_link);
  const fields = records(a.fields).map((f) => [str(f.title), str(f.value)].filter(Boolean).join(': ')).filter(Boolean);
  const actions = records(a.actions).map((x) => str(x.name)).filter(Boolean);
  const body: [string, string][] = [
    ['作成者', str(a.author_name)],
    ['前置き', str(a.pretext)],
    ['タイトル', title && link ? `${title}（${link}）` : title || link],
    ['本文', str(a.text)],
    ...fields.map((f): [string, string] => ['項目', f]),
  ];
  // Not showing the fallback beside the rest: it is a plain-text summary of the same content.
  if (![str(a.pretext), title || link, str(a.text), ...fields].some(Boolean)) body.push(['要約', str(a.fallback)]);
  body.push(['フッター', str(a.footer)], ['ボタンやメニュー', actions.length ? `${actions.join('、')}（MCP からは操作できません）` : '']);
  return [`メッセージ添付（Bot などの整形表示）${n}/${total}:`, ...body.filter(([, v]) => v).flatMap(([k, v]) => item(k, v))];
}

function messageAttachments(p: MmPost): { text: string; truncated: boolean } {
  const list = records(p.props?.attachments);
  return truncate(list.flatMap((a, i) => messageAttachment(a, i + 1, list.length)).join('\n'));
}

export const postTruncated = (p: MmPost): boolean => truncate(p.message).truncated || messageAttachments(p).truncated;

// Not trusting Mattermost's order: it sorts by create_at alone, so reactions of the same millisecond come in any order.
const reactionOrder = (a: MmReaction, b: MmReaction) =>
  a.create_at - b.create_at || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0) || (a.emoji_name < b.emoji_name ? -1 : a.emoji_name > b.emoji_name ? 1 : 0);

function reactionsByEmoji(p: MmPost): { emoji: string; shown: string[]; total: number }[] {
  const by = new Map<string, string[]>();
  for (const r of [...(p.metadata?.reactions ?? [])].sort(reactionOrder)) by.set(r.emoji_name, [...(by.get(r.emoji_name) ?? []), r.user_id]);
  return [...by].map(([emoji, ids]) => ({ emoji, shown: ids.slice(0, REACTION_NAMES), total: ids.length }));
}

export const postUserIds = (p: MmPost): string[] => [...new Set([p.user_id, ...reactionsByEmoji(p).flatMap((r) => r.shown)])];

function reactionLines(p: MmPost, usernames: Map<string, string>): string[] {
  const by = reactionsByEmoji(p);
  // Only without metadata at all: the threads API returns none, while the post APIs always do and leave reactions out when there are none.
  if (!by.length) return p.has_reactions && !p.metadata ? ['リアクションあり（get_post で確認できます）'] : [];
  const name = (id: string) => (usernames.has(id) ? `@${usernames.get(id)}` : `user_id: ${id}`);
  const each = by.map(({ emoji, shown, total }) =>
    `:${emoji}: ${total}（${shown.map(name).join('、')}${total > shown.length ? `、ほか ${total - shown.length} 人` : ''}）`);
  const head = 'リアクション: ';
  let n = graphemeCount(head) + graphemeCount(each[0]);
  let k = 1;
  while (k < each.length && (n += 1 + graphemeCount(each[k])) <= REACTION_MAX_CHARS) k++;
  const left = by.slice(k);
  const rest = left.length ? `、ほか ${left.length} 種類（リアクション ${left.reduce((m, r) => m + r.total, 0)} 件）` : '';
  return [`${head}${each.slice(0, k).join('、')}${rest}`];
}

export function formatPost(p: MmPost, ctx: PostCtx): string {
  const who = ctx.usernames.get(p.user_id);
  const ma = messageAttachments(p);
  return [
    `--- post_id: ${p.id}${p.root_id ? `（返信先 post_id: ${p.root_id}）` : ''}`,
    `${who ? `@${who}` : `user_id: ${p.user_id}`} | ${formatTime(p.create_at)}`,
    ...(p.edit_at ? [`編集済み: ${formatTime(p.edit_at)}`] : []),
    ...(p.type?.startsWith('system_') ? [`システムメッセージ（${p.type}）`] : []),
    ...(ctx.channel ? [ctx.channel] : []),
    ...(p.message ? lines(truncate(p.message).text).map((l) => `  ${l}`) : ['']),
    ...(ma.text ? [ma.text] : []),
    ...(ma.truncated ? ['（メッセージ添付をここで切りました。続きは Mattermost の画面で確認してください）'] : []),
    ...attachmentLines(p),
    ...reactionLines(p, ctx.usernames),
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

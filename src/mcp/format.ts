import { msg } from '../i18n/index.ts';
import { timeZone, zonedIso } from '../zone.ts';

export class InputError extends Error {
  name = 'InputError';
}

export type MmFileInfo = { id: string; name: string; mime_type: string; size: number; width?: number; height?: number };
export type MmReaction = { user_id: string; emoji_name: string; create_at: number };
export type MmPost = {
  id: string; user_id: string; channel_id: string; root_id: string; message: string; create_at: number;
  type?: string; edit_at?: number; has_reactions?: boolean; props?: Record<string, unknown>;
  file_ids?: string[]; metadata?: { files?: MmFileInfo[]; reactions?: MmReaction[]; redacted_file_count?: number };
};
export type PostCtx = { baseUrl: string; teamName: string; usernames: Map<string, string>; channel?: string };

const segmenter = new Intl.Segmenter();

export const graphemeCount = (s: string): number => [...segmenter.segment(s)].length;

// Not written out in each tool description: the guidance quoting the note would fall behind when the limit changes.
export const BODY_MAX_CHARS = 4000;
export const bodyCutNote = (): string => msg().format.bodyCutNote(BODY_MAX_CHARS);

export function truncate(s: string, max = BODY_MAX_CHARS): { text: string; truncated: boolean } {
  let n = 0;
  for (const { index } of segmenter.segment(s)) {
    if (n++ === max) return { text: s.slice(0, index), truncated: true };
  }
  return { text: s, truncated: false };
}

export function formatTime(ms: number): string {
  const utc = `${new Date(ms).toISOString().slice(0, 19)}Z`;
  return timeZone() === 'UTC' ? utc : `${utc} | ${zonedIso(ms)}`;
}

export function localTime(tz: string, nowMs: number): string | undefined {
  if (!tz) return undefined;
  try {
    return zonedIso(nowMs, tz);
  } catch {
    return undefined;
  }
}

const LINE_BREAK = /\r\n|[\r\n\v\f\x1c-\x1e\u0085\u2028\u2029]/;
export const lines = (s: string): string[] => s.split(LINE_BREAK);
// A space rather than nothing: the words on either side of a break would otherwise run together into another word.
export const oneLine = (s: string): string => lines(s).join(' ');

// Not the name first: a name written as "（file_id: …）" would then come before the real id.
export const fileLine = (f: MmFileInfo): string =>
  msg().format.fileLine(f.id, oneLine(f.mime_type) || msg().format.unknownType, f.size, f.width && f.height ? `${f.width}x${f.height}` : '', oneLine(f.name));

function attachmentLines(p: MmPost): string[] {
  const shown = p.metadata?.files?.length ? p.metadata.files.map((f) => msg().format.attachment(fileLine(f)))
    : p.file_ids?.length ? [msg().format.attachmentCount(p.file_ids.length)] : [];
  // Not trusting the type: only a whole count of 1 or more, as Mattermost writes it when an ABAC policy strips the files.
  const hidden = p.metadata?.redacted_file_count;
  return Number.isInteger(hidden) && hidden! >= 1
    ? [...shown, msg().format.attachmentHidden(hidden!)]
    : shown;
}

const REACTION_NAMES = 10;
const REACTION_MAX_CHARS = BODY_MAX_CHARS;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string => (typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '');
const records = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter(isRecord) : []);

const labelled = (label: string, value: string, first: string): string[] => lines(`${label}: ${value}`).map((l, i) => `${i ? '    ' : first}${l}`);

// Not oneLine: a channel header or purpose holds Markdown tables and lists.
export const indented = (label: string, value: string): string[] => labelled(label, value, '');

// Indenting every line rather than quoting: attachments are written by whoever posts, and a line at the margin could pass for a post, file or heading line.
const item = (label: string, value: string): string[] => labelled(label, value, '  ');

function messageAttachment(a: Record<string, unknown>, n: number, total: number): string[] {
  const title = str(a.title), link = str(a.title_link);
  const fields = records(a.fields).map((f) => [str(f.title), str(f.value)].filter(Boolean).join(': ')).filter(Boolean);
  const actions = records(a.actions).map((x) => str(x.name)).filter(Boolean);
  const f = msg().format;
  const body: [string, string][] = [
    [f.attachmentAuthor, str(a.author_name)],
    [f.attachmentPretext, str(a.pretext)],
    [f.attachmentTitle, title && link ? f.titleWithLink(title, link) : title || link],
    [f.attachmentText, str(a.text)],
    ...fields.map((x): [string, string] => [f.attachmentField, x]),
  ];
  // Not showing the fallback beside the rest: it is a plain-text summary of the same content.
  if (![str(a.pretext), title || link, str(a.text), ...fields].some(Boolean)) body.push([f.attachmentSummary, str(a.fallback)]);
  body.push([f.attachmentFooter, str(a.footer)], [f.attachmentActions, actions.length ? f.actionsNote(f.list(actions)) : '']);
  return [f.attachmentHead(n, total), ...body.filter(([, v]) => v).flatMap(([k, v]) => item(k, v))];
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
  for (const r of [...(p.metadata?.reactions ?? [])].sort(reactionOrder)) {
    const ids = by.get(r.emoji_name);
    if (ids) ids.push(r.user_id);
    else by.set(r.emoji_name, [r.user_id]);
  }
  return [...by].map(([emoji, ids]) => ({ emoji, shown: ids.slice(0, REACTION_NAMES), total: ids.length }));
}

// One place for how the reactions line is built and cut, so the users looked up always cover the users shown.
function fitReactions(by: ReturnType<typeof reactionsByEmoji>, name: (id: string) => string): { each: string[]; k: number } {
  const f = msg().format;
  const each = by.map(({ emoji, shown, total }) => f.reactionItem(emoji, total, f.list(shown.map(name)), total - shown.length));
  const sep = graphemeCount(f.list(['', '']));
  let n = graphemeCount(f.reactionsHead) + graphemeCount(each[0] ?? '');
  let k = Math.min(1, each.length);
  while (k < each.length && (n += sep + graphemeCount(each[k])) <= REACTION_MAX_CHARS) k++;
  return { each, k };
}

// The cut depends on the names, unknown before the lookup, so it is made with the shortest name a user can have ('@' and one letter).
// Every emoji shown with the real names is then kept, since longer names only cut earlier.
export const postUserIds = (p: MmPost): string[] => {
  const by = reactionsByEmoji(p);
  const { k } = fitReactions(by, () => '@x');
  return [...new Set([p.user_id, ...by.slice(0, k).flatMap((r) => r.shown)])];
};

function reactionLines(p: MmPost, usernames: Map<string, string>): string[] {
  const by = reactionsByEmoji(p);
  // Only without metadata at all: the threads API returns none, while the post APIs always do and leave reactions out when there are none.
  if (!by.length) return p.has_reactions && !p.metadata ? [msg().format.reactionsExist] : [];
  const name = (id: string) => (usernames.has(id) ? `@${usernames.get(id)}` : `user_id: ${id}`);
  const { each, k } = fitReactions(by, name);
  const left = by.slice(k);
  const f = msg().format;
  const rest = left.length ? f.reactionsRest(left.length, left.reduce((m, r) => m + r.total, 0)) : '';
  return [`${f.reactionsHead}${f.list(each.slice(0, k))}${rest}`];
}

export function formatPost(p: MmPost, ctx: PostCtx): string {
  const who = ctx.usernames.get(p.user_id);
  const ma = messageAttachments(p);
  return [
    msg().format.postHead(p.id, p.root_id),
    `${who ? `@${who}` : `user_id: ${p.user_id}`} | ${formatTime(p.create_at)}`,
    ...(p.edit_at ? [msg().format.edited(formatTime(p.edit_at))] : []),
    ...(p.type?.startsWith('system_') ? [msg().format.systemMessage(p.type)] : []),
    ...(ctx.channel ? [ctx.channel] : []),
    ...(p.message ? lines(truncate(p.message).text).map((l) => `  ${l}`) : ['']),
    ...(ma.text ? [ma.text] : []),
    ...(ma.truncated ? [msg().format.attachmentsCut] : []),
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
    throw new InputError(msg().common.badCursor);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new InputError(msg().common.badCursor);
  return o;
}

// Format characters (Unicode Cf: zero-width, direction marks, soft hyphen) too, not only what trim drops: they slip in with a copy, and no
// channel, team or user name or ID can have them, as those are ASCII only.
const EDGE = /^[\s\p{Cf}]$/u;
// Not one regex with [\s\p{Cf}]+$: it restarts at every position of a long run of spaces followed by other text, taking time quadratic in the length, and arguments have no length limit.
export const unformat = (s: string) => {
  const t = s.replace(/^[\s\p{Cf}]+/u, '');
  let end = t.length;
  while (end > 0) {
    // Not one UTF-16 unit at a time: some Cf characters (tags, U+E0001 and up) are surrogate pairs.
    const lo = t.charCodeAt(end - 1);
    const hi = t.charCodeAt(end - 2);
    const start = end >= 2 && lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? end - 2 : end - 1;
    if (!EDGE.test(t.slice(start, end))) break;
    end = start;
  }
  return t.slice(0, end);
};

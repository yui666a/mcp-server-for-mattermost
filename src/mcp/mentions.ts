export type MentionUser = { username: string; first_name?: string; notify_props?: { mention_keys?: string; first_name?: string } };

const CHANNEL_WIDE = new Set(['@channel', '@all', '@here']);

const keys = (u: MentionUser) => (u.notify_props?.mention_keys ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const firstName = (u: MentionUser) => (u.notify_props?.first_name === 'true' && u.first_name ? [u.first_name] : []);

export function mentionTerms(u: MentionUser): string[] {
  const seen = new Set<string>();
  // Not searching keys with a double quote: each term is sent wrapped in quotes, and Mattermost's search has no escape for one inside.
  return [`@${u.username}`, ...[...keys(u), ...firstName(u)].filter((k) => !k.includes('"'))].filter((t) => {
    const k = t.toLowerCase();
    if (CHANNEL_WIDE.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
const INDENTED = /^( {4}|\t)/;

// Not a regex with a backreference: it looks for a closing run from every opening one, which takes O(n^1.5) for runs of many lengths.
export function stripCodeSpans(text: string): string {
  const runs = [...text.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const next: number[] = [];
  const later = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    next[i] = later.get(runs[i].len) ?? -1;
    later.set(runs[i].len, i);
  }
  let out = '';
  let from = 0;
  for (let i = 0; i < runs.length;) {
    const j = next[i];
    if (j < 0) {
      i++;
      continue;
    }
    out += `${text.slice(from, runs[i].at)} `;
    from = runs[j].at + runs[j].len;
    i = j + 1;
  }
  return out + text.slice(from);
}

// Not a full CommonMark parser: blocks are told apart line by line, so code nested in block quotes or deep lists is read as text.
function textOf(message: string): string {
  const blocks: string[][] = [[]];
  const out = (line: string, startsBlock: boolean) => {
    if (startsBlock && blocks.at(-1)!.length) blocks.push([]);
    blocks.at(-1)!.push(line);
  };
  let fence: string | undefined;
  let afterBlank = true;
  let inCode = false;
  let inList = false;
  let afterItem = false;
  for (const line of message.split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      out('', true);
      continue;
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === '`' && line.slice(f[0].length).includes('`'))) {
      fence = f[1];
      out('', true);
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      afterItem = false;
      out('', true);
      continue;
    }
    if (INDENTED.test(line) && !inList && (afterBlank || inCode)) {
      inCode = true;
      out('', true);
      continue;
    }
    const m = LIST_ITEM.exec(line);
    // Not every item line starts a block: like the server's listStart, an empty item or one numbered from other than 1 does not interrupt a paragraph.
    const item: boolean = !!m && (afterBlank || afterItem || (line.slice(m[0].length).trim() !== '' && (!/\d/.test(m[1]) || parseInt(m[1], 10) === 1)));
    afterItem = item;
    if (item) inList = true;
    else if (afterBlank && !INDENTED.test(line)) inList = false;
    inCode = false;
    afterBlank = false;
    out(line, item);
  }
  // Per block rather than over the whole message: like the server's parser, a code span cannot close in another paragraph or list item.
  return blocks.map((b) => stripCodeSpans(b.join('\n'))).join('\n');
}

// Not removing link destinations or autolinks, though the server does not read them: the database search never hits inside them, and removing them risks erasing body text.
// Not trusting the search hit alone: the database search finds a bare "alice" for "@alice", which the server never notifies as a mention.
export function mentionsMe(message: string, u: MentionUser): boolean {
  const keywords = new Set([`@${u.username.toLowerCase()}`, ...keys(u).map((k) => k.toLowerCase()), ...firstName(u)]);
  keywords.forEach((k) => CHANNEL_WIDE.has(k) && keywords.delete(k));
  const multibyte = [...keywords].filter((k) => /[^\x00-\x7f]/.test(k));
  const hit = (w: string) => keywords.has(w.toLowerCase()) || keywords.has(w);
  // Lowercasing never shortens a string, so a word longer than every keyword cannot be one.
  const longest = Math.max(0, ...[...keywords].map((k) => k.length));
  for (let word of textOf(message).split(/[^:.\-_@\p{L}\p{N}]+/u)) {
    if (!word || (word[0] === ':' && word.at(-1) === ':')) continue;
    word = word.replace(/^[:.\-_]+/, '');
    if (hit(word)) return true;
    // Not dropping the trailing marks one at a time from the whole word: a word ending in thousands of them would take quadratic time, and only prefixes no longer than a keyword can match.
    let end = word.length;
    while (end > 0 && '.-:_'.includes(word[end - 1])) end--;
    for (let k = Math.min(word.length - 1, longest); k >= end; k--) if (hit(word.slice(0, k))) return true;
    if (!word.startsWith('@') && /[.\-:]/.test(word) && word.split(/[.\-:]+/).some(hit)) return true;
    if (/[^\x00-\x7f]/.test(word) && multibyte.some((k) => word.includes(k))) return true;
  }
  return false;
}

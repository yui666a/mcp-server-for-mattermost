export type MentionUser = { username: string; first_name?: string; notify_props?: { mention_keys?: string; first_name?: string } };

const CHANNEL_WIDE = new Set(['@channel', '@all', '@here']);

const keys = (u: MentionUser) => (u.notify_props?.mention_keys ?? '').split(',').map((k) => k.trim()).filter(Boolean);
const firstName = (u: MentionUser) => (u.notify_props?.first_name === 'true' && u.first_name ? [u.first_name] : []);

export function mentionTerms(u: MentionUser): string[] {
  const seen = new Set<string>();
  // Not searching keys with a double quote: each term is sent wrapped in quotes, and Mattermost's search has no escape for one inside.
  return [`@${u.username}`, ...keys(u).filter((k) => !k.includes('"')), ...firstName(u)].filter((t) => {
    const k = t.toLowerCase();
    if (CHANNEL_WIDE.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-+*]|\d{1,9}[.)])(\s|$)/;
const INDENTED = /^( {4}|\t)/;
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

// Not a full CommonMark parser: blocks are told apart line by line, so code nested in block quotes or deep lists is read as text.
function withoutCode(message: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let afterBlank = true;
  let inCode = false;
  let inList = false;
  for (const line of message.split('\n')) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      out.push('');
      continue;
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === '`' && line.slice(f[0].length).includes('`'))) {
      fence = f[1];
      out.push('');
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      out.push('');
      continue;
    }
    if (INDENTED.test(line) && !inList && (afterBlank || inCode)) {
      inCode = true;
      out.push('');
      continue;
    }
    if (LIST_ITEM.test(line)) inList = true;
    else if (afterBlank && !INDENTED.test(line)) inList = false;
    inCode = false;
    afterBlank = false;
    out.push(line);
  }
  return out.join('\n').replace(CODE_SPAN, ' ');
}

// Not trusting the search hit alone: the database search finds a bare "alice" for "@alice", which the server never notifies as a mention.
export function mentionsMe(message: string, u: MentionUser): boolean {
  const keywords = new Set([`@${u.username.toLowerCase()}`, ...keys(u).map((k) => k.toLowerCase()), ...firstName(u)]);
  keywords.forEach((k) => CHANNEL_WIDE.has(k) && keywords.delete(k));
  const multibyte = [...keywords].filter((k) => /[^\x00-\x7f]/.test(k));
  const hit = (w: string) => keywords.has(w.toLowerCase()) || keywords.has(w);
  for (let word of withoutCode(message).split(/[^:.\-_@\p{L}\p{N}]+/u)) {
    if (!word || (word[0] === ':' && word.at(-1) === ':')) continue;
    word = word.replace(/^[:.\-_]+/, '');
    if (hit(word)) return true;
    for (let w = word; /[.\-:_]$/.test(w);) {
      w = w.slice(0, -1);
      if (hit(w)) return true;
    }
    if (!word.startsWith('@') && /[.\-:]/.test(word) && word.split(/[.\-:]+/).some(hit)) return true;
    if (/[^\x00-\x7f]/.test(word) && multibyte.some((k) => word.includes(k))) return true;
  }
  return false;
}

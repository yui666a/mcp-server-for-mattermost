import { describe, expect, test } from 'vitest';
import { mentionsMe, mentionTerms, stripCodeSpans, type MentionUser } from '../../src/mcp/mentions.ts';

const alice: MentionUser = { username: 'alice', first_name: 'Alice', notify_props: { mention_keys: '', first_name: 'false' } };
const withKeys = (keys: string, firstName = 'false'): MentionUser => ({ ...alice, notify_props: { mention_keys: keys, first_name: firstName } });

describe('mentionTerms', () => {
  test('always searches for @username', () => {
    expect(mentionTerms(alice)).toEqual(['@alice']);
  });

  test('adds each mention key, trimmed, dropping empty ones and ones containing a double quote', () => {
    expect(mentionTerms(withKeys(' aiso ,, ,say "hi",DB team'))).toEqual(['@alice', 'aiso', 'DB team']);
  });

  test('adds the first name only when the first_name notify prop is the string "true" and the name is set', () => {
    expect(mentionTerms(withKeys('', 'true'))).toEqual(['@alice', 'Alice']);
    expect(mentionTerms({ ...withKeys('', 'true'), first_name: '' })).toEqual(['@alice']);
  });

  test('leaves out a first name containing a double quote', () => {
    expect(mentionTerms({ ...withKeys('', 'true'), first_name: 'A"B' })).toEqual(['@alice']);
  });

  test('leaves out @channel, @all and @here even when they are mention keys', () => {
    expect(mentionTerms(withKeys('@channel,@ALL,@here,ops'))).toEqual(['@alice', 'ops']);
  });

  test('does not repeat a term', () => {
    expect(mentionTerms(withKeys('@alice,ops,OPS'))).toEqual(['@alice', 'ops']);
  });
});

describe('mentionsMe', () => {
  test.each([
    '@alice',
    '@alice.',
    '@alice_',
    '@alice-',
    '@alice:',
    '@ALICE',
    'hi @alice',
    '@alice\nnext line',
    'line\n@alice',
    '、@alice',
    '（@alice）',
    'ok,@alice',
    'foo.@alice',
    '*@alice*',
    '_@alice_',
    '[@alice](https://example.com)',
    '@alice`code`',
    '> @alice',
  ])('counts %j as a mention', (message) => {
    expect(mentionsMe(message, alice)).toBe(true);
  });

  test.each([
    'x@alice',
    '@alicex',
    'alice',
    '@alice.bob',
    '`@alice`',
    '``a ` @alice``',
    '```\n@alice\n```',
    '~~~js\n@alice\n~~~',
    'text\n\n    @alice',
    '```\nunclosed @alice',
    ':@alice:',
    '@aliceさん',
  ])('does not count %j as a mention', (message) => {
    expect(mentionsMe(message, alice)).toBe(false);
  });

  test('a word ending in several marks still counts once the marks are dropped, and a longer prefix does not', () => {
    const u = { username: 'alice', notify_props: { mention_keys: 'bar-baz' } };
    expect(mentionsMe('@alice.-:_', u)).toBe(true);
    expect(mentionsMe('bar-baz..', u)).toBe(true);
    expect(mentionsMe('@alicex.', u)).toBe(false);
  });

  test('takes time linear in the length, even for a word ending in a long run of marks', () => {
    const u = { username: 'alice' };
    const started = performance.now();
    expect(mentionsMe(`@alice${'.'.repeat(200_000)}`, u)).toBe(true);
    expect(mentionsMe(`a${'_:'.repeat(100_000)}`, u)).toBe(false);
    // Not a tight limit: dropping one mark at a time took about eight seconds here, so a loaded machine still tells them apart.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('an indented line continuing a paragraph or a list item is still text, not code', () => {
    expect(mentionsMe('para\n    @alice', alice)).toBe(true);
    expect(mentionsMe('- item\n\n    @alice', alice)).toBe(true);
  });

  test('an inline code span closes only within its own paragraph or list item', () => {
    expect(mentionsMe('a ` b\n\n@alice\n\nc ` d', alice)).toBe(true);
    expect(mentionsMe('- a `\n- @alice\n- b `', alice)).toBe(true);
    expect(mentionsMe('a `\n@alice\nb `', alice)).toBe(false);
  });

  test.each([
    '[済](@alice さん確認)',
    'xhttps://e.com/@alice',
    '「www.e.com/@alice」',
    'WWW.e.com/@alice',
  ])('reads %j as text, as the database search never hits the inside of a link anyway', (message) => {
    expect(mentionsMe(message, alice)).toBe(true);
  });

  test('a list item that cannot interrupt a paragraph (numbered from other than 1, or empty) does not end a code span', () => {
    expect(mentionsMe('a `x\n2. y` @alice `z`', alice)).toBe(true);
    expect(mentionsMe('a `x\n-\ny` @alice `z`', alice)).toBe(true);
  });

  test('a mention next to a link still counts', () => {
    expect(mentionsMe('@alice see https://e.com/x', alice)).toBe(true);
    expect(mentionsMe('[@alice](https://e.com/@bob)', alice)).toBe(true);
  });

  test('a mention outside a code block still counts', () => {
    expect(mentionsMe('```\ncode\n```\n@alice', alice)).toBe(true);
    expect(mentionsMe('`x` @alice', alice)).toBe(true);
  });

  test('mention keys match case-insensitively on the same word boundaries', () => {
    const u = withKeys('Aiso');
    expect(mentionsMe('ask aiso.', u)).toBe(true);
    expect(mentionsMe('ASK AISO', u)).toBe(true);
    expect(mentionsMe('aisox', u)).toBe(false);
    expect(mentionsMe('`aiso`', u)).toBe(false);
  });

  test('a mention key with a multibyte character also matches inside a longer word', () => {
    expect(mentionsMe('あいそさん、見て', withKeys('あいそ'))).toBe(true);
  });

  test('the first name matches case-sensitively, and only when enabled', () => {
    expect(mentionsMe('hi Alice', withKeys('', 'true'))).toBe(true);
    expect(mentionsMe('hi alice', withKeys('', 'true'))).toBe(false);
    expect(mentionsMe('hi Alice', alice)).toBe(false);
  });

  test('@channel, @all and @here are not mentions of the user', () => {
    expect(mentionsMe('@channel @all @here', alice)).toBe(false);
  });
});

describe('stripCodeSpans', () => {
  // The regex it replaces, kept as the reference for what a code span is.
  const reference = (text: string) => text.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');

  test('gives what the backreference regex gave, for many texts mixing runs of backticks, text and line breaks', () => {
    let seed = 1;
    const random = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const parts = ['`', '``', '```', 'a', ' ', '\n', '@alice'];
    for (let c = 0; c < 3000; c++) {
      const text = Array.from({ length: random(30) }, () => parts[random(parts.length)]).join('');
      expect(stripCodeSpans(text), JSON.stringify(text)).toBe(reference(text));
    }
  });

  test('takes time linear in the length, even for runs of backticks of ever more lengths that never close', () => {
    let text = '';
    for (let i = 1; text.length < 2_000_000; i++) text += `${'`'.repeat(i)} `;
    const started = performance.now();
    expect(mentionsMe(`${text}@alice`, { username: 'alice' })).toBe(true);
    // Not a tight limit: the backreference regex took several seconds here, so a loaded machine still tells them apart.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

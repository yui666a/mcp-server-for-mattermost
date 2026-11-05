import { describe, expect, test } from 'vitest';
import { decodeCursor, encodeCursor, fileLine, formatPost, formatTime, indented, InputError, localTime, oneLine, postTruncated, postUserIds, truncate } from '../../src/mcp/format.ts';

test('truncation keeps grapheme clusters', () => {
  const s = '👨‍👩‍👧'.repeat(4001); const r = truncate(s);
  expect([...new Intl.Segmenter().segment(r.text)].length).toBe(4000); expect(r.truncated).toBe(true); expect(r.text.endsWith('👨‍👩‍👧')).toBe(true);
  expect(truncate('a'.repeat(4000))).toEqual({ text: 'a'.repeat(4000), truncated: false });
});

test('a post shows @username, UTC and JST in ISO 8601, the body and the team permalink', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: 'hello', create_at: Date.UTC(2026, 10, 1, 3, 4, 5) };
  const out = formatPost(p, { baseUrl: 'https://mattermost.example.com', teamName: 'team-a', usernames: new Map([['u1', 'alice']]) });
  expect(out).toContain('@alice');
  expect(out).toContain('2026-11-01T03:04:05Z');
  expect(out).toContain('2026-11-01T12:04:05+09:00');
  expect(out).toContain('hello');
  expect(out).toContain('https://mattermost.example.com/team-a/pl/p1');
});

test('a post body longer than 4000 characters is cut', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: 'あ'.repeat(4001), create_at: 0 };
  const out = formatPost(p, { baseUrl: 'https://x', teamName: 't', usernames: new Map() });
  expect(out).toContain('あ'.repeat(4000));
  expect(out).not.toContain('あ'.repeat(4001));
});

test('cursor round-trips as base64url JSON and rejects anything else as an input error', () => {
  const c = encodeCursor({ page: 2, per_page: 20 });
  expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeCursor(c)).toEqual({ page: 2, per_page: 20 });
  for (const bad of ['%%%', Buffer.from('[1]').toString('base64url'), Buffer.from('null').toString('base64url'), Buffer.from('3').toString('base64url')]) {
    expect(() => decodeCursor(bad), bad).toThrow(InputError);
  }
});

test('a time shows UTC and JST in ISO 8601, in the same form as a post', () => {
  expect(formatTime(Date.UTC(2026, 10, 1, 20, 4, 5))).toBe('2026-11-01T20:04:05Z | 2026-11-02T05:04:05+09:00');
});

describe('localTime', () => {
  const at = (iso: string) => Date.parse(iso);

  test('gives the local time with the zone offset of that moment', () => {
    expect(localTime('Asia/Tokyo', at('2026-11-01T20:04:05Z'))).toBe('2026-11-02T05:04:05+09:00');
    expect(localTime('Asia/Kolkata', at('2026-11-01T20:04:05Z'))).toBe('2026-11-02T01:34:05+05:30');
  });

  test('follows daylight saving time', () => {
    expect(localTime('America/New_York', at('2026-03-08T06:59:59Z'))).toBe('2026-03-08T01:59:59-05:00');
    expect(localTime('America/New_York', at('2026-03-08T07:00:00Z'))).toBe('2026-03-08T03:00:00-04:00');
  });

  test('writes a zero offset as +00:00', () => {
    expect(localTime('Europe/London', at('2026-01-15T00:30:00Z'))).toBe('2026-01-15T00:30:00+00:00');
    expect(localTime('UTC', at('2026-01-15T12:00:00Z'))).toBe('2026-01-15T12:00:00+00:00');
    expect(localTime('Etc/UTC', at('2026-01-15T12:00:00Z'))).toBe('2026-01-15T12:00:00+00:00');
  });

  test('is undefined for an empty or unknown zone', () => {
    expect(localTime('', 0)).toBeUndefined();
    expect(localTime('Mars/Olympus_Mons', 0)).toBeUndefined();
  });
});

describe('attachments of a post', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: 'see attached', create_at: 0 };
  const ctx = { baseUrl: 'https://x', teamName: 't', usernames: new Map<string, string>() };
  const png = { id: 'f'.repeat(26), name: 'shot.png', mime_type: 'image/png', size: 11393, width: 1920, height: 1080 };
  const pdf = { id: 'g'.repeat(26), name: 'spec.pdf', mime_type: 'application/pdf', size: 52000 };

  test('lists each file of metadata.files in its order, with file_id, name, MIME type, size and, for an image, width and height', () => {
    const out = formatPost({ ...p, file_ids: [pdf.id, png.id], metadata: { files: [png, pdf] } }, ctx);
    const lines = out.split('\n');
    const a = lines.findIndex((l) => l.includes(png.id));
    const b = lines.findIndex((l) => l.includes(pdf.id));
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(lines[a]).toContain('shot.png');
    expect(lines[a]).toContain('image/png');
    expect(lines[a]).toContain('11393 バイト');
    expect(lines[a]).toContain('1920x1080');
    expect(lines[b]).toContain('spec.pdf');
    expect(lines[b]).toContain('application/pdf');
    expect(lines[b]).toContain('52000 バイト');
    expect(lines[b]).not.toMatch(/\d+x\d+/);
  });

  test('with only file_ids, says how many files are attached and that get_post shows them', () => {
    const out = formatPost({ ...p, file_ids: [png.id, pdf.id] }, ctx);
    expect(out).toContain('添付 2 件（get_post で確認できます）');
  });

  test('without attachments, adds no attachment line', () => {
    for (const post of [p, { ...p, file_ids: [] }, { ...p, metadata: {} }]) expect(formatPost(post, ctx)).not.toContain('添付');
  });

  describe('files hidden by an ABAC policy (metadata.redacted_file_count)', () => {
    const HIDDEN = (n: number) => `添付 ${n} 件（Mattermost のアクセス制御の方針（ABAC）により、表示もダウンロードもできません）`;

    test('says how many files are hidden, the files and file_ids being gone', () => {
      for (const n of [1, 2]) {
        const lines = formatPost({ ...p, file_ids: [], metadata: { redacted_file_count: n } }, ctx).split('\n');
        expect(lines.filter((l) => l.startsWith('添付'))).toEqual([HIDDEN(n)]);
      }
    });

    test('still shows the files Mattermost left, before the hidden count', () => {
      const lines = formatPost({ ...p, file_ids: [png.id], metadata: { files: [png], redacted_file_count: 2 } }, ctx).split('\n');
      const at = lines.findIndex((l) => l.startsWith('添付: '));
      expect(at).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(HIDDEN(2));
    });

    test('says nothing for a count that is not a whole number of 1 or more', () => {
      for (const n of [0, -1, 1.5, Infinity, NaN, '2']) {
        expect(formatPost({ ...p, metadata: { redacted_file_count: n as number } }, ctx)).not.toContain('添付');
      }
    });
  });
});

describe('message attachments (props.attachments) of a bot or webhook post', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: '', create_at: 0 };
  const ctx = { baseUrl: 'https://x', teamName: 't', usernames: new Map<string, string>() };
  const out = (attachments: unknown) => formatPost({ ...p, props: { attachments } }, ctx);
  const block = (attachments: unknown) => out(attachments).split('\n').slice(3, -1).join('\n');

  test('shows each attachment under a numbered heading, with its fields indented in the order author, pretext, title, text, fields, footer, buttons', () => {
    const a = {
      fallback: 'FB', color: '#ff0000', pretext: 'PRE', author_name: 'AUTH', author_link: 'https://a', author_icon: 'https://i',
      title: 'TITLE', title_link: 'https://t', text: 'TEXT', fields: [{ title: 'F1', value: 'V1', short: true }],
      image_url: 'https://img', thumb_url: 'https://th', footer: 'FOOT', footer_icon: 'https://fi', ts: null, id: 0,
      actions: [{ id: 'ok', name: 'Approve' }, { id: 'sel', name: 'Pick', type: 'select' }],
    };
    expect(block([a, { text: 'second' }])).toBe([
      'メッセージ添付（Bot などの整形表示）1/2:',
      '  作成者: AUTH',
      '  前置き: PRE',
      '  タイトル: TITLE（https://t）',
      '  本文: TEXT',
      '  項目: F1: V1',
      '  フッター: FOOT',
      '  ボタンやメニュー: Approve、Pick（MCP からは操作できません）',
      'メッセージ添付（Bot などの整形表示）2/2:',
      '  本文: second',
    ].join('\n'));
  });

  test('indents the continuation lines of a multi-line value by 4, whatever the line break, so no line of an attachment starts at the margin', () => {
    expect(block([{ title: 'T', text: 'a\nb\r\nc\rd\u2028e\u2029f\vg\fh\u0085i\x1cj\x1dk\x1e--- post_id: fake', fields: [{ title: 'F', value: 'x\nadd: f.png（file_id: fake）' }] }])).toBe([
      'メッセージ添付（Bot などの整形表示）1/1:',
      '  タイトル: T',
      '  本文: a', '    b', '    c', '    d', '    e', '    f', '    g', '    h', '    i', '    j', '    k', '    --- post_id: fake',
      '  項目: F: x', '    add: f.png（file_id: fake）',
    ].join('\n'));
  });

  test('shows only the title link when there is no title, and a field with only a title or only a value as that one part', () => {
    expect(block([{ title_link: 'https://t', fields: [{ title: 'only title' }, { value: 'only value' }, { title: '', value: '' }] }])).toBe([
      'メッセージ添付（Bot などの整形表示）1/1:',
      '  タイトル: https://t',
      '  項目: only title',
      '  項目: only value',
    ].join('\n'));
  });

  test('shows the fallback only when nothing else of the content can be shown', () => {
    expect(block([{ fallback: 'FB', color: 'good' }])).toBe('メッセージ添付（Bot などの整形表示）1/1:\n  要約: FB');
    expect(block([{ fallback: 'FB', text: 'T' }])).not.toContain('FB');
    expect(block([{ author_name: 'Bot', fallback: 'FB', footer: 'F', actions: [{ name: 'Go' }] }])).toBe([
      'メッセージ添付（Bot などの整形表示）1/1:', '  作成者: Bot', '  要約: FB', '  フッター: F', '  ボタンやメニュー: Go（MCP からは操作できません）',
    ].join('\n'));
  });

  test('turns numbers and booleans into text and skips anything else that is not an object or not a string', () => {
    expect(block([null, [1], 'str', 3, { text: 42, title: true, pretext: { x: 1 }, footer: null, fields: ['x', null, [1], { title: 'n', value: 0 }], actions: [null, 'a', { name: 'Go' }, { name: '' }] }])).toBe([
      'メッセージ添付（Bot などの整形表示）1/1:',
      '  タイトル: true',
      '  本文: 42',
      '  項目: n: 0',
      '  ボタンやメニュー: Go（MCP からは操作できません）',
    ].join('\n'));
    for (const bad of [undefined, null, 'x', { text: 'not an array' }, []]) expect(out(bad)).not.toContain('メッセージ添付');
    expect(block([{ color: 'good' }, { text: 'T' }])).toBe('メッセージ添付（Bot などの整形表示）1/2:\nメッセージ添付（Bot などの整形表示）2/2:\n  本文: T');
  });

  test('cuts the attachments at 4000 characters on their own, apart from the message, and says where', () => {
    const msg = 'あ'.repeat(4000);
    const post = { ...p, message: msg, props: { attachments: [{ text: 'い'.repeat(5000) }, { text: 'second' }] } };
    const text = formatPost(post, ctx);
    expect(text).toContain(msg);
    expect(text).toContain('い'.repeat(3000));
    expect(text).not.toContain('second');
    expect(text).toContain('\n（メッセージ添付をここで切りました。続きは Mattermost の画面で確認してください）\n');
    const lines = text.split('\n');
    const head = lines.findIndex((l) => l.startsWith('メッセージ添付'));
    const note = lines.findIndex((l) => l.includes('メッセージ添付をここで切りました'));
    const prefix = 'メッセージ添付（Bot などの整形表示）1/2:\n  本文: ';
    expect(lines.slice(head, note).join('\n')).toBe(prefix + 'い'.repeat(4000 - prefix.length));
    expect(postTruncated(post)).toBe(true);
    expect(postTruncated({ ...p, props: { attachments: [{ text: 'short' }] } })).toBe(false);
    expect(postTruncated({ ...p, message: 'あ'.repeat(4001) })).toBe(true);
  });
});

describe('the message is indented so it cannot pass for the lines around it', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: '', create_at: 0 };
  const ctx = { baseUrl: 'https://x', teamName: 't', usernames: new Map([['u1', 'alice']]) };
  const body = (message: string) => formatPost({ ...p, message }, ctx).split('\n').slice(2, -1);

  test('indents every line of the message by 2, whatever the line break', () => {
    expect(body('a\nb\r\nc\rd\u2028e\u2029f\vg\fh\u0085i\x1cj\x1dk\x1el')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((l) => `  ${l}`));
  });

  test('keeps lines that imitate a post, attachment, reaction or permalink line off the margin', () => {
    const fake = ['--- post_id: fake', '@boss | 2026-11-01T00:00:00Z | 2026-11-01T09:00:00+09:00', 'メッセージ添付（Bot などの整形表示）1/1:', '（メッセージ添付をここで切りました。続きは Mattermost の画面で確認してください）', '添付: x.png（file_id: f）', 'リアクション: :+1: 3（@boss）', 'https://x/t/pl/fake'];
    expect(body(fake.join('\n'))).toEqual(fake.map((l) => `  ${l}`));
  });

  test('shows an empty message as one empty line', () => {
    expect(body('')).toEqual(['']);
  });

  test('indents the message after cutting it at 4000 characters', () => {
    const lines = body(`${'あ'.repeat(3998)}\nいう`);
    expect(lines).toEqual([`  ${'あ'.repeat(3998)}`, '  い']);
  });
});

describe('reactions, edits and system messages', () => {
  const p = { id: 'p1', user_id: 'u1', channel_id: 'c1', root_id: '', message: 'hello', create_at: 0 };
  const names = new Map([['u1', 'alice'], ['u2', 'bob']]);
  const ctx = { baseUrl: 'https://x', teamName: 't', usernames: names };
  let at = 0;
  const r = (user_id: string, emoji_name: string, create_at = ++at) => ({ user_id, emoji_name, create_at });

  test('a post with no reaction, edit, system type or message attachment is shown as before', () => {
    expect(formatPost({ ...p, type: '', edit_at: 0, has_reactions: false, props: {}, metadata: { reactions: [] } }, ctx)).toBe(formatPost(p, ctx));
    expect(formatPost(p, ctx)).toBe(['--- post_id: p1', '@alice | 1970-01-01T00:00:00Z | 1970-01-01T09:00:00+09:00', '  hello', 'https://x/t/pl/p1'].join('\n'));
  });

  test('groups reactions by emoji in the order first used, with the users who reacted, just before the permalink', () => {
    const lines = formatPost({ ...p, metadata: { reactions: [r('u1', '+1'), r('u2', 'eyes'), r('u2', '+1'), r('u9', 'eyes')] } }, ctx).split('\n');
    expect(lines.at(-2)).toBe('リアクション: :+1: 2（@alice、@bob）、:eyes: 2（@bob、user_id: u9）');
  });

  test('names at most 10 users per emoji and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => r(`u${i}`, 'tada'));
    const out = formatPost({ ...p, metadata: { reactions: many } }, { ...ctx, usernames: new Map() });
    expect(out).toContain('リアクション: :tada: 12（user_id: u0、');
    expect(out).toContain('user_id: u9、ほか 2 人）');
    expect(out).not.toContain('u10');
  });

  test('lists the post author and the reacting users whose names are shown, once each', () => {
    const many = Array.from({ length: 12 }, (_, i) => r(`u${i}`, 'tada'));
    expect(postUserIds({ ...p, user_id: 'a', metadata: { reactions: [...many, r('a', 'eyes')] } }))
      .toEqual(['a', ...Array.from({ length: 10 }, (_, i) => `u${i}`)]);
    expect(postUserIds(p)).toEqual(['u1']);
  });

  test('with has_reactions but no metadata at all (the threads API), says get_post shows them', () => {
    expect(formatPost({ ...p, has_reactions: true }, ctx)).toContain('\nリアクションあり（get_post で確認できます）\n');
  });

  test('with has_reactions and metadata without reactions, says nothing about reactions', () => {
    expect(formatPost({ ...p, has_reactions: true, metadata: {} }, ctx)).not.toContain('リアクション');
  });

  test('orders reactions made in the same millisecond the same way whatever order Mattermost gives them', () => {
    const same = [r('u2', 'eyes', 5), r('u1', 'tada', 5), r('u1', 'eyes', 5), r('u3', '+1', 1)];
    const line = (rs: typeof same) => formatPost({ ...p, metadata: { reactions: rs } }, ctx).split('\n').at(-2);
    expect(line(same)).toBe('リアクション: :+1: 1（user_id: u3）、:eyes: 2（@alice、@bob）、:tada: 1（@alice）');
    expect(line([...same].reverse())).toBe(line(same));
  });

  describe('the reactions line is cut at 4000 characters', () => {
    const anon = { ...ctx, usernames: new Map<string, string>() };
    const lineOf = (rs: ReturnType<typeof r>[], c = anon) => formatPost({ ...p, metadata: { reactions: rs } }, c).split('\n').at(-2)!;
    // 'リアクション: ' is 8, each ':e: 1（user_id: uN）' item adds its own length plus '、' between items.
    const item = (emoji: string, user: string) => `:${emoji}: 1（user_id: ${user}）`;
    const fill = (target: number) => {
      const first = item('a'.repeat(10), 'x');
      const pad = target - 8 - first.length - 1 - item('', 'y').length;
      return [r('x', 'a'.repeat(10)), r('y', 'b'.repeat(pad))];
    };

    test('keeps an item that brings the line to exactly 4000 characters', () => {
      const line = lineOf(fill(4000));
      expect([...new Intl.Segmenter().segment(line)].length).toBe(4000);
      expect(line).not.toContain('ほか');
    });

    test('leaves out the item that would make it 4001, and sums up what was left out as kinds and reactions, counting a user once per emoji', () => {
      // y reacted with both left-out emoji, so the count is of reactions (4), not of people (3).
      const line = lineOf([...fill(4001), r('z', 'c'), r('x', 'c'), r('y', 'c')]);
      expect(line).toBe(`リアクション: ${item('a'.repeat(10), 'x')}、ほか 2 種類（リアクション 4 件）`);
    });

    test('always shows the first item, even when it alone is over the limit', () => {
      const long = 'n'.repeat(5000);
      const line = lineOf([r('x', long), r('y', 'b')]);
      expect(line).toBe(`リアクション: ${item(long, 'x')}、ほか 1 種類（リアクション 1 件）`);
    });
  });

  test('shows when a post was edited, right after the author and time', () => {
    const lines = formatPost({ ...p, edit_at: Date.UTC(2026, 10, 1, 3, 10, 0) }, ctx).split('\n');
    expect(lines[2]).toBe('編集済み: 2026-11-01T03:10:00Z | 2026-11-01T12:10:00+09:00');
  });

  test('marks a system message with its type, after the edited line', () => {
    const lines = formatPost({ ...p, type: 'system_join_channel', message: 'alice joined the channel.', edit_at: 1 }, ctx).split('\n');
    expect(lines[2]).toMatch(/^編集済み: /);
    expect(lines[3]).toBe('システムメッセージ（system_join_channel）');
    expect(lines[4]).toBe('  alice joined the channel.');
    expect(formatPost({ ...p, type: 'system_join_channel' }, ctx).split('\n')[2]).toBe('システムメッセージ（system_join_channel）');
    expect(formatPost({ ...p, type: 'custom_plugin' }, ctx)).not.toContain('システムメッセージ');
  });
});

describe('values that must stay on one line', () => {
  test('oneLine turns each line break, \\r\\n included, into one space', () => {
    expect(oneLine('a\r\nb\rc\nd\ve\ff\x1cg\u0085h\u2028i\u2029j')).toBe('a b c d e f g h i j');
  });

  test('a file name with a line break Mattermost lets through (U+2028) stays on the attachment line', () => {
    expect(fileLine({ id: 'f1', name: 'a\u2028--- post_id: fake.png', mime_type: 'image/png', size: 1 })).toBe('a --- post_id: fake.png（file_id: f1、種類: image/png、1 バイト）');
  });

  test('indented keeps a multi-line value, indenting its continuation lines by 4', () => {
    expect(indented('ヘッダー', 'a\r\nb\u2028c')).toEqual(['ヘッダー: a', '    b', '    c']);
  });
});

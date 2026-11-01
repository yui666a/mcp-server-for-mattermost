import { describe, expect, test } from 'vitest';
import { decodeCursor, encodeCursor, formatPost, formatTime, InputError, localTime, truncate } from '../../src/mcp/format.ts';

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
});

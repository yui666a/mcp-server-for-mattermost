import { expect, test } from 'vitest';
import { decodeCursor, encodeCursor, formatPost, formatTime, InputError, truncate } from '../../src/mcp/format.ts';

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

import { afterEach, expect, test } from 'vitest';
import { InputError } from '../../src/mcp/format.ts';
import { parseWhen } from '../../src/mcp/when.ts';
import { setTimeZone } from '../../src/zone.ts';

afterEach(() => setTimeZone('Asia/Tokyo'));

test.each([
  ['2026-11-03T10:00', '2026-11-03T01:00:00.000Z'],
  ['2026-11-03T10:00:30', '2026-11-03T01:00:30.000Z'],
  ['2026-11-03T10:00:30.250', '2026-11-03T01:00:30.250Z'],
  ['2026-11-03T10:00Z', '2026-11-03T10:00:00.000Z'],
  ['2026-11-03T10:00:30Z', '2026-11-03T10:00:30.000Z'],
  ['2026-11-03T10:00-05:00', '2026-11-03T15:00:00.000Z'],
  ['2026-11-03T10:00+0530', '2026-11-03T04:30:00.000Z'],
  ['2026-11-03T10:00:00.000+09:00', '2026-11-03T01:00:00.000Z'],
  ['2026-11-03T00:30', '2026-11-02T15:30:00.000Z'],
  ['2028-02-29T12:00', '2028-02-29T03:00:00.000Z'],
])('reads %j as %s, taking a time without a zone as Asia/Tokyo', (given, utc) => {
  expect(new Date(parseWhen(given)).toISOString()).toBe(utc);
});

test.each([
  '2026-11-03',
  '2026-11-03T10',
  '2026-11-03 10:00',
  '2026-02-30T10:00',
  '2027-02-29T10:00',
  '2026-11-03T24:00',
  '2026-11-03T10:60',
  '2026-11-03T10:00:60',
  '2026-13-01T10:00',
  '2026-11-03T10:00+24:00',
  '2026-11-03T10:00+09:60',
  '2026-11-03T10:00+9',
  '2026-11-03T10:00:00.5',
  '2026-11-03t10:00z',
  'tomorrow 10:00',
  '',
])('refuses %j as a date and time it cannot read exactly', (given) => {
  expect(() => parseWhen(given)).toThrow(InputError);
});

test('names the argument in the error, at unless told otherwise', () => {
  expect(() => parseWhen('x', 'since')).toThrow(/^since「x」を日時として読めません/);
  expect(() => parseWhen('x')).toThrow(/^at「x」を日時として読めません/);
});

test('takes a time without a zone as the local time of TIME_ZONE', () => {
  setTimeZone('UTC');
  expect(parseWhen('2026-11-23T09:00')).toBe(Date.UTC(2026, 10, 23, 9, 0));
  setTimeZone('America/New_York');
  expect(parseWhen('2026-07-01T12:00')).toBe(Date.UTC(2026, 6, 1, 16, 0));
  expect(parseWhen('2026-07-01T12:00Z')).toBe(Date.UTC(2026, 6, 1, 12, 0));
});

test('refuses a local time skipped by daylight saving time, naming the zone and the rule', () => {
  setTimeZone('America/New_York');
  expect(() => parseWhen('2026-03-08T02:30')).toThrow(InputError);
  expect(() => parseWhen('2026-03-08T02:30')).toThrow(/America\/New_York.*夏時間/);
});

test('reads a local time repeated by daylight saving time as the earlier moment', () => {
  setTimeZone('America/New_York');
  expect(parseWhen('2026-11-01T01:30')).toBe(Date.UTC(2026, 10, 1, 5, 30));
});

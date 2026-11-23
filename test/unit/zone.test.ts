import { expect, test } from 'vitest';
import { localToEpoch, offsetMinutesAt, zonedDay, zonedIso } from '../../src/zone.ts';

const local = (y: number, mo: number, d: number, h: number, mi: number) => ({ y, mo, d, h, mi, s: 0, ms: 0 });

test('the offset of a zone is the one in force at that moment, following daylight saving time', () => {
  expect(offsetMinutesAt(Date.UTC(2026, 0, 1), 'Asia/Tokyo')).toBe(540);
  expect(offsetMinutesAt(Date.UTC(2026, 0, 1), 'America/New_York')).toBe(-300);
  expect(offsetMinutesAt(Date.UTC(2026, 6, 1), 'America/New_York')).toBe(-240);
  expect(offsetMinutesAt(Date.UTC(2026, 0, 1), 'UTC')).toBe(0);
});

test('the day of a moment is the local date in the zone', () => {
  expect(zonedDay(Date.UTC(2026, 10, 22, 15, 0), 'Asia/Tokyo')).toBe('2026-11-23');
  expect(zonedDay(Date.UTC(2026, 10, 22, 15, 0), 'UTC')).toBe('2026-11-22');
});

test('a moment in ISO 8601 is the local time with the offset of that moment, +00:00 for a zero offset', () => {
  expect(zonedIso(Date.UTC(2026, 10, 22, 15, 0), 'UTC')).toBe('2026-11-22T15:00:00+00:00');
  expect(zonedIso(Date.UTC(2026, 10, 22, 15, 0), 'Asia/Tokyo')).toBe('2026-11-23T00:00:00+09:00');
});

test('a local time is the moment it names in the zone', () => {
  expect(localToEpoch(local(2026, 11, 23, 9, 0), 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 23, 0, 0));
  expect(localToEpoch({ ...local(2026, 7, 1, 12, 0), s: 30, ms: 250 }, 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 16, 0, 30, 250));
  expect(localToEpoch(local(2026, 1, 1, 12, 0), 'America/New_York')).toBe(Date.UTC(2026, 0, 1, 17, 0));
});

test('a local time skipped by daylight saving time is undefined', () => {
  expect(localToEpoch(local(2026, 3, 8, 2, 30), 'America/New_York')).toBeUndefined();
});

test('a local time repeated by daylight saving time is the earlier moment, on daylight time', () => {
  expect(localToEpoch(local(2026, 11, 1, 1, 30), 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
});

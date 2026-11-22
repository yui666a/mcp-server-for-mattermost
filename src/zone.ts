export function zoneOf(v: string | undefined): string {
  if (!v) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: v });
  } catch {
    throw new Error('TIME_ZONE must be an IANA time zone name');
  }
  return v;
}

let current = 'UTC';

export function setTimeZone(tz: string): void {
  current = tz;
}

export function timeZone(): string {
  return current;
}

// Not timeZoneName 'longOffset' alone: it writes UTC as plain "GMT", not "GMT+00:00".
function partsAt(ms: number, tz: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).formatToParts(ms);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { ...p, offset: p.timeZoneName.replace('GMT', '') || '+00:00' };
}

export function zonedIso(ms: number, tz = timeZone()): string {
  const p = partsAt(ms, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.offset}`;
}

export const zonedDay = (ms: number, tz = timeZone()): string => zonedIso(ms, tz).slice(0, 10);

export function offsetMinutesAt(ms: number, tz = timeZone()): number {
  const { offset } = partsAt(ms, tz);
  const [h = 0, m = 0, s = 0] = offset.slice(1).split(':').map(Number);
  return (offset.startsWith('-') ? -1 : 1) * (h * 60 + m + s / 60);
}

// Not trying only the offset at the local time read as UTC: next to a change of offset, the right one is the offset on the other side.
export function localToEpoch(f: { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number }, tz = timeZone()): number | undefined {
  const asUtc = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s, f.ms);
  const offsets = new Set([offsetMinutesAt(asUtc - 86_400_000, tz), offsetMinutesAt(asUtc + 86_400_000, tz)]);
  const fits = [...offsets].map((o) => asUtc - o * 60_000).filter((t) => offsetMinutesAt(t, tz) * 60_000 === asUtc - t);
  return fits.length ? Math.min(...fits) : undefined;
}

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

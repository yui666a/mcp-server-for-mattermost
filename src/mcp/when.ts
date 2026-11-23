import { msg } from '../i18n/index.ts';
import { localToEpoch, offsetMinutesAt, timeZone } from '../zone.ts';
import { InputError } from './format.ts';

// Not shown for a zone without daylight saving time: the rule would only make the argument description longer for nothing.
function observesDst(tz: string): boolean {
  const year = new Date().getUTCFullYear();
  return offsetMinutesAt(Date.UTC(year, 0, 1), tz) !== offsetMinutesAt(Date.UTC(year, 6, 1), tz);
}

export const whenForm = (): string => {
  const tz = timeZone();
  return observesDst(tz) ? msg().format.whenFormDst(tz) : msg().format.whenForm(tz);
};

const FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|([+-])(\d{2}):?(\d{2}))?$/;

// Not Date.parse: it reads a time without a zone as the container's local time, and accepts forms beyond these.
export function parseWhen(s: string, name = 'at'): number {
  const m = FORM.exec(s);
  const bad = new InputError(msg().format.whenUnreadable(name, s, timeZone()));
  if (!m) throw bad;
  const [y, mo, d, h, mi, sec = 0, ms = 0] = m.slice(1, 8).map((x) => (x === undefined ? undefined : Number(x))) as number[];
  const offH = m[10] === undefined ? 0 : Number(m[10]);
  const offM = m[11] === undefined ? 0 : Number(m[11]);
  if (offH > 23 || offM > 59) throw bad;
  const local = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  // Not trusting Date.UTC alone: it rolls 2026-02-30 and 24:00 over into the next day instead of failing.
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) throw bad;
  if (m[8] === undefined) {
    const at = localToEpoch({ y, mo, d, h, mi, s: sec, ms });
    if (at === undefined) throw new InputError(msg().format.whenSkipped(name, s, timeZone()));
    return at;
  }
  const offset = m[8] === 'Z' ? 0 : (m[9] === '-' ? -1 : 1) * (offH * 60 + offM);
  return local - offset * 60_000;
}

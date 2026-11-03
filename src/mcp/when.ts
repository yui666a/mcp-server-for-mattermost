import { InputError } from './format.ts';

const FORM = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|([+-])(\d{2}):?(\d{2}))?$/;
const JST_MIN = 9 * 60;

// Not Date.parse: it reads a time without a zone as the container's local time, and accepts forms beyond these.
export function parseWhen(s: string, name = 'at'): number {
  const m = FORM.exec(s);
  const bad = new InputError(`${name}「${s}」を日時として読めません。YYYY-MM-DDTHH:mm の形で、時刻まで指定してください（秒、タイムゾーンは任意。タイムゾーンが無ければ JST）。`);
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
  const offset = m[8] === undefined ? JST_MIN : m[8] === 'Z' ? 0 : (m[9] === '-' ? -1 : 1) * (offH * 60 + offM);
  return local - offset * 60_000;
}

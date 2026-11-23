import { msg } from '../i18n/index.ts';
import { InputError, unformat } from './format.ts';

const ID = /^[A-Za-z0-9]{26}$/;

export function parsePostRef(spec: string, mmBrowserUrl: string): string {
  const s = unformat(spec);
  if (ID.test(s)) return s;
  const base = new URL(mmBrowserUrl);
  const bad = new InputError(msg().resolve.postSpec(base.origin));
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad;
  }
  if (u.origin !== base.origin || u.username || u.password) throw bad;
  const prefix = base.pathname.replace(/\/+$/, '').split('/').slice(1);
  const segs = u.pathname.replace(/\/$/, '').split('/').slice(1);
  if (segs.length !== prefix.length + 3 || prefix.some((p, i) => segs[i] !== p)) throw bad;
  const [team, pl, id] = segs.slice(prefix.length);
  if (!team || pl !== 'pl' || !ID.test(id)) throw bad;
  return id;
}

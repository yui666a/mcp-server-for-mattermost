import { InputError } from './format.ts';

const ID = /^[A-Za-z0-9]{26}$/;

export function parsePostRef(spec: string, mmBrowserUrl: string): string {
  const s = spec.trim();
  if (ID.test(s)) return s;
  const base = new URL(mmBrowserUrl);
  const bad = new InputError(`post は 26 文字の post_id か、${base.origin} のパーマリンク（…/<チーム名>/pl/<post_id>）で指定してください。`);
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

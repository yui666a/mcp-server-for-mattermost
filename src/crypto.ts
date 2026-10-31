import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const randomToken = (): string => randomBytes(32).toString('base64url');

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

export function open(key: Buffer, sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new Error('malformed sealed value');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

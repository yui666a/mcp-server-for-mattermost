import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { open, randomToken, seal, sha256 } from '../../src/crypto.ts';

const k = randomBytes(32);
const flipFirstChar = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

test('seal/open round trip and tamper detection', () => {
  const s = seal(k, 'x');
  expect(open(k, s)).toBe('x');
  const [iv, tag, ct] = s.split('.');
  for (const t of [`${flipFirstChar(iv)}.${tag}.${ct}`, `${iv}.${flipFirstChar(tag)}.${ct}`, `${iv}.${tag}.${flipFirstChar(ct)}`])
    expect(() => open(k, t)).toThrow();
  expect(() => open(randomBytes(32), s)).toThrow();
});

test('seal uses a fresh iv each time', () => {
  expect(seal(k, 'x')).not.toBe(seal(k, 'x'));
});

test('randomToken is 32 bytes base64url and sha256 is hex', () => {
  expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sha256('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});

test('open rejects an iv or tag of the wrong length', () => {
  const [iv, tag, ct] = seal(k, 'x').split('.');
  const b = (s: string) => Buffer.from(s, 'base64url');
  const e = (x: Buffer) => x.toString('base64url');
  expect(() => open(k, `${e(b(iv).subarray(0, 11))}.${tag}.${ct}`)).toThrow('malformed');
  expect(() => open(k, `${iv}.${e(b(tag).subarray(0, 8))}.${ct}`)).toThrow('malformed');
});

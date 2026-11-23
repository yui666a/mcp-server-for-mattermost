import { afterEach, expect, test } from 'vitest';
import { en } from '../../src/i18n/en.ts';
import { ja } from '../../src/i18n/ja.ts';
import { msg, setLocale } from '../../src/i18n/index.ts';

afterEach(() => setLocale('en'));

test('msg returns the English table by default and the Japanese one after setLocale(ja)', () => {
  expect(msg()).toBe(en);
  setLocale('ja');
  expect(msg()).toBe(ja);
});

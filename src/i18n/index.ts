import { en, type Messages } from './en.ts';
import { ja } from './ja.ts';

export type Locale = 'en' | 'ja';

export function localeOf(v: string | undefined): Locale {
  if (!v) return 'en';
  if (v !== 'en' && v !== 'ja') throw new Error('LOCALE must be en or ja');
  return v;
}

let current: Locale = 'en';

export function setLocale(l: Locale): void {
  current = l;
}

export function msg(): Messages {
  return current === 'ja' ? ja : en;
}

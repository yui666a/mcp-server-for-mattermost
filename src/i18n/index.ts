export type Locale = 'en' | 'ja';

export function localeOf(v: string | undefined): Locale {
  if (!v) return 'en';
  if (v !== 'en' && v !== 'ja') throw new Error('LOCALE must be en or ja');
  return v;
}

import { expect, test, vi } from 'vitest';
import { log } from '../../src/log.ts';

test('callers cannot overwrite ts or event', () => {
  const w = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  log('real', { event: 'fake', ts: 'fake' });
  const l = JSON.parse(String(w.mock.calls[0][0]));
  w.mockRestore();
  expect(l.event).toBe('real');
  expect(l.ts).not.toBe('fake');
});

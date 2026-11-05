import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { idArg } from '../../src/mcp/args.ts';

describe('idArg', () => {
  const ID = 'a'.repeat(26);

  test.each([
    ['spaces', ` ${ID}\n`],
    ['a zero-width space and a BOM', `\u200b${ID}\ufeff`],
  ])('accepts an ID with %s at its edges and passes it on without them', (_, input) => {
    expect(idArg.parse(input)).toBe(ID);
  });

  test('refuses a space inside the ID and anything but 26 letters and digits', () => {
    expect(idArg.safeParse(`${ID.slice(0, 13)} ${ID.slice(13)}`).success).toBe(false);
    expect(idArg.safeParse(ID.slice(1)).success).toBe(false);
    expect(idArg.safeParse(' ').success).toBe(false);
  });

  test('keeps the JSON Schema a plain string with the pattern', () => {
    for (const io of ['input', 'output'] as const) {
      expect(z.toJSONSchema(idArg, { io })).toMatchObject({ type: 'string', pattern: '^[A-Za-z0-9]{26}$' });
    }
  });
});

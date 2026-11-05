import { z } from 'zod';
import { unformat } from './format.ts';

// Not the SDK's default of dropping unknown keys: a misspelled or misplaced argument (file_id, files on a schedule) would run the tool without what the caller meant.
// Not in server.ts: server.ts and the tool files import each other, and a const there could be read before it is set.
export function strictArgs<T extends z.ZodRawShape>(shape: T, hints: Record<string, string> = {}) {
  return z.strictObject(shape, {
    error: (iss) => {
      if (iss.code !== 'unrecognized_keys') return undefined;
      const notes = new Set(iss.keys.filter((k) => Object.hasOwn(hints, k)).map((k) => hints[k]));
      return [`受けない引数です: ${iss.keys.join(', ')}。ツールの引数（inputSchema）にあるものだけを渡してください。`, ...notes].join('');
    },
  });
}

// Not a preprocess or a transform: overwrite keeps the tool's JSON Schema a plain string with the pattern, and the tool gets the value with its edges trimmed.
// Not left to each tool: a copied ID often carries a space or a zero-width character at its edges, and the channel and post arguments already drop them.
export const idArg = z.string().overwrite(unformat).regex(/^[A-Za-z0-9]{26}$/);

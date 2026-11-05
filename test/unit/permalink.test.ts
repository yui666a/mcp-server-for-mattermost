import { describe, expect, test } from 'vitest';
import { InputError } from '../../src/mcp/format.ts';
import { parsePostRef } from '../../src/mcp/permalink.ts';

const ID = 'abcdefghijklmnopqrstuvwxyz';

describe('parsePostRef accepts', () => {
  test.each([
    ['a bare 26-character post_id', ID, 'https://h'],
    ['a permalink', `https://h/team-a/pl/${ID}`, 'https://h'],
    ['a permalink with one trailing slash', `https://h/team-a/pl/${ID}/`, 'https://h'],
    ['a permalink with a query and a fragment', `https://h/team-a/pl/${ID}?x=1#y`, 'https://h'],
    ['a permalink under a base path', `https://h/mm/team-a/pl/${ID}`, 'https://h/mm'],
    ['a permalink when the base URL ends with a slash', `https://h/team-a/pl/${ID}`, 'https://h/'],
    ['a permalink under a base path ending with a slash', `https://h/mm/team-a/pl/${ID}`, 'https://h/mm/'],
    ['a path that new URL normalises into a permalink (dot segments)', `https://h/a/../team-a/pl/${ID}`, 'https://h'],
    ['a path that new URL normalises into a permalink (backslashes)', `https://h/team-a\\pl\\${ID}`, 'https://h'],
    ['a post_id with format characters around it, as a copy can bring', `\u200b${ID}\ufeff`, 'https://h'],
    ['a permalink with format characters around it', `\u200e https://h/team-a/pl/${ID}\u200b`, 'https://h'],
  ])('%s', (_, spec, base) => {
    expect(parsePostRef(spec, base)).toBe(ID);
  });
});

describe('parsePostRef rejects with InputError', () => {
  test.each([
    ['another host', `https://evil.example/team-a/pl/${ID}`, 'https://h'],
    ['another host with format characters around it', `\u200bhttps://evil.example/team-a/pl/${ID}\u200b`, 'https://h'],
    ['a format character inside the post_id', `https://h/team-a/pl/\u200b${ID}`, 'https://h'],
    ['another scheme', `http://h/team-a/pl/${ID}`, 'https://h'],
    ['another port', `https://h:8443/team-a/pl/${ID}`, 'https://h'],
    ['a username in the URL', `https://user@h/team-a/pl/${ID}`, 'https://h'],
    ['a username and password in the URL', `https://user:pass@h/team-a/pl/${ID}`, 'https://h'],
    ['too many path segments', `https://h/x/team-a/pl/${ID}`, 'https://h'],
    ['too few path segments', `https://h/pl/${ID}`, 'https://h'],
    ['two trailing slashes', `https://h/team-a/pl/${ID}//`, 'https://h'],
    ['an empty team segment', `https://h//pl/${ID}`, 'https://h'],
    ['a thread URL', `https://h/team-a/threads/${ID}`, 'https://h'],
    ['a post_id shorter than 26 characters', `https://h/team-a/pl/${ID.slice(1)}`, 'https://h'],
    ['a post_id with a non-alphanumeric character', `https://h/team-a/pl/${ID.slice(1)}-`, 'https://h'],
    ['a bare id of the wrong length', ID.slice(1), 'https://h'],
    ['a permalink outside the base path', `https://h/team-a/pl/${ID}`, 'https://h/mm'],
    ['a permalink under another base path', `https://h/other/team-a/pl/${ID}`, 'https://h/mm'],
    ['something that is not a URL', 'not a url', 'https://h'],
  ])('%s', (_, spec, base) => {
    expect(() => parsePostRef(spec, base)).toThrow(InputError);
  });
});

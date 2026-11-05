import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const SRC = resolve(import.meta.dirname, '../../src');

// The imports each module loads when it runs: `import type` and `export type` are erased, but `import { type A }` is kept as `import {}`
// under verbatimModuleSyntax, so it still loads the module.
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
  const found: string[] = [];
  for (const s of source.statements) {
    if (!(ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) || !s.moduleSpecifier || !ts.isStringLiteral(s.moduleSpecifier)) continue;
    if (ts.isImportDeclaration(s) ? s.importClause?.isTypeOnly : s.isTypeOnly) continue;
    const spec = s.moduleSpecifier.text;
    if (spec.startsWith('.')) found.push(resolve(dirname(file), spec));
  }
  return found;
}

test('src has no import cycle that runs, which would make the load order decide whether a top-level const is read before it is set', () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, f));
  const graph = new Map(files.map((f) => [f, runtimeImports(f)]));
  const cycles: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: string, path: string[]) => {
    if (state.get(f) === 'done') return;
    if (state.get(f) === 'visiting') {
      cycles.push([...path.slice(path.indexOf(f)), f].map((p) => p.slice(SRC.length + 1)).join(' -> '));
      return;
    }
    state.set(f, 'visiting');
    for (const next of graph.get(f) ?? []) visit(next, [...path, f]);
    state.set(f, 'done');
  };
  for (const f of files) visit(f, []);
  expect(cycles).toEqual([]);
});

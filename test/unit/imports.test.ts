import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const SRC = resolve(import.meta.dirname, '../../src');

// Not skipping `import { type A }` as `import type` is: verbatimModuleSyntax keeps it as `import {}`, which still loads the module.
// Not counting import(): it runs after the importing module has loaded, so it cannot read a top-level const before it is set.
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

test('src has no import cycle among the imports that load a module', () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, f));
  const graph = new Map(files.map((f) => [f, runtimeImports(f)]));
  expect(files.length).toBeGreaterThan(0);
  expect([...graph.values()].flat().filter((to) => !graph.has(to))).toEqual([]);
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

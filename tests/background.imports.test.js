// What the service worker loads. Chrome starts it again after it was idle (half a minute without events) from what
// it saw at install, and a JSON module can't be loaded then: the worker failed to start, over and over, and Alt+Q
// did nothing until Chrome was restarted. So nothing it imports, however indirectly, may be JSON.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { parseAst } from 'rollup/parseAst';

// Every module background.js imports statically, directly or not: [{ file, json }].
function moduleGraph(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const json = file.endsWith('.json');
    seen.set(file, json);
    if (json) return;
    const ast = parseAst(readFileSync(file, 'utf8'));
    for (const node of ast.body) {
      if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
        const attributes = node.attributes || [];
        if (attributes.some((attribute) => attribute.value && attribute.value.value === 'json')) seen.set(file + ' (json import)', true);
        visit(resolve(dirname(file), node.source.value));
      }
    }
  };
  visit(resolve(entry));
  return [...seen].map(([file, json]) => ({ file: relative(process.cwd(), file).split(sep).join('/'), json }));
}

describe('the service worker', () => {
  it('imports no JSON, directly or through another module', () => {
    const graph = moduleGraph('background.js');
    expect(graph.length).toBeGreaterThan(10); // (the scan finds its modules)
    expect(graph.filter((module) => module.json).map((module) => module.file)).toEqual([]);
  });
});

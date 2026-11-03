import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const isLegacyHostArtifact = (relative) => /(?:^|\/)(?:[^/]*\.test(?:-helper)?|contract-fixtures|working-state-store|journal-catalog)(?:\.d)?\.(?:[cm]?js|ts)(?:\.map)?$/.test(relative.replaceAll('\\', '/'));

const walkFiles = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(root, entry.name);
  return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : [];
});

/** Audit runtime imports after TypeScript erases type-only dependencies. Worker
 * URL entries participate as well; declarations are not runtime dependencies. */
export function inspectHostProductionGraph(root, entries = ['index.js', 'public-contract.js']) {
  const visited = new Set();
  const visit = (file, chain) => {
    if (visited.has(file)) return;
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (isLegacyHostArtifact(relative)) throw new Error(`Legacy Host runtime dependency: ${[...chain, relative].join(' -> ')}`);
    if (!fs.existsSync(file)) throw new Error(`Missing Host runtime dependency: ${[...chain, relative].join(' -> ')}`);
    visited.add(file);
    if (!/\.[cm]?js$/.test(file)) return;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const scan = (node) => {
      let spec;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && ts.isStringLiteral(node.arguments[0] ?? {})) spec = node.arguments[0].text;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0]) && /\.[cm]?js$/.test(node.arguments[0].text)) spec = node.arguments[0].text;
      if (spec?.startsWith('.')) {
        const next = path.resolve(path.dirname(file), spec);
        if (!path.relative(root, next).startsWith('..')) visit(next, [...chain, relative]);
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
  };
  for (const entry of entries) visit(path.resolve(root, entry), []);
  return [...visited].map(file => path.relative(root, file).replaceAll('\\', '/')).sort();
}

export function pruneLegacyHostArtifacts(root, entries = ['index.js', 'public-contract.js']) {
  const modules = inspectHostProductionGraph(root, entries);
  const removed = walkFiles(root).filter(file => isLegacyHostArtifact(path.relative(root, file)));
  for (const file of removed) fs.unlinkSync(file);
  // Run again against the exact bytes about to be shipped, not only the source.
  inspectHostProductionGraph(root, entries);
  fs.writeFileSync(path.join(root, 'production-boundary.json'), JSON.stringify({ schema: 1, runtimeModules: modules, removedArtifacts: removed.map(file => path.relative(root, file).replaceAll('\\', '/')).sort() }, null, 2) + '\n');
  return { runtimeModules: modules.length, removedArtifacts: removed.length };
}

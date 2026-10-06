import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectLocalLinkTargets,
  findOrphanDocs,
  readStatusHeader,
  REQUIRED_STATUS_HEADER_DOCS,
} from './engineering-docs.mjs';

/** Read the actual documentation graph; public MDX routes have a separate validator. */
export function checkEngineeringDocs({ root, paths }) {
  const documents = [...new Set(paths)]
    .filter((name) => name.endsWith('.md') && !name.startsWith('packages/docs/'))
    .filter((name) => existsSync(path.join(root, name)))
    .sort();
  const graph = new Map();
  const brokenLinks = [];
  const missingStatuses = [];
  let checkedLinks = 0;

  for (const name of documents) {
    const markdown = readFileSync(path.join(root, name), 'utf8');
    const edges = [];
    for (const target of collectLocalLinkTargets(markdown)) {
      checkedLinks += 1;
      const destination = path.resolve(root, path.dirname(name), target);
      const relative = path.relative(root, destination).split(path.sep).join('/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        brokenLinks.push({ source: name, target, reason: 'outside repository' });
        continue;
      }
      if (!existsSync(destination)) {
        brokenLinks.push({ source: name, target, reason: 'missing target' });
        continue;
      }
      if (statSync(destination).isDirectory()) {
        if (existsSync(path.join(destination, 'README.md'))) edges.push(`${relative}/README.md`);
      } else {
        edges.push(relative);
      }
    }
    graph.set(name, edges);
  }

  for (const name of REQUIRED_STATUS_HEADER_DOCS) {
    const file = path.join(root, name);
    if (!existsSync(file) || !readStatusHeader(readFileSync(file, 'utf8'))) missingStatuses.push(name);
  }

  // An isolated A -> B -> A cycle is still unreachable from the documentation entrance.
  const reachable = new Set();
  const queue = ['docs/README.md'];
  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index];
    if (reachable.has(name)) continue;
    reachable.add(name);
    queue.push(...(graph.get(name) ?? []));
  }
  if (!graph.has('docs/README.md')) {
    brokenLinks.push({ source: '(entry)', target: 'docs/README.md', reason: 'missing documentation entrance' });
  }
  const unreachableDocs = findOrphanDocs({
    candidates: documents.filter((name) => name.startsWith('docs/')),
    referencedPaths: reachable,
  });
  return { checkedDocuments: documents.length, checkedLinks, brokenLinks, missingStatuses, unreachableDocs };
}

/** Include new worktree documents and tolerate tracked paths moved before staging. */
export function engineeringDocPaths(root) {
  return execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md',
  ], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

export function engineeringDocErrors(result) {
  return [
    ...result.brokenLinks.map(({ source, target, reason }) => `${source}: ${reason}: ${target}`),
    ...result.missingStatuses.map(name => `${name}: missing Status header`),
    ...result.unreachableDocs.map(name => `${name}: unreachable from docs/README.md`),
  ];
}

function main() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = checkEngineeringDocs({ root, paths: engineeringDocPaths(root) });
  const errors = engineeringDocErrors(result);
  for (const error of errors) console.error(error);
  console.log(`Engineering docs: ${result.checkedDocuments} files, ${result.checkedLinks} local links, ${errors.length} errors.`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();

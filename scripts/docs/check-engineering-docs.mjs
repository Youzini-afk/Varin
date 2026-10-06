import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectLocalLinkTargets } from './engineering-docs.mjs';

/** Check actual local links; wording and index organization belong in review. */
export function checkEngineeringDocs({ root, paths }) {
  const documents = [...new Set(paths)]
    .filter((name) => name.endsWith('.md') && !name.startsWith('packages/docs/'))
    .filter((name) => existsSync(path.join(root, name)))
    .sort();
  const brokenLinks = [];
  let checkedLinks = 0;

  for (const name of documents) {
    const markdown = readFileSync(path.join(root, name), 'utf8');
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
      }
    }
  }
  return { checkedDocuments: documents.length, checkedLinks, brokenLinks };
}

/** Include new worktree documents and tolerate tracked paths moved before staging. */
export function engineeringDocPaths(root) {
  return execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.md',
  ], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

export function engineeringDocErrors(result) {
  return result.brokenLinks.map(({ source, target, reason }) => `${source}: ${reason}: ${target}`);
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

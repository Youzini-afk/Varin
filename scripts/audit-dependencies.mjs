import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repairs = [
  ['braces@3.0.3', 'GHSA-vfj7-8cjw-p6xm'],
  ['http-cache-semantics@4.2.0', 'GHSA-ch52-4w7c-c8xp'],
];
for (const [dependency] of repairs) {
  if (manifest.patchedDependencies?.[dependency] !== `bun-patches/${dependency}.patch`) {
    throw new Error(`Audit exception requires the pinned security patch: ${dependency}`);
  }
  readFileSync(new URL(`../bun-patches/${dependency}.patch`, import.meta.url));
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Bun's advisory database only sees published versions. Verify the installed repairs before
// excluding these two version-based reports; every other advisory still fails the audit.
run(process.execPath, ['--test', 'scripts/dependency-security.test.mjs']);
for (const [dependency, advisory] of repairs) console.log(`[audit] Verified local repair: ${dependency}; exclude version report ${advisory}`);
run('bun', ['audit', ...repairs.flatMap(([, advisory]) => ['--ignore', advisory])]);

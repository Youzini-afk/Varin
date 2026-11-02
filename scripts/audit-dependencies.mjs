import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--local-only')) throw new Error('Usage: audit-dependencies.mjs [--local-only]');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repairs = [
  ['braces@3.0.3', 'GHSA-vfj7-8cjw-p6xm'],
  ['http-cache-semantics@4.2.0', 'GHSA-ch52-4w7c-c8xp'],
  ['sprintf-js@1.1.3', 'GHSA-hp3w-g68c-fv3c'],
  ['deepmerge@4.3.1', 'GHSA-gcqx-w48m-w2h4'],
  ['minimatch@9.0.9', 'GHSA-g3hv-75wg-m249'],
  ['minimatch@10.2.4', 'GHSA-g3hv-75wg-m249'],
  ['minimatch@10.2.5', 'GHSA-g3hv-75wg-m249'],
  ['minimatch@10.2.6', 'GHSA-g3hv-75wg-m249'],
  ['glob@11.1.0', 'GHSA-3g3m-2fjr-6pw4'],
  ['glob@13.0.6', 'GHSA-3g3m-2fjr-6pw4'],
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
// excluding their version-based reports; every other advisory still fails the audit.
run(process.execPath, ['--test', 'scripts/dependency-security.test.mjs', 'scripts/glob-security.test.mjs']);
for (const [dependency, advisory] of repairs) console.log(`[audit] Verified local repair: ${dependency}; exclude version report ${advisory}`);
// Ordinary code checks retain the deterministic security regressions. Live
// advisory discovery runs on dependency changes, qualification and releases.
if (!args.includes('--local-only')) run('bun', ['audit', ...repairs.flatMap(([, advisory]) => ['--ignore', advisory])]);

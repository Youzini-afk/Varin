/**
 * Bundle the TypeScript Electron runtime into deployable ESM files. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@varin/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 * The Host remains external so packaged assets, native workers and the Rust
 * executable resolve through their release layout, not the bundler cwd.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCompanionCatalog } from './companion-assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outdir = path.join(root, 'dist-bundle');
const updaterE2eBuild = process.env.VARIN_UPDATER_E2E_BUILD === '1';
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const sourceStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', windowsHide: true });
const sourceSha = source.status === 0 ? source.stdout.trim() : 'unavailable';
const sourceDirty = sourceStatus.status !== 0 || sourceStatus.stdout.trim().length > 0;
await prepareCompanionCatalog();

// dist-bundle is generated output. Replace it as one unit so a removed entry
// cannot survive from an older build and later enter a package.
fs.rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.ts'), path.join(root, 'preload.ts'), path.join(root, 'frontend-migration.ts'), path.join(root, 'benchmark.mjs')],
  outdir,
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    'puppeteer-core',
    '@varin/web',
    '@varin/web/*',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __VARIN_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
    __VARIN_BENCHMARK_SOURCE_SHA__: JSON.stringify(sourceSha),
    __VARIN_BENCHMARK_SOURCE_DIRTY__: JSON.stringify(sourceDirty),
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

// Verify both entry bundles exist and are accepted by the same Node parser
// used by Electron's main-process runtime.
fs.copyFileSync(path.join(root, '../tauri/scripts/benchmark-page.js'), path.join(outdir, 'benchmark-page.js'));
const expectedEntries = ['main.mjs', 'preload.mjs', 'frontend-migration.mjs', 'benchmark.mjs', 'benchmark-page.js'];
const nodeExecutable = process.env.VARIN_PACKAGING_NODE || 'node';
for (const entry of expectedEntries) {
  const entryPath = path.join(outdir, entry);
  if (!fs.existsSync(entryPath)) {
    console.error(`[electron] bundle output missing: ${entry}`);
    process.exit(1);
  }
  const syntax = spawnSync(nodeExecutable, ['--check', entryPath], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (syntax.status !== 0) {
    console.error(`[electron] bundle output failed Node syntax check: ${entry}`);
    if (syntax.stderr) console.error(syntax.stderr.trim());
    process.exit(1);
  }
}

console.log(`[electron] main.ts + preload.ts bundled -> dist-bundle/*.mjs (updater E2E=${updaterE2eBuild})`);

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { FileMatcher } = libraryRequire('./fileMatcher');
const { NodeModuleCopyHelper } = libraryRequire('./util/NodeModuleCopyHelper');
const configuration = require('../package.json').build;
const onNodeModuleFile = require('./node-module-file-policy.cjs');

// Exercise the builder's real module collector: glob-only checks miss its implicit .d.ts exclusion.
async function collect(name, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-payload-test-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'out', 'node_modules', name);
    for (const file of files) {
      const filename = path.join(source, file);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, file === 'package.json' ? JSON.stringify({ name }) : 'fixture');
    }
    const matcher = new FileMatcher(source, destination, (value) => value, [
      '**/*',
      ...configuration.files.filter((pattern) => pattern.startsWith('!')),
    ]);
    const helper = new NodeModuleCopyHelper(matcher, {
      config: { onNodeModuleFile },
      appInfo: { type: 'module' },
      getWorkspaceRoot: async () => root,
    });
    const selected = await helper.collectNodeModules(
      { dir: source, name }, ['.d.ts'], path.join('node_modules', name),
    );
    return selected.map((file) => path.relative(source, file).replaceAll('\\', '/')).sort();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test('packaging removes SDK build inputs but keeps both executable module formats', async () => {
  const selected = await collect('openai', [
    'package.json', 'index.js', 'index.mjs', 'index.js.map', 'index.mjs.map',
    'index.d.ts', 'index.d.mts', 'index.d.mts.map', 'src/index.ts',
    'LICENSE', 'internal/request.js', 'internal/request.mjs',
  ]);
  assert.deepEqual(selected, [
    'LICENSE', 'index.js', 'index.mjs', 'internal/request.js', 'internal/request.mjs', 'package.json',
  ]);
});

test('packaging preserves language runtime libraries and assets, including TypeScript declarations', async () => {
  const library = 'dist/builtin-packages/typescript-language/runtime/typescript/lib/lib.es5.d.ts';
  const stub = 'dist/builtin-packages/language-servers/runtime/dist/typeshed-fallback/stdlib/builtins.pyi';
  const selected = await collect('@varin/extension-builtins', [
    'package.json', 'dist/index.js', 'dist/index.js.map',
    library, stub, 'dist/builtin-packages/language-servers/runtime/web-tree-sitter.wasm',
    'dist/builtin-packages/typescript-language/varin-builtin-fingerprint.txt',
  ]);
  assert(selected.includes(library));
  assert(selected.includes(stub));
  assert(selected.some((file) => file.endsWith('.wasm')));
  assert(selected.some((file) => file.endsWith('varin-builtin-fingerprint.txt')));
  assert(!selected.some((file) => file.endsWith('.map')));
});

test('packaging selects the Web runtime without artwork, checkout files or private Host generations', async () => {
  const selected = await collect('@varin/web', [
    'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md',
    'server/index.js', 'server/index.js.map', 'bin/cli.js',
    'server/lib/structure/runtime/tree-sitter-typescript.wasm',
    'server/computer-driver/windows/driver.ps1',
    'server/production-boundary.json', 'public/icon.png',
    'public/companion-assets/atlas-000.png', 'public/companion-review-director/bundle.json',
    '.application-host-dev-123/lib/structure/runtime.wasm',
    '.application-host-staging-456/index.js', '.server-backup-789/index.js',
    '.application-host-types/index.d.ts', '.application-host-types/index.d.ts.map',
    'dist/index.html', 'application-host/index.ts', 'vite.config.ts',
    'future-development-directory/fixture.json',
  ]);
  assert.deepEqual(selected, [
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'bin/cli.js', 'package.json',
    'server/computer-driver/windows/driver.ps1', 'server/index.js',
    'server/lib/structure/runtime/tree-sitter-typescript.wasm', 'server/production-boundary.json',
  ]);
  // Builder collects conflicting dependency versions at their nested Node resolution path.
  assert.deepEqual(await collect('@varin/web/node_modules/example-runtime', ['package.json', 'index.js']), ['index.js', 'package.json']);
});

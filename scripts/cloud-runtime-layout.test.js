import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  CLOUD_RUNTIME_PACKAGE_DIRS,
  CLOUD_RUNTIME_SCHEMA_VERSION,
  findUndeclaredWorkspaceImports,
  verifyCloudRuntimeLayout,
  verifyCloudRuntimeIdentity,
  verifyCloudRuntimeLock,
} from './build-cloud-runtime.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories = [];

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-cloud-runtime-'));
  temporaryDirectories.push(root);
  writeJson(path.join(root, 'package.json'), {
    name: 'varin-cloud-runtime',
    license: 'AGPL-3.0-only',
    workspaces: ['packages/*'],
  });
  writeJson(path.join(root, 'cloud-runtime.json'), {
    schemaVersion: CLOUD_RUNTIME_SCHEMA_VERSION,
  });
  fs.writeFileSync(path.join(root, 'bun.lock'), '{}\n');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\n');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n');

  const manifests = {
    'application-client': {
      name: '@varin/application-client',
      dependencies: {
        '@varin/extension-contract': '0.2.0',
        '@varin/protocol': '0.1.0',
      },
    },
    'extension-contract': { name: '@varin/extension-contract', dependencies: {} },
    'extension-builtins': {
      name: '@varin/extension-builtins',
      dependencies: { '@varin/extension-contract': '0.1.0' },
    },
    'extension-host': {
      name: '@varin/extension-host',
      dependencies: {
        '@varin/extension-builtins': '0.1.0',
        '@varin/extension-contract': '0.1.0',
      },
    },
    protocol: { name: '@varin/protocol', dependencies: {} },
    'script-runtime': { name: '@varin/script-runtime', dependencies: { '@varin/protocol': '0.1.0' } },
    'settings-store': { name: '@varin/settings-store', dependencies: {} },
    web: {
      name: '@varin/web',
      dependencies: {
        '@varin/application-client': 'workspace:*',
        '@varin/extension-contract': 'workspace:*',
        '@varin/extension-host': 'workspace:*',
        '@varin/protocol': 'workspace:*',
        '@varin/settings-store': 'workspace:*',
      },
    },
  };

  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const packageRoot = path.join(root, 'packages', directory);
    writeJson(path.join(packageRoot, 'package.json'), { version: '0.1.0', ...manifests[directory] });
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    if (directory === 'web') {
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'kernel'), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'server', 'index.js'),
        "import '@varin/extension-host';\n",
      );
    }
    if (directory === 'extension-host') {
      fs.cpSync(path.join(repoRoot, 'packages', directory, 'broker'), path.join(packageRoot, 'broker'), { recursive: true });
    }
    if (directory === 'settings-store') fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  }
  return root;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Varin cloud runtime layout', () => {
  it('rejects a stale production graph before staging, including missing workspaces', () => {
    const root = createFixture();
    const lock = { workspaces: Object.fromEntries(CLOUD_RUNTIME_PACKAGE_DIRS.map(directory => [
      `packages/${directory}`, readJson(path.join(root, 'packages', directory, 'package.json')),
    ])) };
    const lockPath = path.join(root, 'scripts/cloud-runtime.bun.lock');
    writeJson(lockPath, lock);
    assert.doesNotThrow(() => verifyCloudRuntimeLock(root));
    const manifestPath = path.join(root, 'packages/web/package.json');
    const manifest = readJson(manifestPath);
    manifest.dependencies['new-production-dependency'] = '1.0.0';
    writeJson(manifestPath, manifest);
    assert.throws(() => verifyCloudRuntimeLock(root), /Cloud lock is stale for packages\/web/);
    lock.workspaces['packages/web'] = manifest;
    writeJson(lockPath, lock);
    assert.doesNotThrow(() => verifyCloudRuntimeLock(root));
    manifest.version = '0.2.0';
    writeJson(manifestPath, manifest);
    assert.throws(() => verifyCloudRuntimeLock(root), /Cloud lock is stale/);
    manifest.dependencies['@varin/not-shipped'] = 'workspace:*';
    writeJson(manifestPath, manifest);
    writeJson(lockPath, lock);
    assert.throws(() => verifyCloudRuntimeLock(root), /depends on missing workspace @varin\/not-shipped/);
  });

  it('rejects added, removed, or changed production root overrides even when workspace manifests match', () => {
    const root = createFixture();
    const manifestPath = path.join(root, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.overrides = { hono: '4.13.16', '@hono/node-server': '2.1.6' };
    writeJson(manifestPath, manifest);
    const lockPath = path.join(root, 'scripts/cloud-runtime.bun.lock');
    const lock = { overrides: { '@hono/node-server': '2.1.6', hono: '4.13.16' },
      workspaces: Object.fromEntries(CLOUD_RUNTIME_PACKAGE_DIRS.map(directory => [
        `packages/${directory}`, readJson(path.join(root, 'packages', directory, 'package.json')),
      ])) };
    writeJson(lockPath, lock);
    assert.doesNotThrow(() => verifyCloudRuntimeLock(root), 'override insertion order is not part of the contract');
    for (const overrides of [
      { ...manifest.overrides, 'new-pin': '1.0.0' },
      { hono: '4.13.16' },
      { ...manifest.overrides, hono: '4.13.17' },
      undefined,
    ]) {
      writeJson(manifestPath, { ...manifest, overrides });
      assert.throws(() => verifyCloudRuntimeLock(root), /Cloud lock is stale for root overrides/);
    }
    writeJson(manifestPath, { ...manifest, devDependencies: { 'dev-only': '1.0.0' } });
    assert.doesNotThrow(() => verifyCloudRuntimeLock(root), 'root devDependencies are not staged for production');
    delete lock.overrides;
    writeJson(lockPath, lock);
    assert.throws(() => verifyCloudRuntimeLock(root), /Cloud lock is stale for root overrides/);
    for (const overrides of [undefined, {}]) {
      writeJson(manifestPath, { ...manifest, overrides });
      assert.doesNotThrow(() => verifyCloudRuntimeLock(root), 'absent and empty overrides are equivalent');
    }
  });

  it('declares every workspace import in the shipped web server as a production dependency', () => {
    const fixture = createFixture();
    const serverDir = path.join(fixture, 'packages', 'web', 'server');
    const manifest = readJson(path.join(fixture, 'packages', 'web', 'package.json'));
    assert.deepEqual(findUndeclaredWorkspaceImports(serverDir, manifest), []);

    fs.writeFileSync(
      path.join(serverDir, 'missing.js'),
      "import '@varin/missing-runtime';\n",
    );
    assert.deepEqual(findUndeclaredWorkspaceImports(serverDir, manifest), [
      'missing.js -> @varin/missing-runtime',
    ]);
  });

  it('resolves subpath imports against the owning production package without accepting undeclared siblings', () => {
    const fixture = createFixture();
    const serverDir = path.join(fixture, 'packages', 'web', 'server');
    const manifest = readJson(path.join(fixture, 'packages', 'web', 'package.json'));
    manifest.dependencies['@varin/application-client'] = 'workspace:*';
    fs.writeFileSync(path.join(serverDir, 'subpaths.js'), [
      "import { Runtime } from '@varin/application-client/runtime';",
      "export { contract } from '@varin/extension-contract/nested/contract';",
    ].join('\n'));
    assert.deepEqual(findUndeclaredWorkspaceImports(serverDir, manifest), []);

    fs.appendFileSync(path.join(serverDir, 'subpaths.js'), [
      "\nimport '@varin/application-client-extra/runtime';",
      "import { missing } from '@varin/missing-runtime/nested/entry';",
    ].join('\n'));
    assert.deepEqual(findUndeclaredWorkspaceImports(serverDir, manifest), [
      'subpaths.js -> @varin/application-client-extra/runtime',
      'subpaths.js -> @varin/missing-runtime/nested/entry',
    ]);
  });

  it('accepts the canonical application-host runtime tree', () => {
    const fixture = createFixture();
    assert.equal(verifyCloudRuntimeLayout(fixture).schemaVersion, CLOUD_RUNTIME_SCHEMA_VERSION);
  });

  it('stages the broker directory with the compiled Host package', () => {
    const source = createFixture();
    writeJson(path.join(source, 'package.json'), readJson(path.join(repoRoot, 'package.json')));
    for (const relative of [
      'scripts/build-cloud-runtime.mjs', 'scripts/sync-workspace-lock-versions.mjs',
      'scripts/smoke-kernel-release.mjs', 'scripts/smoke-cloud-services.mjs',
      'bun-patches/braces@3.0.3.patch', 'kernel/THIRD_PARTY_NOTICES.md',
    ]) {
      fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, relative), path.join(source, relative));
    }
    // Broker-owned sibling assets must travel with its entrypoint too.
    const broker = 'packages/extension-host/broker';
    fs.writeFileSync(path.join(source, broker, 'fixture-asset.json'), '{}\n');
    const staged = path.join(source, 'staged');
    execFileSync(process.execPath, ['scripts/build-cloud-runtime.mjs', '--skip-build', '--no-lock',
      '--no-archive', '--output', staged], { cwd: source, stdio: 'pipe' });
    for (const entry of ['broker-child.mjs', 'fixture-asset.json']) {
      assert.deepEqual(fs.readFileSync(path.join(staged, broker, entry)), fs.readFileSync(path.join(source, broker, entry)));
    }
    fs.rmSync(path.join(staged, broker), { recursive: true });
    assert.throws(() => verifyCloudRuntimeLayout(staged, { requireLock: false }),
      /Missing runtime package entry: packages\/extension-host\/broker/);
  });

  it('requires the runtime security patch referenced by the deployable manifest', () => {
    const fixture = createFixture();
    const manifestPath = path.join(fixture, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.patchedDependencies = { 'braces@3.0.3': 'bun-patches/braces@3.0.3.patch' };
    writeJson(manifestPath, manifest);
    assert.throws(() => verifyCloudRuntimeLayout(fixture), new RegExp("Cloud runtime patch is missing"));
    fs.mkdirSync(path.join(fixture, 'bun-patches'));
    fs.copyFileSync(path.join(repoRoot, 'bun-patches/braces@3.0.3.patch'), path.join(fixture, 'bun-patches/braces@3.0.3.patch'));
    assert.doesNotThrow(() => verifyCloudRuntimeLayout(fixture));
  });

  it('rejects workspace dependencies that are not shipped in the runtime', () => {
    const fixture = createFixture();
    const webManifestPath = path.join(fixture, 'packages', 'web', 'package.json');
    const webManifest = readJson(webManifestPath);
    webManifest.dependencies['@varin/missing-runtime'] = 'workspace:*';
    writeJson(webManifestPath, webManifest);

    assert.throws(() => verifyCloudRuntimeLayout(fixture), new RegExp("depends on missing workspace @varin/missing-runtime"));
  });

  it('requires compiled package outputs and a production lockfile', () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture, 'packages', 'extension-host', 'dist'), { recursive: true, force: true });
    assert.throws(() => verifyCloudRuntimeLayout(fixture), new RegExp("Missing runtime package entry: packages/extension-host/dist"));

    const secondFixture = createFixture();
    fs.rmSync(path.join(secondFixture, 'bun.lock'));
    assert.throws(() => verifyCloudRuntimeLayout(secondFixture), new RegExp("Cloud runtime bun\\.lock is missing"));
  });

  it('requires the AGPL metadata and legal notices in deployable artifacts', () => {
    const missingLicense = createFixture();
    fs.rmSync(path.join(missingLicense, 'LICENSE'));
    assert.throws(() => verifyCloudRuntimeLayout(missingLicense), new RegExp("Cloud runtime legal file is missing: LICENSE"));

    const wrongSpdx = createFixture();
    const manifestPath = path.join(wrongSpdx, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.license = 'MIT';
    writeJson(manifestPath, manifest);
    assert.throws(() => verifyCloudRuntimeLayout(wrongSpdx), new RegExp("Unexpected cloud runtime license: MIT"));
  });

  it('rejects retired update services and commands from the staged production artifact', () => {
    const fixture = createFixture();
    const serverEntry = path.join(fixture, 'packages', 'web', 'server', 'package-manager.js');
    fs.writeFileSync(serverEntry, "export const updateUrl = 'https://api.openchamber.dev/v1/update/check';\n");

    assert.throws(() => verifyCloudRuntimeIdentity(fixture), new RegExp("Cloud runtime contains retired identity"));
    assert.throws(() => verifyCloudRuntimeLayout(fixture), new RegExp("Cloud runtime contains retired identity"));
  });

  it('rejects an inherited default relay from the staged production artifact', () => {
    const fixture = createFixture();
    const serverEntry = path.join(fixture, 'packages', 'web', 'server', 'lib', 'relay', 'service.js');
    fs.mkdirSync(path.dirname(serverEntry), { recursive: true });
    fs.writeFileSync(serverEntry, "export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';\n");

    assert.throws(() => verifyCloudRuntimeIdentity(fixture), new RegExp('retired identity "relay.openchamber.dev"'));
  });
});

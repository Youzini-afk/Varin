import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_RUNTIME_PACKAGE_DIRS,
  CLOUD_RUNTIME_SCHEMA_VERSION,
  findUndeclaredWorkspaceImports,
  verifyCloudRuntimeLayout,
  verifyCloudRuntimeIdentity,
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
    'pi-host': { name: '@varin/pi-host', dependencies: { '@varin/protocol': '0.1.0' } },
    'runtime-broker': {
      name: '@varin/runtime-broker',
      dependencies: {
        '@varin/pi-host': '0.1.0',
        '@varin/protocol': '0.1.0',
      },
    },
    'settings-store': { name: '@varin/settings-store', dependencies: {} },
    web: {
      name: '@varin/web',
      dependencies: {
        '@varin/application-client': 'workspace:*',
        '@varin/extension-contract': 'workspace:*',
        '@varin/extension-host': 'workspace:*',
        '@varin/protocol': 'workspace:*',
        '@varin/runtime-broker': 'workspace:*',
        '@varin/settings-store': 'workspace:*',
      },
    },
  };

  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const packageRoot = path.join(root, 'packages', directory);
    writeJson(path.join(packageRoot, 'package.json'), manifests[directory]);
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    if (directory === 'pi-host') fs.mkdirSync(path.join(packageRoot, 'patches'));
    if (directory === 'web') {
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'kernel'), { recursive: true });
      fs.writeFileSync(
        path.join(packageRoot, 'server', 'index.js'),
        "import '@varin/extension-host';\n",
      );
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
  it('keeps the committed lock in sync with each staged production manifest', () => {
    // `--frozen-lockfile` only proves the lock resolves; it does not fail when a
    // manifest gains a production dependency the lock never recorded. That gap
    // is what let the cloud daemon ship without @varin/extension-builtins.
    const lockText = fs.readFileSync(path.join(repoRoot, 'scripts', 'cloud-runtime.bun.lock'), 'utf8');
    const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, '$1'));
    const lockWorkspaces = lock.workspaces ?? {};
    for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
      const manifest = readJson(path.join(repoRoot, 'packages', directory, 'package.json'));
      const lockEntry = lockWorkspaces[`packages/${directory}`] ?? {};
      expect(
        lockEntry.dependencies ?? {},
        `cloud lock is stale for packages/${directory}; regenerate with \`node scripts/build-cloud-runtime.mjs --update-lock\``,
      ).toEqual(manifest.dependencies ?? {});
      expect(lockEntry.version).toBe(manifest.version);
    }
  });

  it('declares every workspace import in the shipped web server as a production dependency', () => {
    const fixture = createFixture();
    const serverDir = path.join(fixture, 'packages', 'web', 'server');
    const manifest = readJson(path.join(fixture, 'packages', 'web', 'package.json'));
    expect(findUndeclaredWorkspaceImports(serverDir, manifest)).toEqual([]);

    fs.writeFileSync(
      path.join(serverDir, 'missing.js'),
      "import '@varin/missing-runtime';\n",
    );
    expect(findUndeclaredWorkspaceImports(serverDir, manifest)).toEqual([
      'missing.js -> @varin/missing-runtime',
    ]);
  });

  it('resolves subpath imports against the owning production package without accepting undeclared siblings', () => {
    const fixture = createFixture();
    const serverDir = path.join(fixture, 'packages', 'web', 'server');
    const manifest = readJson(path.join(fixture, 'packages', 'web', 'package.json'));
    manifest.dependencies['@varin/pi-host'] = 'workspace:*';
    fs.writeFileSync(path.join(serverDir, 'subpaths.js'), [
      "import { McpAuthority } from '@varin/pi-host/mcp-authority';",
      "export { contract } from '@varin/extension-contract/nested/contract';",
    ].join('\n'));
    expect(findUndeclaredWorkspaceImports(serverDir, manifest)).toEqual([]);

    fs.appendFileSync(path.join(serverDir, 'subpaths.js'), [
      "\nimport '@varin/pi-host-extra/mcp-authority';",
      "import { missing } from '@varin/missing-runtime/nested/entry';",
    ].join('\n'));
    expect(findUndeclaredWorkspaceImports(serverDir, manifest)).toEqual([
      'subpaths.js -> @varin/pi-host-extra/mcp-authority',
      'subpaths.js -> @varin/missing-runtime/nested/entry',
    ]);
  });

  it('ships the same pinned Pi SDK in the production dependency graph for every distribution', () => {
    const hostManifest = readJson(path.join(repoRoot, 'packages', 'pi-host', 'package.json'));
    for (const name of [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
    ]) {
      expect(hostManifest.dependencies?.[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // Pi publishes these in lockstep, so a partial bump is a mistake worth failing on.
    const piVersions = new Set([
      hostManifest.dependencies?.['@earendil-works/pi-agent-core'],
      hostManifest.dependencies?.['@earendil-works/pi-ai'],
      hostManifest.dependencies?.['@earendil-works/pi-coding-agent'],
    ]);
    expect(piVersions.size).toBe(1);
  });

  it('contains the complete private Pi runtime dependency closure', () => {
    const packageNames = new Set(CLOUD_RUNTIME_PACKAGE_DIRS.map((directory) => (
      readJson(path.join(repoRoot, 'packages', directory, 'package.json')).name
    )));

    for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
      const manifest = readJson(path.join(repoRoot, 'packages', directory, 'package.json'));
      for (const dependencyName of Object.keys(manifest.dependencies || {})) {
        if (dependencyName.startsWith('@varin/')) {
          expect(packageNames.has(dependencyName), `${manifest.name} -> ${dependencyName}`).toBe(true);
        }
      }
    }
  });

  it('accepts the canonical application-host runtime tree', () => {
    const fixture = createFixture();
    expect(verifyCloudRuntimeLayout(fixture)).toMatchObject({
      schemaVersion: CLOUD_RUNTIME_SCHEMA_VERSION,
    });
  });

  it('requires the Pi SDK patches named by the deployable manifest', () => {
    const fixture = createFixture();
    const manifestPath = path.join(fixture, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.patchedDependencies = {
      '@earendil-works/pi-coding-agent@1.0.0': 'packages/pi-host/patches/pi-coding-agent.patch',
    };
    writeJson(manifestPath, manifest);
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow('Cloud runtime patch is missing');
    fs.writeFileSync(path.join(fixture, 'packages', 'pi-host', 'patches', 'pi-coding-agent.patch'), 'fixture patch\n');
    expect(() => verifyCloudRuntimeLayout(fixture)).not.toThrow();
  });

  it('requires the runtime security patch referenced by the deployable manifest', () => {
    const fixture = createFixture();
    const manifestPath = path.join(fixture, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.patchedDependencies = { 'braces@3.0.3': 'bun-patches/braces@3.0.3.patch' };
    writeJson(manifestPath, manifest);
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow('Cloud runtime patch is missing');
    fs.mkdirSync(path.join(fixture, 'bun-patches'));
    fs.copyFileSync(path.join(repoRoot, 'bun-patches/braces@3.0.3.patch'), path.join(fixture, 'bun-patches/braces@3.0.3.patch'));
    expect(() => verifyCloudRuntimeLayout(fixture)).not.toThrow();
  });

  it('rejects workspace dependencies that are not shipped in the runtime', () => {
    const fixture = createFixture();
    const webManifestPath = path.join(fixture, 'packages', 'web', 'package.json');
    const webManifest = readJson(webManifestPath);
    webManifest.dependencies['@varin/missing-runtime'] = 'workspace:*';
    writeJson(webManifestPath, webManifest);

    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'depends on missing workspace @varin/missing-runtime',
    );
  });

  it('requires compiled package outputs and a production lockfile', () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture, 'packages', 'pi-host', 'dist'), { recursive: true, force: true });
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'Missing runtime package entry: packages/pi-host/dist',
    );

    const secondFixture = createFixture();
    fs.rmSync(path.join(secondFixture, 'bun.lock'));
    expect(() => verifyCloudRuntimeLayout(secondFixture)).toThrow(
      'Cloud runtime bun.lock is missing',
    );
  });

  it('requires the AGPL metadata and legal notices in deployable artifacts', () => {
    const missingLicense = createFixture();
    fs.rmSync(path.join(missingLicense, 'LICENSE'));
    expect(() => verifyCloudRuntimeLayout(missingLicense)).toThrow(
      'Cloud runtime legal file is missing: LICENSE',
    );

    const wrongSpdx = createFixture();
    const manifestPath = path.join(wrongSpdx, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.license = 'MIT';
    writeJson(manifestPath, manifest);
    expect(() => verifyCloudRuntimeLayout(wrongSpdx)).toThrow(
      'Unexpected cloud runtime license: MIT',
    );
  });

  it('rejects retired update services and commands from the staged production artifact', () => {
    const fixture = createFixture();
    const serverEntry = path.join(fixture, 'packages', 'web', 'server', 'package-manager.js');
    fs.writeFileSync(serverEntry, "export const updateUrl = 'https://api.openchamber.dev/v1/update/check';\n");

    expect(() => verifyCloudRuntimeIdentity(fixture)).toThrow(
      'Cloud runtime contains retired update identity',
    );
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'Cloud runtime contains retired update identity',
    );
  });
});

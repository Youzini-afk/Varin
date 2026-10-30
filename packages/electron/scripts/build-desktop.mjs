import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BuildCache } from '../../../scripts/build-cache.mjs';
import { repository, productRoot, prepareRuntime, prepareFrontend, prepareHost, prepareKernel, runBuild, resolveBunExecutable } from '../../../scripts/build-products.mjs';
import { stageRuntime } from './stage-runtime.mjs';
import { stageDesktopUi } from './build-web-assets.mjs';

/** One product preparation owner shared by local packaging and release jobs. */
export async function prepareDesktopProduct({ platform, architecture }) {
  const target = `${platform}-${architecture}`;
  const cache = new BuildCache(repository);
  const runtime = await prepareRuntime();
  const frontend = await prepareFrontend();
  if (platform === 'linux' && architecture === 'x64') {
    const guest = path.join(repository, 'packages/computer-driver/linux/guest-bundle-x64');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(guest, 'manifest.json'), 'utf8')); } catch { /* no attached guest */ }
    const { createHash } = await import('node:crypto');
    const attached = manifest?.sourceRevision === revision && manifest.sourceDirty === false
      && manifest.version === JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
    if (attached) {
      for (const [name, digest] of Object.entries(manifest.digests)) {
        const file = path.join(guest, name === 'runtime' ? 'runtime.tgz' : name);
        if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== digest) throw new Error('Attached VM guest integrity mismatch');
        if (name !== 'runtime') await fs.chmod(file, 0o755);
      }
    } else await cache.task('vm-guest-linux-x64', {
      inputs: ['packages', 'scripts', 'kernel', 'bun.lock', 'package.json'], values: { revision }, outputs: [guest],
      build() { runBuild('scripts/build-vm-guest-bundle.mjs'); },
    });
  }
  const host = await prepareHost();
  const kernel = await prepareKernel(platform, architecture);
  runBuild('packages/electron/scripts/prepare-native-runtime.mjs', [], { VARIN_TARGET_PLATFORM: platform, VARIN_TARGET_ARCH: architecture });
  const bundle = await cache.task(`desktop-bundle-${target}`, {
    inputs: ['package.json', 'bun.lock', 'tsconfig.base.json', 'packages/electron', 'packages/application-client/src', 'packages/ui/src', 'scripts/build-products.mjs', 'scripts/build-cache.mjs'],
    values: { runtime: runtime.digest, tools: runtime.values, updaterFixture: process.env.VARIN_UPDATER_E2E_BUILD ?? '' },
    outputs: [path.join(repository, 'packages/electron/dist-bundle')],
    build() { execFileSync(resolveBunExecutable(), ['run', '--cwd', 'packages/electron', 'bundle:main'], { cwd: repository, stdio: 'inherit', windowsHide: true }); },
  });
  const directory = path.join(productRoot, `desktop-${target}`, 'app');
  await cache.task(`desktop-runtime-${target}`, {
    inputs: ['package.json', 'bun.lock', 'bun-patches', 'packages/electron/package.json', 'packages/electron/bootstrap.mjs',
      'packages/electron/scripts/stage-runtime.mjs', 'packages/electron/scripts/node-module-file-policy.cjs',
      'packages/electron/scripts/prepare-trivium-runtime.mjs', 'packages/electron/scripts/patch-trivium-arm64-loader.mjs'],
    values: { platform, architecture, host: host.digest, bundle: bundle.digest, runtime: runtime.digest }, outputs: [directory],
    build() { return stageRuntime({ repository, destination: directory, hostDirectory: host.directory, platform, architecture }); },
  });
  const layout = JSON.parse(await fs.readFile(path.join(directory, 'runtime-layout.json'), 'utf8'));
  await stageDesktopUi(frontend.directory);
  const stagedKernel = path.join(repository, 'packages/electron/resources/kernel');
  await fs.rm(stagedKernel, { recursive: true, force: true });
  await fs.cp(kernel.directory, stagedKernel, { recursive: true });
  runBuild('packages/electron/scripts/verify-native.mjs', ['--web-root', path.join(directory, 'node_modules/@varin/web'), '--kernel-root', stagedKernel]);
  return { directory, unpackPatterns: layout.unpackPatterns };
}

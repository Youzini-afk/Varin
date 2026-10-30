import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BuildCache } from './build-cache.mjs';

export const repository = path.resolve(import.meta.dirname, '..');
export const productRoot = path.join(repository, 'artifacts/build');
const runtimePackages = ['settings-store', 'protocol', 'script-runtime', 'extension-contract', 'application-client',
  'extension-surface', 'extension-sdk', 'extension-builtins', 'extension-host', 'extension-loader'];
const cache = new BuildCache(repository);
export function resolveBunExecutable() {
  if (process.env.BUN) return process.env.BUN;
  if (process.env.npm_execpath && /^bun(?:\.exe)?$/u.test(path.basename(process.env.npm_execpath)) && existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  const installed = process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  return installed && existsSync(installed) ? installed : process.platform === 'win32' ? 'bun.exe' : 'bun';
}
const environment = { node: process.versions.node,
  get bun() { return execFileSync(resolveBunExecutable(), ['--version'], { encoding: 'utf8', windowsHide: true }).trim(); },
};
export const runBuild = (script, args = [], env = {}) => execFileSync(process.execPath, [path.join(repository, script), ...args], {
  cwd: repository, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true,
});
const bun = (args, env = {}) => execFileSync(resolveBunExecutable(), args, {
  cwd: repository, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true,
});
const sharedInputs = ['bun.lock', 'package.json', 'tsconfig.json', 'tsconfig.base.json', 'scripts/build-cache.mjs', 'scripts/build-products.mjs'];
const runtimeInputs = [...sharedInputs, 'bun-patches', ...runtimePackages.map(name => `packages/${name}`)];
const frontendInputs = [...sharedInputs, 'packages/ui', 'packages/web/src', 'packages/web/public',
  'packages/web/vite.config.ts', 'packages/web/package.json', 'packages/web/tsconfig.json', 'packages/web/index.html', 'packages/web/mobile.html',
  'packages/web/mini-chat.html', 'packages/web/companion.html', 'packages/web/postcss.config.js',
  ...runtimePackages.map(name => `packages/${name}`),
  ':(exclude)packages/web/public/companion-assets', ':(exclude)packages/web/public/companion-review-director'];
const frontendValues = () => ({ nodeMajor: environment.node.split('.')[0], bun: environment.bun, reactScan: process.env.VITE_ENABLE_REACT_SCAN ?? '',
  smoke: process.env.VARIN_MONACO_SMOKE ?? '', audit: process.env.VARIN_MONACO_BUNDLE_AUDIT ?? '', lowMemory: process.env.VARIN_LOW_MEMORY_BUILD ?? '' });

export function prepareRuntime() {
  return cache.task(`runtime-${process.platform}-${process.arch}`, {
    inputs: runtimeInputs, values: environment,
    outputs: runtimePackages.map(name => path.join(repository, 'packages', name, 'dist')),
    build() {
      for (const name of runtimePackages) bun(['run', '--cwd', `packages/${name}`, ['settings-store', 'protocol', 'script-runtime', 'extension-contract'].includes(name) ? 'build' : 'build:raw']);
    },
  });
}

export async function prepareFrontend({ importDirectory = process.env.VARIN_FRONTEND_ARTIFACT } = {}) {
  const destination = path.join(productRoot, 'frontend');
  const inputs = frontendInputs, values = frontendValues();
  // Shared UI transfers contain plain browser assets only, never a platform-specific Host or native library.
  if (importDirectory) {
    const result = await cache.restore('frontend', path.resolve(importDirectory), { inputs, values, output: destination });
    return { directory: destination, ...result };
  }
  const result = await cache.task('frontend', { inputs, values, outputs: [destination], async build() {
    await prepareRuntime();
    bun(['run', '--cwd', 'packages/web', 'vite', 'build', '--outDir', destination], { VARIN_PRODUCT_UI: '1', NODE_ENV: 'production' });
  } });
  return { directory: destination, ...result };
}

export async function exportFrontend(directory) {
  const built = await prepareFrontend();
  await cache.export('frontend', directory, built.directory);
}

export async function prepareHost() {
  const runtime = await prepareRuntime();
  const directory = path.join(productRoot, `host-${process.platform}-${process.arch}`, 'server');
  const result = await cache.task(`host-${process.platform}-${process.arch}`, {
    inputs: [...sharedInputs, 'packages/web/application-host', 'packages/web/scripts', 'packages/web/tsconfig.application-host.json',
      'packages/computer-driver', 'scripts/host-production-boundary.mjs', 'scripts/refresh-grammar-manifest.mjs'],
    values: { ...environment, platform: process.platform, arch: process.arch, runtime: runtime.digest }, outputs: [directory],
    build() { runBuild('packages/web/scripts/build-application-host.mjs', ['--output', directory]); },
  });
  return { directory, ...result };
}

export async function prepareKernel(platform = process.platform, arch = process.arch) {
  const directory = path.join(productRoot, `kernel-${platform}-${arch}`);
  const name = `kernel-${platform}-${arch}`;
  const prebuilt = process.env.VARIN_KERNEL_PREBUILT;
  if (prebuilt && process.env.VARIN_RELEASE_SOURCE_SHA) throw new Error('Release builds import a verified VARIN_KERNEL_ARTIFACT rather than an unproven prebuilt binary');
  const spec = {
    inputs: ['kernel', 'scripts/build-kernel.mjs', 'scripts/kernel-binary-identity.cjs', 'scripts/build-products.mjs', 'scripts/build-cache.mjs', 'packages/workspace-driver/macos'],
    values: { platform, arch, toolchain: await fs.readFile(path.join(repository, 'kernel/rust-toolchain.toml'), 'utf8'),
      overrideToolchain: process.env.RUSTUP_TOOLCHAIN ?? '', targetTriple: process.env.VARIN_TARGET_TRIPLE ?? '',
      buildIdentity: process.env.VARIN_KERNEL_BUILD_IDENTITY || JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version,
      prebuilt: prebuilt ? (await import('node:crypto')).createHash('sha256').update(await fs.readFile(path.resolve(prebuilt))).digest('hex') : null,
      profiles: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('CARGO_PROFILE_'))),
      rustflags: process.env.RUSTFLAGS ?? '', encodedRustflags: process.env.CARGO_ENCODED_RUSTFLAGS ?? '' },
    outputs: [directory], build() { runBuild('scripts/build-kernel.mjs', ['--platform', platform, '--arch', arch, '--stage', directory]); },
  };
  const result = process.env.VARIN_KERNEL_ARTIFACT
    ? await cache.restore(name, path.resolve(process.env.VARIN_KERNEL_ARTIFACT), { ...spec, output: directory })
    : await cache.task(name, spec);
  if (platform !== 'win32') await fs.chmod(path.join(directory, 'varin-kernel'), 0o755);
  return { directory, ...result };
}

export async function prepareWebProduct() {
  const host = await prepareHost();
  const frontend = await prepareFrontend();
  const kernel = await prepareKernel();
  const directory = path.join(productRoot, 'web');
  const cliDirectory = path.join(productRoot, 'cli');
  const cli = await cache.task('web-cli', {
    inputs: ['packages/web/cli', 'packages/web/tsconfig.cli.json', 'packages/web/scripts/build-cli.mjs'],
    values: { runtime: (await prepareRuntime()).digest }, outputs: [cliDirectory],
    build() { runBuild('packages/web/scripts/build-cli.mjs', ['--output', cliDirectory]); },
  });
  await cache.task(`web-product-${process.platform}-${process.arch}`, {
    inputs: ['scripts/build-products.mjs'], values: { host: host.digest, frontend: frontend.digest, kernel: kernel.digest, cli: cli.digest }, outputs: [directory],
    async build() {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true });
      for (const [name, source] of [['server', host.directory], ['dist', frontend.directory], ['kernel', kernel.directory], ['bin', cliDirectory]]) {
        await fs.cp(source, path.join(directory, name), { recursive: true });
      }
    },
  });
  return directory;
}

async function publishDirectory(source, destination) {
  try {
    if (await new BuildCache(source).outputs([source]) === await new BuildCache(destination).outputs([destination])) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = await fs.mkdtemp(path.join(productRoot, 'publish-'));
  const candidate = path.join(staging, 'candidate'), previous = path.join(staging, 'previous');
  let moved = false, preserveBackup = false;
  try {
    await fs.cp(source, candidate, { recursive: true });
    try { await fs.rename(destination, previous); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(candidate, destination); }
    catch (error) {
      if (moved) try { await fs.rename(previous, destination); }
      catch (recovery) { preserveBackup = true; throw new AggregateError([error, recovery], `Previous build retained at ${previous}`); }
      throw error;
    }
  } finally { if (!preserveBackup) await fs.rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'runtime') await prepareRuntime();
  else if (command === 'frontend') {
    const exportIndex = args.indexOf('--export');
    if (exportIndex >= 0) await exportFrontend(path.resolve(args[exportIndex + 1]));
    else {
      const frontend = await prepareFrontend();
      if (args.includes('--publish')) await publishDirectory(frontend.directory, path.join(repository, 'packages/web/dist'));
    }
  } else if (command === 'host') await prepareHost();
  else if (command === 'web') {
    const product = await prepareWebProduct();
    if (args.includes('--publish')) for (const name of ['server', 'dist', 'kernel', 'bin']) {
      await publishDirectory(path.join(product, name), path.join(repository, 'packages/web', name));
    }
  }
  else if (command === 'kernel') {
    const result = await prepareKernel();
    const exportIndex = args.indexOf('--export');
    if (exportIndex >= 0) await cache.export(`kernel-${process.platform}-${process.arch}`, path.resolve(args[exportIndex + 1]), result.directory);
  }
  else throw new Error('Usage: build-products.mjs runtime|frontend [--export directory]|host|kernel');
}

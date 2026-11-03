import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveCache, nodeTarget, stageNodeRuntime } from './node-runtime.mjs';
import { writeRuntimeManifest, verifyRuntimeManifest } from './runtime-manifest.mjs';
import { publishRuntime } from './publish-runtime.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
export const defaultRuntimeDirectory = (platform = process.platform, architecture = process.arch) =>
  path.join(repository, 'artifacts/build', `tauri-${platform}-${architecture}`, 'runtime');

export async function validateRuntimeDestination(destination) {
  destination = path.resolve(destination);
  const checkout = path.relative(destination, repository);
  if (!checkout || !checkout.startsWith(`..${path.sep}`) && checkout !== '..' && !path.isAbsolute(checkout)) {
    throw new Error('Runtime output cannot replace the checkout or one of its ancestors');
  }
  try {
    if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Runtime output must be an ordinary directory');
    if (!(await fs.readdir(destination)).length) return;
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'runtime-manifest.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.product !== 'varin-tauri-desktop') throw new Error('Output is not a managed desktop runtime');
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === destination) return;
    throw new Error(`Refusing to replace an unrelated output directory: ${destination}`, { cause: error });
  }
}

export async function stageDesktopRuntime({ platform = process.platform, architecture = process.arch,
  destination = defaultRuntimeDirectory(platform, architecture), nodeArchive,
  hostDirectory, frontendDirectory, kernelDirectory, legacyElectronDirectory } = {}) {
  nodeTarget(platform, architecture); // Reject unknown targets before any build or download.
  // Native Node-API dependencies and platform helpers are prepared on their real
  // target runner. A foreign archive does not make a cross-architecture Host safe.
  if (platform !== process.platform || architecture !== process.arch) throw new Error('Desktop runtime staging requires a matching native platform and architecture runner');
  destination = path.resolve(destination);
  await validateRuntimeDestination(destination);
  const { prepareHost, prepareFrontend, prepareKernel, runBuild } = await import('../../../scripts/build-products.mjs');
  const { stageRuntime } = await import('../../electron/scripts/stage-runtime.mjs');
  const { prepareRipgrep } = await import('../../../scripts/prepare-ripgrep.mjs');
  const { default: pruneTriviumRuntime } = await import('../../electron/scripts/prune-trivium-runtime.cjs');
  const { prepareCompanionCatalog, stageDesktopWebAsset } = await import('../../electron/scripts/companion-assets.mjs');
  const app = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const pin = nodeTarget(platform, architecture);
  // Fail fast for an absent or damaged Node archive before compiling a kernel.
  const archive = nodeArchive ? path.resolve(nodeArchive) : path.join(archiveCache, pin.archive);
  const { verifyNodeArchive } = await import('./node-runtime.mjs');
  await verifyNodeArchive(archive, pin).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Prepare the fixed Node archive first with packages/tauri/scripts/node-runtime.mjs fetch', { cause: error });
    throw error;
  });
  const host = hostDirectory ? { directory: path.resolve(hostDirectory) } : await prepareHost();
  const frontend = frontendDirectory ? { directory: path.resolve(frontendDirectory) } : await prepareFrontend();
  const kernel = kernelDirectory ? { directory: path.resolve(kernelDirectory) } : await prepareKernel(platform, architecture);
  for (const source of [host.directory, frontend.directory, kernel.directory]) {
    const relative = path.relative(destination, source);
    if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('A runtime source cannot be inside its publication destination');
  }
  runBuild('packages/electron/scripts/prepare-native-runtime.mjs', [], { VARIN_TARGET_PLATFORM: platform, VARIN_TARGET_ARCH: architecture });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), '.tauri-runtime-stage-'));
  const candidate = path.join(temporary, 'candidate');
  await fs.mkdir(candidate);
  try {
    const node = await stageNodeRuntime({ destination: path.join(candidate, 'node'), platform, architecture, archive });
    await stageRuntime({ repository, destination: path.join(candidate, 'host'), hostDirectory: host.directory, platform, architecture,
      appDirectory: path.join(repository, 'packages/tauri'), entries: [],
      manifest: { name: '@varin/tauri-host-runtime', version: app.version, private: true, type: 'module', license: app.license,
        dependencies: { '@varin/web': 'workspace:*' } },
    });
    pruneTriviumRuntime(path.join(candidate, 'host/node_modules'), platform, architecture);
    prepareRipgrep({ platform, arch: architecture, stage: path.join(candidate, 'tools') });
    await fs.cp(kernel.directory, path.join(candidate, 'kernel'), { recursive: true });
    await fs.cp(frontend.directory, path.join(candidate, 'frontend'), { recursive: true,
      filter: file => stageDesktopWebAsset(path.relative(frontend.directory, file)) });
    await prepareCompanionCatalog({ output: path.join(candidate, 'frontend/companion-catalog.json') });
    await fs.mkdir(path.join(candidate, 'legal'));
    for (const [source, name] of [['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
      ['kernel/THIRD_PARTY_NOTICES.md', 'kernel-third-party-notices.md'],
      ['packages/tauri/src-tauri/vendor/tauri-runtime-cef/LICENSE-MIT', 'tauri-runtime-cef-LICENSE-MIT'],
      ['packages/tauri/src-tauri/vendor/tauri-runtime-cef/VARIN-PATCH.md', 'tauri-runtime-cef-source.md']]) await fs.copyFile(path.join(repository, source), path.join(candidate, 'legal', name));
    const sourceSha = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const sourceDirty = Boolean((await import('node:child_process')).execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8' }).trim());
    const legacyElectron = legacyElectronDirectory ? await (await import('./legacy-runtime.mjs')).stageLegacyElectron({
      source: path.resolve(legacyElectronDirectory), destination: path.join(candidate, 'legacy-electron'), platform, architecture, version: app.version, sourceSha,
    }) : null;
    await writeRuntimeManifest(candidate, { platform, architecture, version: app.version, node, legacyElectron,
      sources: { sourceSha, sourceDirty, lockfileSha256: await (await import('./runtime-manifest.mjs')).sha256(path.join(repository, 'bun.lock')),
        host: host.digest ?? null, frontend: frontend.digest ?? null, kernel: kernel.digest ?? null } });
    // Verify after all copies and before publication. A failure leaves the last
    // complete generation intact, including its matching manifest and licenses.
    await verifyRuntimeManifest(candidate, { platform, architecture });
    await publishRuntime(candidate, destination);
    return { directory: destination, manifest: path.join(destination, 'runtime-manifest.json') };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--output': 'destination', '--node-archive': 'nodeArchive', '--host': 'hostDirectory',
      '--frontend': 'frontendDirectory', '--kernel': 'kernelDirectory', '--legacy-electron': 'legacyElectronDirectory', '--platform': 'platform', '--arch': 'architecture' }[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: stage-desktop.mjs [--output directory] [--node-archive file] [--host directory] [--frontend directory] [--kernel directory] [--platform platform] [--arch architecture]');
    options[key] = args[index + 1];
  }
  const result = await stageDesktopRuntime(options);
  console.log(`Staged development runtime: ${result.directory}`);
}

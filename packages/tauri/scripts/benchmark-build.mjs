/** Build the two FULL desktop products from one immutable checkout. The legacy
 * migration exporter is not, and can never stand in for, the Electron baseline. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashDirectory, hashFile, hashJson } from './benchmark-contract.mjs';
import { engineInventory, buildCandidate } from './build-candidate.mjs';
import { prepareLegacyExporter } from './prepare-exporter.mjs';
import { fetchNodeArchive } from './node-runtime.mjs';
import { stageDesktopRuntime } from './stage-desktop.mjs';
import { prepareFrontend } from '../../../scripts/build-products.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
function sourceIdentity() {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository, encoding: 'utf8', windowsHide: true }).trim()) throw new Error('Full-product A/B builds require immutable committed source');
  return sourceSha;
}
export async function locateElectronPayload(output, platform = process.platform) {
  const matches = [];
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const payload = path.join(output, entry.name, ...(platform === 'darwin' ? ['Varin.app'] : []));
    const relative = platform === 'darwin' ? 'Contents/MacOS/Varin' : platform === 'win32' ? 'Varin.exe' : 'varin';
    if (await fs.stat(path.join(payload, relative)).then(stat => stat.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; })) matches.push({ payload, executable: path.join(payload, relative),
      frontendDirectory: path.join(payload, platform === 'darwin' ? 'Contents/Resources/web-dist' : 'resources/web-dist') });
  }
  if (matches.length !== 1) throw new Error('Complete Electron --dir payload is missing or ambiguous');
  return matches[0];
}
export async function verifyElectronBaseline(file, { sourceSha, version, target }) {
  const baseline = JSON.parse(await fs.readFile(file, 'utf8'));
  if (baseline.schema !== 1 || baseline.product !== 'varin-electron-benchmark-baseline' || baseline.sourceSha !== sourceSha
    || baseline.version !== version || baseline.target !== target || baseline.buildMode !== 'normal-product-package-dir'
    || baseline.sourceDirty !== false) throw new Error('Electron baseline is not a complete same-source product build');
  if (hashJson(await engineInventory(baseline.payload)) !== hashJson(baseline.files)
    || await hashFile(baseline.executable) !== baseline.executableSha256
    || await hashDirectory(baseline.frontendDirectory) !== baseline.frontendSha256) throw new Error('Complete Electron baseline changed after packaging');
  return baseline;
}
export async function prepareElectronBaseline({ output, sourceSha = sourceIdentity(), frontendDirectory } = {}) {
  output = path.resolve(output); await fs.mkdir(output, { recursive: false });
  const version = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
  if (sourceIdentity() !== sourceSha) throw new Error('Baseline source changed');
  const builderOutput = path.join(output, 'builder');
  const flags = ['--dir', `--${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}`, `--${process.arch}`,
    '--publish=never', `--config.directories.output=${builderOutput}`, ...(process.platform === 'darwin' ? ['--varin-unsigned-mac'] : [])];
  execFileSync(process.execPath, [path.join(repository, 'packages/electron/scripts/package.mjs'), ...flags], {
    cwd: repository, stdio: 'inherit', windowsHide: true, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  const payload = await locateElectronPayload(builderOutput);
  const frontendSha256 = await hashDirectory(payload.frontendDirectory);
  if (frontendDirectory && frontendSha256 !== await hashDirectory(frontendDirectory)) throw new Error('Baseline did not retain the identical shared frontend product');
  const record = { schema: 1, product: 'varin-electron-benchmark-baseline', sourceSha, sourceDirty: false, version,
    target: `${process.platform}-${process.arch}`, buildMode: 'normal-product-package-dir', artifactKind: 'content-addressed-unpacked-complete-product',
    ...payload, executableSha256: await hashFile(payload.executable), frontendSha256, files: await engineInventory(payload.payload) };
  const artifact = path.join(output, 'electron-baseline.json'); await fs.writeFile(artifact, JSON.stringify(record, null, 2) + '\n');
  await verifyElectronBaseline(artifact, record);
  return { executable: payload.executable, frontendDirectory: payload.frontendDirectory, artifact };
}
export async function prepareBenchmarkPair({ output, cef = process.env.CEF_PATH, existingCandidate } = {}) {
  const sourceSha = sourceIdentity();
  if (!cef && !existingCandidate) throw new Error('Use the same explicitly pinned CEF SDK/cache as the native candidate build');
  output = path.resolve(output); await fs.mkdir(output, { recursive: false });
  let existing = null;
  if (existingCandidate) {
    const { verifyTauriBenchmarkCandidate } = await import('./benchmark-desktop.mjs');
    const version = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
    existing = await verifyTauriBenchmarkCandidate(path.resolve(existingCandidate), { sourceSha, version, target: `${process.platform}-${process.arch}` });
    const archive = existing.packaged?.update;
    if (!archive || await hashFile(path.join(existing.assets, archive.name)) !== archive.sha256) throw new Error('Existing candidate update artifact is missing or changed');
  }
  const frontend = existing ? { directory: path.join(existing.runtime, 'frontend') } : await prepareFrontend();
  const electron = await prepareElectronBaseline({ output: path.join(output, 'electron'), sourceSha, frontendDirectory: frontend.directory });
  let tauri = existing;
  if (!tauri) {
    const exporter = await prepareLegacyExporter(path.join(output, 'legacy-exporter'));
    const nodeArchive = await fetchNodeArchive();
    const runtime = path.join(output, 'runtime');
    await stageDesktopRuntime({ destination: runtime, nodeArchive, frontendDirectory: frontend.directory, legacyElectronDirectory: exporter });
    tauri = await buildCandidate({ runtime, output: path.join(output, 'tauri'), cef, mode: 'electron-to-tauri' });
  }
  if (tauri.sourceSha !== sourceSha || await hashDirectory(path.join(tauri.runtime, 'frontend')) !== await hashDirectory(electron.frontendDirectory)) throw new Error('A/B products do not bind the same immutable frontend and source');
  const pair = { schema: 1, product: 'varin-desktop-benchmark-pair', sourceSha, version: tauri.version, target: tauri.target, electron,
    tauri: { candidate: existingCandidate ? path.resolve(existingCandidate) : path.join(output, 'tauri/candidate.json') }, runtime: tauri.runtime };
  await fs.writeFile(path.join(output, 'pair.json'), JSON.stringify(pair, null, 2) + '\n');
  return pair;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), i = args.indexOf('--output');
  if (i < 0 || !args[i + 1]) throw new Error('Usage: benchmark-build.mjs --output NEW-DIR (requires the installed native build toolchain and CEF_PATH)');
  const candidate = args.indexOf('--candidate');
  if (candidate >= 0 && !args[candidate + 1]) throw new Error('--candidate requires the original candidate.json');
  await prepareBenchmarkPair({ output: args[i + 1], existingCandidate: candidate < 0 ? undefined : args[candidate + 1] });
}

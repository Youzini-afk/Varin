/** Collect already signed, separately accepted native builds. No rebuilding,
 * signing, publishing, or invented platform observations happen in this step. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { releaseTargets, recordArtifact, verifyCandidate } from './release.mjs';

function safeName(name) {
  if (typeof name !== 'string' || !name || /[\\/\x00-\x1f]/u.test(name) || name === '.' || name === '..') throw new Error('Unsafe collected artifact name');
  return name;
}
async function readJson(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error('Candidate input must be a regular file');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function collectCandidate({ inputs, acceptanceDirectory, output, sourceSha, toolingSha, version, transition, publicKey }) {
  if (JSON.stringify(Object.keys(inputs).sort()) !== JSON.stringify([...releaseTargets].sort())) throw new Error('Collection requires exactly six native candidate directories');
  output = path.resolve(output);
  if (await fs.lstat(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Collected output must be a new directory');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(output), '.tauri-collect-'));
  const copied = new Map();
  const copyRecord = async (directory, record) => {
    const name = safeName(record?.name), source = path.join(directory, name);
    if (!(await fs.lstat(source)).isFile()) throw new Error(`Collected artifact is not a regular file: ${name}`);
    const actual = await recordArtifact(source);
    if (actual.size !== record.size || actual.sha256 !== record.sha256 || record.sha512 && actual.sha512 !== record.sha512) throw new Error(`Collected artifact changed: ${name}`);
    if (copied.has(name)) {
      if (copied.get(name) !== actual.sha256) throw new Error(`Collected artifact names collide: ${name}`);
    } else {
      await fs.copyFile(source, path.join(temporary, name), fs.constants.COPYFILE_EXCL);
      copied.set(name, actual.sha256);
    }
    return { ...actual, ...(record.signature ? { signature: record.signature } : {}) };
  };
  try {
    const candidate = { schema: 1, product: 'varin-tauri-candidate', sourceSha, toolingSha, version, releaseRef: `v${version}`, transition, targets: {} };
    for (const target of releaseTargets) {
      const directory = path.resolve(inputs[target]), build = await readJson(path.join(directory, 'candidate.json'));
      const packaged = build.packaged;
      if (build.schema !== 1 || build.target !== target || build.sourceSha !== sourceSha || build.version !== version
        || packaged?.mode !== transition.mode || packaged?.schema !== 1 || packaged.product !== 'varin-tauri-packaged-candidate' || packaged.signed !== true
        || `${packaged.platform}-${packaged.architecture}` !== target || packaged.version !== version
        || packaged.runtimeManifestSha256 !== build.runtimeManifest?.sha256) throw new Error(`Native build is not the exact signed candidate: ${target}`);
      const assets = path.join(directory, 'assets');
      const runtimeManifest = await copyRecord(assets, build.runtimeManifest);
      const engineManifest = await copyRecord(assets, build.engineManifest);
      const update = await copyRecord(assets, packaged.update);
      const electron = [];
      for (const record of packaged.electron ?? []) electron.push(await copyRecord(assets, record));
      const acceptanceFile = path.join(acceptanceDirectory, `${target}.acceptance.json`);
      const receipt = await readJson(acceptanceFile);
      for (const result of receipt.results ?? []) await copyRecord(acceptanceDirectory, result.evidence);
      const acceptance = await copyRecord(acceptanceDirectory, await recordArtifact(acceptanceFile));
      candidate.targets[target] = { runtimeManifest, engineManifest, runtimeManifestSha256: runtimeManifest.sha256,
        engineManifestSha256: engineManifest.sha256, update, electron, acceptance };
    }
    await verifyCandidate(temporary, candidate, { publicKey });
    await fs.writeFile(path.join(temporary, 'tauri-candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, output);
    return candidate;
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = name => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]; };
  const inputs = {};
  for (let index = 0; index < args.length; index++) if (args[index] === '--input') {
    const value = args[++index] ?? '', separator = value.indexOf('=');
    const target = value.slice(0, separator), directory = value.slice(separator + 1);
    if (separator < 0 || !directory || inputs[target]) throw new Error('Use one --input TARGET=DIRECTORY per native target');
    inputs[target] = directory;
  }
  await collectCandidate({ inputs, output: get('--output'), acceptanceDirectory: get('--acceptance'), sourceSha: get('--source-sha'), toolingSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8' }).trim(),
    version: get('--version'), transition: { mode: get('--mode'), previousElectronVersion: get('--previous-electron'),
      previousTauriVersion: args.includes('--previous-tauri') ? get('--previous-tauri') : null,
      ...(args.includes('--legacy-bridge') ? { legacyBridge: await readJson(get('--legacy-bridge')) } : {}) }, publicKey: process.env.VARIN_TAURI_UPDATER_PUBLIC_KEY });
}

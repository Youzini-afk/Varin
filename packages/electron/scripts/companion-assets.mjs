import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
/** Artwork lives in its own repository; Varin pins one published commit and every file hash. */
const artworkRepository = 'Youzini-afk/Varin-companion-assets';
const packPath = 'pack/varin';
/** The small descriptors stay versioned with the player code that reads them; images are fetched. */
const descriptors = ['bundle.json', 'occlusion.json'];
const localPack = root => path.join(root, 'packages/web/public/companion-assets');
const lockFile = root => path.join(root, 'packages/web/companion-assets.lock.json');
const assetName = /^[\w.-]+\.(json|png)$/u;
const rawBase = lock => `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${lock.path}/`;

/** Keep the player and tiny catalog previews; art and developer reviews are optional downloads. */
export const stageDesktopWebAsset = relative => !['companion-assets', 'companion-review-director'].includes(relative.split(/[\\/]/u)[0]);

/** Every file of a complete pack, derived from the bundle and its matching alpha pages. */
function packFiles(bundleBytes, occlusionBytes) {
  const bundle = JSON.parse(bundleBytes);
  const occlusion = JSON.parse(occlusionBytes);
  if (occlusion.bundleSHA256 !== digest(bundleBytes)) throw new Error('Companion occlusion pages do not match the current bundle');
  const names = new Set([...descriptors, bundle.worldStool.file]);
  for (const item of bundle.packages) for (const page of item.pages) names.add(page.file);
  for (const page of Object.values(occlusion.pages)) names.add(page.file);
  for (const name of names) if (!assetName.test(name)) throw new Error(`Invalid companion asset name: ${name}`);
  return [...names].sort();
}

export async function readCompanionLock(repoRoot = repository) {
  const lock = JSON.parse(await fs.readFile(lockFile(repoRoot), 'utf8'));
  if (lock.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+$/u.test(lock.repository) || !/^[a-f0-9]{40}$/u.test(lock.commit)
    || !/^[\w-]+(?:\/[\w-]+)*$/u.test(lock.path) || !Array.isArray(lock.files) || !lock.files.every(file => assetName.test(file.path)
      && Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256))) {
    throw new Error('Invalid companion artwork lock');
  }
  return lock;
}

export async function prepareCompanionCatalog({ repoRoot = repository, output } = {}) {
  const lock = await readCompanionLock(repoRoot);
  const [bundleBytes, occlusionBytes] = await Promise.all(descriptors.map(name => fs.readFile(path.join(localPack(repoRoot), name))));
  const names = packFiles(bundleBytes, occlusionBytes);
  const locked = new Map(lock.files.map(file => [file.path, file]));
  if (names.length !== locked.size || names.some(name => !locked.has(name))) {
    throw new Error('The companion artwork lock does not list exactly the files the bundle needs');
  }
  for (const [name, bytes] of [['bundle.json', bundleBytes], ['occlusion.json', occlusionBytes]]) {
    if (locked.get(name).sha256 !== digest(bytes)) throw new Error(`${name} differs from the locked companion artwork; publish the pack and refresh the lock`);
  }
  const files = names.map(name => { const file = locked.get(name); return { path: file.path, bytes: file.bytes, sha256: file.sha256 }; });
  const catalog = { schemaVersion: 1, packs: [{ id: 'varin', name: 'Varin',
    version: digest(JSON.stringify(files)), bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    baseUrl: rawBase(lock), files,
  }] };
  const destination = output ?? path.join(repoRoot, 'packages/electron/resources/web-dist/companion-catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}

/** Committed bytes, exactly as the published repository serves them (no working-tree line-ending filters). */
const committedBlob = (checkout, commit, name, directory = packPath) => execFileSync('git', ['cat-file', 'blob', `${commit}:${directory}/${name}`], {
  cwd: checkout, maxBuffer: 256 * 1024 * 1024, windowsHide: true,
});

/** Pin the pack at a pushed commit of an artwork checkout and copy its descriptors beside the player. */
export async function lockCompanionPack({ assets, repoRoot = repository }) {
  const git = (...args) => execFileSync('git', args, { cwd: assets, encoding: 'utf8', windowsHide: true }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (!git('branch', '--remotes', '--contains', commit)) throw new Error(`Push ${commit} first; installed apps download from the published repository`);
  const [bundleBytes, occlusionBytes] = descriptors.map(name => committedBlob(assets, commit, name));
  const files = packFiles(bundleBytes, occlusionBytes).map(name => {
    const bytes = committedBlob(assets, commit, name);
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  });
  await fs.mkdir(localPack(repoRoot), { recursive: true });
  await fs.writeFile(path.join(localPack(repoRoot), 'bundle.json'), bundleBytes);
  await fs.writeFile(path.join(localPack(repoRoot), 'occlusion.json'), occlusionBytes);
  const lock = { schemaVersion: 1, repository: artworkRepository, commit, path: packPath, files };
  await fs.writeFile(lockFile(repoRoot), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/**
 * Fill the development public directory with the locked pack. Missing files are fetched from a local
 * artwork checkout (VARIN_COMPANION_ASSETS) or the published repository; differing files are left alone.
 */
export async function fetchCompanionPack({ repoRoot = repository, assets = process.env.VARIN_COMPANION_ASSETS, request = fetch } = {}) {
  const lock = await readCompanionLock(repoRoot);
  const target = localPack(repoRoot);
  await fs.mkdir(target, { recursive: true });
  const differing = []; let fetched = 0;
  for (const file of lock.files) {
    const filename = path.join(target, file.path);
    const existing = await fs.readFile(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) { if (digest(existing) !== file.sha256) differing.push(file.path); continue; }
    let bytes;
    if (assets) bytes = committedBlob(path.resolve(assets), lock.commit, file.path, lock.path);
    else {
      const url = new URL(file.path, rawBase(lock));
      const response = await request(url);
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`${file.path} does not match the companion artwork lock`);
    await fs.writeFile(`${filename}.partial`, bytes);
    await fs.rename(`${filename}.partial`, filename);
    fetched += 1;
  }
  if (differing.length) throw new Error(`Local companion files differ from the lock and were left untouched: ${differing.join(', ')}`);
  return { fetched, present: lock.files.length - fetched };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, assets] = process.argv.slice(2);
  if (command === 'fetch') {
    const { fetched, present } = await fetchCompanionPack();
    console.log(`[companion] ${fetched} fetched, ${present} already present`);
  } else if (command === 'lock' && assets) {
    const lock = await lockCompanionPack({ assets: path.resolve(assets) });
    console.log(`[companion] locked ${lock.files.length} files at ${lock.repository}@${lock.commit}`);
  } else {
    console.error('Usage: companion-assets.mjs fetch | lock <Varin-companion-assets checkout>');
    process.exitCode = 2;
  }
}

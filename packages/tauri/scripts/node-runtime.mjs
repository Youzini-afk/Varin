import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readBinaryIdentity, sha256, targets } from './runtime-manifest.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
export const archiveCache = path.join(repository, 'artifacts/tauri/node');
export const nodeLock = JSON.parse(await fs.readFile(new URL('./node-runtime.lock.json', import.meta.url), 'utf8'));

export function nodeTarget(platform, architecture, lock = nodeLock) {
  const target = `${platform}-${architecture}`;
  const pin = lock.targets?.[target];
  const os = platform === 'win32' ? 'win' : platform;
  const archive = `node-v${lock.version}-${os}-${architecture}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  if (lock.schema !== 1 || !/^24\.\d+\.\d+$/u.test(lock.version) || !targets.includes(target)
    || pin?.archive !== archive || !/^[a-f0-9]{64}$/u.test(pin.sha256)) throw new Error(`Missing or invalid fixed Node target: ${target}`);
  return { ...pin, version: lock.version, url: `https://nodejs.org/dist/v${lock.version}/${archive}` };
}

export async function verifyNodeArchive(archive, pin) {
  if (!(await fs.lstat(archive)).isFile()) throw new Error('Node archive must be a regular file');
  if (await sha256(archive) !== pin.sha256) throw new Error(`Node archive SHA256 mismatch: ${path.basename(archive)}`);
}

/** Explicit build-machine operation only. Neither staging nor the installed app downloads Node. */
export async function fetchNodeArchive({ platform = process.platform, architecture = process.arch, cache = archiveCache } = {}) {
  const pin = nodeTarget(platform, architecture);
  await fs.mkdir(cache, { recursive: true });
  const destination = path.join(cache, pin.archive);
  try { await verifyNodeArchive(destination, pin); return destination; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = await fs.mkdtemp(path.join(cache, '.node-download-'));
  const archive = path.join(temporary, pin.archive);
  try {
    const response = await fetch(pin.url, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`Node artifact download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));
    await verifyNodeArchive(archive, pin);
    await fs.rename(archive, destination);
    return destination;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function stageNodeRuntime({ destination, platform = process.platform, architecture = process.arch,
  archive = path.join(archiveCache, nodeTarget(platform, architecture).archive), lock = nodeLock } = {}) {
  const pin = nodeTarget(platform, architecture, lock);
  try { await verifyNodeArchive(archive, pin); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Node archive is not prepared: ${archive}. Run node packages/tauri/scripts/node-runtime.mjs fetch --platform ${platform} --arch ${architecture} on the build machine first.`, { cause: error });
    throw error;
  }
  const root = `node-v${pin.version}-${platform === 'win32' ? 'win' : platform}-${architecture}`;
  const executable = platform === 'win32' ? 'node.exe' : 'bin/node';
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('Node staging requires an empty destination');
  const output = path.join(destination, platform === 'win32' ? 'node.exe' : 'node');
  // Read only the two named regular-file payloads from a checksum-verified official
  // distribution. npm, corepack, headers and archive path metadata never get installed.
  try {
    if (platform === 'win32') {
      const require = createRequire(new URL('../../web/package.json', import.meta.url));
      const Zip = require('adm-zip');
      const zip = new Zip(archive);
      for (const [entryName, target] of [[`${root}/${executable}`, output], [`${root}/LICENSE`, path.join(destination, 'LICENSE')]]) {
        const matches = zip.getEntries().filter(entry => entry.entryName === entryName);
        if (matches.length !== 1 || matches[0].isDirectory) throw new Error(`Missing or duplicate Node archive entry: ${entryName}`);
        await fs.writeFile(target, matches[0].getData(), { flag: 'wx' });
      }
    } else {
      for (const [entryName, target] of [[`${root}/${executable}`, output], [`${root}/LICENSE`, path.join(destination, 'LICENSE')]]) {
        const handle = await fs.open(target, 'wx');
        try { execFileSync('tar', ['-xOf', path.resolve(archive), entryName], { stdio: ['ignore', handle.fd, 'pipe'], windowsHide: true }); }
        finally { await handle.close(); }
      }
      await fs.chmod(output, 0o755);
    }
    const binary = await readBinaryIdentity(output);
    if (binary.platform !== platform || binary.arch !== architecture) throw new Error('Node binary architecture does not match its distribution');
    if (!(await fs.stat(path.join(destination, 'LICENSE'))).size) throw new Error('Node distribution license is empty');
    if (platform === process.platform && architecture === process.arch) {
      const env = { ...process.env };
      delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
      const version = execFileSync(output, ['--version'], { encoding: 'utf8', env, windowsHide: true, timeout: 30_000 }).trim();
      if (version !== `v${pin.version}`) throw new Error(`Node version mismatch: ${version}`);
    }
    return { version: pin.version, archive: pin.archive, sourceSha256: pin.sha256, source: pin.url };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = { '--platform': 'platform', '--arch': 'architecture', '--cache': 'cache' }[args[index]];
    if (!key || !args[index + 1]) throw new Error('Usage: node-runtime.mjs fetch [--platform darwin|linux|win32] [--arch x64|arm64] [--cache directory]');
    options[key] = args[index + 1];
  }
  if (command !== 'fetch') throw new Error('Node fetching is an explicit build-only command: node-runtime.mjs fetch');
  console.log(await fetchNodeArchive(options));
}

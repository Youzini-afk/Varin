/**
 * The official cef-rs 156.3.0 sandbox bundle layout, with our Cargo lib name
 * explicitly mapped to the bootstrap executable's stem. No unsandboxed fallback.
 * Upstream: cef/src/build_util/win/mod.rs (MIT OR Apache-2.0).
 */
import fs from 'node:fs/promises';
import { pinnedCefLicense } from './cef-license.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, relativePath, sha256 } from './runtime-manifest.mjs';

const cefLock = JSON.parse(await fs.readFile(new URL('./cef-runtime.lock.json', import.meta.url), 'utf8'));
export const cefVersion = cefLock.version;
export const windowsArchives = Object.freeze(Object.fromEntries(
  [['x64', 0x8664], ['arm64', 0xaa64]].map(([architecture, machine]) => {
    const pin = cefLock.targets[`win32-${architecture}`];
    return [architecture, Object.freeze({ name: `cef_binary_${cefVersion}_${pin.upstream}_minimal.tar.bz2`, sha1: pin.sha1, machine })];
  }),
));

const receiptName = 'cef-runtime-manifest.json';

async function regular(file) {
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Expected a regular build input: ${file}`);
  return metadata;
}
async function readAt(handle, offset, length, size) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size || length > 16 * 1024 * 1024) throw new Error('Invalid PE range');
  const bytes = Buffer.alloc(length);
  const result = await handle.read(bytes, 0, length, offset);
  if (result.bytesRead !== length) throw new Error('Truncated PE input');
  return bytes;
}
/** Inspect PE headers and exports without loading/executing foreign binaries. */
export async function inspectPortableExecutable(file) {
  const stat = await regular(file);
  const handle = await fs.open(file, 'r');
  try {
    const dos = await readAt(handle, 0, 64, stat.size);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Input is not a Windows executable');
    const peOffset = dos.readUInt32LE(0x3c);
    const header = await readAt(handle, peOffset, 24, stat.size);
    if (header.readUInt32LE(0) !== 0x4550) throw new Error('Invalid PE signature');
    const machine = header.readUInt16LE(4), count = header.readUInt16LE(6), optionalSize = header.readUInt16LE(20);
    if (count < 1 || count > 96 || optionalSize < 120) throw new Error('Invalid PE section metadata');
    const optional = await readAt(handle, peOffset + 24, optionalSize, stat.size);
    if (optional.readUInt16LE(0) !== 0x20b) throw new Error('CEF desktop requires a 64-bit PE image');
    const sectionBytes = await readAt(handle, peOffset + 24 + optionalSize, count * 40, stat.size);
    const sections = Array.from({ length: count }, (_, index) => {
      const offset = index * 40;
      return { virtualSize: sectionBytes.readUInt32LE(offset + 8), address: sectionBytes.readUInt32LE(offset + 12), size: sectionBytes.readUInt32LE(offset + 16), offset: sectionBytes.readUInt32LE(offset + 20) };
    });
    const physical = (rva, length) => {
      const section = sections.find(section => rva >= section.address && rva - section.address + length <= section.size);
      if (!section) throw new Error('PE export points outside a file-backed section');
      return section.offset + rva - section.address;
    };
    const names = [];
    if (optional.readUInt32LE(108) > 0 && optional.readUInt32LE(112) !== 0) {
      const exports = await readAt(handle, physical(optional.readUInt32LE(112), 40), 40, stat.size);
      const count = exports.readUInt32LE(24), table = exports.readUInt32LE(32);
      if (count > 65536) throw new Error('Unreasonable PE export table');
      const pointers = await readAt(handle, physical(table, count * 4), count * 4, stat.size);
      for (let index = 0; index < count; index += 1) {
        const nameOffset = physical(pointers.readUInt32LE(index * 4), 1);
        const bytes = await readAt(handle, nameOffset, Math.min(256, stat.size - nameOffset), stat.size);
        const end = bytes.indexOf(0);
        if (end < 0) throw new Error('Unterminated PE export name');
        names.push(bytes.toString('ascii', 0, end));
      }
    }
    return { machine, dll: (header.readUInt16LE(22) & 0x2000) !== 0, exports: names, dllCharacteristics: optional.readUInt16LE(70) };
  } finally { await handle.close(); }
}

export async function resolveCefDirectory(configured, architecture) {
  if (!configured) throw new Error('CEF_PATH is required for the sandboxed Windows bootstrap stage');
  const lock = windowsArchives[architecture];
  if (!lock) throw new Error('Windows CEF supports only x64 and arm64');
  const root = path.resolve(configured);
  const candidates = [root, path.join(root, cefVersion.split('+')[0], `cef_windows_${architecture === 'x64' ? 'x86_64' : 'aarch64'}`), path.join(root, `cef_windows_${architecture === 'x64' ? 'x86_64' : 'aarch64'}`)];
  for (const candidate of candidates) {
    try {
      const receipt = JSON.parse(await fs.readFile(path.join(candidate, 'archive.json'), 'utf8'));
      if (receipt.name === lock.name && receipt.sha1 === lock.sha1 && receipt.type === 'minimal') return candidate;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('CEF_PATH has no pinned download-cef archive receipt');
}

/** Find the exact SDK produced by the preceding native Cargo build. */
export async function discoverWindowsCef({ configured, targetDirectory, architecture }) {
  if (configured) return resolveCefDirectory(configured, architecture);
  const build = path.join(targetDirectory, 'build');
  const candidates = [];
  for (const entry of await fs.readdir(build, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('cef-dll-sys-')) continue;
    const out = path.join(build, entry.name, 'out');
    try {
      const directory = await resolveCefDirectory(out, architecture);
      const receipt = JSON.parse(await fs.readFile(path.join(directory, 'archive.json'), 'utf8'));
      if (receipt.name === windowsArchives[architecture]?.name && receipt.sha1 === windowsArchives[architecture]?.sha1) candidates.push(directory);
    } catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
  }
  if (candidates.length !== 1) throw new Error('Set CEF_PATH to the exact pinned SDK when Cargo has zero or multiple CEF build generations');
  return candidates[0];
}

/** Build a private runnable directory. No Cargo executable is modified here. */
export async function stageWindowsBootstrap({ cefDirectory, targetDirectory, destination, architecture }) {
  const lock = windowsArchives[architecture];
  if (!lock) throw new Error('Windows CEF supports only x64 and arm64');
  cefDirectory = await resolveCefDirectory(cefDirectory, architecture);
  targetDirectory = path.resolve(targetDirectory); destination = path.resolve(destination);
  if (destination === targetDirectory || destination === cefDirectory) throw new Error('Bootstrap staging requires its own output directory');
  const archive = JSON.parse(await fs.readFile(path.join(cefDirectory, 'archive.json'), 'utf8'));
  if (archive.name !== lock.name || archive.type !== 'minimal' || archive.sha1 !== lock.sha1) throw new Error('CEF SDK does not match the pinned Windows target/version');
  // download-cef flattens Release/Resources. Also accept the official unflattened
  // archive layout, without guessing any binary from the system installation.
  const release = await fs.stat(path.join(cefDirectory, 'Release')).then(stat => stat.isDirectory() ? path.join(cefDirectory, 'Release') : cefDirectory).catch(() => cefDirectory);
  const resources = await fs.stat(path.join(cefDirectory, 'Resources')).then(stat => stat.isDirectory() ? path.join(cefDirectory, 'Resources') : cefDirectory).catch(() => cefDirectory);
  const bootstrap = path.join(release, 'bootstrap.exe');
  const library = path.join(targetDirectory, 'varin_desktop.dll');
  const [hostIdentity, appIdentity] = await Promise.all([inspectPortableExecutable(bootstrap), inspectPortableExecutable(library)]);
  if (hostIdentity.machine !== lock.machine || hostIdentity.dll || appIdentity.machine !== lock.machine || !appIdentity.dll) throw new Error('Bootstrap and application DLL must match the native Windows architecture');
  if (!appIdentity.exports.includes('RunWinMain')) throw new Error('Application DLL does not export the CEF sandbox bootstrap entry');
  if ((appIdentity.dllCharacteristics & 0x140) !== 0x140) throw new Error('Application DLL must retain ASLR and non-executable data protection');
  const sources = new Map();
  for (const directory of new Set([cefDirectory, release, resources])) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === 'archive.json' || entry.name === 'bootstrap.exe') continue;
      if (!/\.(?:dll|pak|bin|dat|json)$/iu.test(entry.name) && !['LICENSE.txt', 'CREDITS.html', 'chrome_crashpad_handler.exe', 'crashpad_handler.exe'].includes(entry.name)) continue;
      if (sources.has(entry.name) && sources.get(entry.name) !== path.join(directory, entry.name)) throw new Error(`Ambiguous CEF runtime file: ${entry.name}`);
      sources.set(entry.name, path.join(directory, entry.name));
    }
  }
  sources.set('LICENSE.txt', await pinnedCefLicense(cefDirectory));
  const required = ['libcef.dll', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'v8_context_snapshot.bin', 'LICENSE.txt', 'CREDITS.html'];
  for (const name of required) if (!sources.has(name)) throw new Error(`CEF runtime is incomplete: ${name}`);
  const locales = path.join(resources, 'locales');
  await regular(path.join(locales, 'en-US.pak'));
  // Stage into a new generation; failure never replaces a runnable generation.
  await fs.mkdir(destination, { recursive: false });
  try {
    for (const [name, source] of sources) { await regular(source); await fs.copyFile(source, path.join(destination, name)); }
    await fs.mkdir(path.join(destination, 'locales'));
    for (const name of await fs.readdir(locales)) {
      if (!name.endsWith('.pak')) continue;
      await regular(path.join(locales, name)); await fs.copyFile(path.join(locales, name), path.join(destination, 'locales', name));
    }
    // bootstrap.exe derives its DLL filename from its own executable stem.
    await fs.copyFile(library, path.join(destination, 'varin.dll'));
    await fs.copyFile(bootstrap, path.join(destination, 'varin.exe'));
    await fs.copyFile(new URL('../src-tauri/windows/bootstrap.exe.manifest', import.meta.url), path.join(destination, 'varin.exe.manifest'));
    await fs.copyFile(new URL('../src-tauri/windows/CEF-RS-LICENSE-MIT', import.meta.url), path.join(destination, 'CEF-RS-LICENSE-MIT'));
    const receipt = { schema: 1, engine: 'CEF', cefVersion, architecture, sandbox: 'required',
      executable: 'varin.exe', applicationLibrary: 'varin.dll', entry: 'RunWinMain',
      sourceLibrary: { name: 'varin_desktop.dll', sha256: await sha256(library) },
      sdk: { archive: archive.name, archiveSha1: archive.sha1, receipt: 'download-cef/archive.json' },
      files: await inventory(destination) };
    await fs.writeFile(path.join(destination, 'cef-runtime-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { directory: destination, executable: path.join(destination, 'varin.exe'), receipt };
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
}

/** Validate the entire immutable generation, including the executable. */
export async function verifyWindowsBootstrap(stageDirectory) {
  stageDirectory = path.resolve(stageDirectory);
  await regular(path.join(stageDirectory, receiptName));
  const receipt = JSON.parse(await fs.readFile(path.join(stageDirectory, receiptName), 'utf8'));
  const lock = windowsArchives[receipt.architecture];
  if (!lock || receipt.schema !== 1 || receipt.engine !== 'CEF' || receipt.cefVersion !== cefVersion
    || receipt.executable !== 'varin.exe' || receipt.sandbox !== 'required' || receipt.applicationLibrary !== 'varin.dll'
    || receipt.entry !== 'RunWinMain' || receipt.sdk?.archive !== lock.name || receipt.sdk?.archiveSha1 !== lock.sha1
    || !Array.isArray(receipt.files)) throw new Error('A verified Windows bootstrap stage is required');
  const expected = new Map();
  for (const file of receipt.files) {
    relativePath(file.path);
    if (file.path === receiptName || expected.has(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid bootstrap file inventory');
    expected.set(file.path, file);
  }
  for (const name of ['varin.exe', 'varin.dll', 'libcef.dll', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak', 'LICENSE.txt', 'CREDITS.html']) {
    if (!expected.has(name)) throw new Error(`Missing bootstrap runtime file: ${name}`);
  }
  if (await fs.lstat(path.join(stageDirectory, 'runtime-manifest.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Unexpected runtime manifest in a CEF stage');
  const actual = (await inventory(stageDirectory)).filter(file => file.path !== receiptName);
  if (actual.length !== expected.size || actual.some(file => file.sha256 !== expected.get(file.path)?.sha256 || file.size !== expected.get(file.path)?.size)) {
    throw new Error('CEF bootstrap stage integrity changed');
  }
  return receipt;
}

/**
 * Sign only our application DLL, then the actual bootstrap EXE, and reseal the
 * byte inventory. A caller supplies its already-authorized signing and signature
 * verification operations. This does not claim a synthetic receipt is a valid
 * Authenticode signature, and does not overwrite upstream CEF signatures.
 */
export async function signWindowsBootstrap(stageDirectory, { sign, verifySignature }) {
  if (typeof sign !== 'function' || typeof verifySignature !== 'function') throw new Error('Signing requires both a signer and an actual signature verifier');
  const receipt = await verifyWindowsBootstrap(stageDirectory);
  const signed = new Set(['varin.dll', 'varin.exe']);
  for (const name of signed) {
    const file = path.join(stageDirectory, name);
    await sign(file);
    if (await verifySignature(file) !== true) throw new Error(`Authenticode verification failed: ${name}`);
    const identity = await inspectPortableExecutable(file);
    if (identity.machine !== windowsArchives[receipt.architecture].machine || identity.dll !== name.endsWith('.dll')
      || (name.endsWith('.dll') && !identity.exports.includes('RunWinMain'))) throw new Error('Signing changed the bootstrap identity');
  }
  const actual = (await inventory(stageDirectory)).filter(file => file.path !== receiptName);
  const before = new Map(receipt.files.map(file => [file.path, file]));
  if (actual.length !== before.size || actual.some(file => !before.has(file.path)
    || (!signed.has(file.path) && file.sha256 !== before.get(file.path).sha256))) throw new Error('Signing changed unrelated runtime bytes');
  const updated = { ...receipt, signing: { application: 'verified', order: ['varin.dll', 'varin.exe'] }, files: actual };
  const temporary = path.join(stageDirectory, `${receiptName}.${process.pid}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(updated, null, 2) + '\n'); await fs.rename(temporary, path.join(stageDirectory, receiptName)); }
  finally { await fs.rm(temporary, { force: true }); }
  await verifyWindowsBootstrap(stageDirectory);
  return updated;
}

/** Map a staged SDK beside the final exe, where the Windows loader requires it. */
export async function windowsBundleResources(stageDirectory) {
  stageDirectory = path.resolve(stageDirectory);
  const receipt = await verifyWindowsBootstrap(stageDirectory);
  return Object.fromEntries([
    ...receipt.files.filter(file => file.path !== 'varin.exe').map(file => [path.join(stageDirectory, file.path), file.path]),
    [path.join(stageDirectory, receiptName), receiptName],
  ]);
}

/** Install the validated main binary only after Cargo has finished, before bundle. */
export async function installBootstrapForBundle(stageDirectory, targetDirectory) {
  await windowsBundleResources(stageDirectory);
  const receipt = JSON.parse(await fs.readFile(path.join(stageDirectory, 'cef-runtime-manifest.json'), 'utf8'));
  const source = path.join(stageDirectory, 'varin.exe');
  const expected = receipt.files.find(file => file.path === 'varin.exe');
  if (!expected || await sha256(source) !== expected.sha256) throw new Error('Bootstrap executable integrity changed');
  const target = path.join(path.resolve(targetDirectory), 'varin.exe');
  const temporary = target + `.bootstrap-${process.pid}`;
  try { await fs.copyFile(source, temporary); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(process.argv.slice(2).reduce((entries, value, index, args) => {
    if (index % 2 === 0) { if (!['--cef', '--target-directory', '--output', '--arch'].includes(value) || !args[index + 1]) throw new Error('Usage: windows-bootstrap.mjs --cef SDK --target-directory cargo-profile --output new-directory --arch x64|arm64'); entries.push([value, args[index + 1]]); } return entries;
  }, []));
  const result = await stageWindowsBootstrap({ cefDirectory: options['--cef'] ?? process.env.CEF_PATH, targetDirectory: options['--target-directory'], destination: options['--output'], architecture: options['--arch'] ?? process.arch });
  console.log(`[tauri] Sandboxed Windows executable: ${result.executable}`);
}

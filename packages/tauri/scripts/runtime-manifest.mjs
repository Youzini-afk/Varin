import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import identity from '../../../scripts/kernel-binary-identity.cjs';

export const manifestName = 'runtime-manifest.json';
export const targets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
export const hostPackage = 'host/node_modules/@varin/web';
export const hostEntry = `${hostPackage}/server/desktop-host.js`;
export const hostSettingsEntry = `${hostPackage}/server/desktop-settings.js`;
export const hostBrowserEntry = `${hostPackage}/server/desktop-browser.js`;
export const requiredHostAssets = [
  'host/node_modules/@varin/script-runtime/dist/index.js',
  'host/node_modules/@varin/script-runtime/dist/worker.js',
  'host/node_modules/@varin/extension-host/dist/index.js',
  'host/node_modules/@varin/extension-host/broker/broker-child.mjs',
  'host/node_modules/@varin/protocol/dist/node/runtime.js',
  'host/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'host/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'host/node_modules/pdfjs-dist/cmaps/Adobe-GB1-0.bcmap',
  'host/node_modules/pdfjs-dist/standard_fonts/FoxitDingbats.pfb',
  'host/node_modules/pdfjs-dist/wasm/openjpeg.wasm',
  'host/node_modules/pdfjs-dist/wasm/qcms_bg.wasm',
  `${hostPackage}/server/lib/structure/grammar-packs.json`,
  `${hostPackage}/server/lib/structure/runtime/web-tree-sitter.wasm`,
];
export const legalPaths = ['legal/LICENSE', 'legal/THIRD_PARTY_NOTICES.md', 'legal/kernel-third-party-notices.md', 'node/LICENSE',
  'legal/tauri-runtime-cef-LICENSE-MIT', 'legal/tauri-runtime-cef-source.md',
  'tools/ripgrep-LICENSE', 'tools/ripgrep-MIT-LICENSE.txt', 'tools/pcre2-LICENSE.txt'];
const hashPattern = /^[a-f0-9]{64}$/u;
export const kernelProtocolVersion = JSON.parse(await fs.readFile(new URL('../../../kernel/protocol/schema.json', import.meta.url), 'utf8')).protocolVersion;

export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\0-\x1f:]/u.test(value)
    || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid runtime relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(directory) {
  const files = [];
  const visit = async relative => {
    const absolute = path.join(directory, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Runtime cannot contain a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(absolute)).sort()) await visit(relative ? `${relative}/${entry}` : entry);
    } else if (stat.isFile()) {
      relativePath(relative);
      if (relative !== manifestName) files.push({ path: relative, size: stat.size, sha256: await sha256(absolute), executable: (stat.mode & 0o111) !== 0 });
    } else throw new Error(`Runtime cannot contain a special file: ${relative}`);
  };
  await visit('');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function readBinaryIdentity(file) {
  // PE's DOS header locates its own machine field. Avoid reading an entire kernel
  // into memory just to inspect a header, and never execute a foreign executable.
  const handle = await fs.open(file, 'r');
  try {
    let bytes = Buffer.alloc(64);
    const first = await handle.read(bytes, 0, bytes.length, 0);
    bytes = bytes.subarray(0, first.bytesRead);
    if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
      const offset = bytes.readUInt32LE(0x3c);
      const stat = await handle.stat();
      if (offset + 6 > stat.size || offset > 1024 * 1024) throw new Error('Invalid executable PE header offset');
      const header = Buffer.alloc(offset + 6);
      const result = await handle.read(header, 0, header.length, 0);
      bytes = header.subarray(0, result.bytesRead);
    }
    return identity.detectKernelBinaryIdentity(bytes);
  } finally { await handle.close(); }
}

export async function writeRuntimeManifest(directory, { platform, architecture, version, node, sources = {}, browser = null, legacyElectron = null }) {
  if (!targets.includes(`${platform}-${architecture}`)) throw new Error(`Unsupported runtime target ${platform}/${architecture}`);
  const executable = platform === 'win32' ? '.exe' : '';
  const manifest = {
    schema: 1, product: 'varin-tauri-desktop', channel: 'development', version, platform, architecture,
    // A byte-complete Node/Host/kernel stage is not a Browser Use, native UI,
    // migration or updater acceptance receipt. No release override flag exists.
    release: { qualification: 'external-signed-evidence-required' },
    node: { ...node, executable: `node/node${executable}`, license: 'node/LICENSE' },
    host: { entry: hostEntry, settingsEntry: hostSettingsEntry, browserEntry: hostBrowserEntry,
      package: `${hostPackage}/package.json`, controlProtocol: 1 },
    kernel: { executable: `kernel/varin-kernel${executable}`, manifest: 'kernel/manifest.json' },
    frontend: { entry: 'frontend/index.html', directory: 'frontend' },
    tools: { ripgrep: `tools/rg${executable}` },
    browser,
    ...(legacyElectron ? { legacyElectron } : {}),
    legal: [...legalPaths], sources, files: await inventory(directory),
  };
  await fs.writeFile(path.join(directory, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  await verifyRuntimeManifest(directory);
  return manifest;
}

export async function verifyRuntimeManifest(directory, { platform, architecture, production = false, nodeLock, qualification, publicKey } = {}) {
  const manifestFile = path.join(directory, manifestName);
  if (!(await fs.lstat(manifestFile)).isFile()) throw new Error('Runtime manifest must be a regular file');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.schema !== 1 || manifest.product !== 'varin-tauri-desktop' || manifest.channel !== 'development'
    || !targets.includes(`${manifest.platform}-${manifest.architecture}`) || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('Unsupported desktop runtime manifest');
  }
  if (production && (!qualification || !publicKey)) throw new Error('Tauri production distribution is blocked without signed platform qualification');
  if (platform && platform !== manifest.platform || architecture && architecture !== manifest.architecture) throw new Error('Runtime target does not match this desktop');
  const lock = nodeLock ?? JSON.parse(await fs.readFile(new URL('./node-runtime.lock.json', import.meta.url), 'utf8'));
  const pin = lock.targets[`${manifest.platform}-${manifest.architecture}`];
  const suffix = manifest.platform === 'win32' ? '.exe' : '';
  if (manifest.node?.version !== lock.version || manifest.node?.sourceSha256 !== pin?.sha256
    || manifest.node?.archive !== pin.archive || manifest.node?.source !== `https://nodejs.org/dist/v${lock.version}/${pin.archive}`
    || manifest.node?.executable !== `node/node${suffix}` || manifest.node?.license !== 'node/LICENSE') {
    throw new Error('Runtime Node does not match the fixed distribution lock');
  }
  if (manifest.host?.entry !== hostEntry || manifest.host?.settingsEntry !== hostSettingsEntry || manifest.host?.browserEntry !== hostBrowserEntry
    || manifest.host?.package !== `${hostPackage}/package.json` || manifest.host?.controlProtocol !== 1
    || manifest.kernel?.executable !== `kernel/varin-kernel${suffix}` || manifest.kernel?.manifest !== 'kernel/manifest.json'
    || manifest.frontend?.entry !== 'frontend/index.html' || manifest.frontend?.directory !== 'frontend'
    || manifest.tools?.ripgrep !== `tools/rg${suffix}`) throw new Error('Invalid runtime entry points');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Missing runtime file inventory');
  const seen = new Set();
  for (const entry of manifest.files) {
    relativePath(entry.path);
    if (entry.path === manifestName || seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !hashPattern.test(entry.sha256) || typeof entry.executable !== 'boolean') throw new Error(`Invalid runtime file record: ${entry.path}`);
    seen.add(entry.path);
  }
  if (!Array.isArray(manifest.legal) || legalPaths.some(file => !manifest.legal.includes(file))) throw new Error('Missing bundled license declaration');
  const required = [manifest.node.executable, manifest.host.entry, manifest.host.settingsEntry, manifest.host.browserEntry,
    manifest.host.package, manifest.kernel.executable, manifest.tools.ripgrep,
    manifest.kernel.manifest, manifest.frontend.entry, `${hostPackage}/server/index.js`, `${hostPackage}/server/public-contract.js`,
    `${hostPackage}/server/production-boundary.json`, ...requiredHostAssets, ...legalPaths];
  for (const file of required) if (!seen.has(file) || !manifest.files.find(entry => entry.path === file).size) throw new Error(`Missing runtime entry or legal asset: ${file}`);
  const actual = await inventory(directory);
  if (actual.length !== manifest.files.length) throw new Error('Runtime file inventory has missing or unlisted assets');
  const expected = new Map(manifest.files.map(entry => [entry.path, entry]));
  for (const entry of actual) {
    const record = expected.get(entry.path);
    if (!record || entry.sha256 !== record.sha256 || entry.size !== record.size) throw new Error(`Runtime file integrity mismatch: ${entry.path}`);
    if (manifest.platform !== 'win32' && entry.executable !== record.executable) throw new Error(`Runtime executable mode mismatch: ${entry.path}`);
  }
  const binaries = new Map();
  for (const executable of [manifest.node.executable, manifest.kernel.executable, manifest.tools.ripgrep]) {
    const binary = await readBinaryIdentity(path.join(directory, executable));
    binaries.set(executable, binary);
    if (binary.platform !== manifest.platform || binary.arch !== manifest.architecture) throw new Error(`Runtime executable architecture mismatch: ${executable}`);
    if (manifest.platform !== 'win32' && !expected.get(executable).executable) throw new Error(`Runtime entry is not executable: ${executable}`);
  }
  const kernel = JSON.parse(await fs.readFile(path.join(directory, manifest.kernel.manifest), 'utf8'));
  if (kernel.schema !== 3 || kernel.platform !== manifest.platform || kernel.arch !== manifest.architecture
    || kernel.executable !== path.posix.basename(manifest.kernel.executable) || kernel.buildIdentity !== manifest.version
    || kernel.targetTriple !== identity.defaultKernelTargetTriple(manifest.platform, manifest.architecture)
    || kernel.protocolVersion !== kernelProtocolVersion || kernel.kernelVersion !== '0.1.0'
    || kernel.binaryFormat !== binaries.get(manifest.kernel.executable).format
    || kernel.sha256 !== expected.get(manifest.kernel.executable).sha256) throw new Error('Kernel manifest identity does not match the desktop runtime');
  const host = JSON.parse(await fs.readFile(path.join(directory, manifest.host.package), 'utf8'));
  if (host.name !== '@varin/web' || host.version !== manifest.version) throw new Error('Host package version does not match the desktop runtime');
  const { validateLegacyManifest } = await import('./legacy-runtime.mjs');
  validateLegacyManifest(manifest);
  if (manifest.legacyElectron) {
    const legacy = await readBinaryIdentity(path.join(directory, manifest.legacyElectron.executable));
    if (legacy.platform !== manifest.platform || legacy.arch !== manifest.architecture) throw new Error('Legacy engine architecture mismatch');
  }
  if (production) {
    const { verifyQualification } = await import('./release.mjs');
    const document = typeof qualification === 'string' ? JSON.parse(await fs.readFile(qualification, 'utf8')) : qualification;
    await verifyQualification(document, { publicKey, runtimeManifestSha256: await sha256(manifestFile), platform: manifest.platform, architecture: manifest.architecture });
    if (document.version !== manifest.version || document.sourceSha !== manifest.sources?.sourceSha || manifest.sources?.sourceDirty !== false) throw new Error('Production qualification source/version mismatch');
    if (manifest.browser?.engine !== 'CEF' || !manifest.browser.version || manifest.browser.architecture !== manifest.architecture) throw new Error('Production qualification requires its bundled browser identity');
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const position = args.indexOf('--qualification');
  if (!args[0] || args.some(arg => arg.startsWith('--') && !['--production', '--qualification'].includes(arg)) || position >= 0 && !args[position + 1]) throw new Error('Usage: runtime-manifest.mjs <runtime-directory> [--production --qualification FILE]');
  const production = args.includes('--production');
  const manifest = await verifyRuntimeManifest(path.resolve(args[0]), { production, qualification: position >= 0 ? args[position + 1] : undefined, publicKey: process.env.VARIN_TAURI_UPDATER_PUBLIC_KEY });
  console.log(`Verified ${manifest.files.length} runtime files for ${manifest.platform}/${manifest.architecture} (${production ? 'signed platform qualification' : 'unqualified candidate'})`);
}

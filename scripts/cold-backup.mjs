import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FORMAT = 'varin-cold-backup/1';
const FENCE = '.varin-offline-restore.json';
const LOCK = '.varin-cold-backup.lock';
const NAME = /^[a-z][a-z0-9-]*$/;
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function digest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try { for (let n; (n = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeJson(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function publishJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeJson(temporary, value);
    // Publish a complete receipt without replacing an existing activation.
    fs.linkSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (exists(temporary)) fs.unlinkSync(temporary);
    syncDirectory(path.dirname(file));
  }
}

function readJsonFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Expected a regular JSON file: ${path.basename(file)}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function inventory(root, { hash = true, skipBackupLock = false, skipRestoreFence = false } = {}) {
  const entries = [];
  function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file, { bigint: true });
    const entry = { path: relative.split(path.sep).join('/'), mode: Number(stat.mode & 0o777n) };
    if (stat.isDirectory()) entry.type = 'directory';
    else if (stat.isFile()) {
      entry.type = 'file'; entry.bytes = Number(stat.size);
      if (!Number.isSafeInteger(entry.bytes)) throw new Error(`File is too large to represent: ${relative}`);
      if (hash) entry.sha256 = digest(file);
    } else if (stat.isSymbolicLink()) {
      entry.type = 'symlink'; entry.target = fs.readlinkSync(file);
      if (path.isAbsolute(entry.target) || !inside(root, path.resolve(path.dirname(file), entry.target))) {
        throw new Error(`External symlink is outside the declared backup scope: ${relative}`);
      }
      // Also reject an internal-looking chain which resolves outside this root.
      try { if (!inside(root, fs.realpathSync(file))) throw new Error(`Symlink escapes backup scope: ${relative}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else throw new Error(`Unsupported socket/device/FIFO in backup scope: ${relative}`);
    entries.push({ ...entry, fingerprint: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) });
    if (entry.type === 'directory') {
      for (const name of fs.readdirSync(file).sort()) {
        if (skipBackupLock && !relative && name === LOCK) continue;
        if (skipRestoreFence && !relative && name === FENCE) continue;
        visit(path.join(relative, name));
      }
    }
  }
  visit('');
  return entries;
}

const publicEntries = entries => entries.map(({ fingerprint: _fingerprint, ...entry }) => entry);
const fingerprints = entries => entries.map(({ sha256: _sha256, ...entry }) => entry);

function copyInventory(source, destination, entries, rootAlreadyCreated = false) {
  for (const entry of entries) {
    const from = path.join(source, entry.path), to = path.join(destination, entry.path);
    if (entry.type === 'directory') { if (entry.path || !rootAlreadyCreated) fs.mkdirSync(to, { mode: 0o700 }); }
    else if (entry.type === 'symlink') fs.symlinkSync(entry.target, to);
    else {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, entry.mode & 0o777);
      const fd = fs.openSync(to, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  // Restore directory modes after children are copied, never setuid/setgid bits.
  for (const entry of [...entries].reverse()) if (entry.type === 'directory') {
    const to = path.join(destination, entry.path);
    fs.chmodSync(to, entry.mode & 0o777); syncDirectory(to);
  }
}

function newDestination(output, sources) {
  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const destination = path.join(parent, path.basename(path.resolve(output)));
  for (const source of sources) if (inside(source, destination) || inside(destination, source)) {
    throw new Error('Backup/restore destination and source roots must not overlap');
  }
  fs.mkdirSync(destination, { mode: 0o700 }); // EEXIST: never replace existing assets.
  return destination;
}

/** Caller must stop every writer, including external workspace writers, before entry. */
export function createColdBackup({ dataDir, scopes = [], output, writersStopped = false }) {
  if (!writersStopped) throw new Error('Cold backup requires --writers-stopped after all writers are stopped and restart is disabled');
  const roots = [{ name: 'data', source: dataDir }, ...scopes].map(root => ({ ...root, source: fs.realpathSync(root.source) }));
  if (roots.some(root => typeof root.name !== 'string' || !NAME.test(root.name)) || new Set(roots.map(root => root.name)).size !== roots.length) {
    throw new Error('Scope names must be distinct lowercase names; data is reserved');
  }
  for (const root of roots) {
    if (!fs.lstatSync(root.source).isDirectory()) throw new Error(`Scope is not a directory: ${root.name}`);
    for (const other of roots) if (other !== root && inside(root.source, other.source)) throw new Error('Declared source roots overlap');
  }
  if (exists(path.join(roots[0].source, FENCE))) throw new Error('An offline restore is not an activated production backup source');
  const lock = path.join(roots[0].source, LOCK);
  fs.mkdirSync(lock, { mode: 0o700 });
  let destination;
  try {
    destination = newDestination(output, roots.map(root => root.source));
    fs.mkdirSync(path.join(destination, 'roots'), { mode: 0o700 });
    const snapshots = roots.map(root => inventory(root.source, { skipBackupLock: root.name === 'data' }));
    roots.forEach((root, i) => copyInventory(root.source, path.join(destination, 'roots', root.name), snapshots[i]));
    roots.forEach((root, i) => {
      const after = inventory(root.source, { hash: false, skipBackupLock: root.name === 'data' });
      if (!same(fingerprints(snapshots[i]), fingerprints(after))) throw new Error(`Source changed during cold backup: ${root.name}`);
      const copied = publicEntries(inventory(path.join(destination, 'roots', root.name)));
      if (!same(publicEntries(snapshots[i]), copied)) throw new Error(`Copied bytes differ from source: ${root.name}`);
    });
    const manifest = {
      format: FORMAT, createdAt: new Date().toISOString(), producerVersion: version,
      consistency: 'all-writers-stopped-operator-assertion',
      scope: 'complete declared roots, including WAL, objects and publication files; no undeclared mounts or external effects',
      databaseValidation: 'byte-preserved; schema validation and recovery belong to the original storage owners',
      confidentiality: 'private credential-bearing backup; hashes are integrity checks, not signatures or encryption',
      roots: roots.map((root, i) => ({ ...root, entries: publicEntries(snapshots[i]) })),
    };
    // The manifest is the completion record. No manifest means no valid backup.
    syncDirectory(path.join(destination, 'roots'));
    writeJson(path.join(destination, 'manifest.json'), manifest);
    syncDirectory(path.dirname(destination));
    return { output: destination, manifestSha256: digest(path.join(destination, 'manifest.json')), roots: roots.map(root => root.name) };
  } catch (error) {
    if (destination) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { fs.rmdirSync(lock); syncDirectory(roots[0].source); }
}

export function verifyColdBackup(input) {
  const root = fs.realpathSync(input);
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.lstatSync(manifestFile).isFile()) throw new Error('Backup manifest must be a regular file');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.roots) || !manifest.roots.length
    || manifest.roots[0]?.name !== 'data' || new Set(manifest.roots.map(item => item.name)).size !== manifest.roots.length
    || manifest.roots.some(item => typeof item.name !== 'string' || !NAME.test(item.name) || !Array.isArray(item.entries))) throw new Error('Invalid or unsupported backup manifest');
  if (!same(fs.readdirSync(root).sort(), ['manifest.json', 'roots'])) throw new Error('Unexpected backup root entries');
  if (!fs.lstatSync(path.join(root, 'roots')).isDirectory()
    || !same(fs.readdirSync(path.join(root, 'roots')).sort(), manifest.roots.map(item => item.name).sort())) throw new Error('Backup scope differs from manifest');
  for (const scope of manifest.roots) {
    const directory = path.join(root, 'roots', scope.name);
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('Backup scope must be a real directory');
    // Never resolve a manifest-supplied entry path. Compare a real traversal to it instead.
    if (!same(publicEntries(inventory(directory)), scope.entries)) throw new Error(`Backup integrity or scope mismatch: ${scope.name}`);
  }
  return { root, manifest, manifestSha256: digest(manifestFile) };
}

export function restoreColdBackup({ input, output, mode = 'inspection' }) {
  if (!['inspection', 'recovery'].includes(mode)) throw new Error('Restore mode must be inspection or recovery; independent runnable clone is unsupported');
  const verified = verifyColdBackup(input);
  const originalRoots = verified.manifest.roots.flatMap(scope => typeof scope.source === 'string' && path.isAbsolute(scope.source)
    ? [exists(scope.source) ? fs.realpathSync(scope.source) : path.resolve(scope.source)] : []);
  const destination = newDestination(output, [verified.root, ...originalRoots]);
  try {
    const receipt = { format: 'varin-offline-restore/1', mode, restoredAt: new Date().toISOString(),
      manifestSha256: verified.manifestSha256, roots: verified.manifest.roots.map(({ name, source }) => ({ name, originalSource: source })),
      identity: 'preserved; must never run concurrently with the source Host',
      effects: 'preserved; missing receipts do not prove that an external effect did not execute' };
    // Fence before copying any identity/store. A partial restore must not start.
    fs.mkdirSync(path.join(destination, 'data'), { mode: 0o700 });
    writeJson(path.join(destination, 'data', FENCE), receipt);
    for (const scope of verified.manifest.roots) {
      copyInventory(path.join(verified.root, 'roots', scope.name), path.join(destination, scope.name), scope.entries, scope.name === 'data');
      if (!same(publicEntries(inventory(path.join(destination, scope.name), { skipRestoreFence: scope.name === 'data' })), scope.entries)) throw new Error(`Restore verification failed: ${scope.name}`);
    }
    writeJson(path.join(destination, 'restore.json'), receipt);
    syncDirectory(path.dirname(destination));
    return { output: destination, mode, startup: 'fenced', manifestSha256: verified.manifestSha256 };
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}

export function activateRecovery({ restoredRoot, sourceFenced = false, effectsReviewed = false, bindingsReviewed = false }) {
  if (!sourceFenced || !effectsReviewed || !bindingsReviewed) throw new Error('Activation requires --source-fenced --effects-reviewed --bindings-reviewed; these are operator assertions, not automatic verification');
  const root = fs.realpathSync(restoredRoot);
  if (!fs.lstatSync(path.join(root, 'data')).isDirectory()) throw new Error('Restored data root must be a real directory');
  const marker = path.join(root, 'data', FENCE);
  const receipt = readJsonFile(path.join(root, 'restore.json'));
  if (receipt.format !== 'varin-offline-restore/1' || receipt.mode !== 'recovery') throw new Error('Inspection clones cannot be activated; prepare an explicit recovery restore');
  const activationFile = path.join(root, 'activation.json');
  const fenced = exists(marker);
  if (fenced && !same(readJsonFile(marker), receipt)) throw new Error('Restore receipt and startup fence disagree');
  if (exists(activationFile)) {
    const { activatedAt, ...activation } = readJsonFile(activationFile);
    if (typeof activatedAt !== 'string' || !Number.isFinite(Date.parse(activatedAt))
      || !same(activation, { ...receipt, sourceFenced, effectsReviewed, bindingsReviewed })) throw new Error('Activation receipt does not match this recovery');
  } else {
    if (!fenced) throw new Error('Missing restore fence without a completed activation receipt');
    publishJson(activationFile, { ...receipt, sourceFenced, effectsReviewed, bindingsReviewed, activatedAt: new Date().toISOString() });
  }
  // A previous attempt may have linked the receipt but failed its directory
  // fsync. Even a valid existing receipt must become durable before unfencing.
  syncDirectory(root);
  if (fenced) fs.unlinkSync(marker);
  syncDirectory(path.dirname(marker));
  return { output: root, startup: 'activated-recovery', warning: 'Keep the source fenced; recovery cannot undo external effects after the backup' };
}

function cli(argv) {
  const [command, ...args] = argv;
  const options = {}, scopes = [];
  const flags = new Set(['writers-stopped', 'source-fenced', 'effects-reviewed', 'bindings-reviewed']);
  const values = new Set(['data-dir', 'scope', 'output', 'input', 'mode', 'restored-root']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] !== `--${key}` || (!flags.has(key) && !values.has(key))) throw new Error(`Unknown option: ${args[i]}`);
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: --${key}`);
      if (key === 'scope') {
        const at = value.indexOf('=');
        if (at < 1) throw new Error('Scope syntax: --scope name=/absolute/directory');
        scopes.push({ name: value.slice(0, at), source: value.slice(at + 1) });
      } else options[key] = value;
    }
  }
  if (command === 'create') return createColdBackup({ dataDir: options['data-dir'], scopes, output: options.output, writersStopped: options['writers-stopped'] });
  if (command === 'verify') { const result = verifyColdBackup(options.input); return { verified: true, manifestSha256: result.manifestSha256, roots: result.manifest.roots.map(root => root.name) }; }
  if (command === 'restore') return restoreColdBackup({ input: options.input, output: options.output, mode: options.mode });
  if (command === 'activate') return activateRecovery({ restoredRoot: options['restored-root'], sourceFenced: options['source-fenced'], effectsReviewed: options['effects-reviewed'], bindingsReviewed: options['bindings-reviewed'] });
  throw new Error('Usage: cold-backup.mjs create|verify|restore|activate (see docs/ops/cold-backup.md)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

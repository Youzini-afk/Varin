import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { Parser } from 'tar';
import AdmZip from 'adm-zip';

export const FRPC_MANAGED_VERSION = '0.65.0';
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;
const MAX_BINARY_BYTES = 48 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const unzip = promisify(gunzip);

export interface FrpcComponentStatus {
  state: 'available' | 'missing' | 'invalid' | 'unsupported';
  source: 'configured' | 'path' | 'managed' | null;
  version: string | null;
  managedVersion: string;
  installSupported: boolean;
  error?: string;
  /** Included only for an explicitly local operator view. */
  executablePath?: string;
}

export class FrpcComponentError extends Error {
  constructor(readonly code: 'invalid_configuration' | 'missing_dependency' | 'unsupported_platform'
    | 'download_failed' | 'integrity_failed' | 'install_failed', message: string) {
    super(message);
    this.name = 'FrpcComponentError';
  }
}

interface Artifact {
  name: string;
  sha256: string;
  size: number;
  zip?: boolean;
}

// Pinned against BOTH the official release API asset.digest and checksum asset:
// https://api.github.com/repos/fatedier/frp/releases/tags/v0.65.0
// https://github.com/fatedier/frp/releases/download/v0.65.0/frp_sha256_checksums.txt
// Checked 2026-11-17. Updates require reviewing the adapter's protocol contract.
const ARTIFACTS: Readonly<Record<string, Artifact>> = {
  'win32-x64': { name: 'frp_0.65.0_windows_amd64', size: 13_820_524, sha256: '5885bff09604e719e429698f800f89379f3910f07490ca1f7d8a7f7a40970eda', zip: true },
  'win32-arm64': { name: 'frp_0.65.0_windows_arm64', size: 12_254_248, sha256: 'cef05f46ec253c3542c3e943740d161f004387d52ff5d9d30d8dde0d58bba6e8', zip: true },
  'linux-x64': { name: 'frp_0.65.0_linux_amd64', size: 13_808_813, sha256: '52ced8c5fdf772f48a9909da4c10c7568c061861946ac9af7a86eeaf14b7e6d5' },
  'linux-arm64': { name: 'frp_0.65.0_linux_arm64', size: 12_404_966, sha256: 'd3e2be696d70b8e8dc475a81b8b5e4089f3a2acde5e42e47d6fc020fe3ddb180' },
  'darwin-x64': { name: 'frp_0.65.0_darwin_amd64', size: 13_952_135, sha256: '83dcf7617c61bef0087cb771e99fd16d749203c16dd6bbf47efb15ce617dc471' },
  'darwin-arm64': { name: 'frp_0.65.0_darwin_arm64', size: 12_825_597, sha256: 'bce3badaf40cf5d3811c9eae593f3b24833bf7cb13b8b7c3f9453e94af45ded1' },
};

interface Options {
  /** Supplied by the Host, never from a request body. */
  dataDirectory: string;
  env?: NodeJS.ProcessEnv;
}

/** Constructor-only seams for deterministic tests, not client configuration. */
interface Dependencies {
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof globalThis.fetch;
  probeVersion?: (executablePath: string) => Promise<string>;
  artifact?: Pick<Artifact, 'sha256' | 'size'>;
  downloadTimeoutMs?: number;
}

type Selection = FrpcComponentStatus & { executablePath?: string };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const integrityError = () => new FrpcComponentError('integrity_failed', 'The FRP component failed integrity verification');
const absoluteFile = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const validVersion = (value: string) => /^v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.exec(value.trim())?.[1] ?? null;

async function probeVersion(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executablePath, ['--version'], {
      encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL', maxBuffer: 4_096,
      shell: false, windowsHide: true, env: { LANG: 'C', LC_ALL: 'C' },
      cwd: path.dirname(executablePath),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    await fs.access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Never follows archive paths on disk: only one validated regular entry becomes bytes. */
async function extractBinary(archive: Buffer, artifact: Artifact): Promise<Buffer> {
  if (artifact.zip) {
    try {
      // Read the selected member into memory; archive paths never reach disk.
      const entry = new AdmZip(archive).getEntry(`${artifact.name}/frpc.exe`);
      if (!entry || entry.isDirectory || entry.header.size > MAX_BINARY_BYTES) throw integrityError();
      return entry.getData();
    } catch { throw integrityError(); }
  }
  let unpacked: Buffer;
  try { unpacked = await unzip(archive, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { throw integrityError(); }
  return new Promise((resolve, reject) => {
    let found = false;
    let binary: Buffer | undefined;
    let entries = 0;
    const parser = new Parser({ strict: true, maxMetaEntrySize: 4_096 });
    parser.on('error', () => reject(integrityError()));
    parser.on('entry', entry => {
      // No links/devices, absolute paths, traversal, or unbounded metadata. Even
      // discarded entries must obey the release's single-root archive shape.
      const name = entry.path.replace(/\/$/, '');
      const segments = name.split('/');
      if (++entries > 64 || segments[0] !== artifact.name
        || segments.some((segment: string) => !segment || segment === '.' || segment === '..')
        || name.includes('\\') || name.includes('\0')
        || !['File', 'Directory'].includes(entry.type) || entry.linkpath
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BINARY_BYTES) {
        parser.abort(integrityError()); return;
      }
      if (name !== `${artifact.name}/frpc`) { entry.resume(); return; }
      if (found || entry.type !== 'File' || entry.size === 0) { parser.abort(integrityError()); return; }
      found = true;
      const chunks: Buffer[] = [];
      let size = 0;
      entry.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BINARY_BYTES) { parser.abort(integrityError()); return; }
        chunks.push(chunk);
      });
      entry.on('end', () => {
        if (size !== entry.size) parser.abort(integrityError());
        else binary = Buffer.concat(chunks, size);
      });
    });
    parser.on('end', () => binary ? resolve(binary) : reject(integrityError()));
    parser.end(unpacked);
  });
}

async function downloadArtifact(artifact: Artifact, fetcher: typeof globalThis.fetch, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    let url = `https://github.com/fatedier/frp/releases/download/v${FRPC_MANAGED_VERSION}/${artifact.name}.${artifact.zip ? 'zip' : 'tar.gz'}`;
    for (let redirects = 0; ; redirects++) {
      response = await fetcher(url, {
        signal: controller.signal, redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 3) throw new Error();
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')
        || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) throw new Error();
      url = next.href;
    }
    if (!response.ok || !response.body) throw new Error();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.size)) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > artifact.size || size > MAX_ARCHIVE_BYTES) throw new Error();
        chunks.push(result.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (size !== artifact.size) throw integrityError();
    const archive = Buffer.concat(chunks, size);
    if (digest(archive) !== artifact.sha256) throw integrityError();
    return archive;
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (error instanceof FrpcComponentError) throw error;
    throw new FrpcComponentError('download_failed', 'The pinned FRP release could not be downloaded within its size and time limits');
  } finally { clearTimeout(timer); }
}

async function privateDirectory(directory: string, create: boolean): Promise<void> {
  if (create) await fs.mkdir(directory, { mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)
    || (process.getuid && stat.uid !== process.getuid())) throw integrityError();
}

/**
 * Optional Host-local component owner. Discovery is read-only and never downloads.
 * Install is an explicit local-management action and never runs the downloaded
 * executable, touches a global install, uses sudo, or accepts a URL/path payload.
 */
export function createFrpcComponentService(options: Options, dependencies: Dependencies = {}) {
  if (!absoluteFile(options.dataDirectory)) throw new FrpcComponentError('invalid_configuration', 'The Host FRP component data directory must be absolute');
  const env = options.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const release = ARTIFACTS[`${platform}-${arch}`];
  const artifact = release ? { ...release, sha256: dependencies.artifact?.sha256 ?? release.sha256,
    size: dependencies.artifact?.size ?? release.size } : undefined;
  const supported = Boolean(artifact);
  const parentDirectory = path.join(options.dataDirectory, 'components', 'frpc');
  const installDirectory = artifact ? path.join(parentDirectory, artifact.name) : '';
  const binaryName = platform === 'win32' ? 'frpc.exe' : 'frpc';
  const managedPath = path.join(installDirectory, binaryName);
  let installation: Promise<FrpcComponentStatus> | undefined;

  const base = (): FrpcComponentStatus => ({ state: 'missing', source: null, version: null, managedVersion: FRPC_MANAGED_VERSION, installSupported: supported });
  const managedSelection = async (): Promise<Selection> => {
    if (!artifact) return { ...base(), state: 'unsupported',
      error: 'No managed FRP download is available for this Host; configure an existing executable' };
    const selected: Selection = { ...base(), source: 'managed' };
    try {
      await fs.lstat(installDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base();
      return { ...selected, state: 'invalid', error: 'The managed FRP component is not readable' };
    }
    try {
      await privateDirectory(path.dirname(parentDirectory), false);
      await privateDirectory(parentDirectory, false);
      await privateDirectory(installDirectory, false);
      const metadataPath = path.join(installDirectory, 'component.json');
      const [metadataStat, binaryStat] = await Promise.all([fs.lstat(metadataPath), fs.lstat(managedPath)]);
      if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 4_096
        || !binaryStat.isFile() || binaryStat.isSymbolicLink() || binaryStat.size <= 0 || binaryStat.size > MAX_BINARY_BYTES) throw integrityError();
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
      if (metadata.schema !== 1 || metadata.version !== FRPC_MANAGED_VERSION || metadata.artifact !== artifact.name
        || metadata.archiveSha256 !== artifact.sha256 || metadata.binarySize !== binaryStat.size
        || typeof metadata.binarySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.binarySha256)) throw integrityError();
      if (digest(await fs.readFile(managedPath)) !== metadata.binarySha256) throw integrityError();
      await fs.access(managedPath, constants.X_OK);
      return { ...selected, state: 'available', version: FRPC_MANAGED_VERSION, executablePath: managedPath };
    } catch { return { ...selected, state: 'invalid', error: 'The managed FRP component failed integrity verification' }; }
  };

  const inspect = async (): Promise<Selection> => {
    const configured = env.VARIN_FRPC_PATH;
    let selectedPath: string | undefined;
    let source: 'configured' | 'path' | undefined;
    if (configured !== undefined && configured !== '') {
      source = 'configured';
      if (!absoluteFile(configured)) return { ...base(), source, state: 'invalid', error: 'VARIN_FRPC_PATH must name an absolute executable file on the Host' };
      selectedPath = configured;
    } else {
      // Never resolve an empty/relative PATH entry against the Host working
      // directory, which can be an untrusted project directory.
      for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
        if (!absoluteFile(directory)) continue;
        const candidate = path.join(directory, binaryName);
        if (await isExecutable(candidate)) { selectedPath = candidate; source = 'path'; break; }
      }
    }
    if (!selectedPath || !source) return managedSelection();
    const selected: Selection = { ...base(), source, executablePath: selectedPath };
    try {
      if (!await isExecutable(selectedPath)) throw new Error();
      const version = validVersion(await (dependencies.probeVersion ?? probeVersion)(selectedPath));
      if (!version) throw new Error();
      return { ...selected, state: 'available', version };
    } catch { return { ...selected, state: 'invalid', error: 'The selected FRP executable did not report a valid version within the probe limits' }; }
  };

  const view = (selection: Selection, includeOperatorDetails = false): FrpcComponentStatus => {
    const { executablePath, ...status } = selection;
    return { ...status, ...(includeOperatorDetails && executablePath ? { executablePath } : {}) };
  };
  const selectionError = (selection: Selection) => new FrpcComponentError(
    selection.state === 'unsupported' ? 'unsupported_platform' : selection.state === 'missing' ? 'missing_dependency' : 'invalid_configuration',
    selection.error ?? 'No FRP component is installed on this Host; install it explicitly or configure an existing executable',
  );

  const install = async (): Promise<FrpcComponentStatus> => {
    const current = await inspect();
    if (current.state === 'available') return view(current);
    if (current.state !== 'missing' || !artifact) throw selectionError(current);
    let staging: string | undefined;
    try {
      // The Host data root may be operator-configured; only the component
      // subtree must be real, owned directories rather than redirecting links.
      await fs.mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
      for (const directory of [path.dirname(parentDirectory), parentDirectory]) {
        try { await privateDirectory(directory, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') await privateDirectory(directory, false); else throw error; }
      }
      staging = await fs.mkdtemp(path.join(parentDirectory, '.install-'));
      await fs.chmod(staging, 0o700);
      const archive = await downloadArtifact(artifact, dependencies.fetch ?? globalThis.fetch, dependencies.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
      const binary = await extractBinary(archive, artifact);
      // Both files are complete before a single directory rename publishes the
      // generation. Failed downloads/extraction cannot replace a valid install.
      const binaryFile = await fs.open(path.join(staging, binaryName), 'wx', 0o500);
      try { await binaryFile.writeFile(binary); await binaryFile.sync(); } finally { await binaryFile.close(); }
      const metadataFile = await fs.open(path.join(staging, 'component.json'), 'wx', 0o400);
      try {
        await metadataFile.writeFile(JSON.stringify({ schema: 1, version: FRPC_MANAGED_VERSION,
          artifact: artifact.name, archiveSha256: artifact.sha256, binarySha256: digest(binary), binarySize: binary.length }));
        await metadataFile.sync();
      } finally { await metadataFile.close(); }
      try { await fs.rename(staging, installDirectory); staging = undefined; }
      catch (error) {
        // A concurrent Host may have committed the same pinned generation.
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')
          && !(process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM'
            && (await managedSelection()).state === 'available')) throw error;
      }
      const installed = await managedSelection();
      if (installed.state !== 'available') throw integrityError();
      return view(installed);
    } catch (error) {
      if (error instanceof FrpcComponentError) throw error;
      throw new FrpcComponentError('install_failed', 'The FRP component could not be installed in the Host data directory');
    } finally {
      if (staging) await fs.rm(staging, { force: true, recursive: true }).catch(() => undefined);
    }
  };

  return {
    getStatus: async (options: { includeOperatorDetails?: boolean } = {}): Promise<FrpcComponentStatus> => view(await inspect(), options.includeOperatorDetails),
    async resolveExecutable(): Promise<string> {
      const selection = await inspect();
      if (selection.state !== 'available' || !selection.executablePath) throw selectionError(selection);
      return selection.executablePath;
    },
    install(): Promise<FrpcComponentStatus> {
      // Repeated clicks join the in-flight operation, not a second download.
      if (!installation) installation = install().finally(() => { installation = undefined; });
      return installation;
    },
  };
}

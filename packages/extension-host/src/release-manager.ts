import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t as listTar, x as extractTar } from 'tar';
import semver from 'semver';
import {
  extensionSourceIdentity, parseGithubReleaseSource, parseNpmReleaseSource, parseVarinExtensionManifest, parseVarinExtensionPackageSource,
  parseVarinExtensionReleaseManifest,
  type VarinExtensionPackageSource, type VarinExtensionPreparedArtifact,
  type VarinExtensionReleasePreview, type VarinExtensionReleaseInstallRequest,
  type VarinExtensionReleaseManifest, type VarinExtensionUpdateCheck,
} from '@varin/extension-contract';
import type { ExtensionPackageManager } from './package-manager.js';

export type ExtensionReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>;
interface ResolvedRelease {
  version: string;
  url: string;
  integrity: string;
  extensionId?: string;
  engines?: { varin: string };
  warnings?: string[];
}
interface GithubRelease {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
}

/** Standard npm-compatible package/ tar layout, with no links, devices or traversal. */
export async function extractExtensionRelease(archive: string, directory: string): Promise<void> {
  const seen = new Set<string>();
  let unsafe: string | undefined;
  await listTar({ file: archive, strict: true, onReadEntry(entry) {
    const path = entry.path.replace(/\/$/, '');
    if (!path || path.includes('\\') || path.includes(':') || !path.split('/').every(part => part && part !== '.' && part !== '..')
      || (path !== 'package' && !path.startsWith('package/'))
      || !['File', 'Directory', 'OldFile'].includes(entry.type) || seen.has(path)) {
      unsafe ??= entry.path;
    }
    seen.add(path);
  } });
  if (unsafe) throw new Error(`Unsafe release archive entry: ${unsafe}`);
  if (!seen.has('package/varin.extension.json')) throw new Error('Release archive is missing package/varin.extension.json');
  await mkdir(directory, { recursive: true });
  await extractTar({ file: archive, cwd: directory, strip: 1, strict: true, preservePaths: false });
}

export class ExtensionReleaseManager {
  readonly #packages: ExtensionPackageManager;
  readonly #hostId: string;
  readonly #fetch: ExtensionReleaseFetch;
  readonly #platform: string;
  readonly #arch: string;
  readonly #metadata = new Map<string, { etag?: string; value: unknown }>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #previews = new Map<string, { artifact: VarinExtensionPreparedArtifact; revision: number }>();
  readonly #install: (artifact: VarinExtensionPreparedArtifact, revision: number, signal?: AbortSignal) => ReturnType<ExtensionPackageManager["installPrepared"]>;
  readonly #checks = new Map<string, Promise<VarinExtensionUpdateCheck>>();
  constructor(options: { packages: ExtensionPackageManager; hostId: string; fetch?: ExtensionReleaseFetch; platform?: string; arch?: string; install?: (artifact: VarinExtensionPreparedArtifact, revision: number, signal?: AbortSignal) => ReturnType<ExtensionPackageManager["installPrepared"]> }) {
    this.#packages = options.packages;
    this.#hostId = options.hostId;
    const request = options.fetch ?? fetch;
    this.#fetch = (url, init) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Release downloads require credential-free HTTPS URLs');
      return request(url, init);
    };
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#install = options.install ?? ((artifact, revision, signal) => this.#packages.installPrepared(artifact, revision, true, signal));
  }

  async #json(url: string): Promise<unknown> {
    const existing = this.#inflight.get(url);
    if (existing) return existing;
    const pending = (async () => {
      const cached = this.#metadata.get(url);
      const response = await this.#fetch(url, { headers: { Accept: 'application/json', ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}) } });
      if (response.status === 304 && cached) return cached.value;
      if (!response.ok) throw new Error(`Release metadata request failed (${response.status})${response.headers.get('retry-after') ? `; retry after ${response.headers.get('retry-after')}` : ''}`);
      const value: unknown = await response.json();
      const etag = response.headers.get('etag');
      this.#metadata.set(url, { value, ...(etag ? { etag } : {}) });
      return value;
    })();
    this.#inflight.set(url, pending);
    try { return await pending; } finally { this.#inflight.delete(url); }
  }

  async #resolve(source: VarinExtensionPackageSource): Promise<ResolvedRelease> {
    if (source.kind === 'github-release') {
      const selection = parseGithubReleaseSource(source.specifier);
      const releases: GithubRelease[] = [];
      for (let page = 1; ; page++) {
        const batch = await this.#json(`https://api.github.com/repos/${selection.repository}/releases?per_page=100&page=${page}`) as GithubRelease[];
        if (!Array.isArray(batch)) throw new Error('Invalid GitHub release metadata');
        releases.push(...batch);
        if (batch.length < 100) break;
      }
      const candidates = releases.filter(release => !release.draft && (selection.channel === 'prerelease' || !release.prerelease) && release.tag_name.startsWith(selection.tagPrefix) && semver.valid(release.tag_name.slice(selection.tagPrefix.length)))
        .sort((a, b) => semver.rcompare(a.tag_name.slice(selection.tagPrefix.length), b.tag_name.slice(selection.tagPrefix.length)));
      let reason = 'No published release is available';
      const warnings: string[] = [];
      for (const release of candidates) {
        const manifestAsset = release.assets.find(asset => asset.name === selection.manifest);
        if (!manifestAsset) { reason = `${release.tag_name} has no ${selection.manifest}`; warnings.push(reason); continue; }
        const manifest: VarinExtensionReleaseManifest = parseVarinExtensionReleaseManifest(await this.#json(manifestAsset.browser_download_url));
        if (manifest.version !== release.tag_name.slice(selection.tagPrefix.length)) throw new Error('Release tag and release manifest versions disagree');
        if (!semver.satisfies(this.#packages.varinVersion, manifest.engines.varin)) { reason = `${manifest.version} requires Varin ${manifest.engines.varin}`; warnings.push(reason); continue; }
        const asset = manifest.assets.filter(asset => (asset.platform === 'any' || asset.platform === this.#platform) && (asset.arch === 'any' || asset.arch === this.#arch))
          .sort((a, b) => Number(b.platform !== 'any') + Number(b.arch !== 'any') - Number(a.platform !== 'any') - Number(a.arch !== 'any'))[0];
        if (!asset) { reason = `${manifest.version} has no package for ${this.#platform}/${this.#arch}`; warnings.push(reason); continue; }
        const download = release.assets.find(item => item.name === asset.file);
        if (!download) { reason = `${manifest.version} is missing ${asset.file}`; warnings.push(reason); continue; }
        return { version: manifest.version, url: download.browser_download_url, integrity: `sha256-${Buffer.from(asset.sha256, 'hex').toString('base64')}`, extensionId: manifest.extensionId, engines: manifest.engines, warnings };
      }
      throw new Error(reason);
    }
    if (source.kind === 'npm') {
      const { name, selection: requested } = parseNpmReleaseSource(source.specifier);
      const metadata = await this.#json(`https://registry.npmjs.org/${encodeURIComponent(name)}`) as { 'dist-tags': Record<string, string>; versions: Record<string, { engines?: { varin?: string }; dist?: { tarball?: string; integrity?: string } }> };
      const tagged = metadata['dist-tags']?.[requested];
      const range = tagged ?? requested;
      const versions = Object.keys(metadata.versions ?? {}).filter(version => semver.valid(version) && (version === range || semver.satisfies(version, tagged ? `<=${tagged}` : range)))
        .sort(semver.rcompare);
      const warnings: string[] = [];
      for (const version of versions) {
        const record = metadata.versions[version]!;
        if (record.engines?.varin && !semver.satisfies(this.#packages.varinVersion, record.engines.varin)) {
          warnings.push(`${version} requires Varin ${record.engines.varin}`); continue;
        }
        if (!record.dist?.tarball || !record.dist.integrity) throw new Error(`npm ${version} is missing tarball integrity`);
        if (!record.engines?.varin) warnings.push('npm metadata does not declare Varin compatibility; the package manifest is verified during preview.');
        return { version, url: record.dist.tarball, integrity: record.dist.integrity, warnings,
          ...(record.engines?.varin ? { engines: { varin: record.engines.varin } } : {}) };
      }
      throw new Error('No compatible npm release is available');
    }
    throw new Error('This source uses manual replacement rather than release metadata');
  }

  async previewInstalled(extensionId: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview> {
    const read = await this.#packages.catalog.store.read();
    if (!read.authoritative) throw new Error('Cannot preview updates from a stale catalog');
    const installed = read.document.extensions[extensionId];
    if (!installed) throw new Error('Extension is not installed');
    if (installed.source.kind === 'release-archive') throw new Error('Local archives require manual replacement');
    return this.preview(installed.source, extensionId, signal);
  }

  async previewArchive(archivePath: string, displayName: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview> {
    return this.#preview({ kind: 'release-archive', display: displayName, specifier: displayName }, undefined, signal, archivePath);
  }

  async preview(sourceValue: VarinExtensionPackageSource, extensionId?: string, signal?: AbortSignal): Promise<VarinExtensionReleasePreview> {
    if (sourceValue.kind === 'release-archive') throw new Error('Import release archives through the archive upload entry');
    return this.#preview(sourceValue, extensionId, signal);
  }

  async #preview(sourceValue: VarinExtensionPackageSource, extensionId?: string, signal?: AbortSignal, archivePath?: string): Promise<VarinExtensionReleasePreview> {
    const source = parseVarinExtensionPackageSource(sourceValue);
    signal?.throwIfAborted();
    let artifact: VarinExtensionPreparedArtifact;
    let warnings: string[] = [];
    if (source.kind === 'github-release' || source.kind === 'npm' || source.kind === 'release-archive') {
      const release = source.kind === 'release-archive' ? undefined : await this.#resolve(source);
      warnings = release?.warnings ?? [];
      const root = await mkdtemp(join(tmpdir(), 'varin-release-'));
      try {
        const archive = join(root, 'release.tgz');
        if (release) {
          const response = await this.#fetch(release.url, { ...(signal ? { signal } : {}) });
          if (!response.ok || !response.body) throw new Error(`Release download failed (${response.status})`);
          const body = response.body;
          const chunks = async function* () {
            const reader = body.getReader();
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                yield chunk.value;
              }
            } finally { await reader.cancel(); reader.releaseLock(); }
          };
          await pipeline(chunks(), createWriteStream(archive, { mode: 0o600 }), { signal });
          await verifyReleaseFileIntegrity(archive, release.integrity, signal);
        } else await copyFile(archivePath ?? source.specifier, archive);
        signal?.throwIfAborted();
        const directory = join(root, 'package');
        await extractExtensionRelease(archive, directory);
        const manifest = parseVarinExtensionManifest(JSON.parse(await readFile(join(directory, 'varin.extension.json'), 'utf8')));
        if (release && (manifest.version !== release.version || (release.extensionId && manifest.id !== release.extensionId)
          || (release.engines && manifest.engines.varin !== release.engines.varin))) throw new Error('Release metadata and package manifest disagree');
        if (extensionId && manifest.id !== extensionId) throw new Error('Release package identity does not match the selected extension');
        artifact = await this.#packages.artifacts.prepareRelease(directory, source, signal);
      } finally { await rm(root, { recursive: true, force: true }); }
    } else {
      if (source.kind !== 'local' && source.kind !== 'git') throw new Error('This source is not installable through release preview');
      artifact = await this.#packages.artifacts.prepare(source, signal);
    }
    if (extensionId && artifact.manifest.id !== extensionId) throw new Error('Package identity does not match the selected extension');
    const read = await this.#packages.catalog.store.read();
    if (!read.authoritative) throw new Error('Cannot preview installation against a stale catalog');
    const current = read.document.extensions[artifact.manifest.id];
    if (current && semver.lt(artifact.resolvedVersion, current.selectedVersion)) throw new Error('Release resolution would downgrade the installed version; use the explicit development source workflow to downgrade');
    if (current?.selectedVersion === artifact.resolvedVersion && current.integrity !== artifact.integrity) {
      warnings.push('The publisher replaced this version with different content. Confirmation stages a separate candidate.');
    }
    const previewId = randomUUID();
    this.#previews.set(previewId, { artifact, revision: read.document.revision });
    return { previewId, catalogRevision: read.document.revision, hostId: this.#hostId, source: { kind: source.kind, display: source.display }, manifest: structuredClone(artifact.manifest),
      version: artifact.resolvedVersion, integrity: artifact.integrity,
      sourceChanged: !!current && extensionSourceIdentity(current.source) !== extensionSourceIdentity(source),
      ...(current ? { previousVersion: current.selectedVersion } : {}), warnings };
  }

  async install(request: VarinExtensionReleaseInstallRequest, signal?: AbortSignal) {
    if (request.expectedHostId !== this.#hostId) throw new Error('Release preview belongs to another Host');
    const preview = this.#previews.get(request.previewId);
    if (!preview) throw new Error('Release preview is no longer available; preview the source again');
    if (request.expectedRevision !== preview.revision) throw new Error('Catalog changed since release preview; preview the source again');
    const { artifact } = preview;
    const current = (await this.#packages.catalog.store.read()).document.extensions[artifact.manifest.id];
    if (current && extensionSourceIdentity(current.source) !== extensionSourceIdentity(artifact.source) && !request.replaceSource) {
      throw new Error('Replacing an installed extension source requires explicit approval');
    }
    await this.#packages.artifacts.verifyPrepared(artifact, signal);
    // Catalog CAS and candidate publication remain with the original package owner.
    const snapshot = await this.#install(artifact, request.expectedRevision, signal);
    this.#previews.delete(request.previewId);
    return snapshot;
  }

  discard(previewId: string): void { this.#previews.delete(previewId); }

  async checkUpdates(extensionId?: string): Promise<VarinExtensionUpdateCheck[]> {
    // Read current installation facts before deduplicating. A Host-wide request
    // can span an update or source replacement while upstream metadata is pending.
    const read = await this.#packages.catalog.store.read();
    if (!read.authoritative) throw new Error('Cannot check updates from a stale extension catalog');
    const records = Object.values(read.document.extensions)
      .filter(record => record.source.kind !== 'builtin' && (!extensionId || record.manifest.id === extensionId));
    return Promise.all(records.map(record => {
      const key = JSON.stringify([record.manifest.id, extensionSourceIdentity(record.source), record.selectedVersion]);
      const pending = this.#checks.get(key);
      if (pending) return pending;
      const check = (async (): Promise<VarinExtensionUpdateCheck> => {
        const base = { extensionId: record.manifest.id, checkedAt: new Date().toISOString() };
        if (record.source.kind !== 'npm' && record.source.kind !== 'github-release') return { ...base, status: 'manual' };
        try {
          const release = await this.#resolve(record.source);
          if (release.extensionId && release.extensionId !== record.manifest.id) throw new Error('Release identity changed');
          return { ...base, version: release.version, status: semver.gt(release.version, record.selectedVersion) ? 'available' : release.warnings?.some(message => !message.startsWith('npm metadata')) ? 'unavailable' : 'current', ...(release.warnings?.length ? { message: release.warnings.join('; ') } : {}) };
        } catch (error) { return { ...base, status: 'failed', message: error instanceof Error ? error.message : String(error) }; }
      })();
      this.#checks.set(key, check);
      void check.finally(() => this.#checks.delete(key));
      return check;
    }));
  }
}

export function verifyReleaseIntegrity(bytes: Uint8Array, integrity: string): void {
  const tokens = integrity.split(/\s+/).map(token => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token)).filter(match => match !== null);
  const strongest = ['sha512', 'sha384', 'sha256'].find(algorithm => tokens.some(token => token[1] === algorithm));
  if (!strongest || !tokens.some(token => token[1] === strongest && createHash(strongest).update(bytes).digest('base64') === token[2])) {
    throw new Error('Release archive integrity mismatch or unsupported digest');
  }
}

export async function verifyReleaseFileIntegrity(file: string, integrity: string, signal?: AbortSignal): Promise<void> {
  const tokens = integrity.split(/\s+/).map(token => /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(token)).filter(match => match !== null);
  const strongest = ['sha512', 'sha384', 'sha256'].find(algorithm => tokens.some(token => token[1] === algorithm));
  if (!strongest) throw new Error('Release archive integrity mismatch or unsupported digest');
  const hash = createHash(strongest);
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  const digest = hash.digest('base64');
  if (!tokens.some(token => token[1] === strongest && token[2] === digest)) throw new Error('Release archive integrity mismatch or unsupported digest');
}

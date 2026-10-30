import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DesktopCompanionPack } from '@varin/application-client/desktop';

interface AssetFile { path: string; bytes: number; sha256: string }
export interface CompanionAssetPack { id: string; name: string; version: string; bytes: number; baseUrl: string; files: AssetFile[] }
export interface CompanionAssetCatalog { schemaVersion: 1; packs: CompanionAssetPack[] }
type Download = NonNullable<DesktopCompanionPack['download']>;
const safeId = (id: string) => /^[a-z0-9][a-z0-9_-]*$/u.test(id);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function readCompanionAssetCatalog(raw: unknown): CompanionAssetCatalog {
  const input = raw as CompanionAssetCatalog;
  if (input?.schemaVersion !== 1 || !Array.isArray(input.packs)) throw new Error('Invalid companion catalog');
  const ids = new Set<string>();
  for (const pack of input.packs) {
    if (!safeId(pack.id) || ids.has(pack.id) || typeof pack.name !== 'string' || !/^[a-f0-9]{64}$/u.test(pack.version)
      || !Array.isArray(pack.files) || new URL(pack.baseUrl).protocol !== 'https:') throw new Error('Invalid companion pack');
    ids.add(pack.id);
    const files = new Set<string>();
    for (const file of pack.files) {
      if (!/^[\w.-]+\.(json|png)$/u.test(file.path) || files.has(file.path)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid companion file');
      files.add(file.path);
    }
    if (!files.has('bundle.json') || pack.bytes !== pack.files.reduce((sum, file) => sum + file.bytes, 0)
      || sha256(Buffer.from(JSON.stringify(pack.files))) !== pack.version) throw new Error('Companion catalog integrity mismatch');
  }
  return input;
}

/** Desktop-owned optional artwork cache. It never writes workspace or conversation files. */
export class CompanionAssets {
  private installed = new Map<string, CompanionAssetPack>();
  private downloads = new Map<string, Download>();
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private publications = new Map<string, Promise<void>>();
  private lastNotification = 0;

  constructor(private options: {
    root: string; catalog: CompanionAssetCatalog; fetch(url: string, init: RequestInit): Promise<Response>;
    changed(): void; beforeReplace?(id: string): void; afterReplace?(id: string): void;
  }) { readCompanionAssetCatalog(options.catalog); }

  private location(id: string, staging = false): string {
    if (!safeId(id)) throw new Error('Invalid companion identity');
    return path.join(this.options.root, staging ? 'downloads' : 'packs', id);
  }
  private notify(progress = false): void {
    const now = Date.now();
    // Stream bytes freely; coalesce native IPC repaint notices rather than rendering per packet.
    if (progress && now - this.lastNotification < 100) return;
    this.lastNotification = now; this.options.changed();
  }
  private async readInstalled(directory: string): Promise<CompanionAssetPack | null> {
    try {
      if (!(await fs.lstat(directory)).isDirectory()) return null;
      const pack = JSON.parse(await fs.readFile(path.join(directory, 'installed.json'), 'utf8')) as CompanionAssetPack;
      readCompanionAssetCatalog({ schemaVersion: 1, packs: [pack] });
      const files = await Promise.all(pack.files.map(async file => {
        const stat = await fs.lstat(path.join(directory, file.path));
        return stat.isFile() && stat.size === file.bytes;
      }));
      return files.every(Boolean) ? pack : null;
    } catch { return null; }
  }
  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.options.root, 'packs'), { recursive: true });
    // A process may stop between the two directory renames. Restore the previous valid
    // generation before publishing availability, then reclaim superseded directories.
    for (const name of await fs.readdir(this.options.root)) {
      if (!/^retired-[a-f0-9-]{36}$/u.test(name)) continue;
      const retired = path.join(this.options.root, name), previous = await this.readInstalled(retired);
      if (previous && !await this.readInstalled(this.location(previous.id))) {
        await fs.rm(this.location(previous.id), { recursive: true, force: true });
        await fs.rename(retired, this.location(previous.id));
      } else await fs.rm(retired, { recursive: true, force: true });
    }
    for (const name of await fs.readdir(path.join(this.options.root, 'packs'))) {
      if (!safeId(name)) continue;
      const pack = await this.readInstalled(this.location(name));
      if (pack?.id === name) this.installed.set(name, pack);
    }
    for (const pack of this.options.catalog.packs) {
      let cached = 0;
      try {
        for (const name of await fs.readdir(this.location(pack.id, true))) {
          const stat = await fs.lstat(path.join(this.location(pack.id, true), name));
          if (stat.isFile()) cached += stat.size;
        }
      } catch { /* There may be no optional download cache. */ }
      if (cached) this.downloads.set(pack.id, { state: 'cancelled', receivedBytes: cached, totalBytes: pack.bytes });
    }
  }
  get(id: string): CompanionAssetPack | undefined { return this.installed.get(id); }
  async ready(id: string | null): Promise<void> { if (id) await this.publications.get(id); }
  list(): DesktopCompanionPack[] {
    const packs = new Map(this.options.catalog.packs.map(pack => [pack.id, pack]));
    for (const pack of this.installed.values()) if (!packs.has(pack.id)) packs.set(pack.id, pack);
    return [...packs.values()].map(pack => ({ id: pack.id, name: pack.name, version: pack.version, downloadBytes: pack.bytes,
      installedVersion: this.installed.get(pack.id)?.version ?? null, installedBytes: this.installed.get(pack.id)?.bytes ?? 0,
      download: this.downloads.get(pack.id) ?? null,
    }));
  }
  start(id: string): void {
    if (this.jobs.has(id)) return;
    const pack = this.options.catalog.packs.find(pack => pack.id === id);
    if (!pack) throw new Error('Companion is not in the downloadable catalog');
    if (this.installed.get(id)?.version === pack.version) return;
    const controller = new AbortController();
    this.downloads.set(id, { state: 'downloading', receivedBytes: 0, totalBytes: pack.bytes });
    const done = Promise.resolve().then(() => this.install(pack, controller.signal)).catch(error => {
      const progress = this.downloads.get(id) ?? { receivedBytes: 0, totalBytes: pack.bytes };
      this.downloads.set(id, { ...progress, state: controller.signal.aborted ? 'cancelled' : 'failed',
        ...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }) });
    }).finally(() => { this.jobs.delete(id); this.notify(); });
    this.jobs.set(id, { controller, done });
    this.notify();
  }
  async wait(id: string): Promise<void> { await this.jobs.get(id)?.done; }
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    job?.controller.abort(new Error('Companion download cancelled'));
    await job?.done;
  }
  async remove(id: string): Promise<void> {
    if (!this.list().some(pack => pack.id === id)) throw new Error('Unknown companion');
    await this.cancel(id);
    await fs.rm(this.location(id), { recursive: true, force: true });
    await fs.rm(this.location(id, true), { recursive: true, force: true });
    this.installed.delete(id); this.downloads.delete(id); this.notify();
  }
  private async verified(file: string, expected: AssetFile): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      return stat.isFile() && stat.size === expected.bytes && sha256(await fs.readFile(file)) === expected.sha256;
    } catch { return false; }
  }
  private async install(pack: CompanionAssetPack, signal: AbortSignal): Promise<void> {
    const staging = this.location(pack.id, true);
    await fs.mkdir(staging, { recursive: true });
    let receivedBytes = 0;
    const progress = (bytes: number) => {
      receivedBytes += bytes;
      this.downloads.set(pack.id, { state: 'downloading', receivedBytes, totalBytes: pack.bytes });
      this.notify(true);
    };
    for (const file of pack.files) {
      signal.throwIfAborted();
      const target = path.join(staging, file.path);
      if (await this.verified(target, file)) { progress(file.bytes); continue; }
      const response = await this.options.fetch(new URL(file.path, pack.baseUrl).toString(), { signal, credentials: 'omit', cache: 'no-store' });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Companion download failed (${response.status}): ${file.path}`);
      }
      const temp = `${target}.part`, hash = createHash('sha256');
      const writer = await fs.open(temp, 'w');
      const reader = response.body.getReader();
      const abortReader = () => { void reader.cancel(signal.reason).catch(() => {}); };
      signal.addEventListener('abort', abortReader, { once: true });
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > file.bytes) throw new Error(`Companion file size mismatch: ${file.path}`);
          hash.update(chunk); await writer.writeFile(chunk); progress(chunk.byteLength);
        }
        signal.throwIfAborted();
        if (size !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Companion file integrity mismatch: ${file.path}`);
      } finally {
        signal.removeEventListener('abort', abortReader);
        await reader.cancel().catch(() => {}); reader.releaseLock(); await writer.close();
      }
      await fs.rename(temp, target);
    }
    signal.throwIfAborted();
    const currentNames = new Set(pack.files.map(file => file.path));
    for (const name of await fs.readdir(staging)) {
      if (!currentNames.has(name)) await fs.rm(path.join(staging, name), { recursive: true, force: true });
    }
    await fs.writeFile(path.join(staging, 'installed.json'), JSON.stringify(pack));
    const active = this.location(pack.id), retired = path.join(this.options.root, `retired-${randomUUID()}`);
    let moved = false;
    let published!: () => void;
    this.publications.set(pack.id, new Promise(resolve => { published = resolve; }));
    try {
      this.options.beforeReplace?.(pack.id);
      try { await fs.rename(active, retired); moved = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await fs.rename(staging, active); }
      catch (error) { if (moved) await fs.rename(retired, active); throw error; }
      this.installed.set(pack.id, pack); this.downloads.delete(pack.id);
      if (moved) await fs.rm(retired, { recursive: true, force: true });
    } finally {
      this.publications.delete(pack.id); published(); this.options.afterReplace?.(pack.id);
    }
  }
  /** Resolve only installed, catalog-declared inert files; URL input never becomes an arbitrary disk path. */
  async resolve(requestPath: string): Promise<string | null> {
    const [id, version, ...parts] = requestPath.split('/');
    if (!id || !version || parts.length !== 1) return null;
    const pack = this.installed.get(id), name = parts[0]!;
    if (!pack || version !== pack.version || !pack.files.some(file => file.path === name)) return null;
    const file = path.join(this.location(id), name);
    try { return (await fs.lstat(file)).isFile() ? file : null; } catch { return null; }
  }
}

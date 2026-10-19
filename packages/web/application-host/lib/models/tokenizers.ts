/** Public tokenizer resources are derived Host data, independent of model credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { ModelTokenizer } from '@varin/application-client';
import type { TokenizerBinding } from '../kernel/protocol.generated.js';
import type { EgressFetch } from '../harness/egress.js';
import { validTokenizer } from './tokenizer-metadata.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const compress = promisify(gzip);
type Network = { fetch: EgressFetch; signal: AbortSignal };
type Entry = { sha256: string; revision?: string; sourceVersion?: string };
export type TokenizerLease = { tokenizer?: TokenizerBinding; release(): void };
type CollectionRoots = { sources(): Promise<ModelTokenizer[]>; durable(): Promise<TokenizerBinding[]> };
export class ModelTokenizers {
  readonly #root: string;
  readonly #ready = new Map<string, TokenizerBinding>();
  readonly #fileVersions = new Map<string, string>();
  readonly #jobs = new Map<string, Promise<TokenizerBinding | undefined>>();
  readonly #issues = new Map<string, string>();
  readonly #pins = new Map<string, number>();
  #gate: Promise<unknown> = Promise.resolve();
  #roots: CollectionRoots | undefined;
  #collection: Promise<void> | undefined;
  #requested = false;
  #obsolete = false;
  constructor(directory: string, private readonly network: () => Network | undefined, private readonly changed: () => void) {
    this.#root = join(directory, 'cache', 'tokenizers');
  }
  #key(source: ModelTokenizer) {
    return digest(JSON.stringify(source.kind === 'encoding' ? [source.kind, source.name]
      : source.kind === 'huggingface' ? [source.kind, source.repository, source.revision ?? 'main']
        : source.kind === 'url' ? [source.kind, source.url] : [source.kind, source.path]));
  }
  issue(source: ModelTokenizer) { return this.#issues.get(this.#key(source)); }
  cached(source: ModelTokenizer) { return this.#exclusive(() => this.#cached(source)); }
  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#gate.then(action);
    this.#gate = result.catch(() => undefined);
    return result;
  }
  #binding(entry: Entry): Extract<TokenizerBinding, { kind: 'file' }> {
    return { kind: 'file', path: join(this.#root, `${entry.sha256}.json.gz`), sha256: entry.sha256 };
  }
  async #cached(source: ModelTokenizer): Promise<TokenizerBinding | undefined> {
    if (source.kind === 'encoding') return { kind: 'encoding', name: source.name };
    const key = this.#key(source), ready = this.#ready.get(key);
    try {
      const local = source.kind === 'file' ? await stat(source.path) : undefined;
      const version = local ? `${local.mtimeMs}:${local.ctimeMs}:${local.size}` : undefined;
      if (ready && (!local || this.#fileVersions.get(key) === version)) return ready;
      this.#ready.delete(key);
      const entry: Entry = JSON.parse(await readFile(join(this.#root, `${key}.ref`), 'utf8'));
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) return undefined;
      if (local && entry.sourceVersion !== version) return undefined;
      const binding = this.#binding(entry);
      try { if (!(await stat(binding.path)).isFile()) return undefined; }
      catch {
        binding.path = join(this.#root, `${entry.sha256}.json`);
        if (!(await stat(binding.path)).isFile()) return undefined;
      }
      if (version) this.#fileVersions.set(key, version);
      this.#ready.set(key, binding); return binding;
    } catch { return undefined; }
  }
  /** Preparing a conversation never waits for a public download. Later bindings use the cache. */
  async resolve(source: ModelTokenizer): Promise<TokenizerBinding | undefined> {
    const cached = await this.cached(source);
    if (cached) return cached;
    void this.prepare(source);
    return undefined;
  }
  async prepare(source: ModelTokenizer): Promise<TokenizerBinding | undefined> {
    if (!validTokenizer(source)) return undefined;
    // Downloads/compression run outside the gate; publishing and collection share it.
    const selected = await this.#exclusive(async () => {
      const cached = await this.#cached(source);
      if (cached) return { cached };
      const key = this.#key(source), pending = this.#jobs.get(key);
      if (pending) return { job: pending };
      const network = this.network();
      if (source.kind !== 'file' && !network) return {};
      const job = this.#load(source, network).then(({ entry, compressed }) => this.#exclusive(async () => {
        const binding = this.#binding(entry);
        await this.#atomic(binding.path, compressed);
        await this.#atomic(join(this.#root, `${key}.ref`), Buffer.from(JSON.stringify(entry)));
        if (entry.sourceVersion) this.#fileVersions.set(key, entry.sourceVersion);
        this.#ready.set(key, binding); this.#issues.delete(key); return binding;
      })).catch(error => {
        if (!network?.signal.aborted) this.#issues.set(key, error instanceof Error ? error.message : 'Tokenizer preparation failed');
        return undefined;
      }).finally(() => { this.#jobs.delete(key); this.changed(); void this.collect(); });
      this.#jobs.set(key, job); return { job };
    });
    return selected.cached ?? selected.job;
  }
  /** Pin before returning a binding, including the interval before native admission. */
  acquire(source?: ModelTokenizer, inherited?: { tokenizer?: TokenizerBinding }): Promise<TokenizerLease> {
    return this.#exclusive(async () => {
      const tokenizer = inherited ? inherited.tokenizer : source ? await this.#cached(source) : undefined;
      if (!inherited && source && !tokenizer) void this.prepare(source);
      const hash = tokenizer?.kind === 'file' ? tokenizer.sha256 : undefined;
      if (hash) this.#pins.set(hash, (this.#pins.get(hash) ?? 0) + 1);
      let released = false;
      return { ...(tokenizer ? { tokenizer } : {}), release: () => {
        if (released) return; released = true;
        if (hash) {
          const count = this.#pins.get(hash)! - 1;
          if (count) this.#pins.set(hash, count); else this.#pins.delete(hash);
        }
        if (this.#obsolete) void this.collect();
      } };
    });
  }
  startCollection(roots: CollectionRoots): () => Promise<void> {
    this.#roots = roots; void this.collect();
    return async () => { this.#roots = undefined; await this.#collection; };
  }
  collect(): Promise<void> {
    if (!this.#roots) return Promise.resolve();
    this.#requested = true;
    return this.#collection ??= (async () => {
      while (this.#roots && this.#requested) {
        this.#requested = false;
        const raw = await this.#exclusive(() => this.#collect());
        for (const path of raw) {
          // Legacy compression is CPU work in zlib's worker pool, outside the binding gate.
          const compressed = await compress(await readFile(path));
          await this.#exclusive(async () => {
            await this.#atomic(`${path}.gz`, compressed);
            await rm(path, { force: true });
          });
        }
      }
    })().catch(() => {
      // Leave files in place when the owning runtime cannot supply its references.
      console.error('[Models] Tokenizer cache maintenance could not complete');
    }).finally(() => { this.#collection = undefined; });
  }
  async #collect(): Promise<string[]> {
    const roots = this.#roots;
    if (!roots) return [];
    let files: string[];
    try { files = await readdir(this.#root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    // Atomic writers use this same gate, so remaining owned staging files are abandoned.
    for (const file of files.filter(name => /^[a-f0-9]{64}\.(?:json(?:\.gz)?|ref)\.[a-f0-9-]{36}\.tmp$/.test(name))) {
      await rm(join(this.#root, file), { force: true });
    }
    const keys = new Set((await roots.sources()).map(source => this.#key(source)));
    const keep = new Set<string>();
    for (const file of files.filter(name => /^[a-f0-9]{64}\.ref$/.test(name))) {
      const key = file.slice(0, -4);
      if (keys.has(key)) {
        const entry: Entry = JSON.parse(await readFile(join(this.#root, file), 'utf8'));
        keep.add(entry.sha256);
      } else {
        await rm(join(this.#root, file), { force: true });
        this.#ready.delete(key); this.#fileVersions.delete(key); this.#issues.delete(key);
      }
    }
    const blobs = files.filter(name => /^[a-f0-9]{64}\.json(?:\.gz)?$/.test(name));
    const candidates = new Set(blobs.filter(name => !keep.has(name.slice(0, 64))));
    for (const hash of this.#pins.keys()) keep.add(hash);
    this.#obsolete = candidates.size > 0;
    if ([...candidates].some(name => !keep.has(name.slice(0, 64)))) for (const binding of await roots.durable()) {
      if (binding.kind === 'file') keep.add(binding.sha256);
    }
    let retainedOld = false;
    const raw: string[] = [];
    for (const file of blobs) {
      const hash = file.slice(0, 64), path = join(this.#root, file);
      if (!keep.has(hash)) { await rm(path, { force: true }); continue; }
      if (candidates.has(file)) retainedOld = true;
      if (file.endsWith('.json')) raw.push(path);
    }
    this.#obsolete = retainedOld;
    return raw;
  }
  async #load(source: ModelTokenizer, network?: Network): Promise<{ entry: Entry; compressed: Buffer }> {
    let bytes: Uint8Array; let revision: string | undefined; let sourceVersion: string | undefined;
    if (source.kind === 'file') {
      const info = await stat(source.path);
      sourceVersion = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      bytes = await readFile(source.path);
    }
    else {
      if (source.kind === 'encoding' || !network) throw new Error('Tokenizer source unavailable');
      const url = source.kind === 'url' ? source.url
        : `https://huggingface.co/${source.repository}/resolve/${encodeURIComponent(source.revision ?? 'main')}/tokenizer.json`;
      const response = await network.fetch(url, { signal: network.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`Tokenizer download failed (HTTP ${response.status})`);
      revision = response.headers.get('x-repo-commit') ?? undefined;
      bytes = new Uint8Array(await response.arrayBuffer()); network.signal.throwIfAborted();
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('Expected a valid tokenizer.json file'); }
    if (!body || typeof body !== 'object' || !('model' in body) || !body.model || typeof body.model !== 'object') throw new Error('Expected a tokenizer.json file');
    const entry = { sha256: digest(bytes), ...(revision ? { revision } : {}), ...(sourceVersion ? { sourceVersion } : {}) };
    return { entry, compressed: await compress(bytes) };
  }
  async #atomic(path: string, bytes: Uint8Array) {
    await mkdir(this.#root, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}

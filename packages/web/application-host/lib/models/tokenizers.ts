/** Public tokenizer resources are derived Host data, independent of model credentials. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelTokenizer } from '@varin/application-client';
import type { TokenizerBinding } from '../kernel/protocol.generated.js';
import type { EgressFetch } from '../harness/egress.js';
import { validTokenizer } from './tokenizer-metadata.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Network = { fetch: EgressFetch; signal: AbortSignal };
type Entry = { sha256: string; revision?: string; sourceVersion?: string };
export class ModelTokenizers {
  readonly #root: string;
  readonly #ready = new Map<string, TokenizerBinding>();
  readonly #fileVersions = new Map<string, string>();
  readonly #jobs = new Map<string, Promise<TokenizerBinding | undefined>>();
  readonly #issues = new Map<string, string>();
  constructor(directory: string, private readonly network: () => Network | undefined, private readonly changed: () => void) {
    this.#root = join(directory, 'cache', 'tokenizers');
  }
  #key(source: ModelTokenizer) {
    return digest(JSON.stringify(source.kind === 'encoding' ? [source.kind, source.name]
      : source.kind === 'huggingface' ? [source.kind, source.repository, source.revision ?? 'main']
        : source.kind === 'url' ? [source.kind, source.url] : [source.kind, source.path]));
  }
  issue(source: ModelTokenizer) { return this.#issues.get(this.#key(source)); }
  cached(source: ModelTokenizer) { return this.#cached(source); }
  #binding(entry: Entry): Extract<TokenizerBinding, { kind: 'file' }> {
    return { kind: 'file', path: join(this.#root, `${entry.sha256}.json`), sha256: entry.sha256 };
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
      if (!(await stat(binding.path)).isFile()) return undefined;
      if (version) this.#fileVersions.set(key, version);
      this.#ready.set(key, binding); return binding;
    } catch { return undefined; }
  }
  /** Preparing a conversation never waits for a public download. Later bindings use the cache. */
  async resolve(source: ModelTokenizer): Promise<TokenizerBinding | undefined> {
    const cached = await this.#cached(source);
    if (cached) return cached;
    void this.prepare(source);
    return undefined;
  }
  async prepare(source: ModelTokenizer): Promise<TokenizerBinding | undefined> {
    if (!validTokenizer(source)) return undefined;
    const cached = await this.#cached(source);
    if (cached) return cached;
    const key = this.#key(source), pending = this.#jobs.get(key);
    if (pending) return pending;
    const network = this.network();
    if (source.kind !== 'file' && !network) return undefined;
    const job = this.#load(source, network).then(async entry => {
      const binding = this.#binding(entry);
      await this.#atomic(join(this.#root, `${key}.ref`), Buffer.from(JSON.stringify(entry)));
      if (entry.sourceVersion) this.#fileVersions.set(key, entry.sourceVersion);
      this.#ready.set(key, binding); this.#issues.delete(key); return binding;
    }).catch(error => {
      if (!network?.signal.aborted) this.#issues.set(key, error instanceof Error ? error.message : 'Tokenizer preparation failed');
      return undefined;
    }).finally(() => { this.#jobs.delete(key); this.changed(); });
    this.#jobs.set(key, job); return job;
  }
  async #load(source: ModelTokenizer, network?: Network): Promise<Entry> {
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
    await this.#atomic(this.#binding(entry).path, bytes);
    return entry;
  }
  async #atomic(path: string, bytes: Uint8Array) {
    await mkdir(this.#root, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
}

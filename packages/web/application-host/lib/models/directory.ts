/** Derived directory cache. Each remote source refreshes independently of execution and other sources. */
import { join } from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import type { ChannelModel, ModelDirectoryStatus, ModelMetadataRequest } from '@varin/application-client';
import type { EgressFetch } from '../harness/egress.js';
import { object, revisionOf } from './configuration.js';
import { directoryModels } from './directory-models.js';
import { enrichModel } from './discovery.js';
import type { ChannelTypes } from './channel-types.js';
import { DIRECTORY_SNAPSHOT, OFFICIAL_DIRECTORY_SNAPSHOT } from './directory-snapshot.js';
import { CHANNEL_DIRECTORY_URL, BUNDLED_CHANNEL_DIRECTORY, parseChannelDirectory } from './channel-directory.js';
import { ModelMetadataIndex, modelDirectoryDefaults } from './metadata-match.js';

const METADATA_URL = 'https://models.dev/api.json';
// Freshness is a background refresh policy, never an execution/admission deadline.
const REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
interface CachedSource { body: unknown; etag?: string; checkedAt: number }
interface ConnectionDirectory { key: string; scope: string; models: ChannelModel[]; checkedAt: number }
interface PreparedSource { body?: unknown; commit(): void }
export class ModelDirectory {
  readonly #file;
  readonly #sources = new Map<string, CachedSource>();
  readonly #connections = new Map<string, ConnectionDirectory>();
  readonly #active = new Set<string>();
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #failures = new Set<string>();
  readonly #defaults: Map<string, ChannelModel[]>;
  #metadata!: ModelMetadataIndex;
  #metadataRevision = '';
  readonly ready: Promise<void>;
  #revision = 'bundled';
  #updatedAt: number | undefined;
  #issue: ModelDirectoryStatus['issue'];
  #refreshes = 0;
  #fetch: EgressFetch | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #refreshed: (() => void) | undefined;
  constructor(directory: string, readonly types: ChannelTypes, readonly changed: () => void) {
    this.#file = createSettingsFileStore({ filePath: join(directory, 'model-directory.json') });
    this.#defaults = new Map(types.entries().map(type => [type.id, structuredClone(type.catalog ?? [])]));
    this.#bundled();
    this.ready = this.#load();
  }
  #bundled() {
    for (const [id, models] of this.#defaults) this.types.setCatalog(id, models);
    this.#commitMetadata(this.#prepareMetadata(DIRECTORY_SNAPSHOT));
    for (const [url, body] of Object.entries(OFFICIAL_DIRECTORY_SNAPSHOT)) this.#sources.set(url, { body, checkedAt: 0 });
    this.#applyOfficial();
  }
  async #load() {
    try {
      const document = await this.#file.read();
      if (!Object.keys(document).length) return;
      if (document.version !== 1 || !object(document.sources)) throw new Error('Invalid directory cache');
      for (const [url, source] of Object.entries(document.sources)) {
        if (!object(source) || typeof source.checkedAt !== 'number' || !Number.isFinite(source.checkedAt) || source.etag !== undefined && typeof source.etag !== 'string') throw new Error('Invalid directory cache');
        this.#sources.set(url, source as unknown as CachedSource);
      }
      const channels = this.#sources.get(CHANNEL_DIRECTORY_URL);
      if (channels) this.types.prepareDirectory(parseChannelDirectory(channels.body))();
      const metadata = this.#sources.get(METADATA_URL);
      this.#commitMetadata(this.#prepareMetadata(metadata?.body ?? DIRECTORY_SNAPSHOT));
      this.#updatedAt = metadata?.checkedAt;
      if (object(document.connections)) for (const [id, entry] of Object.entries(document.connections)) {
        if (!object(entry) || typeof entry.key !== 'string' || typeof entry.scope !== 'string' || !Array.isArray(entry.models) || typeof entry.checkedAt !== 'number') throw new Error('Invalid connection directory');
        this.#connections.set(id, entry as unknown as ConnectionDirectory);
      }
      this.#applyOfficial();
    } catch { this.#sources.clear(); this.#connections.clear(); this.#updatedAt = undefined; this.#bundled(); this.#issue = 'cache-unavailable'; }
  }
  #prepareMetadata(body: unknown) {
    if (!object(body)) throw new Error('Invalid model directory');
    const candidate = new Map<string, ChannelModel[]>();
    for (const type of this.types.entries()) {
      if (!this.types.followsDirectory(type.id)) continue;
      const models = directoryModels(body, { ...type, catalog: this.#defaults.get(type.id) ?? [] });
      if (models) candidate.set(type.id, models);
    }
    if (!candidate.size) throw new Error('The model directory contains no supported providers');
    return { candidate, metadata: new ModelMetadataIndex(body, this.types), revision: revisionOf(body) };
  }
  #commitMetadata({ candidate, metadata, revision }: { candidate: Map<string, ChannelModel[]>; metadata: ModelMetadataIndex; revision: string }) {
    for (const [id, models] of candidate) this.types.setCatalog(id, models);
    this.#metadata = metadata;
    this.#metadataRevision = revision;
  }
  defaults(typeId: string, request: ModelMetadataRequest, models: readonly ChannelModel[] = []): ChannelModel | undefined {
    const type = this.types.get(typeId);
    return type ? modelDirectoryDefaults(this.#metadata, type, request, models) : undefined;
  }
  #applyOfficial() {
    for (const type of this.types.entries()) {
      if (!type.publicDirectory || !type.parseDiscovery) continue;
      const source = this.#sources.get(type.publicDirectory);
      if (!source) continue;
      const presets = new Map(type.catalog?.map(model => [model.id, model]));
      const models = type.parseDiscovery(source.body).map(model => ({ ...enrichModel(presets.get(model.id), model),
        enabled: presets.get(model.id)?.enabled ?? false, operations: model.operations ?? presets.get(model.id)?.operations ?? ['chat'], catalog: { overrides: [] } } as ChannelModel));
      this.types.setCatalog(type.id, models);
    }
    this.#revision = revisionOf([this.#metadataRevision, this.types.list(), this.types.entries().map(type => [type.id, type.catalog]), [...this.#connections].map(([id, value]) => [id, value.key, value.scope, value.models])]);
  }
  status(): ModelDirectoryStatus {
    const issue = this.#failures.has(METADATA_URL) ? 'refresh-failed' : this.#failures.size ? 'partial-refresh' : this.#issue;
    return { revision: this.#revision, ...(this.#updatedAt ? { updatedAt: this.#updatedAt } : {}), refreshing: this.#refreshes > 0, ...(issue ? { issue } : {}) };
  }
  contributionsChanged() { this.#applyOfficial(); }
  activate(type: string) { if (!this.#active.has(type)) { this.#active.add(type); if (this.#fetch) void this.refresh(); } }
  connection(id: string, key: string) { const entry = this.#connections.get(id); return entry?.key === key ? entry : undefined; }
  async remember(id: string, key: string, scope: string, models: ChannelModel[]) {
    this.#connections.set(id, { key, scope, models: structuredClone(models), checkedAt: Date.now() });
    this.#applyOfficial(); this.changed(); await this.#persist();
  }
  async forget(id: string) { if (this.#connections.delete(id)) { this.#applyOfficial(); await this.#persist(); } }
  async #persist() {
    try {
      await this.#file.replace({ version: 1, sources: Object.fromEntries(this.#sources), connections: Object.fromEntries(this.#connections) });
      this.#issue = undefined;
    } catch { this.#issue = 'cache-write-failed'; }
  }
  start(fetchImpl: EgressFetch, refreshed?: () => void) {
    this.#fetch = fetchImpl; this.#refreshed = refreshed; this.#controller = new AbortController();
    void this.refresh(); this.#schedule();
    return () => { this.#controller?.abort(); clearTimeout(this.#timer); this.#fetch = undefined; };
  }
  #schedule() {
    if (!this.#fetch) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void this.refresh(); this.#schedule(); }, REFRESH_INTERVAL);
    this.#timer.unref();
  }
  async refresh(force = false): Promise<ModelDirectoryStatus> {
    this.#refreshes += 1; this.changed();
    try {
      await this.ready;
      if (this.#fetch) {
        const jobs = [
          this.#refreshSource(CHANNEL_DIRECTORY_URL, force, body => {
            const previous = parseChannelDirectory(this.#sources.get(CHANNEL_DIRECTORY_URL)?.body ?? BUNDLED_CHANNEL_DIRECTORY);
            const merged = [...new Map([...previous, ...parseChannelDirectory(body)].map(entry => [entry.id, entry])).values()];
            const commit = this.types.prepareDirectory(merged);
            return { body: { version: 1, channels: merged }, commit: () => {
              commit(); this.#commitMetadata(this.#prepareMetadata(this.#sources.get(METADATA_URL)?.body ?? DIRECTORY_SNAPSHOT));
            } };
          }),
          this.#refreshSource(METADATA_URL, force, body => { const candidate = this.#prepareMetadata(body); return { commit: () => this.#commitMetadata(candidate) }; }),
        ];
        const publicSources = new Map(this.types.entries().filter(type => this.#active.has(type.id) && type.publicDirectory && type.parseDiscovery).map(type => [type.publicDirectory!, type]));
        for (const [url, type] of publicSources) jobs.push(this.#refreshSource(url, force, body => { type.parseDiscovery!(body); return { commit() {} }; }));
        await Promise.allSettled(jobs);
      }
    } finally { this.#refreshes -= 1; this.changed(); }
    return this.status();
  }
  #refreshSource(url: string, force: boolean, prepare: (body: unknown) => PreparedSource): Promise<void> {
    const pending = this.#jobs.get(url);
    if (pending) return pending;
    const old = this.#sources.get(url);
    if (!force && old && Date.now() - old.checkedAt < REFRESH_INTERVAL) return Promise.resolve();
    const fetchImpl = this.#fetch!;
    const signal = this.#controller!.signal;
    const work = Promise.resolve().then(async () => {
      try {
        const response = await fetchImpl(url, { headers: { accept: 'application/json', ...(old?.etag ? { 'if-none-match': old.etag } : {}) }, redirect: 'manual', signal });
        if (response.status === 304 && old) this.#sources.set(url, { ...old, checkedAt: Date.now() });
        else {
          if (!response.ok) throw new Error('Directory refresh failed');
          const body: unknown = await response.json(); signal.throwIfAborted();
          const candidate = prepare(body);
          this.#sources.set(url, { body: candidate.body ?? body, checkedAt: Date.now(), ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) });
          candidate.commit();
        }
        signal.throwIfAborted();
        this.#applyOfficial(); this.#updatedAt = Date.now(); this.#failures.delete(url); this.changed();
        this.#refreshed?.(); await this.#persist();
      } catch { if (!signal.aborted) this.#failures.add(url); }
      finally { this.#jobs.delete(url); this.changed(); }
    });
    this.#jobs.set(url, work);
    return work;
  }
}

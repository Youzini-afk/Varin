import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createSettingsFileStore, type SettingsFileStore } from '@varin/settings-store';
import { extensionSourceIdentity, parseGithubReleaseSource, parseNpmReleaseSource, parseVarinExtensionDiscoveryDocument, type VarinExtensionDiscoveryDocument, type VarinExtensionPackageSource } from '@varin/extension-contract';
import type { ApplicationExtensionCatalog, ExtensionReleaseFetch } from '@varin/extension-host';
import type { PluginCatalogSource, PluginCatalogState, PluginDiscoveryEntry, PluginDiscoverySnapshot } from '@varin/application-client';

/** The repository endpoint works independently of a particular Pages domain. */
export const OFFICIAL_PLUGIN_CATALOG = 'https://raw.githubusercontent.com/Astrmira/Varin-plugins/main/catalog/v1.json';

interface CachedCatalog {
  document?: VarinExtensionDiscoveryDocument;
  etag?: string;
  lastModified?: string;
  updatedAt?: string;
  checkedAt?: string;
  error?: string;
}

interface DiscoveryDocument {
  schemaVersion: 1;
  sources: PluginCatalogSource[];
  catalogs: Record<string, CachedCatalog>;
}

const object = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
);

export function pluginCatalogUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A plugin catalog URL is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Plugin catalogs require an HTTPS URL without credentials or a fragment');
  }
  return url.href;
}

export function parsePluginCatalogSources(value: unknown): PluginCatalogSource[] {
  if (!Array.isArray(value)) throw new Error('Plugin catalog sources must be an array');
  const sources = value.map(raw => {
    const entry = object(raw);
    if (!entry) throw new Error('A plugin catalog source must be an object');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('Catalog enabled must be a boolean');
    if (entry.displayName !== undefined && (typeof entry.displayName !== 'string' || !entry.displayName.trim())) {
      throw new Error('Catalog displayName must be nonempty');
    }
    return {
      url: pluginCatalogUrl(entry.url),
      enabled: entry.enabled !== false,
      ...(typeof entry.displayName === 'string' ? { displayName: entry.displayName.trim() } : {}),
    };
  });
  if (new Set(sources.map(source => source.url)).size !== sources.length) throw new Error('Plugin catalog URLs must be unique');
  return sources;
}

function parseDocument(value: unknown): DiscoveryDocument {
  const raw = object(value);
  if (!raw || raw.schemaVersion !== 1 || !object(raw.catalogs)) throw new Error('Unsupported or malformed plugin discovery cache');
  const sources = parsePluginCatalogSources(raw.sources);
  const catalogs: Record<string, CachedCatalog> = {};
  for (const source of sources) {
    const cached = object((raw.catalogs as Record<string, unknown>)[source.url]);
    if (!cached) continue;
    const entry: CachedCatalog = {};
    if (cached.document !== undefined) entry.document = parseVarinExtensionDiscoveryDocument(cached.document);
    for (const key of ['etag', 'lastModified', 'updatedAt', 'checkedAt', 'error'] as const) {
      if (cached[key] !== undefined) {
        if (typeof cached[key] !== 'string') throw new Error(`Malformed plugin catalog cache ${key}`);
        entry[key] = cached[key];
      }
    }
    catalogs[source.url] = entry;
  }
  return { schemaVersion: 1, sources, catalogs };
}

/** Browsing only reads the catalog and its same-origin static images, never author release endpoints. */
export class PluginDiscoveryService {
  readonly #store: SettingsFileStore;
  readonly #hostId: string;
  readonly #hostLabel: string | undefined;
  readonly #fetch: ExtensionReleaseFetch;
  readonly #now: () => Date;
  readonly #catalog: ApplicationExtensionCatalog | undefined;
  readonly #refreshes = new Map<string, Promise<void>>();

  constructor(options: { dataDir: string; hostId: string; hostLabel?: string; catalog?: ApplicationExtensionCatalog; fetch?: ExtensionReleaseFetch; store?: SettingsFileStore; now?: () => Date }) {
    this.#hostId = options.hostId;
    this.#hostLabel = options.hostLabel;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#catalog = options.catalog;
    this.#store = options.store ?? createSettingsFileStore({
      filePath: join(options.dataDir, 'extensions', 'discovery.json'),
      defaultValue: {
        schemaVersion: 1,
        sources: [{ url: OFFICIAL_PLUGIN_CATALOG, displayName: 'Varin', enabled: true }],
        catalogs: {},
      },
    });
  }

  async snapshot(): Promise<PluginDiscoverySnapshot> {
    const document = parseDocument(await this.#store.read());
    const installed = this.#catalog ? (await this.#catalog.store.read()).document.extensions : {};
    const sources: PluginCatalogState[] = [];
    const listings = new Map<string, PluginDiscoveryEntry>();
    for (const source of document.sources) {
      const cached = document.catalogs[source.url];
      sources.push({
        ...source,
        status: cached?.document ? cached.error ? 'stale' : 'ready' : cached?.error ? 'error' : 'unloaded',
        ...(cached?.updatedAt ? { updatedAt: cached.updatedAt } : {}),
        ...(cached?.checkedAt ? { checkedAt: cached.checkedAt } : {}),
        ...(cached?.error ? { error: cached.error } : {}),
      });
      if (!source.enabled || !cached?.document) continue;
      for (const entry of cached.document.entries) {
        // Presentation changes cannot make one catalog take over a different author's source.
        const identity = extensionSourceIdentity(entry.source);
        const key = createHash('sha256').update(JSON.stringify([entry.id, identity])).digest('hex');
        const previous = listings.get(key);
        if (previous) previous.catalogs.push(source.url);
        else listings.set(key, { key, entry: structuredClone(entry), catalogs: [source.url],
          installed: !!installed[entry.id] && extensionSourceIdentity(installed[entry.id]!.source) === identity });
      }
    }
    return { hostId: this.#hostId, ...(this.#hostLabel ? { hostLabel: this.#hostLabel } : {}), sources, entries: [...listings.values()] };
  }

  /** Public navigation must still locate an installation when its directory has gone away. */
  async resolveInstalled(source: VarinExtensionPackageSource, extensionId?: string): Promise<{ hostId: string; extensionId?: string }> {
    if (source.kind === 'github-release') parseGithubReleaseSource(source.specifier);
    else if (source.kind === 'npm') parseNpmReleaseSource(source.specifier);
    else throw new Error('Public installation links require a GitHub release or npm registry source');
    const read = await this.#catalog?.store.read();
    if (read && !read.authoritative) throw new Error('Cannot locate installed plugins from a stale catalog');
    const identity = extensionSourceIdentity(source);
    const matches = Object.values(read?.document.extensions ?? {}).filter(record =>
      (!extensionId || record.manifest.id === extensionId) && extensionSourceIdentity(record.source) === identity);
    return { hostId: this.#hostId, ...(matches.length === 1 ? { extensionId: matches[0]!.manifest.id } : {}) };
  }

  async setSources(value: unknown): Promise<PluginDiscoverySnapshot> {
    const sources = parsePluginCatalogSources(value);
    await this.#store.update(raw => {
      const current = parseDocument(raw);
      return {
        schemaVersion: 1,
        sources,
        catalogs: Object.fromEntries(sources.flatMap(source => current.catalogs[source.url] ? [[source.url, current.catalogs[source.url]]] : [])),
      };
    });
    return this.snapshot();
  }

  async refresh(): Promise<PluginDiscoverySnapshot> {
    const document = parseDocument(await this.#store.read());
    await Promise.all(document.sources.filter(source => source.enabled).map(source => this.#refresh(source.url)));
    return this.snapshot();
  }

  #refresh(url: string): Promise<void> {
    const previous = this.#refreshes.get(url);
    if (previous) return previous;
    const pending = this.#fetchCatalog(url).finally(() => { this.#refreshes.delete(url); });
    this.#refreshes.set(url, pending);
    return pending;
  }

  async #fetchCatalog(url: string): Promise<void> {
    const prior = parseDocument(await this.#store.read()).catalogs[url];
    const headers = new Headers({ Accept: 'application/json' });
    if (prior?.etag) headers.set('If-None-Match', prior.etag);
    if (prior?.lastModified) headers.set('If-Modified-Since', prior.lastModified);
    let next: CachedCatalog;
    const checkedAt = this.#now().toISOString();
    try {
      // A directory address is a stable public endpoint. Redirects cannot move discovery to an author or credential endpoint.
      const response = await this.#fetch(url, { headers, redirect: 'error' });
      if (response.status === 304) {
        if (!prior?.document) throw new Error('The catalog returned Not Modified without a cached document');
        next = { ...prior, checkedAt };
        delete next.error;
      } else {
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          throw new Error(`Catalog request failed (${response.status})${retryAfter ? `; retry after ${retryAfter}` : ''}`);
        }
        const document = parseVarinExtensionDiscoveryDocument(await response.json());
        for (const entry of document.entries) {
          if (entry.source.kind !== 'npm' && entry.source.kind !== 'github-release') {
            throw new Error(`Public catalog source for ${entry.id} must be a GitHub release or npm registry package`);
          }
          if (!entry.icon) continue;
          const icon = new URL(entry.icon, url);
          if (icon.origin !== new URL(url).origin || icon.username || icon.password) {
            throw new Error(`Catalog icon for ${entry.id} must be a static resource on the catalog origin`);
          }
          entry.icon = icon.href;
        }
        next = {
          document, checkedAt, updatedAt: checkedAt,
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
          ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
        };
      }
    } catch (error) {
      next = { ...prior, checkedAt, error: error instanceof Error ? error.message : 'Catalog request failed' };
    }
    await this.#store.update(raw => {
      const current = parseDocument(raw);
      // Removing a source while a refresh is in flight cannot resurrect it.
      if (!current.sources.some(source => source.url === url && source.enabled)) return;
      return { ...current, catalogs: { ...current.catalogs, [url]: next } };
    });
  }
}

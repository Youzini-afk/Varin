/** A query's admitted source over an existing immutable numeric publication.
 * Source bytes and permissions remain with the original Run/Storage owner. */
import path from 'node:path';
import { indexPathAllowed, type IndexScope } from '../index-scope.js';
import { spaceIdOf, type SemanticScopeKey } from './identity.js';
import type { SemanticEmbedder } from './embedder.js';
import type { EmbedScheduler } from './embed-scheduler.js';
import type { SemanticVectorCache } from './vector-cache.js';
import type { SemanticGenerationStore } from './store.js';
import type { SemanticSourceView } from './query-view.js';
import type { SemanticIndexStatus, SemanticSearchResult } from './runtime.js';
import { waitWithSignal } from '../../cancellation.js';

function resourcePaths(root: string) {
  const coordinates = /^[a-z]:[\\/]|^\\\\/i.test(root) ? path.win32 : path.posix;
  const inside = (directory: string, target: string) => {
    const relative = coordinates.relative(directory, target);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${coordinates.sep}`) && !coordinates.isAbsolute(relative);
  };
  return { coordinates, inside };
}

/** Pure identity intersection. A removed/replaced old live directory cannot reroute this view. */
export function sourceViewRoots(root: string, requested: readonly string[], selected: readonly string[] | null | undefined,
  scope?: IndexScope): string[] {
  const { coordinates, inside } = resourcePaths(root);
  const directories = scope ? [...scope.directories, ...(scope.pausedDirectories ?? [])] : selected ?? [root];
  const paths = directories.flatMap(directory => requested.flatMap(relative => {
    const target = coordinates.resolve(root, relative);
    if (inside(directory, target)) return [target];
    return inside(target, directory) ? [directory] : [];
  })).filter(directory => inside(root, directory) && (!scope || indexPathAllowed(scope, directory, true)));
  return [...new Set(paths)].map(directory => coordinates.relative(root, directory).split(coordinates.sep).join('/') || '.');
}

export async function acquireSourceQuery(input: {
  scope: SemanticScopeKey;
  source: SemanticSourceView;
  embedder: SemanticEmbedder;
  roots: readonly string[];
  indexScope?: IndexScope;
  indexDirectories?: readonly string[] | null;
  cache: SemanticVectorCache;
  scheduler: EmbedScheduler;
  signal: AbortSignal;
  store(): SemanticGenerationStore;
  assertAvailable(): void;
  authorize(signal: AbortSignal): Promise<void>;
  cacheAuthority: string;
  queryVector(question: string, cached: number[] | undefined, signal: AbortSignal): Promise<number[]>;
}) {
  const { source, embedder, cache, scope } = input;
  const schedule = <T>(work: () => Promise<T>): Promise<T> => embedder.ownsScheduling ? work() : input.scheduler.enqueue('foreground', work);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const roots = sourceViewRoots(source.resourceRoot, input.roots, input.indexDirectories, input.indexScope);
  await input.authorize(signal);
  input.assertAvailable(); signal.throwIfAborted();
  let released = false;
  const store = embedder.space.dim > 0 && roots.length ? input.store() : undefined;
  // Query only the publication that already exists. New/changed source files
  // remain available through lexical retrieval; this request never builds an index.
  const reader = await store?.retainPublished(signal) ?? undefined;
  const assertAvailable = () => {
    signal.throwIfAborted(); input.assertAvailable();
    if (released) throw new Error('Semantic source view was released');
    if (reader && store) store.assertPublishedReaderAvailable(reader.token);
  };
  const authorize = async (active: AbortSignal) => {
    active.throwIfAborted(); assertAvailable(); await input.authorize(active); active.throwIfAborted(); assertAvailable();
  };
  const status: SemanticIndexStatus = Object.freeze({ scope,
    status: roots.length ? 'incomplete' : 'unavailable',
    coverage: reader ? 'partial' : 'empty',
    lifecycle: reader?.checkpoint.lifecycle ?? 'idle',
    generation: reader?.publicationId ?? null, spaceId: embedder.space.dim > 0 ? spaceIdOf(embedder.space) : null });
  return {
    reader: reader ?? null, status, assertAvailable,
    async release() {
      if (released) return;
      released = true; lifetime.abort();
      if (reader && store) await store.releasePinned(reader.token);
    },
    async search(question: string, limit: number, searchSignal?: AbortSignal): Promise<SemanticSearchResult> {
      const active = AbortSignal.any([signal, ...(searchSignal ? [searchSignal] : [])]);
      await authorize(active);
      if (!reader || !store) return { status, hits: [], gaps: [{ path: '.', reason: 'index-not-ready' }] };
      const spaceId = spaceIdOf(embedder.space);
      const cached = cache.get({ spaceId, purpose: 'query', embedText: question, authority: input.cacheAuthority });
      const vector = await waitWithSignal(schedule(async () => {
        await authorize(active); return input.queryVector(question, cached, active);
      }), active);
      await authorize(active);
      if (vector.length !== embedder.space.dim || vector.some(value => !Number.isFinite(value))) throw new Error('Semantic query vector is invalid');
      cache.set({ spaceId, purpose: 'query', embedText: question, authority: input.cacheAuthority }, vector);
      const indexScope = input.indexScope;
      const candidates = await store.searchPinned(reader.token, vector, limit, { roots,
        ...(indexScope ? { indexScope: { resourceRoot: source.resourceRoot,
          directories: indexScope.directories, pausedDirectories: indexScope.pausedDirectories,
          removedDirectories: indexScope.removedDirectories, excludedDirectories: indexScope.excludedDirectories } } : {}) }, active);
      const hits: typeof candidates = [], gaps: SemanticSearchResult['gaps'] = [];
      const versions = new Map<string, boolean>();
      for (const hit of candidates) {
        const key = `${hit.documentId}@${hit.revision}`;
        if (!versions.has(key)) {
          try {
            await source.validateDocuments([{ path: hit.documentId, revision: hit.revision }], active);
            versions.set(key, true);
          } catch {
            await authorize(active);
            versions.set(key, false); gaps.push({ path: hit.documentId, reason: 'content-changed' });
          }
        }
        if (versions.get(key)) hits.push(hit);
      }
      await authorize(active);
      return { status, hits, gaps };
    },
  };
}

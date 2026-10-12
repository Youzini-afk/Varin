/** A query's admitted source over an existing immutable numeric publication.
 * Source bytes and permissions remain with the original Run/Storage owner. */
import path from 'node:path';
import type { StructureSource } from '../../structure/types.js';
import { languageIdForPath } from '../../harness/language-id.js';
import { pathInRoots } from '../../workspace/path-scope.js';
import { indexPathAllowed, insideDirectory, type IndexScope } from '../index-scope.js';
import { packStructuralUnits } from './chunker.js';
import { recipeIdOf, spaceIdOf, type SemanticScopeKey } from './identity.js';
import type { SemanticEmbedder } from './embedder.js';
import type { EmbedScheduler } from './embed-scheduler.js';
import type { SemanticVectorCache } from './vector-cache.js';
import type { SemanticGenerationStore, SemanticPublishedReader, SemanticOverlayBlock } from './store.js';
import type { SemanticDocumentState } from './store-contract.js';
import type { SemanticSourceView } from './query-view.js';
import type { SemanticIndexStatus, SemanticSearchResult } from './runtime.js';
import { waitWithSignal } from '../../cancellation.js';

/** Pure identity intersection. A removed/replaced old live directory cannot reroute this view. */
export function sourceViewRoots(root: string, requested: readonly string[], selected: readonly string[] | null | undefined,
  scope?: IndexScope): string[] {
  const directories = scope ? [...scope.directories, ...(scope.pausedDirectories ?? [])] : selected ?? [root];
  const paths = directories.flatMap(directory => requested.flatMap(relative => {
    const target = path.resolve(root, relative);
    if (insideDirectory(directory, target)) return [target];
    return insideDirectory(target, directory) ? [directory] : [];
  })).filter(directory => insideDirectory(root, directory) && (!scope || indexPathAllowed(scope, directory, true)));
  return [...new Set(paths)].map(directory => path.relative(root, directory).split(path.sep).join('/') || '.');
}

export async function acquireSourceQuery(input: {
  scope: SemanticScopeKey;
  source: SemanticSourceView;
  embedder: SemanticEmbedder;
  roots: readonly string[];
  indexScope?: IndexScope;
  indexDirectories?: readonly string[] | null;
  includeIgnoredDirectories?: readonly string[];
  structure: StructureSource;
  cache: SemanticVectorCache;
  scheduler: EmbedScheduler;
  signal: AbortSignal;
  store(): SemanticGenerationStore;
  assertAvailable(): void;
  authorize(signal: AbortSignal): Promise<void>;
  cacheAuthority: string;
  documentVectors(texts: readonly string[], documents: readonly { path: string; revision: string }[], signal: AbortSignal): Promise<number[][]>;
  queryVector(question: string, cached: number[] | undefined, signal: AbortSignal): Promise<number[]>;
}) {
  const { source, embedder, cache, scope } = input;
  const schedule = <T>(work: () => Promise<T>): Promise<T> => embedder.ownsScheduling ? work() : input.scheduler.enqueue('foreground', work);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const roots = sourceViewRoots(source.configurationRoot, input.roots, input.indexDirectories, input.indexScope);
  const held: { store?: SemanticGenerationStore; reader?: SemanticPublishedReader | undefined } = {};
  type Prepared = { extras: SemanticOverlayBlock[]; maskPaths: string[]; gaps: SemanticSearchResult['gaps']; status: SemanticIndexStatus };
  let preparation: Promise<Prepared> | undefined;
  let released = false;
  const assertAvailable = () => {
    signal.throwIfAborted(); input.assertAvailable();
    if (released) throw new Error('Semantic source view was released');
    if (held.reader && held.store) held.store.assertPublishedReaderAvailable(held.reader.token);
  };
  const authorize = async (active: AbortSignal) => {
    active.throwIfAborted(); assertAvailable(); await input.authorize(active); active.throwIfAborted(); assertAvailable();
  };
  const release = async () => {
    if (released) return;
    released = true; lifetime.abort();
    await preparation?.catch(() => undefined);
    if (held.reader && held.store) await held.store.releasePinned(held.reader.token);
  };
  const states = new Map<string, SemanticDocumentState>();
  let statesToken: string | undefined;
  const acquireBase = async () => {
    if (embedder.space.dim <= 0) return;
    const store = held.store ??= input.store();
    // Explicit source preparation may recover the original store once. It never
    // publishes this source into the live writer or flushes it for a query.
    if (!held.reader) {
      await store.ready(); assertAvailable();
      held.reader = await store.retainPublished(signal) ?? await store.retainEmpty(signal) ?? undefined;
    }
    const reader = held.reader;
    if (!reader) throw new Error('Semantic source reader was not retained');
    assertAvailable();
    if (statesToken !== reader.token) {
      const rows = await store.listDocumentStatesPinned(reader.token, signal); assertAvailable();
      states.clear(); for (const row of rows) states.set(row.documentId, row);
      statesToken = reader.token;
    }
  };
  await authorize(signal);
  if (embedder.space.dim > 0 && roots.length) {
    held.store = input.store();
    held.reader = await held.store.retainPublished(signal) ?? undefined;
  }
  const capturedReader = held.reader ?? null;
  const capturedStatus: SemanticIndexStatus = Object.freeze({ scope,
    status: roots.length ? 'incomplete' : 'unavailable', coverage: capturedReader?.checkpoint.coverage ?? 'empty',
    lifecycle: capturedReader?.checkpoint.lifecycle ?? 'idle',
    generation: capturedReader?.publicationId ?? null, spaceId: embedder.space.dim > 0 ? spaceIdOf(embedder.space) : null });
  const prepare = async (): Promise<Prepared> => {
    const extras: SemanticOverlayBlock[] = [];
    const gaps: SemanticSearchResult['gaps'] = [];
    const retained = new Set<string>();
    let complete = true, publishedDocuments = 0;
    await authorize(signal);
    if (roots.length) {
      const ignoredRoots = sourceViewRoots(source.configurationRoot, roots, input.includeIgnoredDirectories ?? []);
      const selections = roots.flatMap(root => {
        const directory = path.resolve(source.configurationRoot, root);
        if (ignoredRoots.some(ignored => insideDirectory(path.resolve(source.configurationRoot, ignored), directory))) {
          return [{ root, respectGitignore: false }];
        }
        return [{ root, respectGitignore: true }, ...ignoredRoots.filter(ignored => insideDirectory(directory,
          path.resolve(source.configurationRoot, ignored))).map(root => ({ root, respectGitignore: false }))];
      });
      const inventoryFiles = new Map<string, { path: string; revision: string }>();
      for (const selection of selections) {
        const inventory = await source.listFiles([selection.root], signal, { respectGitignore: selection.respectGitignore });
        complete &&= inventory.complete;
        for (const file of inventory.files) inventoryFiles.set(file.path, file);
      }
      if (!complete) gaps.push({ path: '.', reason: 'index-read-failed' });
      await acquireBase();
      for (const file of inventoryFiles.values()) {
        assertAvailable();
        if (!pathInRoots(file.path, roots) || input.indexScope
          && !indexPathAllowed(input.indexScope, path.resolve(source.configurationRoot, file.path), true)) continue;
        const languageId = languageIdForPath(file.path);
        if (!languageId) { complete = false; if (!gaps.some(gap => gap.reason === 'unsupported-files')) gaps.push({ path: '.', reason: 'unsupported-files' }); continue; }
        const prior = states.get(file.path);
        if (prior?.revision === file.revision && prior.recipeId === recipeIdOf()) {
          retained.add(file.path); publishedDocuments++; continue;
        }
        if (!input.structure.unitsFixed) throw new Error('Original source units are unavailable');
        try {
          const recipeRequest = { workspaceId: scope.scopeId, path: file.path, languageId };
          const sourceRecipe = input.structure.unitsRecipe ? await input.structure.unitsRecipe(recipeRequest) : undefined;
          assertAvailable();
          const documentKey = () => ({ documentId: file.path, revision: file.revision, spaceId: spaceIdOf(embedder.space),
            recipeId: recipeIdOf(), sourceRecipeId: sourceRecipe ?? 'native-text-v1' });
          let chunks = input.structure.unitsRecipe && embedder.space.dim > 0 ? cache.getDocument(documentKey()) : undefined;
          if (!chunks) {
            const units = await input.structure.unitsFixed({ ...recipeRequest, compute: source.compute, lane: 'foreground', signal });
            assertAvailable();
            if (!['ready', 'empty'].includes(units.status) || units.revision !== file.revision
              || input.structure.unitsRecipe && units.recipeId !== sourceRecipe) throw new Error('Source units changed or did not complete');
            // Local packing uses the retained generation's tokenizer. Cached chunks
            // and vectors do not trigger model preparation or an inference request.
            await embedder.prepare(); assertAvailable();
            chunks = packStructuralUnits({ documentId: file.path, units: units.units, maxTokens: embedder.space.maxTokens,
              countTokens: text => embedder.countTokens(text) });
          }
          const texts = chunks.map(chunk => chunk.embedText);
          const vectors = texts.map(text => embedder.space.dim > 0
            ? cache.get({ spaceId: spaceIdOf(embedder.space), purpose: 'document', embedText: text }) : undefined);
          if (held.reader && held.store && held.reader.checkpoint.recipeId === recipeIdOf()) {
            const reused = await held.store.lookupVectorsPinned(held.reader.token, texts, signal);
            for (let index = 0; index < vectors.length; index++) vectors[index] ??= reused[index];
          }
          const missing = texts.flatMap((text, index) => vectors[index] ? [] : [{ text, index }]);
          if (missing.length) {
            const fresh = await schedule(async () => {
              await authorize(signal);
              return input.documentVectors(missing.map(item => item.text), [file], signal);
            });
            assertAvailable();
            if (fresh.length !== missing.length || fresh.some(vector => vector.length !== embedder.space.dim || vector.some(value => !Number.isFinite(value)))) {
              throw new Error('Source embedding returned invalid vectors');
            }
            missing.forEach((item, index) => { vectors[item.index] = fresh[index]!; });
            await acquireBase();
          }
          await authorize(signal);
          // Captured version checks precede publication and all later model egress.
          await source.validateDocuments([file], signal); assertAvailable();
          for (const [index, chunk] of chunks.entries()) {
            const vector = vectors[index];
            if (!vector) throw new Error('Source embedding is incomplete');
            cache.set({ spaceId: spaceIdOf(embedder.space), purpose: 'document', embedText: chunk.embedText }, vector);
            extras.push({ ...chunk, revision: file.revision, vector });
          }
          if (input.structure.unitsRecipe && embedder.space.dim > 0) cache.setDocument(documentKey(), chunks);
          publishedDocuments++;
        } catch {
          await authorize(signal);
          // A failed file never exposes its older live row. Cancellation and
          // permission/binding loss escape through the original authority check.
          complete = false; gaps.push({ path: file.path, reason: 'index-read-failed' });
        }
      }
      await authorize(signal);
    }
    const maskPaths = [...states.keys()].filter(documentId => !retained.has(documentId));
    const status: SemanticIndexStatus = { scope, status: roots.length === 0 ? 'unavailable' : complete ? publishedDocuments ? 'ready' : 'empty' : 'incomplete',
      coverage: complete ? 'complete' : publishedDocuments ? 'partial' : 'empty', lifecycle: 'ready',
      generation: held.reader?.publicationId ?? null, spaceId: embedder.space.dim > 0 ? spaceIdOf(embedder.space) : null, publishedDocuments };
    return { extras, maskPaths, gaps, status: Object.freeze(status) };
  };
  return {
    reader: capturedReader, status: capturedStatus, assertAvailable, release,
    async search(question: string, limit: number, searchSignal?: AbortSignal): Promise<SemanticSearchResult> {
      const active = AbortSignal.any([signal, ...(searchSignal ? [searchSignal] : [])]);
      await authorize(active);
      preparation ??= prepare();
      const { status, extras, maskPaths, gaps } = await waitWithSignal(preparation, active);
      await authorize(active);
      const { reader, store } = held;
      if (!reader || !store || !status.publishedDocuments) return { status, hits: [], gaps: [...gaps] };
      const spaceId = spaceIdOf(embedder.space);
      const cached = cache.get({ spaceId, purpose: 'query', embedText: question, authority: input.cacheAuthority });
      const vector = await waitWithSignal(schedule(async () => {
        await authorize(active); return input.queryVector(question, cached, active);
      }), active);
      await authorize(active);
      if (vector.length !== embedder.space.dim || vector.some(value => !Number.isFinite(value))) throw new Error('Semantic query vector is invalid');
      cache.set({ spaceId, purpose: 'query', embedText: question, authority: input.cacheAuthority }, vector);
      const indexScope = input.indexScope;
      const hits = await store.searchPinned(reader.token, vector, limit, { roots, maskPaths, extras,
        ...(indexScope ? { indexScope: { resourceRoot: source.configurationRoot,
          directories: indexScope.directories, pausedDirectories: indexScope.pausedDirectories,
          removedDirectories: indexScope.removedDirectories, excludedDirectories: indexScope.excludedDirectories } } : {}) }, active);
      await authorize(active);
      return { status: { ...status, status: status.coverage === 'complete' ? hits.length ? 'ready' : 'empty' : 'incomplete' }, hits, gaps: [...gaps] };
    },
  };
}

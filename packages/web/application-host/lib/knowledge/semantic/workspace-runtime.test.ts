import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PiRuntimeBrokerEvent } from '@varin/runtime-broker';
import type { AgentInputContext, HarnessInferenceBindingSnapshot, HarnessRerankSettings, PiSettingsSnapshot } from '@varin/protocol';
import { createDocumentAuthorityHarness } from '../../documents/contract-fixtures.js';
import { ThreadExecutionViewRegistry } from '../../harness/working-state/execution-view.js';
import { createStructureSource } from '../../structure/source.js';
import { createTreeSitterStructureProvider } from '../../structure/native-provider.test-helper.js';
import { createHashEmbedder } from './embedder.js';
import { createWorkspaceSemanticRuntime, type WorkspaceSemanticRuntimeOptions } from './workspace-runtime.js';

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rerank: HarnessRerankSettings = { protocol: 'http-rerank', providerId: 'remote', modelId: 'ranking' };
const settings = (revision: string): PiSettingsSnapshot => ({
  global: { harness: { rerank: { ...rerank } } }, globalRevision: revision,
  project: {}, projectRevision: 'project', projectTrusted: false,
});
const binding = (configurationId: string): HarnessInferenceBindingSnapshot => ({
  embedding: { status: 'unconfigured' },
  rerank: { status: 'ready', binding: { ...rerank, configurationId } },
});

async function setup(hooks: {
  settings?: () => Promise<PiSettingsSnapshot>;
  describe?: () => Promise<HarnessInferenceBindingSnapshot>;
  watch?: (id: string) => Promise<void>;
  pinQuery?: WorkspaceSemanticRuntimeOptions['workingBranches']['pinQuery'];
  readDraft?: WorkspaceSemanticRuntimeOptions['readDraft'];
  searchFilesystemFiles?: WorkspaceSemanticRuntimeOptions['searchFilesystemFiles'];
  structureSource?: WorkspaceSemanticRuntimeOptions['structureSource'];
  watchDocuments?: WorkspaceSemanticRuntimeOptions['documents']['watch'];
  reconcileMinimumIntervalMs?: number;
  indexDirectories?: string[] | null;
} = {}) {
  const documents = await createDocumentAuthorityHarness();
  disposes.push(() => documents.cleanup());
  const local = createHashEmbedder();
  const embedded = vi.spyOn(local, 'embed');
  const reranked: string[] = [];
  const removedWatches: string[] = [];
  const executionViews = new ThreadExecutionViewRegistry();
  const requestCwds: string[] = [];
  let watchId = 0;
  const broker = {
    requestForWorkspace: async (cwd: string, method: string, params: Record<string, unknown>) => {
      requestCwds.push(cwd);
      if (method === 'settings.get') return hooks.settings?.() ?? settings('initial');
      if (method === 'harness.inference.describe') return hooks.describe?.() ?? binding('initial');
      if (method === 'harness.rerank') {
        reranked.push(params.configurationId as string);
        const document = (params.documents as Array<{ id: string }>)[0]!;
        return { batchId: params.batchId, providerId: 'remote', modelId: 'ranking', scores: [{ index: 0, id: document.id, score: 1 }] };
      }
      throw new Error(`Unexpected method ${method}`);
    },
    watchConfig: async () => {
      const id = `watch-${++watchId}`;
      await hooks.watch?.(id);
      return { watchId: id };
    },
    unwatchConfig: async (id: string) => { removedWatches.push(id); return { unwatched: true }; },
  } as unknown as NonNullable<ReturnType<WorkspaceSemanticRuntimeOptions['getBroker']>>;
  const runtime = createWorkspaceSemanticRuntime({
    dataDir: documents.dataDir, hostId: 'workspace-test',
    documents: { ...documents.authority, watch: hooks.watchDocuments ?? documents.authority.watch },
    structureSource: hooks.structureSource ?? createStructureSource([]), embedder: local,
    ...(hooks.searchFilesystemFiles ? { searchFilesystemFiles: hooks.searchFilesystemFiles } : {}),
    ...(hooks.reconcileMinimumIntervalMs === undefined ? {} : { reconcileMinimumIntervalMs: hooks.reconcileMinimumIntervalMs }),
    ...(hooks.indexDirectories === undefined ? {} : { indexDirectories: hooks.indexDirectories }),
    configCwd: documents.dataDir,
    getBroker: () => broker,
    executionViews, workingBranches: { pinQuery: hooks.pinQuery ?? (async () => null) },
    ...(hooks.readDraft ? { readDraft: hooks.readDraft } : {}),
  });
  disposes.push(() => runtime.dispose());
  return { runtime, workspaceId: documents.identity.workspaceId, embedded, removedWatches, reranked, executionViews, requestCwds, documents };
}

describe('production workspace semantic assembly lifecycle', () => {
  it('keeps semantic indexing off outside selected directories without blocking other retrieval sources', async () => {
    const inventory = vi.fn(async () => []);
    const harness = await setup({ indexDirectories: [], searchFilesystemFiles: inventory });
    const result = await harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5);
    expect(result.status).toBe('unavailable');
    expect(inventory).not.toHaveBeenCalled();
    expect(harness.embedded).not.toHaveBeenCalled();
  });

  it('uses the injected asynchronous draft reader for fixed semantic overlays', async () => {
    const readDraft = vi.fn(async (_sessionId: string, _context: AgentInputContext, resourceId: string, _workspaceId: string) => ({
      status: 'ready' as const,
      content: 'export const sourceViewValue = "fixed external draft";',
      revision: `source-view:${resourceId}`,
      source: 'working-branch' as const,
      encoding: 'utf-8',
      bom: false,
    }));
    const harness = await setup({ readDraft });
    const workspaceId = harness.workspaceId;
    const inputContext: AgentInputContext = {
      source: 'surface',
      roots: [{ workspaceId, dirtyPaths: ['draft.ts'] }],
      snapshot: { status: 'ready', ref: 'source-view:view-1' },
    };

    const result = await harness.runtime.semanticRecall(harness.workspaceId, 'fixed external draft', 5, {
      sessionId: 'subtask',
      inputContext,
    });

    expect(readDraft).toHaveBeenCalledWith('subtask', inputContext, 'draft.ts', workspaceId);
    expect(result.gaps ?? []).not.toContainEqual({ path: 'draft.ts', reason: 'draft-unavailable' });
  });

  it('does not search a disk corpus when the active virtual branch cannot be pinned', async () => {
    const harness = await setup();
    harness.executionViews.bind({
      sessionId: 'child', workspaceId: harness.workspaceId, threadId: 'thread', runId: 'run',
      branchId: 'branch', revision: 0, writeRevision: 1, mode: 'virtual', draftBasePaths: [],
    });
    await expect(harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5, { sessionId: 'child' }))
      .rejects.toThrow('Working-branch query view is unavailable');
    expect(harness.embedded).not.toHaveBeenCalled();
  });

  it('releases the kernel working-state pin after a virtual semantic query', async () => {
    const release = vi.fn(async () => undefined);
    const harness = await setup({
      pinQuery: async (sessionId) => ({
        sessionId,
        workspaceId: 'placeholder',
        branchId: 'branch',
        writeRevision: 1,
        revision: 0,
        root: 'sha256-root',
        pinId: 'pin-query',
        search: async () => ({ status: 'empty' as const, generation: 1 }),
        compute: async () => { throw new Error('not requested'); },
        listFiles: async () => [],
        readFile: async () => ({ status: 'unavailable', message: 'not requested' }),
        release,
      }),
    });
    harness.executionViews.bind({
      sessionId: 'child', workspaceId: harness.workspaceId, threadId: 'thread', runId: 'run',
      branchId: 'branch', revision: 0, writeRevision: 1, mode: 'virtual', draftBasePaths: [],
    });
    await harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5, { sessionId: 'child' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not publish settings that arrive from a retired workspace worker', async () => {
    const entered = deferred<void>();
    const old = deferred<HarnessInferenceBindingSnapshot>();
    let calls = 0;
    const harness = await setup({ describe: () => {
      if (++calls > 1) return Promise.resolve(binding('replacement'));
      entered.resolve();
      return old.promise;
    } });
    const loading = harness.runtime.harnessSettings(harness.workspaceId);
    await entered.promise;
    harness.runtime.processEvent({ kind: 'worker.exit', role: 'workspace' } as PiRuntimeBrokerEvent);
    old.resolve(binding('retired'));
    expect(await loading).toBeNull();
    await harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual(['replacement']);
  });

  it('waits for the config refresh before choosing the next rerank binding', async () => {
    const updated = deferred<HarnessInferenceBindingSnapshot>();
    const entered = deferred<void>();
    let calls = 0;
    const harness = await setup({ describe: () => {
      if (++calls === 1) return Promise.resolve(binding('initial'));
      entered.resolve();
      return updated.promise;
    } });
    await harness.runtime.harnessSettings(harness.workspaceId);
    harness.runtime.processEvent({
      kind: 'host', envelope: { event: 'config.changed', data: { watchId: 'watch-1' } },
    } as PiRuntimeBrokerEvent);
    await entered.promise;
    const ranking = harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual([]);
    updated.resolve(binding('updated'));
    await ranking;
    expect(harness.reranked).toEqual(['updated']);
  });

  it('refreshes bindings after recovering a failed config subscription', async () => {
    let current = 'initial';
    const harness = await setup({
      describe: async () => binding(current),
      watch: async (id) => {
        if (id === 'watch-1') throw new Error('watch unavailable');
        if (id === 'watch-3') current = 'changed-while-unobserved';
      },
    });
    await harness.runtime.harnessSettings(harness.workspaceId);
    await harness.runtime.rerankExploreViews({
      workspaceId: harness.workspaceId, query: 'q', documents: [{ id: 'one', text: 'body' }], settings: rerank,
    });
    expect(harness.reranked).toEqual(['changed-while-unobserved']);
  });

  it('cancels a query during settings resolution without starting a local embedding', async () => {
    const entered = deferred<void>();
    const described = deferred<HarnessInferenceBindingSnapshot>();
    const harness = await setup({ describe: () => { entered.resolve(); return described.promise; } });
    const controller = new AbortController();
    const result = harness.runtime.semanticRecall(harness.workspaceId, 'needle', 5, { signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.embedded).not.toHaveBeenCalled();
    described.resolve(binding('late'));
  });

  it('releases watches which finish registering after disposal has begun', async () => {
    const entered = deferred<void>();
    const watches = deferred<void>();
    const harness = await setup({ watch: async () => { entered.resolve(); await watches.promise; } });
    const loading = harness.runtime.harnessSettings(harness.workspaceId);
    const rejected = expect(loading).rejects.toThrow('closed');
    await entered.promise;
    const disposing = harness.runtime.dispose();
    watches.resolve();
    await Promise.all([disposing, rejected]);
    expect(harness.removedWatches.sort()).toEqual(['watch-1', 'watch-2']);
    await expect(harness.runtime.harnessSettings(harness.workspaceId)).rejects.toThrow('closed');
  });

  it('serves distinct resource roots through one shared inference worker', async () => {
    const harness = await setup();
    const nested = path.join(harness.documents.workspaceRoot, 'nested-root');
    await fs.promises.mkdir(nested, { recursive: true });
    const second = await harness.documents.authority.resolveWorkspace({ path: nested });
    await harness.runtime.harnessSettings(harness.workspaceId);
    await harness.runtime.harnessSettings(second.workspaceId);
    // Every settings/inference request went to the shared config worker; the
    // second root never triggered a worker for its own directory.
    expect(new Set(harness.requestCwds)).toEqual(new Set([harness.documents.dataDir]));
  });

  it('reconciles missed additions in the background and clears its timer on disposal', async () => {
    const oldBody = 'export const oldValue = "existing reconcile marker";\n';
    const newBody = 'export const newValue = "quietly added reconcile marker";\n';
    let inventory: Array<{ name: string; path: string; relativePath: string; metadata: { byteLength: string; modifiedTimeNs: string } }> = [];
    let scans = 0;
    const secondScanEntered = deferred<void>();
    const resumeSecondScan = deferred<void>();
    const indexedPaths: string[] = [];
    const nativeStructure = createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 30_000 })]);
    // Keep the document watch quiet to simulate a file creation missed by
    // Documents observation.
    const controlled = await setup({
      watchDocuments: () => ({ ready: Promise.resolve(true), settle: async () => undefined, close() {} }),
      searchFilesystemFiles: async () => {
        scans += 1;
        if (scans === 2) {
          secondScanEntered.resolve(undefined);
          await resumeSecondScan.promise;
        }
        return inventory;
      },
      structureSource: {
        ...nativeStructure,
        unitsFile: async (request) => {
          indexedPaths.push(request.path);
          return nativeStructure.unitsFile!(request);
        },
      },
      reconcileMinimumIntervalMs: 1_000,
    });
    const oldPath = path.join(controlled.documents.workspaceRoot, 'old.ts');
    const newPath = path.join(controlled.documents.workspaceRoot, 'new.ts');
    await fs.promises.writeFile(oldPath, oldBody, 'utf8');
    inventory = [{ name: 'old.ts', path: oldPath, relativePath: 'old.ts', metadata: {
      byteLength: String(Buffer.byteLength(oldBody)), modifiedTimeNs: 'old-stat',
    } }];
    try {
      await controlled.runtime.harnessSettings(controlled.workspaceId);
      await controlled.runtime.drain();
      expect(scans).toBe(1);
      expect(indexedPaths).toEqual(['old.ts']);

      await fs.promises.writeFile(newPath, newBody, 'utf8');
      inventory = [...inventory, { name: 'new.ts', path: newPath, relativePath: 'new.ts', metadata: {
        byteLength: String(Buffer.byteLength(newBody)), modifiedTimeNs: 'new-stat',
      } }];
      await pause(100);
      expect(scans).toBe(1);
      await secondScanEntered.promise;

      // A query against the last published generation returns while the
      // metadata inventory call is deliberately held open.
      const query = controlled.runtime.semanticRecall(controlled.workspaceId, 'existing reconcile marker', 5);
      const oldResult = await Promise.race([
        query,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('query waited for periodic reconciliation')), 2_000)),
      ]);
      expect(oldResult.status).toBeDefined();

      // The measured inventory duration should push the next interval well
      // beyond the one-second minimum, preserving a low scan duty cycle.
      await pause(100);
      resumeSecondScan.resolve(undefined);
      await controlled.runtime.drain();
      expect(indexedPaths).toContain('new.ts');
      const added = await controlled.runtime.semanticRecall(controlled.workspaceId, 'quietly added reconcile marker', 5);
      expect(added.hits[0]?.documentId).toBe('new.ts');

      await pause(100);
      expect(scans).toBe(2);
      await controlled.runtime.dispose();
      await pause(550);
      expect(scans).toBe(2);
    } finally {
      resumeSecondScan.resolve(undefined);
    }
  });

  it('cancels the pending reconcile timer when the Host runtime is disposed', async () => {
    let scans = 0;
    const harness = await setup({
      watchDocuments: () => ({ ready: Promise.resolve(true), settle: async () => undefined, close() {} }),
      searchFilesystemFiles: async () => { scans += 1; return []; },
      reconcileMinimumIntervalMs: 1_000,
    });
    await harness.runtime.harnessSettings(harness.workspaceId);
    await harness.runtime.drain();
    expect(scans).toBe(1);

    await harness.runtime.dispose();
    await pause(1_050);
    expect(scans).toBe(1);
  });
});

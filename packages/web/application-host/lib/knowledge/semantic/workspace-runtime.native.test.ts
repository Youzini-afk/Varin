import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createDocumentAuthorityHarness } from '../../documents/contract-fixtures.js';
import { createStructureSource } from '../../structure/source.js';
import type { StructureSource } from '../../structure/types.js';
import { createHash } from 'node:crypto';
import { createHashEmbedder } from './embedder.js';
import { splitSourceLines } from './embed-text.js';
import { createSemanticInference } from './runtime-inference.js';
import { createWorkspaceSemanticRuntime, type WorkspaceSemanticRuntimeOptions } from './workspace-runtime.js';
import { createProjectIndexScope } from '../index-scope.js';
const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); vi.useRealTimers(); });
async function setup(hooks: {
  searchFilesystemFiles?: WorkspaceSemanticRuntimeOptions['searchFilesystemFiles'];
  structureSource?: WorkspaceSemanticRuntimeOptions['structureSource'];
  watchDocuments?: WorkspaceSemanticRuntimeOptions['documents']['watch'];
  reconcileMinimumIntervalMs?: number;
  getIndexScope?: WorkspaceSemanticRuntimeOptions['getIndexScope'];
} = {}) {
  const documents = await createDocumentAuthorityHarness(); disposes.push(() => documents.cleanup());
  const inference = createSemanticInference({ readGlobalInferenceSettings: async () => ({}), resolveEmbeddingBinding: async () => { throw new Error('No remote provider selected'); } });
  disposes.push(() => inference.close());
  const local = createHashEmbedder(); const embedded = vi.spyOn(local, 'embed');
  const runtime = createWorkspaceSemanticRuntime({ dataDir: documents.dataDir, hostId: 'workspace-test',
    documents: { ...documents.authority, watch: hooks.watchDocuments ?? documents.authority.watch },
    structureSource: hooks.structureSource ?? createStructureSource([]), embedder: local, runtimeInference: inference,
    ...(hooks.searchFilesystemFiles ? { searchFilesystemFiles: hooks.searchFilesystemFiles } : {}),
    ...(hooks.reconcileMinimumIntervalMs === undefined ? {} : { reconcileMinimumIntervalMs: hooks.reconcileMinimumIntervalMs }),
    ...(hooks.getIndexScope ? { getIndexScope: hooks.getIndexScope } : {}),
  });
  disposes.push(() => runtime.dispose()); return { runtime, workspaceId: documents.identity.workspaceId, embedded, documents };
}
describe('native workspace semantic indexing lifecycle', () => {
  it('reconciles watcher resets without rereading stable files and discovers missed edits', async () => {
    let notify: Parameters<WorkspaceSemanticRuntimeOptions['documents']['watch']>[1] = () => {};
    let file = '';
    const native: StructureSource = { ...createStructureSource([]), unitsRecipe: async () => 'fixture-units-1',
      unitsFile: async request => {
        const file = path.join(request.root, request.path); const text = await fs.promises.readFile(file, 'utf8'); const stat = await fs.promises.stat(file, { bigint: true });
        return { status: 'ready', revision: createHash('sha256').update(text).digest('hex'), recipeId: 'fixture-units-1',
          sourceMetadata: { byteLength: String(stat.size), modifiedTimeNs: String(stat.mtimeNs) },
          units: [{ startLine: 1, endLine: splitSourceLines(text).length, parentName: '', parentKind: 'file', parentSignature: '', docComments: '', text, fallback: true }] };
      } };
    const unitsFile = vi.fn(native.unitsFile!);
    const harness = await setup({
      watchDocuments: (_workspaceId, listener) => {
        notify = listener;
        return { ready: Promise.resolve(true), position: null, settle: async () => undefined, close() {} };
      },
      searchFilesystemFiles: async () => {
        const stat = fs.statSync(file, { bigint: true });
        return [{ name: 'stable.ts', path: file, relativePath: 'stable.ts',
          metadata: { byteLength: String(stat.size), modifiedTimeNs: String(stat.mtimeNs) } }];
      },
      structureSource: { ...native, unitsFile },
    });
    file = path.join(harness.documents.workspaceRoot, 'stable.ts');
    fs.writeFileSync(file, 'export const marker = "before reset";\n');
    await harness.runtime.scanWorkspace(harness.workspaceId);
    await harness.runtime.drain();
    expect(harness.runtime.indexStatuses()[0]?.status).toMatchObject({ coverage: 'complete', publishedDocuments: 1 });
    expect(harness.embedded).toHaveBeenCalledOnce();
    unitsFile.mockClear(); harness.embedded.mockClear();
    const reset = () => notify({ sourceId: 'watch', generation: 2, sequence: 1, kind: 'reset', reason: 'reconnected' });
    reset(); reset();
    await harness.runtime.drain();
    expect(unitsFile).not.toHaveBeenCalled();
    expect(harness.embedded).not.toHaveBeenCalled();
    expect(harness.runtime.indexStatuses()[0]?.status.coverage).toBe('complete');
    fs.writeFileSync(file, 'export const marker = "missed external change after reset";\n');
    reset();
    await harness.runtime.drain();
    expect(unitsFile).toHaveBeenCalledTimes(1);
    expect(harness.embedded).toHaveBeenCalled();
  });

  it('activates selected folders and stops scanning and watching after the project removes them', async () => {
    const selection = createProjectIndexScope([]);
    const inventory = vi.fn(async () => []);
    const closed = vi.fn();
    const watchDocuments = vi.fn(() => ({ ready: Promise.resolve(true), position: null, settle: async () => undefined, close: closed }));
    const harness = await setup({ getIndexScope: selection.get, searchFilesystemFiles: inventory, watchDocuments });
    harness.runtime.observeDocumentMutation({ workspaceId: harness.workspaceId, resourceId: 'a.ts', kind: 'modified' });
    await harness.runtime.drain();
    expect(inventory).not.toHaveBeenCalled();
    expect(watchDocuments).not.toHaveBeenCalled();
    selection.update([harness.documents.workspaceRoot]);
    await harness.runtime.refreshIndexScope();
    await harness.runtime.drain();
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(watchDocuments).toHaveBeenCalledTimes(1);
    selection.update([]);
    await harness.runtime.refreshIndexScope();
    await harness.runtime.scanWorkspace(harness.workspaceId);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(harness.runtime.indexStatuses()[0]?.indexingEnabled).not.toBe(true);
  });

  it('cancels the pending reconcile timer when the Host runtime is disposed', async () => {
    let scans = 0;
    const harness = await setup({
      watchDocuments: () => ({ ready: Promise.resolve(true), position: null, settle: async () => undefined, close() {} }),
      searchFilesystemFiles: async () => { scans += 1; return []; },
      reconcileMinimumIntervalMs: 1_000,
    });
    await harness.runtime.scanWorkspace(harness.workspaceId);
    await harness.runtime.drain();
    expect(scans).toBe(1);

    await harness.runtime.dispose();
    await new Promise<void>(resolve => setTimeout(resolve, 1_050));
    expect(scans).toBe(1);
  });

});

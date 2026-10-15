import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DocumentsAPI, VarinDocumentWatchEvent, VarinResourceReference } from '@varin/application-client';
import type { WorkspaceCombinedRecoveryPlan } from '@varin/extension-contract';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createAuthorityTestRuntime } from '../kernel/authority.test-helper.js';
import { RecoveryPrimitiveError } from './errors.js';
import type { RecoverySessionNavigation } from './journal-engine.js';

interface RegistryRecord {
  buffer: string; baseContent: string; baseRevision: string | null; dirty: boolean;
  localEditRevision: number; lineEnding: string; bom: boolean; status: string;
}
interface Registry {
  open(resource: VarinResourceReference, options?: { reload?: boolean }): Promise<RegistryRecord>;
  get(resource: VarinResourceReference): RegistryRecord | undefined;
  applyTransaction(resource: VarinResourceReference, content: string, options: { origin: string }): unknown;
  flushRecoveryJournals(): Promise<void>;
  dispose(): Promise<void>;
}
const { DocumentRegistry }: { DocumentRegistry: new (options: { documents: DocumentsAPI; getGeneration(): number; recoverySessionId: string; journalDebounceMs: number }) => Registry } = await import(
  new URL('../../../../ui/src/lib/documents/registry.ts', import.meta.url).href
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(before: string | null, navigationMode: 'normal' | 'reject' | 'lose-reply' = 'normal') {
  const h = await createDocumentAuthorityHarness();
  const note = path.join(h.workspaceRoot, 'note.txt');
  if (before !== null) await fs.writeFile(note, before);
  let leaf: string | null = 'assistant-1';
  let responseLost = false;
  let navigationProbe = () => {};
  const navigation: RecoverySessionNavigation = {
    prepare: async () => ({ expectedLeafId: leaf, targetLeafId: 'before-turn', removedEntryIds: ['user-1', 'assistant-1'] }),
    prepareLeaf: async ({ targetLeafId }) => ({ expectedLeafId: leaf, targetLeafId }),
    commit: async ({ expectedLeafId, preparedTargetLeafId }) => {
      navigationProbe();
      if (navigationMode === 'reject') throw new RecoveryPrimitiveError('navigation-conflict', 'Conversation changed after review', { origin: 'navigation' });
      if (leaf === expectedLeafId) leaf = preparedTargetLeafId;
      else expect(leaf).toBe(preparedTargetLeafId);
      if (navigationMode === 'lose-reply' && !responseLost) { responseLost = true; throw new Error('Navigation committed but its reply was lost'); }
      return {};
    },
    commitLeaf: async ({ expectedLeafId, preparedTargetLeafId }) => { expect(leaf).toBe(expectedLeafId); leaf = preparedTargetLeafId; return {}; },
  };
  const open = () => createAuthorityTestRuntime({ documents: h.authority, hostId: h.authority.hostId, dataDir: h.dataDir, sessionNavigation: navigation });
  let native = await open();
  const api = {
    ...h.authority,
    ackDirtyStateBarrier: h.authority.acknowledgeDirtyStateBarrier,
    watch(workspaceId: string, listener: (event: VarinDocumentWatchEvent) => void, options?: { dirtyOwner?: { ownerId: string; generation: number } }) {
      const files = h.authority.watch(workspaceId, event => listener(event as VarinDocumentWatchEvent));
      const surface = options?.dirtyOwner ? h.authority.registerDirtySurface({ workspaceId, ...options.dirtyOwner },
        event => listener(event as VarinDocumentWatchEvent)) : null;
      return { close() { surface?.close(); files.close(); } };
    },
  } as unknown as DocumentsAPI;
  const registry = new DocumentRegistry({ documents: api, getGeneration: () => 1, recoverySessionId: 'dirty-recovery', journalDebounceMs: 0 });
  cleanups.push(async () => { await registry.dispose(); await native.dispose(); await h.cleanup(); });
  const resource = h.resource('note.txt');
  const workspaceId = h.identity.workspaceId;
  const mutation = { executionId: 'execution-1', mutationId: 'mutation-1', path: note, toolCallId: 'tool-1', toolName: 'write' as const, workspaceId };
  expect(await native.engine.recordTurnStart({ activeWriterScopes: [], executionId: mutation.executionId, provenance: 'caused-by', runtimeGeneration: 1,
    conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, userEntryId: 'user-1', workerId: 'worker-1', workspaceId })).toMatchObject({ status: 'ready' });
  expect(await native.engine.recordMutationBefore(mutation)).toMatchObject({ status: 'ready', recorded: true });
  const after = '\ufeffafter\r\n';
  await fs.writeFile(note, after);
  expect(await native.engine.recordMutationAfter({ ...mutation, succeeded: true })).toMatchObject({ status: 'ready', recorded: true });
  expect(await native.engine.recordTurnSettled({ activeWriterScopes: [], assistantEntryId: 'assistant-1', executionId: mutation.executionId, mutationObserved: true,
    observationComplete: true, observedResourceIds: ['note.txt'], provenance: 'caused-by', workspaceId })).toMatchObject({ status: 'ready' });
  await registry.open(resource);
  registry.applyTransaction(resource, 'my unsaved draft\n', { origin: 'editor' });
  await expect.poll(async () => (await h.authority.inspectDirtyBuffers(workspaceId)).flatMap(publication => publication.resources)
    .some(entry => entry.resource.resourceId === resource.resourceId && entry.localEditRevision === registry.get(resource)!.localEditRevision)).toBe(true);
  await registry.flushRecoveryJournals();
  return { h, registry, note, resource, before, after, workspaceId,
    inspectDuringNavigation(probe: () => void) { navigationProbe = probe; },
    get native() { return native; },
    async restart() { await registry.flushRecoveryJournals(); await native.dispose(); native = await open(); },
    async prepare() {
      const result = await native.engine.prepareCombinedRecovery({ entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId });
      if (result.status !== 'ready') throw new Error(result.failure.message);
      expect(result).toMatchObject({ status: 'ready', plan: { conflicts: [{ kind: 'dirty-buffer', path: 'note.txt' }] } });
      return result.plan;
    },
    apply(plan: WorkspaceCombinedRecoveryPlan) { return native.engine.applyCombinedRecovery({ operationId: plan.id, expectedRevision: plan.revision,
      conflictPolicy: 'overwrite-confirmed', confirmedConflicts: plan.conflicts.map(({ path, fingerprint }) => ({ path, fingerprint })) }); },
  };
}

it.each([['CRLF/BOM text', '\ufeffbefore\r\n'], ['a newly created file', null]] as const)(
  'restores %s through its draft and retains disk plus unsaved text for undo after real Storage reopen and GC', async (_label, before) => {
    const f = await fixture(before);
    const original = { ...f.registry.get(f.resource)! };
    const plan = await f.prepare();
    const applied = await f.apply(plan);
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    if (before === null) {
      await expect(fs.readFile(f.note)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.registry.get(f.resource)).toMatchObject({ buffer: '', baseContent: '', baseRevision: null, dirty: false, status: 'missing' });
    } else {
      expect(await fs.readFile(f.note, 'utf8')).toBe(before);
      expect(f.registry.get(f.resource)).toMatchObject({ buffer: 'before\n', baseContent: 'before\n', dirty: false, bom: true, lineEnding: 'crlf' });
    }
    expect(await f.native.engine.cleanupStorage({ workspaceId: f.workspaceId })).toMatchObject({ status: 'ready' });
    await f.restart();
    const undo = await f.native.engine.prepareCombinedUndo(plan.id);
    expect(undo.status).toBe('ready');
    if (undo.status !== 'ready') throw new Error(undo.failure.message);
    const undone = await f.apply(undo.plan);
    expect(undone, JSON.stringify(undone)).toMatchObject({ status: 'ready', operation: { state: 'complete', undoOf: plan.id } });
    expect(await fs.readFile(f.note, 'utf8')).toBe(f.after);
    expect(f.registry.get(f.resource)).toMatchObject({ buffer: original.buffer, baseContent: original.baseContent, baseRevision: original.baseRevision,
      dirty: true, bom: original.bom, lineEnding: original.lineEnding, status: 'ready' });
  }, 30_000,
);

it('rejects a reviewed draft after its revision changes and leaves the newer disk and editor untouched', async () => {
  const f = await fixture('before\n');
  const plan = await f.prepare();
  f.registry.applyTransaction(f.resource, 'newer unconfirmed draft\n', { origin: 'editor' });
  const newer = { ...f.registry.get(f.resource)! };
  expect(await f.apply(plan)).toMatchObject({ status: 'failed', failure: { code: 'stale-plan' } });
  expect(await fs.readFile(f.note, 'utf8')).toBe(f.after);
  expect(f.registry.get(f.resource)).toMatchObject({ buffer: newer.buffer, localEditRevision: newer.localEditRevision, dirty: true });
}, 30_000);

it.each(['reject', 'lose-reply'] as const)('settles disk and draft together when conversation navigation will %s', async mode => {
  const f = await fixture('\ufeffbefore\r\n', mode);
  const original = { ...f.registry.get(f.resource)! };
  const plan = await f.prepare();
  const unrelated = f.h.resource('unrelated.txt');
  await fs.writeFile(path.join(f.h.workspaceRoot, unrelated.resourceId), 'unrelated disk');
  await f.registry.open(unrelated);
  f.inspectDuringNavigation(() => {
    expect(() => f.registry.applyTransaction(f.resource, 'must stay fenced', { origin: 'editor' })).toThrow(/recover|barrier|temporar/i);
    expect(() => f.registry.applyTransaction(unrelated, 'independent editor work', { origin: 'editor' })).not.toThrow();
  });
  expect(await f.apply(plan)).toMatchObject({ status: 'failed', failure: { code: 'navigation-conflict' } });
  if (mode === 'reject') {
    expect(await f.native.engine.getCombinedOperation(plan.id)).toMatchObject({ status: 'ready', operation: { state: 'compensated' } });
    expect(await fs.readFile(f.note, 'utf8')).toBe(f.after);
    expect(f.registry.get(f.resource)).toMatchObject({ buffer: original.buffer, baseContent: original.baseContent, baseRevision: original.baseRevision, dirty: true });
  } else {
    expect(await f.native.engine.getCombinedOperation(plan.id)).toMatchObject({ status: 'ready', operation: { state: 'navigating-conversation' } });
    await f.restart();
    await f.native.engine.resumeCombinedOperations();
    expect(await f.native.engine.getCombinedOperation(plan.id)).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await fs.readFile(f.note, 'utf8')).toBe(f.before);
    expect(f.registry.get(f.resource)).toMatchObject({ buffer: 'before\n', baseContent: 'before\n', dirty: false });
  }
}, 30_000);

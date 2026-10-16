import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryPrepareInput,
  WorkspaceRecoveryCheckpointQuery,
  WorkspaceRecoveryTurnSettledInput,
} from '@varin/extension-contract';
import type { DocumentAuthorityOptions } from '../documents/authority.js';
import {
  createDocumentAuthorityHarness,
  type DocumentAuthorityHarness,
} from '../documents/contract-fixtures.js';
import {
  createWorkspaceRecoveryEngine,
  type CreateWorkspaceRecoveryEngineOptions,
  type RecoverySessionNavigation,
  type WorkspaceRecoveryEngine,
} from './journal-engine.js';
import { RecoveryPrimitiveError } from './errors.js';
import { createManagedRecoveryCoordinator } from './managed-recovery-coordinator.js';
import { createManagedRecoveryService } from '../kernel/managed-recovery-service.js';
import type { RecoveryFileStore } from './journal-files.js';
import { createRecoveryFileStore } from './file-store.test-helper.js';
import {
  createInMemoryRecoveryDurablePort,
  type InMemoryRecoveryDurablePort,
} from './recovery-durable-port.test-helper.js';

const harnesses = new Set<DocumentAuthorityHarness>();

type Ready<T> = Extract<T, { status: 'ready' }>;

const ready = <T extends { status: string }>(result: T): Ready<T> => {
  if (result.status !== 'ready') {
    throw new Error(`Expected ready recovery result, received ${result.status}`);
  }
  return result as Ready<T>;
};

const createTestNavigation = (): RecoverySessionNavigation => ({
  commit: vi.fn(async () => ({ markerId: 'marker-1' })),
  commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
  prepare: vi.fn(async (input) => ({
    editorText: 'draft',
    expectedLeafId: 'leaf-current',
    removedEntryIds: [input.entryId, 'assistant-1'],
    targetLeafId: 'leaf-before',
  })),
  prepareLeaf: vi.fn(async (input) => ({
    expectedLeafId: 'leaf-before',
    removedEntryIds: [],
    targetLeafId: input.targetLeafId,
  })),
});

type HarnessOptions = Partial<Omit<
  CreateWorkspaceRecoveryEngineOptions,
  'authorityId' | 'dataDir' | 'documents' | 'sessionNavigation'
>> & {
  documentAuthority?: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> | undefined;
  sessionNavigation?: RecoverySessionNavigation | undefined;
};

const createHarness = async (options: HarnessOptions = {}): Promise<{
  durable: InMemoryRecoveryDurablePort;
  engine: WorkspaceRecoveryEngine;
  harness: DocumentAuthorityHarness;
  navigation: RecoverySessionNavigation;
}> => {
  const { documentAuthority, sessionNavigation, ...engineOptions } = options;
  const harness = await createDocumentAuthorityHarness(
    documentAuthority ? { authority: documentAuthority } : undefined,
  );
  harnesses.add(harness);
  const navigation = sessionNavigation ?? createTestNavigation();
  const fileStore = engineOptions.fileStore ?? createRecoveryFileStore();
  const identity = recoveryIdentity(harness);
  const durable = createInMemoryRecoveryDurablePort({
    captureState: async ({ path: inputPath }) => (
      await fileStore.captureState(identity, identity.canonicalRoot, inputPath, { store: true })
    ).state,
    relativePathFor: async ({ path: inputPath }) => (
      await fileStore.relativePathFor(identity, inputPath)
    ).relative,
  });
  const engine = createWorkspaceRecoveryEngine({
    authorityId: harness.authority.hostId,
    dataDir: harness.dataDir,
    documents: harness.authority,
    durableRecoveryStore: durable,
    fileStore,
    sessionNavigation: navigation,
    ...engineOptions,
  });
  return { durable, engine, harness, navigation };
};

const startTurn = (engine: WorkspaceRecoveryEngine, harness: DocumentAuthorityHarness, suffix = '1') => engine.recordTurnStart({
  activeWriterScopes: [],
  executionId: `execution-${suffix}`,
  provenance: 'caused-by',
  runtimeGeneration: 1,
  conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' },
  userEntryId: `user-${suffix}`,
  workerId: 'worker-1',
  workspaceId: harness.identity.workspaceId,
});

type SettleTurnOptions = Partial<Pick<
  WorkspaceRecoveryTurnSettledInput,
  'activeWriterScopes' | 'assistantEntryId' | 'executionId' | 'mutationObserved' | 'observationComplete' | 'observedResourceIds'
>>;

const settleTurn = (
  engine: WorkspaceRecoveryEngine,
  harness: DocumentAuthorityHarness,
  options: SettleTurnOptions = {},
) => engine.recordTurnSettled({
  activeWriterScopes: options.activeWriterScopes ?? [],
  assistantEntryId: options.assistantEntryId ?? 'assistant-1',
  executionId: options.executionId ?? 'execution-1',
  mutationObserved: options.mutationObserved ?? true,
  observationComplete: options.observationComplete ?? true,
  observedResourceIds: options.observedResourceIds ?? ['note.txt'],
  provenance: 'caused-by',
  workspaceId: harness.identity.workspaceId,
});

const recordWrite = async (
  engine: WorkspaceRecoveryEngine,
  harness: DocumentAuthorityHarness,
  content: string,
): Promise<void> => {
  const target = path.join(harness.workspaceRoot, 'note.txt');
  const base = {
    executionId: 'execution-1',
    mutationId: 'mutation-1',
    path: target,
    toolCallId: 'tool-1',
    toolName: 'write' as const,
    workspaceId: harness.identity.workspaceId,
  };
  expect(await engine.recordMutationBefore(base)).toMatchObject({ recorded: true, status: 'ready' });
  await fs.promises.writeFile(target, content);
  expect(await engine.recordMutationAfter({ ...base, succeeded: true }))
    .toMatchObject({ recorded: true, status: 'ready' });
};

const prepareCombined = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceCombinedRecoveryPrepareInput,
): Promise<Ready<Awaited<ReturnType<WorkspaceRecoveryEngine['prepareCombinedRecovery']>>>> => (
  ready(await engine.prepareCombinedRecovery(input))
);

const applyCombined = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceCombinedRecoveryApplyInput,
) => ready(await engine.applyCombinedRecovery(input));

const listCheckpoints = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceRecoveryCheckpointQuery,
): Promise<Ready<Awaited<ReturnType<WorkspaceRecoveryEngine['listCheckpoints']>>>> => (
  ready(await engine.listCheckpoints(input))
);

const recoveryIdentity = (harness: DocumentAuthorityHarness) => ({
  authorityId: harness.authority.hostId,
  canonicalRoot: harness.workspaceRoot,
  filesystemProfile: 'test',
  workspaceId: harness.identity.workspaceId,
});

interface DirtyBarrierEvent {
  action: 'acquire' | 'release';
  barrierId: string;
}

const isDirtyBarrierEvent = (event: unknown): event is DirtyBarrierEvent => (
  event !== null
  && typeof event === 'object'
  && 'action' in event
  && ((event as { action?: unknown }).action === 'acquire' || (event as { action?: unknown }).action === 'release')
  && 'barrierId' in event
  && typeof (event as { barrierId?: unknown }).barrierId === 'string'
);

afterEach(async () => {
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

describe('affected-file workspace recovery journal', () => {
  it('keeps shared resource work out of compound metadata serialization and drains it on dispose', async () => {
    const { engine, harness } = await createHarness();
    const workspaceId = recoveryIdentity(harness).workspaceId;
    let releaseExclusive!: () => void;
    let startedExclusive!: () => void;
    const exclusiveStarted = new Promise<void>(resolve => { startedExclusive = resolve; });
    const exclusiveWait = new Promise<void>(resolve => { releaseExclusive = resolve; });
    const first = engine.withWorkspaceStorage(workspaceId, { mode: 'exclusive', purpose: 'first-metadata' }, async () => {
      startedExclusive(); await exclusiveWait;
    });
    await exclusiveStarted;
    let secondStarted = false;
    const second = engine.withWorkspaceStorage(workspaceId, { mode: 'exclusive', purpose: 'second-metadata' }, () => { secondStarted = true; });
    let releaseShared!: () => void;
    let startedShared!: () => void;
    const sharedStarted = new Promise<void>(resolve => { startedShared = resolve; });
    const sharedWait = new Promise<void>(resolve => { releaseShared = resolve; });
    const shared = engine.withWorkspaceStorage(workspaceId, { mode: 'shared', purpose: 'independent-resource' }, async () => {
      startedShared(); await sharedWait;
    });
    await sharedStarted;
    expect(secondStarted).toBe(false);
    releaseExclusive(); await first; await second;
    expect(secondStarted).toBe(true);
    let disposed = false;
    const disposing = engine.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    releaseShared(); await shared; await disposing;
    await expect(engine.withWorkspaceStorage(workspaceId, { mode: 'shared', purpose: 'after-dispose' }, () => undefined)).rejects.toThrow('disposed');
  });

  it('creates a turn checkpoint without scanning unrelated workspace files', async () => {
    const createReadStream = vi.fn(fs.createReadStream.bind(fs));
    const { engine, harness } = await createHarness({
      fileStore: createRecoveryFileStore({ fsModule: { ...fs, createReadStream } }),
    });
    await Promise.all(Array.from({ length: 200 }, (_, index) => (
      fs.promises.writeFile(path.join(harness.workspaceRoot, `unrelated-${index}.txt`), 'large workspace data')
    )));

    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });

    expect(createReadStream).not.toHaveBeenCalled();
    const listed = await listCheckpoints(engine, { workspaceId: harness.identity.workspaceId });
    expect(listed).toMatchObject({
      status: 'ready',
      page: { checkpoints: [{ changedPathCount: 0, state: 'ready' }] },
    });
  });

  it('records only the first before-image and restores the affected path with the conversation', async () => {
    const { engine, harness, navigation } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1',
      conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({
      status: 'ready',
      plan: { affectedPaths: ['note.txt'], conflicts: [], coverage: 'ready', uncoveredPaths: [] },
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'navigated', fileState: 'restored', state: 'complete' },
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    expect(navigation.commit).toHaveBeenCalledOnce();
  });

  it('waits for connected document surfaces before inspecting and applying recovery', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const events: DirtyBarrierEvent[] = [];
    const surface = harness.authority.registerDirtySurface({
      generation: 1,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    }, (event) => {
      if (!isDirtyBarrierEvent(event)) return;
      events.push(event);
      if (event.action !== 'acquire') return;
      void (async () => {
        await harness.authority.publishDirtyBuffers({
          generation: 1,
          ownerId: 'surface-1',
          resources: [],
          workspaceId: harness.identity.workspaceId,
        });
        await harness.authority.acknowledgeDirtyStateBarrier({
          barrierId: event.barrierId,
          generation: 1,
          ownerId: 'surface-1',
          workspaceId: harness.identity.workspaceId,
        });
      })();
    });
    try {
      const prepared = await prepareCombined(engine, {
        entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
      });
      expect(prepared).toMatchObject({ status: 'ready', plan: { conflicts: [] } });
      const applied = await applyCombined(engine, {
        confirmedConflicts: [],
        conflictPolicy: 'abort',
        expectedRevision: prepared.plan.revision,
        operationId: prepared.plan.id,
      });
      expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
      expect(events.filter((event) => event.action === 'acquire')).toHaveLength(2);
      expect(events.filter((event) => event.action === 'release')).toHaveLength(2);
    } finally {
      surface.close();
    }
  });

  it('fails retryably instead of treating an unresponsive dirty surface as clean', async () => {
    const { engine, harness } = await createHarness({
      documentAuthority: { dirtyBarrierTimeoutMs: 20 },
    });
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const events: unknown[] = [];
    const surface = harness.authority.registerDirtySurface({
      generation: 1,
      ownerId: 'unresponsive-surface',
      workspaceId: harness.identity.workspaceId,
    }, (event) => events.push(event));
    try {
      expect(await engine.prepareCombinedRecovery({
        entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
      })).toMatchObject({
        status: 'failed',
        failure: { code: 'dirty-state-unavailable', retryable: true },
      });
      expect(events).toContainEqual(expect.objectContaining({ action: 'release' }));
    } finally {
      surface.close();
    }
  });

  it('keeps the first before-image and last after-image across repeated writes in one turn', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'original');
    await startTurn(engine, harness);
    const base = {
      executionId: 'execution-1',
      path: target,
      toolCallId: 'tool-1',
      toolName: 'edit' as const,
      workspaceId: harness.identity.workspaceId,
    };
    await engine.recordMutationBefore({ ...base, mutationId: 'mutation-1' });
    await fs.promises.writeFile(target, 'middle');
    await engine.recordMutationAfter({ ...base, mutationId: 'mutation-1', succeeded: true });
    await engine.recordMutationBefore({ ...base, mutationId: 'mutation-2', toolCallId: 'tool-2' });
    await fs.promises.writeFile(target, 'final');
    await engine.recordMutationAfter({
      ...base,
      mutationId: 'mutation-2',
      succeeded: true,
      toolCallId: 'tool-2',
    });
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('original');
  });

  it('turns an unchanged response into an immediate zero-file rollback', async () => {
    const { engine, harness } = await createHarness();
    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1',
      conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], changedBytes: 0, coverage: 'ready' });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied.operation).toMatchObject({ fileState: 'unchanged', state: 'complete' });
  });

  it('keeps a journalled write with no net content change exact but out of the restore plan', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'same');
    await startTurn(engine, harness);
    const mutation = {
      executionId: 'execution-1', mutationId: 'mutation-same', path: target,
      toolCallId: 'tool-same', toolName: 'write' as const, workspaceId: harness.identity.workspaceId,
    };
    expect(await engine.recordMutationBefore(mutation)).toMatchObject({ recorded: true });
    await fs.promises.writeFile(target, 'same');
    expect(await engine.recordMutationAfter({ ...mutation, succeeded: true }))
      .toMatchObject({ recorded: false });
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], coverage: 'ready' });
  });

  it('rejects an absolute mutation path that does not resolve inside the workspace', async () => {
    const { engine, harness } = await createHarness();
    await startTurn(engine, harness);

    const result = await engine.recordMutationBefore({
      executionId: 'execution-1',
      mutationId: 'mutation-outside',
      path: path.join(harness.root, 'outside.txt'),
      toolCallId: 'tool-outside',
      toolName: 'write' as const,
      workspaceId: harness.identity.workspaceId,
    });

    expect(result).toMatchObject({
      failure: { code: 'workspace-untrusted', retryable: false },
      status: 'failed',
    });
  });

  it('detects later user edits per path and overwrites only after an explicit choice', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'agent');
    await settleTurn(engine, harness);
    await fs.promises.writeFile(target, 'user-later');

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'content-changed', path: 'note.txt' }),
    ]);
    const refused = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(refused).toMatchObject({ status: 'failed', failure: { code: 'path-conflict' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-later');

    const forced = await applyCombined(engine, {
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(forced.operation.state).toBe('complete');
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
  });

  it('surfaces an unsaved editor buffer only for the affected path', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 1,
        resource: { resourceId: 'note.txt', workspaceId: harness.identity.workspaceId },
      }],
      workspaceId: harness.identity.workspaceId,
    });

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'dirty-buffer', path: 'note.txt' }),
    ]);
  });

  it('does not claim exact file recovery for unjournaled shell changes', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'shell.txt'), 'changed by shell');
    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['shell.txt'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('none');
    expect(prepared.plan.uncoveredPaths).toEqual([
      { path: 'shell.txt', source: 'unknown' },
    ]);
    expect(prepared.plan.affectedPaths).toEqual([]);
    const applied = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'failed', failure: { code: 'checkpoint-incomplete' } });
  });

  it('reports partial coverage when a journaled write coexists with an unjournaled shell change', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    const shellTarget = path.join(harness.workspaceRoot, 'shell.txt');
    await fs.promises.writeFile(target, 'before');
    await fs.promises.writeFile(shellTarget, 'shell-before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    // Simulate a shell change that the watcher observes but the journal never captures.
    await fs.promises.writeFile(shellTarget, 'changed by shell');
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt', 'shell.txt'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('partial');
    expect(prepared.plan.affectedPaths).toEqual(['note.txt']);
    expect(prepared.plan.uncoveredPaths).toEqual([
      { path: 'shell.txt', source: 'unknown' },
    ]);
    // Apply should succeed — the journaled path is restorable, the shell path is left as-is.
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'navigated', fileState: 'restored', state: 'complete' },
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    // The shell path was not restored — it keeps the unjournaled change.
    expect(await fs.promises.readFile(shellTarget, 'utf8')).toBe('changed by shell');
  });

  it('does not claim ready coverage when a checkpoint is incomplete with no unrecorded paths (worker exit / observationComplete=false)', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    // Settle with observationComplete=false to simulate a worker exit / host stop
    // before the watcher finished. There are no unrecorded paths, but the
    // checkpoint is incomplete because coverage was never confirmed.
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: false,
      observedResourceIds: ['note.txt'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    // The journaled write is still restorable, so coverage is 'partial', not 'ready'.
    expect(prepared.plan.coverage).toBe('partial');
    expect(prepared.plan.affectedPaths).toEqual(['note.txt']);
    expect(prepared.plan.uncoveredPaths).toEqual([]);
    expect(prepared.plan.uncoveredReasons.length).toBeGreaterThan(0);
  });

  it('does not claim ready coverage when an incomplete checkpoint has no unrecorded paths and no restorable paths', async () => {
    const { engine, harness } = await createHarness();
    // A turn with no journaled writes and observationComplete=false.
    // mutationObserved=true with observationComplete=false makes the
    // checkpoint incomplete. No paths are restorable and no paths are
    // unrecorded, so coverage is 'none' with uncoveredReasons.
    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: false,
      observedResourceIds: [],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('none');
    expect(prepared.plan.affectedPaths).toEqual([]);
    expect(prepared.plan.uncoveredPaths).toEqual([]);
    expect(prepared.plan.uncoveredReasons.length).toBeGreaterThan(0);
  });

  it('attributes uncovered paths to shell source when a process writer is registered', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    const shellTarget = path.join(harness.workspaceRoot, 'shell.txt');
    await fs.promises.writeFile(target, 'before');
    await fs.promises.writeFile(shellTarget, 'shell-before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await fs.promises.writeFile(shellTarget, 'changed by shell');
    // Settle with a process writer scope active so source attribution
    // resolves to 'shell' via the `process/` prefix.
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt', 'shell.txt'],
      activeWriterScopes: ['process/native-runtime:worker-1@1'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('partial');
    expect(prepared.plan.uncoveredPaths).toEqual([
      { path: 'shell.txt', source: 'shell' },
    ]);
  });

  it('stores affected-path safety state and can undo a completed combined rollback', async () => {
    const { engine, harness, navigation } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    const undo = ready(await engine.prepareCombinedUndo(applied.operation.id));
    const redone = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: undo.plan.revision, operationId: undo.plan.id,
    });
    expect(redone.operation).toMatchObject({ state: 'complete', undoOf: applied.operation.id });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('after');
    expect(navigation.commitLeaf).toHaveBeenCalledOnce();
  });

  it('keeps newly referenced objects reachable during cleanup', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const cleaned = await engine.cleanupStorage({ workspaceId: harness.identity.workspaceId });
    expect(cleaned).toMatchObject({
      status: 'ready',
      result: { objectsDeleted: 0, recordsDeleted: 0, status: 'complete' },
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
  });

  it('resumes the original operation after an uncertain Thread navigation response', async () => {
    const navigation: RecoverySessionNavigation = {
      commit: vi.fn(async () => { throw new Error('navigation response unavailable'); }),
      commitLeaf: vi.fn(async () => ({ markerId: 'unused' })),
      prepare: vi.fn(async (input) => ({
        expectedLeafId: 'leaf-current',
        removedEntryIds: [input.entryId, 'assistant-1'],
        targetLeafId: 'leaf-before',
      })),
      prepareLeaf: vi.fn(async (input) => ({
        expectedLeafId: 'leaf-before',
        removedEntryIds: [],
        targetLeafId: input.targetLeafId,
      })),
    };
    const { durable, engine, harness } = await createHarness({ sessionNavigation: navigation });
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    const result = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'navigation-conflict' } });
    // The response is uncertain, so the original operation keeps its restored files.
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    expect(await engine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: {
        failure: { code: 'navigation-conflict' },
        fileState: 'restored',
        state: 'navigating-conversation',
      },
    });

    // Restart retries the original navigation identity, not a replacement plan.
    const restartNavigation = createTestNavigation();
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path }),
      sessionNavigation: restartNavigation,
    });
    await restartEngine.resumeCombinedOperations();
    expect(restartNavigation.commit).toHaveBeenCalledWith({
      conversation: prepared.plan.conversation,
      entryId: prepared.plan.entryId,
      expectedLeafId: prepared.plan.expectedLeafId,
      operationId: prepared.plan.id,
      preparedTargetLeafId: prepared.plan.targetLeafId,
      workspaceId: prepared.plan.workspaceId,
    });
    expect(await restartEngine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { id: prepared.plan.id, revision: prepared.plan.revision, conversationState: 'navigated', fileState: 'restored', state: 'complete' },
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
  });

  it('reports retired storage management and retention controls as unavailable', async () => {
    const { engine, harness } = await createHarness();
    const workspaceId = harness.identity.workspaceId;
    const policy = {
      maxAgeDays: null,
      maxByteLength: null,
      maxCheckpointCount: 1,
      maxOperationCount: null,
    };
    for (const result of [
      await engine.deleteWorkspaceHistory(workspaceId),
      await engine.setRetentionPolicy({ policy, workspaceId }),
      await engine.setStorageLocation({ location: { mode: 'workspace-adjacent' }, workspaceId }),
      await engine.setDefaultStorageLocation({ mode: 'application-data' }),
      await engine.getStorageMove('operation-1'),
      await engine.clearStorageLocationOverride(workspaceId),
    ]) {
      expect(result).toMatchObject({ status: 'failed', failure: { code: 'unavailable' } });
    }
  });

  it('reports retired direct-buffer mutations without replaying or rewriting their original records', async () => {
    const { engine, harness, durable } = await createHarness();
    const workspaceId = harness.identity.workspaceId;
    harness.authority.bindDurableMutationStorage((id, callback) => engine.withWorkspaceStorage(id,
      { mode: 'shared', purpose: 'native-recovery-test', create: true }, callback));
    const file = path.join(harness.workspaceRoot, 'kept.txt');
    await fs.promises.writeFile(file, 'later user bytes');
    await durable.createOperation({ operationId: 'retired-write', workspaceId, kind: 'agent-mutation', state: 'applying',
      data: { sessionId: 'original-retired-session', operationId: 'retired-write', intent: 'agent-surface-write' },
      targets: { 'kept.txt': { expected: { kind: 'missing' }, target: { kind: 'missing' } } } });
    const before = durable.snapshot(workspaceId, 'retired-write');
    const writeFile = vi.spyOn(durable, 'updateOperationFile');
    const complete = vi.spyOn(durable, 'completeOperation');
    await engine.resumeCombinedOperations();
    expect(await engine.status(workspaceId)).toMatchObject({ status: 'ready', failures: [
      { code: 'storage-schema-retired', operationId: 'retired-write', message: expect.stringMatching(/unsupported.*preserved/), retryable: false },
    ] });
    expect(durable.snapshot(workspaceId, 'retired-write')).toEqual(before);
    expect(writeFile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(file, 'utf8')).toBe('later user bytes');
  });

  it('rejects overwrite-confirmed when a conflict fingerprint changed after review', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await fs.promises.writeFile(target, 'user-later-v1');

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toHaveLength(1);
    // File changes again after conflict review — fingerprint must differ.
    await fs.promises.writeFile(target, 'user-later-v2');
    const stale = await engine.applyCombinedRecovery({
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(stale).toMatchObject({ status: 'failed', failure: { code: 'stale-plan', retryable: true } });
    // The file must not have been overwritten.
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-later-v2');
  });

  it('requires a connected complete surface binding before restoring an acknowledged dirty-buffer conflict', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 1,
        resource: { resourceId: 'note.txt', workspaceId: harness.identity.workspaceId },
      }],
      workspaceId: harness.identity.workspaceId,
    });

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts[0]?.kind).toBe('dirty-buffer');
    const rejected = await engine.applyCombinedRecovery({
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(rejected).toMatchObject({ status: 'failed', failure: { code: 'dirty-state-unavailable' } });
  });

  it('reconciles a crash in the apply-intent window by detecting the target was already written', async () => {
    const { durable, engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });

    // Recovery semantics: target = 'before' (rollback destination), safety = 'after' (current).
    // Use a spy fileStore that crashes after applyState writes the rollback target.
    const { createRecoveryFileStore } = await import('./file-store.test-helper.js');
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      await realFileStore.applyState(...args);
      throw new Error('SIMULATED_CRASH_AFTER_APPLY');
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: crashFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed).toMatchObject({ status: 'failed', failure: { message: 'SIMULATED_CRASH_AFTER_APPLY' } });
    expect(crashApplyState).toHaveBeenCalledOnce();

    // applyState wrote the rollback target ('before') to disk before crashing.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('before');

    // The operation file phase should still be 'apply-intent' because the
    // crash happened before the phase update to target-observed.
    const crashedOperation = durable.snapshot(harness.identity.workspaceId, prepared.plan.id);
    expect(crashedOperation).not.toBeNull();
    expect(crashedOperation!.files).toHaveLength(1);
    expect(crashedOperation!.files.every((file) => file.phase === 'apply-intent')).toBe(true);

    // Now create a fresh engine (simulating a restart) and call resumeCombinedOperations.
    // It should reconcile: disk == target, phase == apply-intent → target-observed,
    // then compensate writes safety ('after') back to disk.
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: realFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    await restartEngine.resumeCombinedOperations();

    // After resume, the file should be compensated back to safety ('after').
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
  });

  it('reconciles a crash in the compensate-intent window by detecting safety was already written', async () => {
    const { durable, engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    const extraPath = path.join(harness.workspaceRoot, 'extra.txt');
    await fs.promises.writeFile(notePath, 'before');
    await fs.promises.writeFile(extraPath, 'before-extra');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    const extraBase = {
      executionId: 'execution-1',
      mutationId: 'mutation-extra',
      path: extraPath,
      toolCallId: 'tool-extra',
      toolName: 'write' as const,
      workspaceId: harness.identity.workspaceId,
    };
    await engine.recordMutationBefore(extraBase);
    await fs.promises.writeFile(extraPath, 'after-extra');
    await engine.recordMutationAfter({ ...extraBase, succeeded: true });
    await settleTurn(engine, harness, { observedResourceIds: ['extra.txt', 'note.txt'] });

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.affectedPaths).toEqual(['extra.txt', 'note.txt']);

    // Recovery semantics: target = 'before*', safety = 'after*'.
    // Phase 1: extra.txt applyState writes 'before-extra' — succeeds.
    // Phase 2: note.txt applyState writes 'before' — then crashes. Compensation
    //          observes that intent and restores note.txt to its safety state.
    // Phase 3: compensation writes 'after-extra' — then crashes, leaving that
    //          path in 'compensate-intent' even though its safety is on disk.
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      await realFileStore.applyState(...args);
      const written = await fs.promises.readFile(path.join(args[1], args[2]), 'utf8');
      if ((args[2] === 'note.txt' && written === 'before') || (args[2] === 'extra.txt' && written === 'after-extra')) {
        throw new Error(`SIMULATED_CRASH_AFTER_WRITE_${args[2]}`);
      }
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: crashFileStore,
      sessionNavigation: createTestNavigation(),
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed.status).toBe('failed');
    // After the crash: both files are back at safety, but extra.txt's
    // compensation acknowledgement is still unresolved.
    // The runtime failure path correctly persists needs-attention.
    expect(await fs.promises.readFile(extraPath, 'utf8')).toBe('after-extra');
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
    const crashedOperation = durable.snapshot(harness.identity.workspaceId, prepared.plan.id);
    expect(crashedOperation).not.toBeNull();
    expect(crashedOperation!.state).toBe('needs-attention');
    expect(crashedOperation!.files.find((file) => file.path === 'extra.txt')?.phase).toBe('compensate-intent');
    expect(crashedOperation!.files.find((file) => file.path === 'note.txt')?.phase).toBe('safety-observed');

    // A host kill mid-compensation (instead of a catchable exception) leaves
    // the same file phases but never reaches the terminal persist. Rewind the
    // catalog state to 'compensating-files' to stage that post-mortem shape.
    durable.debugSetOperationState(harness.identity.workspaceId, prepared.plan.id, 'compensating-files');

    // Restart recognizes extra.txt's completed write and finishes this same
    // compensation without replaying either file mutation.
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: realFileStore,
      sessionNavigation: createTestNavigation(),
    });
    await restartEngine.resumeCombinedOperations();

    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
    expect(await fs.promises.readFile(extraPath, 'utf8')).toBe('after-extra');
    expect(await restartEngine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { fileState: 'compensated', state: 'compensated' },
    });
  });

  it('blocks retry when a file is in needs-attention state', async () => {
    const { durable, engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', conversation: { kind: 'thread', threadId: 'session-1', branchId: 'branch-1' }, workspaceId: harness.identity.workspaceId,
    });

    // Use a crash fileStore to capture safety and crash during applyState.
    const { createRecoveryFileStore } = await import('./file-store.test-helper.js');
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      await realFileStore.applyState(...args);
      throw new Error('SIMULATED_CRASH_AFTER_APPLY');
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: crashFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed.status).toBe('failed');

    // Now force the file to needs-attention in the durable store.
    durable.debugSetFilePhase(harness.identity.workspaceId, prepared.plan.id, 'note.txt', 'needs-attention');
    durable.debugSetOperationState(harness.identity.workspaceId, prepared.plan.id, 'applying-files');

    // Reset the file to safety state ('after').
    await fs.promises.writeFile(notePath, 'after');

    // Attempt to retry with the original engine — should fail because
    // needs-attention is a blocking terminal phase.
    const result = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(result).toMatchObject({ status: 'ready', operation: {
      state: 'needs-attention', fileState: 'needs-attention', failure: { code: 'needs-attention' },
    } });
    expect(await engine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: {
        failure: { code: 'needs-attention' },
        fileState: 'needs-attention',
        state: 'needs-attention',
      },
    });
    // The file must not have been changed.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
  });

});

describe('managed file participants in the original recovery journal', () => {
  const createPair = async (mixed = false) => {
    const bFiles = createRecoveryFileStore();
    const b = await createHarness({ fileStore: bFiles });
    const conversation = { kind: 'thread' as const, threadId: 'thread-A', branchId: 'branch-A' };
    const fileTarget = { kind: 'physical' as const, workspaceId: b.harness.identity.workspaceId, threadId: conversation.threadId,
      runId: 'run-A', rootId: 'root-B', canonicalRoot: b.harness.workspaceRoot,
      executionWorkspaceId: b.harness.identity.workspaceId, sourceMode: 'live_root' as const };
    const executionId = 'run-A:user-1';
    const notePath = path.join(b.harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before-B');
    ready(await b.engine.recordTurnStart({ activeWriterScopes: [], executionId, provenance: 'caused-by',
      runtimeGeneration: 1, conversation, userEntryId: 'user-1', workerId: 'kernel',
      workspaceId: b.harness.identity.workspaceId, fileTarget }));
    const mutation = { executionId, mutationId: 'mutation-B', path: notePath, toolCallId: 'tool-B', toolName: 'write' as const, workspaceId: b.harness.identity.workspaceId };
    ready(await b.engine.recordMutationBefore(mutation));
    await fs.promises.writeFile(notePath, 'after-B');
    ready(await b.engine.recordMutationAfter({ ...mutation, succeeded: true }));
    await settleTurn(b.engine, b.harness, { executionId });
    const owner = { kind: 'managed_host' as const, hostId: 'host-B', connectionId: 'connection-B', endpointIdentity: 'endpoint-B' };
    const physicalRoot = { hostId: owner.hostId, rootId: fileTarget.rootId, canonicalRoot: fileTarget.canonicalRoot };
    const source: import('../kernel/protocol.generated.js').LaunchSource = { resource_owner: owner,
      workspace_id: b.harness.identity.workspaceId, execution_workspace_id: b.harness.identity.workspaceId,
      live_root: physicalRoot, mode: 'live_root', branch_id: null, revision: null };
    const turns: import('./managed-recovery-coordinator.js').ManagedRecoveryTurn[] = [{ restore: true, turn: {
      anchor: { executionId, threadId: 'thread-A', branchId: 'branch-A', runId: 'run-A', entryId: 'user-1', epoch: 1 },
      source, entryIds: ['user-1', 'assistant-1'], uncovered: false, settled: true,
    } }];
    const binding = { principalId: 'principal-A', coordinatorHostId: 'host-A', workspaceId: source.workspace_id, conversation, turns };
    const service = createManagedRecoveryService({ hostId: 'host-B',
      kernel: { start: async () => ({}), sourceRequest: async () => [{ source, physicalRoot,
        scope: { kind: 'run', threadId: 'thread-A', runId: 'run-A', epoch: 1 }, phase: 'retired' }] } as unknown as import('../kernel/kernel-client.js').KernelClient,
      storage: { fileAuthorityContext: async () => ({ rootId: 'root-B', canonicalRoot: b.harness.workspaceRoot, client: {} }) } as unknown as import('../kernel/storage-adapter.js').KernelStorageAdapter,
      documents: b.harness.authority, store: b.durable, recovery: b.engine, validateLiveSource: async () => {},
    });
    const originalCapture = bFiles.captureState;
    const originalApply = bFiles.applyState;
    bFiles.captureState = async (...args) => { if (args[0].fileTarget) expect(await service.resolveFileResources(args[0])).not.toBeNull(); return originalCapture(...args); };
    bFiles.applyState = async (...args) => { expect(await service.resolveFileResources(args[0])).not.toBeNull(); return originalApply(...args); };
    const client = { recovery: (input: import('../harness/managed-recovery-contract.js').ManagedRecoveryRequest) =>
      service.handle({ principalId: 'principal-A', capabilities: ['filesystem:read', 'filesystem:write'] }, input) };
    const remote = createManagedRecoveryCoordinator({ coordinatorHostId: 'host-A',
      registry: { source: async () => client as import('../harness/managed-remote-client.js').ManagedSourceClient } });
    vi.spyOn(remote, 'apply'); vi.spyOn(remote, 'read'); vi.spyOn(remote, 'complete'); vi.spyOn(remote, 'cancel');
    const navigation = createTestNavigation();
    navigation.prepare = vi.fn(async () => ({ expectedLeafId: 'leaf-current', targetLeafId: 'leaf-before',
      removedEntryIds: ['user-1', 'assistant-1'], journalTurns: [], managedTurns: turns }));
    const aFiles = createRecoveryFileStore();
    const capture = vi.spyOn(aFiles, 'captureState');
    const metadata = { coordinatorWorkspaceId: 'recovery-coordinator:host-A',
      resolveCoordinatorIdentity: async (workspaceId: string) => workspaceId === 'recovery-coordinator:host-A'
        ? { authorityId: 'host-A', workspaceId, canonicalRoot: '', filesystemProfile: 'metadata' } : null,
      listCoordinatorWorkspaces: async () => [{ workspaceId: 'recovery-coordinator:host-A' }],
    };
    const a = await createHarness({ ...metadata, fileStore: aFiles, managedRecovery: remote, sessionNavigation: navigation });
    await fs.promises.writeFile(path.join(a.harness.workspaceRoot, 'note.txt'), mixed ? 'before-A' : 'independent-A');
    if (mixed) {
      const localTarget = { ...fileTarget, workspaceId: a.harness.identity.workspaceId, executionWorkspaceId: a.harness.identity.workspaceId,
        canonicalRoot: a.harness.workspaceRoot, rootId: 'root-A', runId: 'run-local' };
      ready(await a.engine.recordTurnStart({ activeWriterScopes: [], executionId: 'execution-1', provenance: 'caused-by',
        runtimeGeneration: 1, conversation, userEntryId: 'user-local', workerId: 'worker-A', workspaceId: a.harness.identity.workspaceId, fileTarget: localTarget }));
      await recordWrite(a.engine, a.harness, 'after-A');
      await settleTurn(a.engine, a.harness);
      navigation.prepare = vi.fn(async () => ({ expectedLeafId: 'leaf-current', targetLeafId: 'leaf-before',
        removedEntryIds: ['user-local', 'user-1', 'assistant-1'], journalTurns: [{ workspaceId: a.harness.identity.workspaceId, executionId: 'execution-1', restore: true }], managedTurns: turns }));
    }
    const prepared = ready(await a.engine.prepareCombinedRecovery({ conversation, workspaceId: b.harness.identity.workspaceId, entryId: 'user-1' }));
    const apply = { operationId: prepared.plan.id, expectedRevision: prepared.plan.revision, conflictPolicy: 'abort' as const, confirmedConflicts: [] };
    const reopen = () => createWorkspaceRecoveryEngine({ ...metadata, authorityId: 'host-A', dataDir: a.harness.dataDir,
      documents: a.harness.authority, durableRecoveryStore: a.durable, fileStore: aFiles,
      managedRecovery: remote, sessionNavigation: navigation });
    return { a, b, remote, navigation, prepared, apply, capture, binding, reopen, bFileStore: bFiles };
  };

  it('restores on B, navigates only A, and undoes from B-owned safety without A file access', async () => {
    const { a, b, remote, navigation, prepared, apply, capture } = await createPair();
    expect(prepared.plan.workspaceId).toBe('recovery-coordinator:host-A');
    const result = ready(await a.engine.applyCombinedRecovery(apply));
    expect(result.operation.state).toBe('complete');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-B');
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('independent-A');
    expect(capture).not.toHaveBeenCalled();
    expect(b.navigation.commit).not.toHaveBeenCalled();
    expect(navigation.commit).toHaveBeenCalledOnce();
    expect(remote.complete).toHaveBeenCalledOnce();
    const aRecord = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
    expect(aRecord.files).toEqual([]);
    const undo = ready(await a.engine.prepareCombinedUndo(prepared.plan.id));
    expect(ready(await a.engine.applyCombinedRecovery({ operationId: undo.plan.id, expectedRevision: undo.plan.revision, conflictPolicy: 'abort', confirmedConflicts: [] })).operation.state).toBe('complete');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps a lost B response pending and resumes the same journal after reopening without replay', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair();
    const originalApply = remote.apply;
    remote.apply = vi.fn(async (...args: Parameters<typeof originalApply>) => { await originalApply(...args); throw new Error('lost apply reply'); });
    const read = remote.read;
    remote.read = vi.fn(async () => { throw new Error('target temporarily disconnected'); });
    expect(await a.engine.applyCombinedRecovery(apply)).toMatchObject({ status: 'failed', failure: { retryable: true } });
    expect(ready(await a.engine.getCombinedOperation(prepared.plan.id)).operation.state).toBe('applying-files');
    expect(navigation.commit).not.toHaveBeenCalled();
    expect(remote.cancel).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-B');
    await a.engine.dispose();
    remote.read = read;
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]?.state).toBe('complete');
    expect(remote.apply).toHaveBeenCalledOnce();
    expect(navigation.commit).toHaveBeenCalledOnce();
    await restarted.dispose();
  });

  it('compensates B after a definite A head rejection, preserving unrelated A files', async () => {
    const { a, b, navigation, prepared, apply } = await createPair();
    navigation.commit = vi.fn(async () => { throw new RecoveryPrimitiveError('navigation-conflict', 'head changed', { origin: 'navigation' }); });
    expect((await a.engine.applyCombinedRecovery(apply)).status).toBe('failed');
    expect(ready(await a.engine.getCombinedOperation(prepared.plan.id)).operation.state).toBe('compensated');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('independent-A');
  });

  it('holds a restored B participant on autonomous restart and refuses a different authenticated binding', async () => {
    const { a, b, remote, prepared, apply, binding } = await createPair();
    const record = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
    const participant = ((record.result ?? record.data).managedParticipants as import('./managed-recovery-coordinator.js').ManagedRecoveryParticipant[])[0]!;
    expect(ready(await remote.apply(participant, { ...apply, operationId: participant.id, expectedRevision: participant.plan.revision })).operation.state).toBe('files-restored');
    expect(await b.engine.resumeCombinedOperations()).toEqual([]);
    expect(await b.engine.readFileRecovery({ operationId: participant.id, binding: { ...binding, principalId: 'other' } }))
      .toMatchObject({ status: 'failed', failure: { code: 'workspace-untrusted' } });
    expect(b.navigation.commit).not.toHaveBeenCalled();
    expect(ready(await remote.cancel(participant)).operation.state).toBe('compensated');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
  });

  it('durably records preparation before B can acknowledge and retries only that original plan', async () => {
    const { a, b, remote, prepared } = await createPair();
    ready(await a.engine.cancelCombinedOperation(prepared.plan.id));
    const prepare = remote.prepare;
    remote.prepare = vi.fn(async (...args: Parameters<typeof prepare>) => { await prepare(...args); throw new Error('lost preparation acknowledgement'); });
    const input = { workspaceId: prepared.plan.workspaceId, conversation: prepared.plan.conversation, entryId: prepared.plan.entryId };
    const lost = await a.engine.prepareCombinedRecovery(input);
    expect(lost).toMatchObject({ status: 'failed', failure: { code: 'recovery-in-progress', retryable: true } });
    if (lost.status !== 'failed' || !lost.failure.operationId) throw new Error('Expected the original durable operation identity');
    const operationId = lost.failure.operationId;
    const pending = a.durable.snapshot(prepared.plan.workspaceId, operationId)!;
    expect((pending.result ?? pending.data).managedPreparation).toBeTruthy();
    const count = (await b.durable.listOperations(b.harness.identity.workspaceId, 'combined')).length;
    remote.prepare = prepare;
    const retried = ready(await a.engine.prepareCombinedRecovery(input));
    expect(retried.plan.id).toBe(operationId);
    expect((await b.durable.listOperations(b.harness.identity.workspaceId, 'combined')).length).toBe(count);
    expect(ready(await a.engine.cancelCombinedOperation(operationId)).operation.state).toBe('compensated');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
  });

  it('recovers mixed A and B files without compensating an uncertain A navigation or replaying files', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair(true);
    navigation.commit = vi.fn(async () => { throw new RecoveryPrimitiveError('navigation-conflict', 'original Catalog response is pending', { origin: 'navigation', retryable: true }); });
    expect((await a.engine.applyCombinedRecovery(apply)).status).toBe('failed');
    expect(ready(await a.engine.getCombinedOperation(prepared.plan.id)).operation.state).toBe('navigating-conversation');
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-B');
    expect(remote.cancel).not.toHaveBeenCalled();
    navigation.commit = vi.fn(async () => ({ markerId: prepared.plan.id }));
    const complete = remote.complete;
    remote.complete = vi.fn(async (...args: Parameters<typeof complete>) => { await complete(...args); throw new Error('lost completion receipt'); });
    await a.engine.dispose();
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]?.state).toBe('complete');
    expect(remote.apply).toHaveBeenCalledOnce();
    expect(navigation.commit).toHaveBeenCalledWith(expect.objectContaining({ operationId: prepared.plan.id }));
    expect(ready(await restarted.getCombinedOperation(prepared.plan.id)).operation.appliedPathCount).toBe(2);
    await restarted.dispose();
  });


  it('keeps B editor conflicts namespaced and compensates local files when the confirmed B surface is unavailable', async () => {
    const { a, b, navigation, prepared } = await createPair(true);
    ready(await a.engine.cancelCombinedOperation(prepared.plan.id));
    await b.harness.authority.publishDirtyBuffers({ generation: 1, ownerId: 'surface-B',
      resources: [{ baseRevision: null, localEditRevision: 1, resource: { resourceId: 'note.txt', workspaceId: b.harness.identity.workspaceId } }],
      workspaceId: b.harness.identity.workspaceId });
    const plan = ready(await a.engine.prepareCombinedRecovery({ workspaceId: prepared.plan.workspaceId, conversation: prepared.plan.conversation, entryId: prepared.plan.entryId })).plan;
    expect(plan.conflicts).toEqual([expect.objectContaining({ kind: 'dirty-buffer', path: expect.stringMatching(/^managed\//) })]);
    const result = await a.engine.applyCombinedRecovery({ operationId: plan.id, expectedRevision: plan.revision, conflictPolicy: 'overwrite-confirmed',
      confirmedConflicts: plan.conflicts.map(({ path, fingerprint }) => ({ path, fingerprint })) });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'dirty-state-unavailable' } });
    expect(navigation.commit).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
  });


  it('re-enters the same planned B operation when the durable apply dispatch never reached its owner', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair();
    const dispatch = remote.apply;
    remote.apply = vi.fn(async () => { throw new Error('connection failed before B received apply'); });
    expect(await a.engine.applyCombinedRecovery(apply)).toMatchObject({ status: 'failed', failure: { retryable: true } });
    expect(navigation.commit).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
    await a.engine.dispose();
    remote.apply = dispatch;
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]?.state).toBe('complete');
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await b.durable.listOperations(b.harness.identity.workspaceId, 'combined'))).toHaveLength(1);
    expect(ready(await restarted.getCombinedOperation(prepared.plan.id)).operation.state).toBe('complete');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-B');
    await restarted.dispose();
  });


  it('compensates confirmed local output when reopened B reconciles its interrupted file stage to compensated', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair(true);
    const dispatch = remote.apply;
    remote.apply = vi.fn(async (...args: Parameters<typeof dispatch>) => {
      await dispatch(...args);
      b.durable.debugSetOperationState(args[0].workspaceId, args[0].id, 'applying-files');
      throw new Error('B restarted before its final file-stage acknowledgement');
    });
    const read = remote.read;
    remote.read = vi.fn(async () => { throw new Error('B restart still in progress'); });
    expect(await a.engine.applyCombinedRecovery(apply)).toMatchObject({ status: 'failed', failure: { retryable: true } });
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-A');
    await a.engine.dispose();
    remote.read = read;
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]?.state).toBe('compensated');
    expect(ready(await restarted.getCombinedOperation(prepared.plan.id)).operation.conversationState).toBe('unchanged');
    expect(navigation.commit).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
    await restarted.dispose();
  });


  it('compensates local output when the same planned B apply is rejected after a user edit during disconnection', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair(true);
    const dispatch = remote.apply;
    remote.apply = vi.fn(async () => { throw new Error('apply never reached B'); });
    expect(await a.engine.applyCombinedRecovery(apply)).toMatchObject({ status: 'failed', failure: { retryable: true } });
    await fs.promises.writeFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'later-user-B');
    await a.engine.dispose();
    remote.apply = dispatch;
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]).toMatchObject({ state: 'compensated', failure: { code: 'path-conflict' } });
    expect(ready(await restarted.getCombinedOperation(prepared.plan.id)).operation.conversationState).toBe('unchanged');
    expect(navigation.commit).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('later-user-B');
    await restarted.dispose();
  });


  it('records cancellation outside a withheld B reply and finishes the original participants before that reply is released', async () => {
    const { a, b, remote, navigation, prepared, apply } = await createPair(true);
    let releaseReply!: () => void;
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
    let applied!: () => void;
    const appliedAtB = new Promise<void>(resolve => { applied = resolve; });
    const dispatch = remote.apply;
    remote.apply = vi.fn(async (...args: Parameters<typeof dispatch>) => {
      const receipt = await dispatch(...args); applied(); await replyGate; return receipt;
    });
    const applying = a.engine.applyCombinedRecovery(apply);
    await appliedAtB;
    try {
      const cancelling = a.engine.cancelCombinedOperation(prepared.plan.id);
      const result = await Promise.race([cancelling, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Cancellation waited for the withheld apply reply')), 2000))]);
      expect(ready(result).operation.state).toBe('compensated');
      expect(ready(await applying).operation.state).toBe('compensated');
      const stored = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
      expect((stored.result ?? stored.data).cancelRequested).toBe(true);
      expect(remote.cancel).toHaveBeenCalled();
      expect(navigation.commit).not.toHaveBeenCalled();
      expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-A');
      expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
    } finally { releaseReply(); await applying; }
    await Promise.resolve();
    expect(ready(await a.engine.getCombinedOperation(prepared.plan.id)).operation.state).toBe('compensated');
  });


  it('records B cancellation before its in-flight file owner settles without treating observation interruption as stopped work', async () => {
    const { a, b, remote, navigation, prepared, apply, bFileStore } = await createPair(true);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    let wrote!: () => void;
    const wroteAtB = new Promise<void>(resolve => { wrote = resolve; });
    const write = bFileStore.applyState;
    bFileStore.applyState = async (...args) => { await write(...args); wrote(); await writeGate; };
    const applying = a.engine.applyCombinedRecovery(apply);
    await wroteAtB;
    const stored = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
    const participant = ((stored.result ?? stored.data).managedParticipants as import('./managed-recovery-coordinator.js').ManagedRecoveryParticipant[])[0]!;
    let cancelled = false;
    const cancelling = a.engine.cancelCombinedOperation(prepared.plan.id).then(result => { cancelled = true; return result; });
    try {
      await expect.poll(() => {
        const operation = b.durable.snapshot(participant.workspaceId, participant.id)!;
        return (operation.result ?? operation.data).cancelRequested;
      }, { timeout: 2000 }).toBe(true);
      expect(cancelled).toBe(false);
      expect(ready(await b.engine.getCombinedOperation(participant.id)).operation.state).toBe('applying-files');
      expect(remote.cancel).toHaveBeenCalled();
      expect(navigation.commit).not.toHaveBeenCalled();
    } finally { releaseWrite(); }
    expect(ready(await cancelling).operation.state).toBe('compensated');
    expect(ready(await applying).operation.state).toBe('compensated');
    for (const [durable, workspaceId, id] of [[a.durable, prepared.plan.workspaceId, prepared.plan.id], [b.durable, participant.workspaceId, participant.id]] as const) {
      const operation = durable.snapshot(workspaceId, id)!;
      expect((operation.result ?? operation.data).cancelRequested).toBe(true);
    }
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('after-B');
  });

  it('cancels the original pending preparation and ignores its late successful reply', async () => {
    const { a, b, remote, navigation, prepared } = await createPair();
    ready(await a.engine.cancelCombinedOperation(prepared.plan.id));
    const input = { workspaceId: prepared.plan.workspaceId, conversation: prepared.plan.conversation, entryId: prepared.plan.entryId };
    let releaseReply!: () => void;
    const replyGate = new Promise<void>(resolve => { releaseReply = resolve; });
    let preparedAtB!: (id: string) => void;
    const bPrepared = new Promise<string>(resolve => { preparedAtB = resolve; });
    const prepare = remote.prepare;
    let calls = 0;
    remote.prepare = vi.fn(async (...args: Parameters<typeof prepare>) => {
      const result = await prepare(...args);
      if (++calls === 1) { preparedAtB(args[0]); await replyGate; }
      return result;
    });
    const preparing = a.engine.prepareCombinedRecovery(input);
    const operationId = await bPrepared;
    try {
      const cancelling = a.engine.cancelCombinedOperation(operationId);
      const result = await Promise.race([cancelling, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Cancellation waited for the old preparation reply')), 2000))]);
      expect(ready(result).operation.state).toBe('compensated');
      expect(await preparing).toMatchObject({ status: 'failed', failure: { operationId } });
      expect(remote.apply).not.toHaveBeenCalled();
      expect(navigation.commit).not.toHaveBeenCalled();
      const bOperations = await b.durable.listOperations(b.harness.identity.workspaceId, 'combined');
      expect(bOperations).toHaveLength(2);
      expect(bOperations.every(operation => operation.state === 'aborted')).toBe(true);
    } finally { releaseReply(); await preparing; }
    await Promise.resolve();
    const record = a.durable.snapshot(prepared.plan.workspaceId, operationId)!;
    expect((record.result ?? record.data).cancelRequested).toBe(true);
    expect(ready(await a.engine.getCombinedOperation(operationId)).operation.state).toBe('compensated');
  });

  it('keeps late cancellation durable while an already-issued navigation remains unknown and resolves its original receipt', async () => {
    const { a, b, remote, navigation, prepared, apply, reopen } = await createPair(true);
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>(resolve => { releaseNavigation = resolve; });
    let navigating!: () => void;
    const navigationStarted = new Promise<void>(resolve => { navigating = resolve; });
    navigation.commit = vi.fn(async () => {
      navigating(); await navigationGate;
      throw new RecoveryPrimitiveError('navigation-conflict', 'Original Catalog receipt is unknown', { retryable: true, origin: 'navigation' });
    });
    const applying = a.engine.applyCombinedRecovery(apply);
    await navigationStarted;
    const cancelling = a.engine.cancelCombinedOperation(prepared.plan.id);
    try {
      await expect.poll(() => {
        const record = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
        return (record.result ?? record.data).cancelRequested;
      }, { timeout: 2000 }).toBe(true);
      expect(remote.cancel).not.toHaveBeenCalled();
    } finally { releaseNavigation(); }
    expect(await applying).toMatchObject({ status: 'failed', failure: { code: 'navigation-conflict' } });
    expect(ready(await cancelling).operation.state).toBe('navigating-conversation');
    expect(remote.cancel).not.toHaveBeenCalled();
    expect(await fs.promises.readFile(path.join(a.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-A');
    expect(await fs.promises.readFile(path.join(b.harness.workspaceRoot, 'note.txt'), 'utf8')).toBe('before-B');
    await a.engine.dispose();
    navigation.commit = vi.fn(async () => ({ navigationMarkerId: prepared.plan.id }));
    const restarted = reopen();
    expect((await restarted.resumeCombinedOperations())[0]?.state).toBe('complete');
    expect(navigation.commit).toHaveBeenCalledWith(expect.objectContaining({ operationId: prepared.plan.id }));
    expect(remote.cancel).not.toHaveBeenCalled();
    const record = a.durable.snapshot(prepared.plan.workspaceId, prepared.plan.id)!;
    expect((record.result ?? record.data).cancelRequested).toBe(true);
    await restarted.dispose();
  });

});

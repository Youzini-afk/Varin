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
  sessionId: 'session-1',
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
      sessionId: 'session-1',
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
        entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
        entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      sessionId: 'session-1',
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      activeWriterScopes: ['process/pi-worker:worker-1@1'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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

  it('keeps restored files and stays resumable when Pi rejects conversation navigation', async () => {
    const navigation: RecoverySessionNavigation = {
      commit: vi.fn(async () => { throw new Error('leaf changed'); }),
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const result = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'navigation-conflict' } });
    // The file restore already succeeded; only conversation navigation failed.
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    expect(await engine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: {
        failure: { code: 'navigation-conflict' },
        fileState: 'restored',
        state: 'navigating-conversation',
      },
    });

    // Retried navigation finishes the operation after restart.
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: durable,
      fileStore: createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path }),
      sessionNavigation: createTestNavigation(),
    });
    await restartEngine.resumeCombinedOperations();
    expect(await restartEngine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'navigated', fileState: 'restored', state: 'complete' },
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

  it('reports v5 recovery lifecycle capabilities as implemented', async () => {
    const { engine, harness } = await createHarness();
    const status = await engine.status(harness.identity.workspaceId);
    expect(status).toMatchObject({
      status: 'ready',
      capabilities: {
        bindings: true,
        catalogLifecycle: true,
        checkpoints: true,
        combined: true,
        conflictConfirmation: true,
        dirtyStateBarrier: true,
        journal: true,
        redo: true,
        retention: false,
        storageManagement: false,
        workspaceLease: false,
      },
      failures: [],
    });
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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

  it('rejects overwrite-confirmed for an acknowledged dirty-buffer conflict', async () => {
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
    expect(rejected).toMatchObject({ status: 'failed', failure: { code: 'dirty-buffers' } });
  });

  it('reconciles a crash in the apply-intent window by detecting the target was already written', async () => {
    const { durable, engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.affectedPaths).toEqual(['extra.txt', 'note.txt']);

    // Recovery semantics: target = 'before*', safety = 'after*'.
    // Phase 1: extra.txt applyState writes 'before-extra' — succeeds.
    // Phase 2: note.txt applyState writes 'before' — then crashes. extra.txt is
    //          already applied, so the engine must compensate it.
    // Phase 3: compensation applyState writes 'after-extra' — then crashes,
    //          leaving extra.txt in 'compensate-intent' with safety on disk.
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    let applyCallCount = 0;
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      applyCallCount += 1;
      await realFileStore.applyState(...args);
      if (applyCallCount >= 2) {
        throw new Error(`SIMULATED_CRASH_ON_APPLY_${applyCallCount}`);
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
    expect(crashApplyState).toHaveBeenCalledTimes(3);

    // After the crash: extra.txt was compensated back to safety; note.txt's
    // crashed apply left the target on disk with an unresolved intent phase.
    // The runtime failure path correctly persists needs-attention.
    expect(await fs.promises.readFile(extraPath, 'utf8')).toBe('after-extra');
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('before');
    const crashedOperation = durable.snapshot(harness.identity.workspaceId, prepared.plan.id);
    expect(crashedOperation).not.toBeNull();
    expect(crashedOperation!.state).toBe('needs-attention');
    expect(crashedOperation!.files.find((file) => file.path === 'extra.txt')?.phase).toBe('compensate-intent');
    expect(crashedOperation!.files.find((file) => file.path === 'note.txt')?.phase).toBe('apply-intent');

    // A host kill mid-compensation (instead of a catchable exception) leaves
    // the same file phases but never reaches the terminal persist. Rewind the
    // catalog state to 'compensating-files' to stage that post-mortem shape.
    durable.debugSetOperationState(harness.identity.workspaceId, prepared.plan.id, 'compensating-files');

    // Restart: extra.txt reconciles compensate-intent → safety-observed;
    // note.txt reconciles apply-intent → target-observed; the operation then
    // finishes compensating note.txt back to safety.
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
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
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
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'needs-attention' } });
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

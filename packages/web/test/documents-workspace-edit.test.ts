import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentsAPI, VarinDocumentWatchEvent } from '@varin/application-client';
import { DocumentRegistry } from '@varin/ui/lib/documents/registry';
import { createDocumentAuthorityHarness } from '#application-host/lib/documents/contract-fixtures.js';
import { createRecoveryFileStore } from '#application-host/lib/recovery/file-store.test-helper.js';
import { createInMemoryRecoveryDurablePort } from '#application-host/lib/recovery/recovery-durable-port.test-helper.js';
import { objectPath } from '#application-host/lib/recovery/object-path.js';
import { sameState, type RecoveryState } from '#application-host/lib/recovery/journal-files.js';
import type { DurableFileOperationContext, HostFileResourceBackend } from '#application-host/lib/recovery/durable-file-operation.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = async () => {
  const harness = await createDocumentAuthorityHarness();
  cleanup.push(harness.cleanup);
  const storageRoot = path.join(harness.root, 'workspace-edit-recovery');
  const fileStore = createRecoveryFileStore();
  const identity = {
    authorityId: harness.authority.hostId,
    canonicalRoot: harness.workspaceRoot,
    filesystemProfile: 'linux-local',
    workspaceId: harness.identity.workspaceId,
  };
  fileStore.storeContent = async (_identity, bytes) => {
    const hash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
    const destination = objectPath(storageRoot, hash);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
    return {
      state: { kind: 'regular-file', byteLength: bytes.length, objectHash: hash },
      release: async () => undefined,
    };
  };
  const durable = createInMemoryRecoveryDurablePort();
  const calls: string[] = [];
  const matches = (expected: RecoveryState, actual: RecoveryState) =>
    sameState('mode' in actual && !('mode' in expected) ? { ...expected, mode: actual.mode } : expected, actual);
  const gate = { run: async <T>(_resources: unknown, callback: () => Promise<T>) => callback() };
  const files: HostFileResourceBackend = {
    writeBytes: async (_identity, name, bytes, options) => {
      const stored = await fileStore.storeContent!(identity, Buffer.from(bytes));
      return files.applyStateDetailed(
        identity,
        name,
        { ...stored.state, ...(options?.mode === undefined ? {} : { mode: options.mode }) },
        options
      );
    },
    mkdir: async () => {
      throw new Error('Unexpected mkdir in workspace edit test');
    },
    remove: async () => {
      throw new Error('Unexpected remove in workspace edit test');
    },
    measure: async () => {
      throw new Error('Unexpected measure in workspace edit test');
    },
    materializeRoot: async () => {
      throw new Error('Unexpected materializeRoot in workspace edit test');
    },
    gateFor: () => gate,
    captureDetailed: (_identity, name, options) => fileStore.captureState(identity, storageRoot, name, options),
    applyStateDetailed: async (_identity, name, state, options) => {
      const current = (await fileStore.captureState(identity, storageRoot, name, { store: false })).state;
      if (options?.expected && !matches(options.expected, current)) return { status: 'conflict', state: current };
      calls.push(`apply:${name}:${state.kind}`);
      await fileStore.applyState(identity, storageRoot, name, state);
      return {
        status: 'applied',
        state: (await fileStore.captureState(identity, storageRoot, name, { store: false })).state,
      };
    },
    rename: async (_identity, from, to, options) => {
      const before = (await fileStore.captureState(identity, storageRoot, from, { store: false })).state;
      const target = (await fileStore.captureState(identity, storageRoot, to, { store: false })).state;
      if (
        (options?.expectedFrom && !matches(options.expectedFrom, before)) ||
        (options?.expectedTo && !matches(options.expectedTo, target))
      )
        return 'conflict';
      calls.push(`rename:${from}:${to}`);
      await fs.rename(path.join(harness.workspaceRoot, from), path.join(harness.workspaceRoot, to));
      return 'renamed';
    },
    scanPaths: async (_identity, prefix, _scopes, options) => {
      const output: string[] = [];
      const walk = async (relative: string) => {
        for (const entry of await fs.readdir(path.join(harness.workspaceRoot, prefix ?? '', relative), {
          withFileTypes: true,
        })) {
          if (!options?.includeInternalEntries && ['.git', '.varin'].includes(entry.name)) continue;
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          output.push(name);
          if (entry.isDirectory()) await walk(name);
        }
      };
      await walk('');
      return output.sort();
    },
  };
  const context: DurableFileOperationContext = {
    identity,
    root: storageRoot,
    fileStore,
    fileResources: files,
    resourceOperationGate: gate,
    durableRecoveryStore: durable,
  };
  harness.authority.bindDurableMutationStorage(async (_workspace, callback) => callback(context));
  const api = {
    ...harness.authority,
    watch: (
      workspaceId: string,
      listener: (event: VarinDocumentWatchEvent) => void,
      options?: { dirtyOwner?: { ownerId: string; generation: number } }
    ) => {
      const watch = harness.authority.watch(workspaceId, (event) => listener(event as VarinDocumentWatchEvent));
      const surface = options?.dirtyOwner
        ? harness.authority.registerDirtySurface({ workspaceId, ...options.dirtyOwner }, (event) =>
            listener(event as VarinDocumentWatchEvent)
          )
        : null;
      return {
        close() {
          watch.close();
          surface?.close();
        },
      };
    },
    ackDirtyStateBarrier: harness.authority.acknowledgeDirtyStateBarrier,
    listWorkspaceEdits: ({ workspaceId }: { workspaceId: string }) => harness.authority.listWorkspaceEdits(workspaceId),
  } as unknown as DocumentsAPI;
  const registry = new DocumentRegistry({
    documents: api,
    getGeneration: () => 1,
    recoverySessionId: 'workspace-edit-test',
    journalDebounceMs: 10_000,
  });
  cleanup.push(() => registry.dispose());
  const ref = harness.resource;
  const text = (name: string, newText: string, character = 0, version: number | null = null) => ({
    kind: 'text' as const,
    identity: ref(name),
    version,
    edits: [{ range: { start: { line: 0, character }, end: { line: 0, character } }, newText }],
  });
  const prepare = (changes: Parameters<DocumentRegistry['prepareWorkspaceEdit']>[0]['changes']) =>
    registry.prepareWorkspaceEdit({ workspaceId: identity.workspaceId, origin: 'language:test', changes });
  return { ...harness, registry, api, durable, context, files, calls, ref, text, prepare };
};

const ready = <T extends { status: string }>(value: T): Extract<T, { status: 'ready' }> => {
  expect(value.status, JSON.stringify(value)).toBe('ready');
  return value as Extract<T, { status: 'ready' }>;
};

describe('ordered workspace edits through Documents and the live Registry', () => {
  it('prepares without writes, then creates, edits, renames, edits and undoes as one operation', async () => {
    const f = await fixture();
    const preview = ready(
      await f.prepare([
        { kind: 'create', identity: f.ref('a.ts') },
        f.text('a.ts', 'one', 0, 0),
        { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') },
        f.text('b.ts', ' two', 3, 1),
      ])
    );
    expect(f.calls).toEqual([]);
    expect(f.registry.get(f.ref('a.ts'))).toBeUndefined();
    expect(await f.durable.listOperations(f.identity.workspaceId)).toEqual([]);
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(f.registry.get(f.ref('a.ts'))).toBeUndefined();
    expect(f.registry.get(f.ref('b.ts'))).toMatchObject({ buffer: 'one two', dirty: true, localEditRevision: 2 });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'b.ts'), 'utf8')).toBe('');
    expect(f.calls).toEqual(['apply:a.ts:regular-file', 'rename:a.ts:b.ts']);
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'b.ts')).catch(() => null)).toBeNull();
    expect(f.registry.get(f.ref('b.ts'))).toBeUndefined();
  });

  it('preserves an unsaved draft and stable instance across rename, deletion and undo', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    const original = await f.registry.open(f.ref('a.ts'));
    f.registry.applyTransaction(f.ref('a.ts'), 'draft', { origin: 'user' });
    const preview = ready(
      await f.prepare([
        { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') },
        { kind: 'delete', identity: f.ref('b.ts') },
      ])
    );
    expect(preview.requiresConfirmation).toBe(true);
    expect(await fs.readFile(path.join(f.workspaceRoot, 'a.ts'), 'utf8')).toBe('saved');
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(f.registry.get(f.ref('b.ts'))).toMatchObject({
      buffer: 'draft',
      dirty: true,
      status: 'deleted',
      documentInstanceId: original.documentInstanceId,
    });
    await f.registry.open(f.ref('b.ts'), { reload: true });
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(f.registry.get(f.ref('a.ts'))).toMatchObject({
      buffer: 'draft',
      dirty: true,
      status: 'ready',
      documentInstanceId: original.documentInstanceId,
    });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'a.ts'), 'utf8')).toBe('saved');
  });

  it('revalidates every disk resource before the first buffer or resource mutation', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    await f.registry.open(f.ref('a.ts'));
    const preview = ready(await f.prepare([f.text('a.ts', 'draft '), { kind: 'create', identity: f.ref('b.ts') }]));
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'external');
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'rejected' });
    expect(f.calls).toEqual([]);
    expect(f.registry.get(f.ref('a.ts'))?.buffer).not.toBe('draft saved');
  });

  it('reads a committed receipt after a lost apply response without replaying any resource step', async () => {
    const f = await fixture();
    const apply = f.api.applyWorkspaceEdit;
    f.api.applyWorkspaceEdit = async (request) => {
      await apply(request);
      throw new Error('response lost');
    };
    const preview = ready(await f.prepare([{ kind: 'create', identity: f.ref('a.ts') }, f.text('a.ts', 'draft')]));
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(f.calls).toEqual(['apply:a.ts:regular-file']);
  });

  it('retains later user edits when undo cannot restore the buffer', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    await f.registry.open(f.ref('a.ts'));
    const preview = ready(
      await f.prepare([{ kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') }, f.text('b.ts', 'first ')])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    f.registry.applyTransaction(f.ref('b.ts'), 'later user edit', { origin: 'user' });
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({
      status: 'rejected',
      failures: [{ reason: 'needs-attention' }],
    });
    expect(f.registry.get(f.ref('b.ts'))?.buffer).toBe('later user edit');
    expect(
      (await f.authority.readWorkspaceEdit({ workspaceId: f.identity.workspaceId, operationId: preview.groupId }))
        .status
    ).toBe('needs-attention');
  });

  it('renames and restores complete directory trees including internal names and empty directories', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.workspaceRoot, 'dir/.varin'), { recursive: true });
    await fs.mkdir(path.join(f.workspaceRoot, 'dir/empty'));
    await fs.writeFile(path.join(f.workspaceRoot, 'dir/.varin/data'), 'body');
    const preview = ready(
      await f.prepare([
        { kind: 'rename', from: f.ref('dir'), to: f.ref('next') },
        { kind: 'delete', identity: f.ref('next'), recursive: true },
      ])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'next')).catch(() => null)).toBeNull();
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'dir/.varin/data'), 'utf8')).toBe('body');
    expect((await fs.stat(path.join(f.workspaceRoot, 'dir/empty'))).isDirectory()).toBe(true);
  });
  it('gives overwrite precedence over ignoreIfExists and restores the overwritten dirty target', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'source');
    await fs.writeFile(path.join(f.workspaceRoot, 'b.ts'), 'target');
    await f.registry.open(f.ref('a.ts'));
    const target = await f.registry.open(f.ref('b.ts'));
    f.registry.applyTransaction(f.ref('b.ts'), 'target draft', { origin: 'user' });
    const preview = ready(
      await f.prepare([
        { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts'), overwrite: true, ignoreIfExists: true },
      ])
    );
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.files.some((file) => file.beforeContent === 'target draft' && file.affectsDraft)).toBe(true);
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'b.ts'), 'utf8')).toBe('source');
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'b.ts'), 'utf8')).toBe('target');
    expect(f.registry.get(f.ref('b.ts'))).toMatchObject({
      buffer: 'target draft',
      documentInstanceId: target.documentInstanceId,
      dirty: true,
    });
  });

  it('compensates a partially executed batch and records intent before the first resource effect', async () => {
    const f = await fixture();
    const apply = f.files.applyStateDetailed;
    f.files.applyStateDetailed = async (identity, name, state, options) => {
      const operations = await f.durable.listOperations(f.identity.workspaceId, 'workspace-edit');
      expect(operations).toHaveLength(1);
      expect(f.durable.snapshot(f.identity.workspaceId, String(operations[0]!.operationId))?.data).toHaveProperty(
        'workspaceEdit.plan.initialDisk'
      );
      if (name === 'b.ts' && state.kind === 'regular-file') throw new Error('second resource failed');
      return apply(identity, name, state, options);
    };
    const preview = ready(
      await f.prepare([
        { kind: 'create', identity: f.ref('a.ts') },
        f.text('a.ts', 'draft'),
        { kind: 'create', identity: f.ref('b.ts') },
      ])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'rejected' });
    expect(
      await f.authority.readWorkspaceEdit({ workspaceId: f.identity.workspaceId, operationId: preview.groupId })
    ).toMatchObject({ status: 'compensated' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'a.ts')).catch(() => null)).toBeNull();
    expect(f.registry.get(f.ref('a.ts'))).toBeUndefined();
  });

  it('keeps external content when partial-failure compensation observes disk drift', async () => {
    const f = await fixture();
    const apply = f.files.applyStateDetailed;
    f.files.applyStateDetailed = async (identity, name, state, options) => {
      if (name === 'b.ts' && state.kind === 'regular-file') {
        await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'external edit');
        throw new Error('second resource failed');
      }
      return apply(identity, name, state, options);
    };
    const preview = ready(
      await f.prepare([
        { kind: 'create', identity: f.ref('a.ts') },
        { kind: 'create', identity: f.ref('b.ts') },
      ])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({
      status: 'rejected',
      failures: [{ reason: 'needs-attention' }],
    });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'a.ts'), 'utf8')).toBe('external edit');
    expect(
      await f.authority.readWorkspaceEdit({ workspaceId: f.identity.workspaceId, operationId: preview.groupId })
    ).toMatchObject({
      status: 'needs-attention',
      resourceResults: expect.arrayContaining([{ resource: f.ref('a.ts'), status: 'needs-attention' }]),
    });
  });

  it('reconciles an interrupted resource dispatch from its original record without repeating creation', async () => {
    const f = await fixture();
    const preview = ready(await f.prepare([{ kind: 'create', identity: f.ref('a.ts') }]));
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    const stored = f.durable.snapshot(f.identity.workspaceId, preview.groupId)!;
    const result = structuredClone(stored.result) as {
      workspaceEdit: { receipt: { status: string }; actions: string[] };
    };
    result.workspaceEdit.receipt.status = 'pending';
    result.workspaceEdit.actions = ['dispatched'];
    await f.durable.completeOperation({
      operationId: preview.groupId,
      workspaceId: f.identity.workspaceId,
      expectedRevision: stored.revision,
      state: 'applying',
      result,
    });
    expect(await f.authority.reconcileWorkspaceEdits(f.identity.workspaceId)).toMatchObject([
      { status: 'compensated' },
    ]);
    expect(f.calls.filter((call) => call === 'apply:a.ts:regular-file')).toHaveLength(1);
    expect(await fs.stat(path.join(f.workspaceRoot, 'a.ts')).catch(() => null)).toBeNull();
  });

  it('moves clean observer documents and their subscriptions with the confirmed resource rename', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    const observer = new DocumentRegistry({ documents: f.api, getGeneration: () => 1, recoverySessionId: 'observer' });
    cleanup.push(() => observer.dispose());
    await f.registry.open(f.ref('a.ts'));
    const original = await observer.open(f.ref('a.ts'));
    const seen: string[] = [];
    const unsubscribe = observer.subscribe(f.ref('a.ts'), (record) => seen.push(record.identity.resourceId));
    const preview = ready(await f.prepare([{ kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') }]));
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observer.get(f.ref('b.ts'))?.documentInstanceId).toBe(original.documentInstanceId);
    expect(seen).toContain('b.ts');
    unsubscribe();
    const count = seen.length;
    observer.applyTransaction(f.ref('b.ts'), 'another draft', { origin: 'user' });
    expect(seen).toHaveLength(count);
  });

  it('coordinates another window draft without saving it or replacing the initiating clean buffer', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    await f.registry.open(f.ref('a.ts'));
    const other = new DocumentRegistry({
      documents: f.api,
      getGeneration: () => 1,
      recoverySessionId: 'draft-owner',
      journalDebounceMs: 10_000,
    });
    cleanup.push(() => other.dispose());
    const original = await other.open(f.ref('a.ts'));
    other.applyTransaction(f.ref('a.ts'), 'draft', { origin: 'user' });
    const preview = ready(
      await f.prepare([
        { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') },
        f.text('b.ts', '!', 5, 1),
        { kind: 'delete', identity: f.ref('b.ts') },
      ])
    );
    expect(preview.requiresConfirmation).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(other.get(f.ref('b.ts'))).toMatchObject({
      buffer: 'draft!',
      status: 'deleted',
      documentInstanceId: original.documentInstanceId,
    });
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(other.get(f.ref('a.ts'))).toMatchObject({
      buffer: 'draft',
      dirty: true,
      documentInstanceId: original.documentInstanceId,
    });
    expect(f.registry.get(f.ref('a.ts'))).toMatchObject({ buffer: 'saved', dirty: false });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'a.ts'), 'utf8')).toBe('saved');
  });

  it('keeps skipped rename and create options in the same path/version sequence', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'source');
    await fs.writeFile(path.join(f.workspaceRoot, 'b.ts'), 'target');
    const other = new DocumentRegistry({
      documents: f.api,
      getGeneration: () => 1,
      recoverySessionId: 'target-owner',
      journalDebounceMs: 10_000,
    });
    cleanup.push(() => other.dispose());
    await f.registry.open(f.ref('a.ts'));
    await other.open(f.ref('b.ts'));
    other.applyTransaction(f.ref('b.ts'), 'draft', { origin: 'user' });
    const preview = ready(
      await f.prepare([
        { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts'), ignoreIfExists: true },
        { kind: 'create', identity: f.ref('b.ts'), ignoreIfExists: true },
        f.text('b.ts', '!', 5, 1),
      ])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(other.get(f.ref('b.ts'))?.buffer).toBe('draft!');
    expect(f.calls).toEqual([]);
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(other.get(f.ref('b.ts'))?.buffer).toBe('draft');
  });

  it('restores both source and overwritten target subscriptions to their original instances on undo', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'source');
    await fs.writeFile(path.join(f.workspaceRoot, 'b.ts'), 'target');
    const a = await f.registry.open(f.ref('a.ts'));
    const b = await f.registry.open(f.ref('b.ts'));
    const seenA: string[] = [];
    const seenB: string[] = [];
    f.registry.subscribe(f.ref('a.ts'), (record) =>
      seenA.push(`${record.identity.resourceId}:${record.documentInstanceId}:${record.buffer}`)
    );
    f.registry.subscribe(f.ref('b.ts'), (record) =>
      seenB.push(`${record.identity.resourceId}:${record.documentInstanceId}:${record.buffer}`)
    );
    const preview = ready(
      await f.prepare([{ kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts'), overwrite: true }])
    );
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'undone' });
    expect(seenA.at(-1)).toBe(`a.ts:${a.documentInstanceId}:source`);
    expect(seenB.at(-1)).toBe(`b.ts:${b.documentInstanceId}:target`);
  });

  it('rejects undo during maintenance and after the workspace epoch changes', async () => {
    const f = await fixture();
    const preview = ready(await f.prepare([{ kind: 'create', identity: f.ref('a.ts') }]));
    expect(await f.registry.applyWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'applied' });
    await f.authority.setMaintenance(f.identity.workspaceId, true);
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'rejected' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'a.ts')).then(() => true)).toBe(true);
    await f.authority.setMaintenance(f.identity.workspaceId, false);
    await f.authority.advanceEpoch(f.identity.workspaceId);
    expect(await f.registry.undoWorkspaceEdit(preview.groupId)).toMatchObject({ status: 'rejected' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'a.ts')).then(() => true)).toBe(true);
  });

  it('runs a Host resource-only create and rename without any Surface', async () => {
    const f = await fixture();
    const plan = ready(
      await f.authority.prepareWorkspaceEdit({
        operationId: 'headless-resource-edit',
        workspaceId: f.identity.workspaceId,
        origin: 'extension:fixture',
        edit: {
          documentChanges: [
            { kind: 'create', resource: f.ref('a.ts') },
            { kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') },
          ],
        },
      })
    );
    expect(f.calls).toEqual([]);
    expect(f.registry.get(f.ref('a.ts'))).toBeUndefined();
    expect(await f.authority.applyWorkspaceEdit(plan)).toMatchObject({ status: 'applied' });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'b.ts'), 'utf8')).toBe('');
    expect(await f.authority.undoWorkspaceEdit(plan)).toMatchObject({ status: 'undone' });
    expect(await fs.stat(path.join(f.workspaceRoot, 'b.ts')).catch(() => null)).toBeNull();
  });

  it('captures the actual open draft for a Host caller without a claimed Surface identity', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspaceRoot, 'a.ts'), 'saved');
    const original = await f.registry.open(f.ref('a.ts'));
    f.registry.applyTransaction(f.ref('a.ts'), 'draft', { origin: 'user' });
    const plan = ready(
      await f.authority.prepareWorkspaceEdit({
        operationId: 'host-draft-edit',
        workspaceId: f.identity.workspaceId,
        origin: 'extension:fixture',
        edit: { documentChanges: [{ kind: 'rename', from: f.ref('a.ts'), to: f.ref('b.ts') }] },
      })
    );
    expect(plan.files.some((file) => file.affectsDraft)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(await f.authority.applyWorkspaceEdit(plan)).toMatchObject({ status: 'applied' });
    expect(f.registry.get(f.ref('b.ts'))).toMatchObject({
      documentInstanceId: original.documentInstanceId,
      buffer: 'draft',
      dirty: true,
    });
    expect(await fs.readFile(path.join(f.workspaceRoot, 'b.ts'), 'utf8')).toBe('saved');
    expect(await f.authority.undoWorkspaceEdit(plan)).toMatchObject({ status: 'undone' });
    expect(f.registry.get(f.ref('a.ts'))).toMatchObject({
      documentInstanceId: original.documentInstanceId,
      buffer: 'draft',
      dirty: true,
    });
  });

  it('preserves referenced annotations and rejects undefined annotation identities before writing', async () => {
    const f = await fixture();
    expect(
      await f.registry.prepareWorkspaceEdit({
        workspaceId: f.identity.workspaceId,
        origin: 'test',
        changes: [{ kind: 'create', identity: f.ref('a.ts'), annotationId: 'approval' }],
      })
    ).toMatchObject({ status: 'rejected' });
    const preview = ready(
      await f.registry.prepareWorkspaceEdit({
        workspaceId: f.identity.workspaceId,
        origin: 'test',
        changes: [{ kind: 'create', identity: f.ref('a.ts'), annotationId: 'approval' }],
        changeAnnotations: { approval: { label: 'Create module', needsConfirmation: true } },
      })
    );
    expect(preview).toMatchObject({ requiresConfirmation: true, files: [{ annotationIds: ['approval'] }] });
    expect(f.calls).toEqual([]);
  });
});

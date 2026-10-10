import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentAuthorityOptions,
} from './authority.js';
import {
  attachLiveSurfaceCompleter,
  createDocumentAuthorityHarness,
  hashSurfaceText,
  type DocumentAuthorityHarness,
  type LiveSurfaceBuffer,
} from './contract-fixtures.js';
import type { WatchEvent, WatchPosition, WorkspaceWatchFs } from './watch.js';
import { DocumentPathError, DocumentUntrustedError } from './errors.js';
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";
import { createInMemoryRecoveryDurablePort } from '../recovery/recovery-durable-port.test-helper.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T>(probe: () => T | Promise<T>, timeoutMs = 8000): Promise<T> => {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(20);
  }
  throw lastError ?? new Error('Timed out waiting for document authority condition');
};

const isWatchEvent = (value: unknown): value is WatchEvent => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof (value as { kind?: unknown }).kind === 'string'
  && typeof (value as { sourceId?: unknown }).sourceId === 'string'
  && Number.isSafeInteger((value as { generation?: unknown }).generation)
  && Number.isSafeInteger((value as { sequence?: unknown }).sequence)
);

const requireStatus = <T extends { status: string }, S extends T['status']>(
  result: T,
  status: S,
): Extract<T, { status: S }> => {
  if (result.status !== status) throw new Error(`Expected ${status}, received ${result.status}`);
  return result as Extract<T, { status: S }>;
};

const requireValue = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
};

describe('document authority contract', () => {
  let harness!: DocumentAuthorityHarness;

  beforeEach(async () => {
    harness = await createDocumentAuthorityHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
  });

  it('distinguishes missing, empty, binary, and read failure', async () => {
    const missing = await harness.authority.read(harness.resource('missing.txt'));
    expect(missing).toEqual({
      status: 'missing',
      epoch: harness.identity.epoch,
      resource: harness.resource('missing.txt'),
    });

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'empty.txt'), '');
    const empty = requireStatus(await harness.authority.read(harness.resource('empty.txt')), 'ready');
    expect(empty.status).toBe('ready');
    expect(empty.content).toBe('');
    expect(empty.byteLength).toBe(0);

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 0, 9]));
    const binary = requireStatus(await harness.authority.read(harness.resource('binary.bin')), 'binary');
    expect(binary.status).toBe('binary');
    expect('content' in binary).toBe(false);

    const fsPromises = new Proxy(fs.promises, {
      get(target, property, receiver) {
        if (property === 'readFile') return async (...args: Parameters<typeof fs.promises.readFile>) => {
          if (String(args[0]).includes('denied.txt')) {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return Reflect.apply(target.readFile, target, args) as ReturnType<typeof fs.promises.readFile>;
        };
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    await harness.cleanup();
    harness = await createDocumentAuthorityHarness({
      authority: { fsPromises },
    });
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'denied.txt'), 'classified');
    await expect(harness.authority.read(harness.resource('denied.txt'))).rejects.toMatchObject({
      code: 'failed',
    });
    const stillMissing = requireStatus(await harness.authority.read(harness.resource('also-missing.txt')), 'missing');
    expect(stillMissing.status).toBe('missing');
  });

  it('creates when expected revision is missing and conflicts when the file exists', async () => {
    const resource = harness.resource('created.txt');
    const written = requireStatus(await harness.authority.write({
      token: harness.token(),
      resource,
      content: 'hello\n',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    }), 'written');
    expect(written.status).toBe('written');
    const conflict = requireStatus(await harness.authority.write({
      token: harness.token(),
      resource,
      content: 'other',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    }), 'conflict');
    expect(conflict.status).toBe('conflict');
    const current = requireStatus(conflict.current, 'ready');
    expect(current.epoch).toBe(harness.identity.epoch);
    expect('content' in current).toBe(false);
  });

  it('rejects stale revisions and detects same-mtime content changes', async () => {
    const filePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(filePath, 'alpha');
    const first = requireStatus(await harness.authority.read(harness.resource('note.txt')), 'ready');
    expect(first.status).toBe('ready');
    const stat = await fs.promises.stat(filePath);
    await fs.promises.writeFile(filePath, 'bravo');
    await fs.promises.utimes(filePath, stat.atime, stat.mtime);
    const second = requireStatus(await harness.authority.read(harness.resource('note.txt')), 'ready');
    expect(second.status).toBe('ready');
    expect(second.content).toBe('bravo');
    expect(second.revision).not.toBe(first.revision);
    const conflict = requireStatus(await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('note.txt'),
      content: 'charlie',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: first.revision,
      operationId: randomUUID(),
    }), 'conflict');
    expect(conflict.status).toBe('conflict');
  });

  it('serializes mutations so overlapping read/write operations do not tear', async () => {
    const filePath = path.join(harness.workspaceRoot, 'race.txt');
    await fs.promises.writeFile(filePath, 'start');
    const resource = harness.resource('race.txt');
    const firstRead = harness.authority.read(resource);
    const current = requireStatus(await firstRead, 'ready');
    const firstWrite = harness.authority.write({
      token: harness.token(),
      resource,
      content: 'first-write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.status === 'ready' ? current.revision : null,
      operationId: randomUUID(),
    });
    const secondWrite = harness.authority.write({
      token: harness.token(),
      resource,
      content: 'second-write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.status === 'ready' ? current.revision : null,
      operationId: randomUUID(),
    });
    const results = await Promise.all([firstWrite, secondWrite]);
    expect(results.filter((result) => result.status === 'written').length).toBeGreaterThanOrEqual(1);
    const final = requireStatus(await harness.authority.read(resource), 'ready');
    expect(final.status).toBe('ready');
    expect(['first-write', 'second-write']).toContain(final.content);
  });

  it('preserves the previous document when atomic replacement fails', async () => {
    await harness.cleanup();
    const fsPromises = new Proxy(fs.promises, {
      get(target, property, receiver) {
        if (property === 'rename') return async (...args: Parameters<typeof fs.promises.rename>) => {
          if (String(args[0]).includes('.varin-tmp-') && String(args[1]).endsWith('protected.txt')) {
            throw Object.assign(new Error('EPERM: replacement denied'), { code: 'EPERM' });
          }
          return target.rename(...args);
        };
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    harness = await createDocumentAuthorityHarness({ authority: { fsPromises } });
    const filePath = path.join(harness.workspaceRoot, 'protected.txt');
    await fs.promises.writeFile(filePath, 'original');
    const current = requireStatus(await harness.authority.read(harness.resource('protected.txt')), 'ready');
    expect(current.status).toBe('ready');

    await expect(harness.authority.write({
      token: harness.token(),
      resource: harness.resource('protected.txt'),
      content: 'replacement',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: current.revision,
      operationId: randomUUID(),
    })).rejects.toMatchObject({ code: 'failed' });

    expect(await fs.promises.readFile(filePath, 'utf8')).toBe('original');
    expect((await fs.promises.readdir(harness.workspaceRoot)).some((entry) => entry.includes('.varin-tmp-'))).toBe(false);
  });

  it('fences document and journal mutations by persisted workspace epoch', async () => {
    const note = harness.resource('fenced.txt');
    const first = requireStatus(await harness.authority.write({
      token: harness.token(),
      resource: note,
      content: 'epoch-one',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    }), 'written');
    expect(first.status).toBe('written');
    const journal = requireStatus(await harness.authority.writeRecoveryJournal({
      token: harness.token(),
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-fenced',
      resource: note,
      content: 'draft-one',
      encoding: 'utf-8',
      bom: false,
      baseRevision: first.revision,
      expectedRevision: null,
    }), 'written');
    expect(journal.status).toBe('written');
    expect(journal.journal.epoch).toBe(harness.identity.epoch);

    const active = await harness.authority.registerWriter(harness.token(), { purpose: 'test-active' });
    await expect(harness.authority.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
      .rejects.toMatchObject({ code: 'active-writer' });
    await active.close();

    const advanced = await harness.authority.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
    const staleWrite = await harness.authority.write({
      token: harness.token(),
      resource: note,
      content: 'stale-write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: first.revision,
      operationId: randomUUID(),
    });
    expect(staleWrite).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'fenced.txt'), 'utf8')).toBe('epoch-one');
    expect(await harness.authority.move({
      token: harness.token(),
      from: note,
      to: harness.resource('moved.txt'),
      expectedRevision: first.revision,
      operationId: randomUUID(),
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    expect(await harness.authority.delete({
      token: harness.token(),
      resource: note,
      expectedRevision: first.revision,
      operationId: randomUUID(),
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    expect(await harness.authority.writeRecoveryJournal({
      token: harness.token(),
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-fenced',
      resource: note,
      content: 'stale-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: first.revision,
      expectedRevision: journal.journal.revision,
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    expect(await harness.authority.deleteRecoveryJournal({
      token: harness.token(),
      journalId: journal.journal.journalId,
      expectedRevision: journal.journal.revision,
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });

    const freshToken = harness.token(advanced.epoch);
    const freshJournal = requireStatus(await harness.authority.writeRecoveryJournal({
      token: freshToken,
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-fenced',
      resource: note,
      content: 'epoch-two-draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: first.revision,
      expectedRevision: null,
    }), 'written');
    expect(freshJournal.status).toBe('written');
    expect(freshJournal.journal.epoch).toBe(advanced.epoch);
    const journalHistory = await harness.authority.listRecoveryJournals({
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-fenced',
    });
    expect(journalHistory.some((entry) => entry.epoch === harness.identity.epoch)).toBe(true);
    expect(journalHistory.some((entry) => entry.epoch === advanced.epoch)).toBe(true);
    const fresh = requireStatus(await harness.authority.write({
      token: freshToken,
      resource: note,
      content: 'epoch-two',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: first.revision,
      operationId: randomUUID(),
    }), 'written');
    expect(fresh.status).toBe('written');
    const restarted = createDocumentAuthority({
      hostId: harness.authority.hostId,
      dataDir: harness.dataDir,
      isTrusted: async () => true,
      isAllowedRoot: async () => true,
    });
    const persisted = await restarted.inspectMutation(harness.identity.workspaceId);
    expect(persisted.epoch).toBe(advanced.epoch);
    await restarted.dispose();
  });

  it('binds mutation tokens to the target workspace and gates new writers during maintenance', async () => {
    const resource = harness.resource('workspace-bound.txt');
    const wrongToken = {
      ...harness.token(),
      workspaceId: '22222222-2222-4222-8222-222222222222',
    };
    await expect(harness.authority.write({
      token: wrongToken,
      resource,
      content: 'must-not-write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(fs.promises.stat(path.join(harness.workspaceRoot, 'workspace-bound.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const active = await harness.authority.registerWriter(harness.token(), { purpose: 'maintenance-drain' });
    const maintenance = await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    expect(maintenance.maintenance).toBe(true);
    expect(maintenance.activeWriters).toHaveLength(1);
    await expect(harness.authority.registerWriter(harness.token(), { purpose: 'late-writer' }))
      .rejects.toMatchObject({ code: 'maintenance' });
    await active.close();
    const advanced = await harness.authority.advanceEpoch(harness.identity.workspaceId, {
      expectedEpoch: harness.identity.epoch,
    });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
    await expect(harness.authority.advanceEpoch(harness.identity.workspaceId, {
      expectedEpoch: harness.identity.epoch,
    })).rejects.toMatchObject({ code: 'stale-epoch', currentEpoch: advanced.epoch });
    await harness.authority.setMaintenance(harness.identity.workspaceId, false);
  });

  it('tracks legacy Host mutations by canonical workspace scope', async () => {
    const nested = path.join(harness.workspaceRoot, 'nested-cwd');
    await fs.promises.mkdir(nested);
    expect(await harness.authority.resolveScopeId(nested)).toBe(harness.identity.workspaceId);
    expect(await harness.authority.resolveScopeId(path.join(nested, 'not-created-yet')))
      .toBe(harness.identity.workspaceId);
    const before = await harness.authority.inspectMutation(harness.identity.workspaceId);
    await harness.authority.runMutationForScope(
      harness.workspaceRoot,
      { kind: 'host-route', id: 'legacy-fixture' },
      () => fs.promises.writeFile(path.join(harness.workspaceRoot, 'legacy.txt'), 'tracked'),
    );
    const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
    expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);

    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    await expect(harness.authority.runMutationForScope(
      harness.workspaceRoot,
      { kind: 'host-route', id: 'maintenance-rejected' },
      () => fs.promises.writeFile(path.join(harness.workspaceRoot, 'late.txt'), 'late'),
    )).rejects.toMatchObject({ code: 'maintenance' });
    await expect(fs.promises.stat(path.join(harness.workspaceRoot, 'late.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await harness.authority.setMaintenance(harness.identity.workspaceId, false);
  });

  it('tracks live dirty buffers by surface owner and rejects stale generations', async () => {
    const publication = await harness.authority.publishDirtyBuffers({
      generation: 2,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 3,
        resource: harness.resource('dirty.txt'),
      }],
      workspaceId: harness.identity.workspaceId,
    });
    expect(publication).toMatchObject({ ownerId: 'surface-1', generation: 2 });
    const dirty = await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId);
    expect(dirty).toHaveLength(1);
    const dirtyPublication = requireValue(dirty[0], 'Dirty buffer publication');
    expect(dirtyPublication.ownerId).toBe('surface-1');
    expect(requireValue(dirtyPublication.resources[0], 'Dirty buffer resource').resource)
      .toEqual(harness.resource('dirty.txt'));
    await expect(harness.authority.clearDirtyBuffers({
      generation: 1,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).rejects.toMatchObject({ code: 'stale-completion' });
    expect(await harness.authority.clearDirtyBuffers({
      generation: 2,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ cleared: true });
    expect(await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId)).toEqual([]);
  });

  it('watches created, changed, moved, deleted, and reset events without file bodies', async () => {
    const events: WatchEvent[] = [];
    const subscription = harness.authority.watch(harness.identity.workspaceId, (event: unknown) => {
      if (!isWatchEvent(event)) return;
      events.push(event);
    });
    await waitUntil(() => harness.authority.hasWatch(harness.identity.workspaceId));
    await wait(150);
    const filePath = path.join(harness.workspaceRoot, 'watched.txt');
    await fs.promises.writeFile(filePath, 'one');
    await waitUntil(() => events.some((event) => event.kind === 'created' && event.resource?.resourceId === 'watched.txt'));
    await fs.promises.writeFile(filePath, 'two');
    await waitUntil(() => events.some((event) => event.kind === 'changed' && event.resource?.resourceId === 'watched.txt'));
    await fs.promises.rename(filePath, path.join(harness.workspaceRoot, 'renamed.txt'));
    await waitUntil(() => events.some((event) => (
      event.kind === 'moved'
      || (event.kind === 'deleted' && event.resource?.resourceId === 'watched.txt')
    )));
    await fs.promises.unlink(path.join(harness.workspaceRoot, 'renamed.txt'));
    await waitUntil(() => events.some((event) => event.kind === 'deleted'));
    expect(JSON.stringify(events)).not.toContain('one');
    expect(JSON.stringify(events)).not.toContain('two');
    expect(harness.authority.emitWatchOverflow(harness.identity.workspaceId)).toBe(true);
    await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'overflow'));
    harness.authority.reconnectWatch(harness.identity.workspaceId);
    await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'reconnected'));
    const overflowIndex = events.findIndex((event) => event.kind === 'reset' && event.reason === 'overflow');
    expect(events.slice(overflowIndex).filter((event) => event.kind === 'deleted')).toEqual([]);
    subscription.close();
  });

  it('rejects symlink escape, path traversal, and untrusted projects', async () => {
    await expect(harness.authority.read(harness.resource('../secret.txt'))).rejects.toBeInstanceOf(DocumentPathError);
    const outside = path.join(harness.root, 'outside.txt');
    await fs.promises.writeFile(outside, 'nope');
    const link = path.join(harness.workspaceRoot, 'escape.txt');
    try {
      await fs.promises.symlink(outside, link);
      await expect(harness.authority.read(harness.resource('escape.txt'))).rejects.toBeInstanceOf(DocumentPathError);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM') {
        // Windows without developer symlink privilege still covered by path traversal.
      } else {
        throw error;
      }
    }
    harness.setTrusted(false);
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'trusted.txt'), 'ok');
    await expect(harness.authority.read(harness.resource('trusted.txt'))).rejects.toBeInstanceOf(DocumentUntrustedError);
  });

  it('treats missing, malformed, and failed recovery journals as distinct results', async () => {
    await harness.cleanup();
    let failJournalWrites = false;
    const fsPromises = new Proxy(fs.promises, {
      get(target, property, receiver) {
        if (property === 'writeFile') return async (...args: Parameters<typeof fs.promises.writeFile>) => {
          if (failJournalWrites && String(args[0]).includes('document-recovery') && String(args[0]).includes('.tmp')) {
            throw new Error('disk full');
          }
          return Reflect.apply(target.writeFile, target, args) as ReturnType<typeof fs.promises.writeFile>;
        };
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    harness = await createDocumentAuthorityHarness({ authority: { fsPromises } });
    const missing = await harness.authority.readRecoveryJournal('missing-journal');
    expect(missing.status).toBe('missing');
    const resource = harness.resource('draft.txt');
    const written = requireStatus(await harness.authority.writeRecoveryJournal({
      token: harness.token(),
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-1',
      resource,
      content: 'draft',
      encoding: 'utf-8',
      bom: false,
      baseRevision: null,
      expectedRevision: null,
    }), 'written');
    expect(written.status).toBe('written');
    const listed = await harness.authority.listRecoveryJournals({
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-1',
    });
    expect(listed).toHaveLength(1);
    const journalDir = path.join(
      harness.dataDir,
      'document-recovery',
      harness.authority.hostId,
      harness.identity.workspaceId,
      'session-1',
    );
    await fs.promises.writeFile(path.join(journalDir, 'broken.json'), '{not-json');
    const afterMalformed = await harness.authority.listRecoveryJournals({
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-1',
    });
    expect(afterMalformed).toHaveLength(1);
    failJournalWrites = true;
    await expect(harness.authority.writeRecoveryJournal({
      token: harness.token(),
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: 'session-1',
      resource: harness.resource('other.txt'),
      content: 'nope',
      encoding: 'utf-8',
      bom: false,
      baseRevision: null,
      expectedRevision: null,
    })).rejects.toThrow(/disk full/);
    await expect(harness.authority.listRecoveryJournals({
      workspaceId: '../escape',
    })).rejects.toThrow(/workspaceId is malformed/);
    await expect(harness.authority.writeRecoveryJournal({
      token: harness.token(),
      workspaceId: harness.identity.workspaceId,
      recoverySessionId: '../escape',
      resource,
      content: 'nope',
      encoding: 'utf-8',
      bom: false,
      baseRevision: null,
      expectedRevision: null,
    })).rejects.toThrow(/recoverySessionId is malformed/);
  });
});

const surfaceHash = (text: string) => `sha256-${createHash('sha256').update(text).digest('hex')}`;

it('assigns a nested runtime root its own workspace identity', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const nestedRoot = path.join(harness.workspaceRoot, '.varin', 'threads', 'child-worktree');
    await fs.promises.mkdir(nestedRoot, { recursive: true });
    const nested = await harness.authority.resolveWorkspace({ path: nestedRoot });
    expect(nested.workspaceId).not.toBe(harness.identity.workspaceId);
    await expect(harness.authority.inspectWorkspace(nested.workspaceId)).resolves.toMatchObject({
      root: await fs.promises.realpath(nestedRoot),
    });
  } finally {
    await harness.cleanup();
  }
});

it('gives overlapping project roots one physical coordination identity and separates hosts', async () => {
  const harness = await createDocumentAuthorityHarness();
  const otherHost = createDocumentAuthority({
    hostId: '22222222-2222-4222-8222-222222222222',
    dataDir: path.join(harness.root, 'other-host'),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  try {
    const nestedRoot = path.join(harness.workspaceRoot, 'child');
    await fs.promises.mkdir(nestedRoot);
    await fs.promises.writeFile(path.join(nestedRoot, 'same.txt'), 'one\n');
    const child = await harness.authority.resolveWorkspace({ path: nestedRoot });
    const parentIdentity = await harness.authority.resolveResourceIdentity(harness.resource('child/same.txt'));
    const childIdentity = await harness.authority.resolveResourceIdentity({ workspaceId: child.workspaceId, resourceId: 'same.txt' });
    expect(childIdentity.coordinationId).toBe(parentIdentity.coordinationId);
    expect(childIdentity.aliases).toEqual(expect.arrayContaining([harness.resource('child/same.txt'), { workspaceId: child.workspaceId, resourceId: 'same.txt' }]));
    const remote = await otherHost.resolveWorkspace({ path: nestedRoot });
    const remoteIdentity = await otherHost.resolveResourceIdentity({ workspaceId: remote.workspaceId, resourceId: 'same.txt' });
    expect(remoteIdentity.coordinationId).not.toBe(parentIdentity.coordinationId);
  } finally {
    await otherHost.dispose();
    await harness.cleanup();
  }
});

it('serializes the same physical file across parent and child project roots', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const nestedRoot = path.join(harness.workspaceRoot, 'child');
    await fs.promises.mkdir(nestedRoot);
    const child = await harness.authority.resolveWorkspace({ path: nestedRoot });
    await fs.promises.writeFile(path.join(nestedRoot, 'same.txt'), 'base\n');
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstActive = false;
    let overlapped = false;
    const first = harness.authority.runResourceOperation(
      harness.identity.workspaceId,
      [{ resourceId: 'child/same.txt', scope: 'exact' }],
      async () => {
        firstActive = true;
        enterFirst();
        await firstReleased;
        firstActive = false;
      },
    );
    await firstEntered;
    const second = harness.authority.runResourceOperation(
      child.workspaceId,
      [{ resourceId: 'same.txt', scope: 'exact' }],
      async () => { overlapped = firstActive; },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst();
    await Promise.all([first, second]);
    expect(overlapped).toBe(false);
  } finally {
    await harness.cleanup();
  }
});

it('captures distinct dirty files in two roots under one fixed snapshot without name collisions', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const childRoot = path.join(harness.workspaceRoot, 'child');
    await fs.promises.mkdir(childRoot);
    const child = await harness.authority.resolveWorkspace({ path: childRoot });
    const first = { workspaceId: harness.identity.workspaceId, resourceId: 'same.txt' };
    const second = { workspaceId: child.workspaceId, resourceId: 'same.txt' };
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'same.txt'), 'A disk\n');
    await fs.promises.writeFile(path.join(childRoot, 'same.txt'), 'B disk\n');
    const ownerId = 'two-root-owner';
    const generation = 1;
    await harness.authority.publishDirtyBuffers({ ownerId, generation, workspaceId: first.workspaceId, resources: [{ resource: first, baseRevision: null, localEditRevision: 1 }] });
    await harness.authority.publishDirtyBuffers({ ownerId, generation, workspaceId: second.workspaceId, resources: [{ resource: second, baseRevision: null, localEditRevision: 1 }] });
    const context = await harness.authority.captureAgentInputSnapshot({
      ownerId, generation, sessionId: 'two-root-session',
      resources: [
        { resource: first, baseRevision: null, localEditRevision: 1, content: 'A draft\n', encoding: 'utf-8', bom: false },
        { resource: second, baseRevision: null, localEditRevision: 1, content: 'B draft\n', encoding: 'utf-8', bom: false },
      ],
    });
    expect(context.source).toBe('surface');
    if (context.source !== 'surface') throw new Error('Expected fixed drafts');
    expect(context.roots).toEqual(expect.arrayContaining([
      { workspaceId: first.workspaceId, dirtyPaths: ['same.txt'] },
      { workspaceId: second.workspaceId, dirtyPaths: ['same.txt'] },
    ]));
    expect(harness.authority.readAgentInputSnapshot('two-root-session', context, 'same.txt', first.workspaceId)).toMatchObject({ status: 'ready', content: 'A draft\n' });
    expect(harness.authority.readAgentInputSnapshot('two-root-session', context, 'same.txt', second.workspaceId)).toMatchObject({ status: 'ready', content: 'B draft\n' });
    await harness.authority.publishDirtyBuffers({ ownerId, generation, workspaceId: second.workspaceId, resources: [{ resource: second, baseRevision: null, localEditRevision: 2 }] });
    await expect(harness.authority.captureAgentInputSnapshot({
      ownerId, generation, sessionId: 'stale-two-root-session',
      resources: [
        { resource: first, baseRevision: null, localEditRevision: 1, content: 'A draft\n', encoding: 'utf-8', bom: false },
        { resource: second, baseRevision: null, localEditRevision: 1, content: 'B draft\n', encoding: 'utf-8', bom: false },
      ],
    })).rejects.toMatchObject({ code: 'stale-completion' });
    await harness.authority.observeAgentWrite(first.workspaceId, path.join(harness.workspaceRoot, 'same.txt'));
    expect(harness.authority.readAgentInputSnapshot('two-root-session', context, 'same.txt', first.workspaceId)).toMatchObject({ status: 'disk', superseded: true });
    expect(harness.authority.readAgentInputSnapshot('two-root-session', context, 'same.txt', second.workspaceId)).toMatchObject({ status: 'ready', content: 'B draft\n' });
    harness.authority.dropAgentInputSnapshots('two-root-session');
    expect(harness.authority.readAgentInputSnapshot('two-root-session', context, 'same.txt', second.workspaceId)).toMatchObject({ status: 'unavailable' });
  } finally {
    await harness.cleanup();
  }
});

it('supersedes every project alias after a write to their shared physical file', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const childRoot = path.join(harness.workspaceRoot, 'child');
    await fs.promises.mkdir(childRoot);
    const child = await harness.authority.resolveWorkspace({ path: childRoot });
    const parentAlias = { workspaceId: harness.identity.workspaceId, resourceId: 'child/shared.txt' };
    const childAlias = { workspaceId: child.workspaceId, resourceId: 'shared.txt' };
    await fs.promises.writeFile(path.join(childRoot, 'shared.txt'), 'disk\n');
    for (const alias of [parentAlias, childAlias]) {
      await harness.authority.publishDirtyBuffers({
        ownerId: 'shared-owner', generation: 1, workspaceId: alias.workspaceId,
        resources: [{ resource: alias, baseRevision: null, localEditRevision: 1 }],
      });
    }
    const context = await harness.authority.captureAgentInputSnapshot({
      ownerId: 'shared-owner', generation: 1, sessionId: 'shared-session',
      resources: [parentAlias, childAlias].map((resource) => ({
        resource, baseRevision: null, localEditRevision: 1, content: 'draft\n', encoding: 'utf-8', bom: false,
      })),
    });
    expect(harness.authority.readAgentInputSnapshot('shared-session', context, parentAlias.resourceId, parentAlias.workspaceId)).toMatchObject({ status: 'ready' });
    expect(harness.authority.readAgentInputSnapshot('shared-session', context, childAlias.resourceId, childAlias.workspaceId)).toMatchObject({ status: 'ready' });
    const cloned = harness.authority.cloneAgentInputSnapshot('shared-session', context);
    expect(cloned.status).toBe('ready');
    if (cloned.status !== 'ready') throw new Error('Expected shared fixed draft');
    expect(cloned.resources).toHaveLength(2);
    expect(cloned.resources[0]?.coordinationId).toBe(cloned.resources[1]?.coordinationId);
    expect(cloned.resources[0]?.aliases).toEqual(expect.arrayContaining([parentAlias, childAlias]));
    await harness.authority.observeAgentWrite(parentAlias.workspaceId, path.join(childRoot, 'shared.txt'));
    expect(harness.authority.readAgentInputSnapshot('shared-session', context, parentAlias.resourceId, parentAlias.workspaceId)).toMatchObject({ status: 'disk', superseded: true });
    expect(harness.authority.readAgentInputSnapshot('shared-session', context, childAlias.resourceId, childAlias.workspaceId)).toMatchObject({ status: 'disk', superseded: true });
  } finally {
    await harness.cleanup();
  }
});

it('publishes committed document mutations without letting an observer fail the write', async () => {
  const events: Array<{ resourceId: string; kind: string; owner: { kind: string } }> = [];
  const harness = await createDocumentAuthorityHarness({
    authority: {
      onMutation: (event) => {
        events.push(event);
        throw new Error('observer unavailable');
      },
    },
  });
  try {
    const result = await harness.authority.write({
      resource: harness.resource('observed.ts'),
      token: harness.token(undefined, { kind: 'web-route', id: 'editor' }),
      content: 'export const observed = true;\n',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
      operationId: randomUUID(),
    });
    expect(result.status).toBe('written');
    expect(events).toMatchObject([{ resourceId: 'observed.ts', kind: 'created', owner: { kind: 'web-route' } }]);
  } finally {
    await harness.cleanup();
  }
});

it('routes surface bodies only to the bound owner registration and rejects late completion after disconnect', async () => {
  const harness = await createDocumentAuthorityHarness();
  const events: unknown[] = [];
  const ownerId = 'surface-owner';
  const generation = 4;
  const subscription = harness.authority.registerDirtySurface({
    ownerId, generation, workspaceId: harness.identity.workspaceId,
  }, (event) => events.push(event));
  const target = {
    resource: harness.resource('surface.txt'),
    baseRevision: 'disk-revision',
    localEditRevision: 7,
    documentInstanceId: 'document-instance',
    bufferHash: surfaceHash('draft\n'),
    encoding: 'utf-8',
    bom: false,
    lineEnding: 'lf' as const,
  };
  try {
    await harness.authority.publishDirtyBuffers({
      ownerId, generation, workspaceId: harness.identity.workspaceId, resources: [target],
    });
    const publication = (await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))[0]!;
    const pending = harness.authority.requestSurfaceOperation({
      action: 'capture', ownerId, generation, registrationId: publication.registrationId!,
      operationId: 'integration-surface', targets: [target], workspaceId: harness.identity.workspaceId,
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const event = events[0] as { requestId: string; content?: unknown; targets?: unknown };
    expect(event.content).toBeUndefined();
    expect(event.targets).toBeUndefined();
    const payload = await harness.authority.readSurfaceOperation({
      ownerId, generation, requestId: event.requestId, workspaceId: harness.identity.workspaceId,
    });
    expect(payload.targets[0]).toMatchObject({ resource: { resourceId: 'surface.txt' } });
    await expect(harness.authority.completeSurfaceOperation({
      ownerId, generation, requestId: event.requestId, operationId: 'integration-surface',
      workspaceId: harness.identity.workspaceId, resources: [{
        resource: harness.resource('surface.txt'), status: 'captured', content: 'draft\n',
        documentInstanceId: 'document-instance', beforeLocalEditRevision: 7, beforeHash: surfaceHash('draft\n'),
      }],
    })).resolves.toEqual({ accepted: true });
    await expect(pending).resolves.toMatchObject([{ status: 'captured', content: 'draft\n' }]);

    const disconnected = harness.authority.requestSurfaceOperation({
      action: 'capture', ownerId, generation, registrationId: publication.registrationId!,
      operationId: 'integration-disconnected', targets: [target], workspaceId: harness.identity.workspaceId,
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const disconnectedEvent = events[1] as { requestId: string };
    subscription.close();
    await expect(disconnected).rejects.toThrow(/disconnected/u);
    await expect(harness.authority.completeSurfaceOperation({
      ownerId, generation, requestId: disconnectedEvent.requestId, operationId: 'integration-disconnected',
      workspaceId: harness.identity.workspaceId, resources: [{
        resource: harness.resource('surface.txt'), status: 'captured', content: 'draft\n',
      }],
    })).rejects.toThrow(/stale or unavailable/u);
  } finally {
    subscription.close();
    await harness.cleanup();
  }
});

it('advances the matching fixed input snapshot after a confirmed surface apply and invalidates older snapshots', async () => {
  const harness = await createDocumentAuthorityHarness();
  const events: Array<{ requestId?: string }> = [];
  const ownerId = 'surface-owner';
  const generation = 5;
  const resource = harness.resource('surface-read.txt');
  const subscription = harness.authority.registerDirtySurface({ ownerId, generation, workspaceId: harness.identity.workspaceId }, (event) => {
    events.push(event as { requestId?: string });
  });
  const publish = async (localEditRevision: number, content: string) => {
    const target = {
      resource, baseRevision: 'disk-base', localEditRevision,
      documentInstanceId: 'document-instance', bufferHash: surfaceHash(content),
      encoding: 'utf-8', bom: false, lineEnding: 'lf' as const,
    };
    await harness.authority.publishDirtyBuffers({ ownerId, generation, workspaceId: harness.identity.workspaceId, resources: [target] });
    return target;
  };
  try {
    const oldTarget = await publish(6, 'older\n');
    const oldContext = await harness.authority.captureAgentInputSnapshot({
      ownerId, generation, sessionId: 'old-session',
      resources: [{ ...oldTarget, content: 'older\n' }],
    });
    harness.authority.commitAgentInputSnapshot('old-session', oldContext);
    const target = await publish(7, 'current\n');
    const currentContext = await harness.authority.captureAgentInputSnapshot({
      ownerId, generation, sessionId: 'current-session',
      resources: [{ ...target, content: 'current\n' }],
    });
    harness.authority.commitAgentInputSnapshot('current-session', currentContext);
    const publication = (await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))[0]!;
    const pending = harness.authority.requestSurfaceOperation({
      action: 'apply', ownerId, generation, registrationId: publication.registrationId!, operationId: 'surface-apply',
      workspaceId: harness.identity.workspaceId, targets: [{ ...target, newText: 'integrated\n' }],
    });
    await vi.waitFor(() => expect(events.some((event) => event.requestId)).toBe(true));
    const requestId = events.find((event) => event.requestId)!.requestId!;
    await harness.authority.completeSurfaceOperation({
      ownerId, generation, requestId, operationId: 'surface-apply', workspaceId: harness.identity.workspaceId,
      resources: [{
        resource, status: 'applied', documentInstanceId: 'document-instance',
        beforeLocalEditRevision: 7, beforeHash: surfaceHash('current\n'),
        afterLocalEditRevision: 8, afterHash: surfaceHash('integrated\n'),
      }],
    });
    await pending;
    expect(harness.authority.readAgentInputSnapshot('current-session', currentContext, 'surface-read.txt', harness.identity.workspaceId))
      .toMatchObject({ status: 'ready', content: 'integrated\n', revision: expect.stringContaining(':8') });
    expect(harness.authority.readAgentInputSnapshot('old-session', oldContext, 'surface-read.txt', harness.identity.workspaceId))
      .toMatchObject({ status: 'unavailable' });

    await harness.authority.publishDirtyBuffers({
      ownerId, generation, workspaceId: harness.identity.workspaceId, resources: [],
    });
    const undo = harness.authority.requestSurfaceOperation({
      action: 'undo', ownerId, generation, registrationId: publication.registrationId!, operationId: 'surface-undo',
      workspaceId: harness.identity.workspaceId,
      targets: [{ ...target, expectedAppliedRevision: 8, expectedAppliedHash: surfaceHash('integrated\n') }],
    });
    await vi.waitFor(() => expect(events.filter((event) => event.requestId)).toHaveLength(2));
    const undoRequestId = events.filter((event) => event.requestId).at(-1)!.requestId!;
    await harness.authority.completeSurfaceOperation({
      ownerId, generation, requestId: undoRequestId, operationId: 'surface-undo', workspaceId: harness.identity.workspaceId,
      resources: [{
        resource, status: 'undone', documentInstanceId: 'document-instance', content: 'current\n',
        afterLocalEditRevision: 9, afterHash: surfaceHash('current\n'),
      }],
    });
    await undo;
    expect(harness.authority.readAgentInputSnapshot('current-session', currentContext, 'surface-read.txt', harness.identity.workspaceId))
      .toMatchObject({ status: 'ready', content: 'current\n', revision: expect.stringContaining(':9') });
  } finally {
    subscription.close();
    await harness.cleanup();
  }
});

it('invalidates a fixed input snapshot when a dispatched surface write is cancelled without a receipt', async () => {
  const harness = await createDocumentAuthorityHarness();
  const events: Array<{ requestId?: string }> = [];
  const ownerId = 'surface-owner';
  const generation = 6;
  const resource = harness.resource('surface-cancelled.txt');
  const subscription = harness.authority.registerDirtySurface({ ownerId, generation, workspaceId: harness.identity.workspaceId }, (event) => {
    events.push(event as { requestId?: string });
  });
  const target = {
    resource,
    baseRevision: 'disk-base',
    localEditRevision: 3,
    documentInstanceId: 'document-instance',
    bufferHash: surfaceHash('draft\n'),
    encoding: 'utf-8',
    bom: false,
    lineEnding: 'lf' as const,
  };
  try {
    await harness.authority.publishDirtyBuffers({
      ownerId, generation, workspaceId: harness.identity.workspaceId, resources: [target],
    });
    const context = await harness.authority.captureAgentInputSnapshot({
      ownerId,
      generation,
      sessionId: 'surface-cancelled-session',
      resources: [{ ...target, content: 'draft\n' }],
    });
    harness.authority.commitAgentInputSnapshot('surface-cancelled-session', context);
    const publication = (await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))[0]!;
    const controller = new AbortController();
    const pending = harness.authority.requestSurfaceOperation({
      action: 'apply', ownerId, generation, registrationId: publication.registrationId!,
      operationId: 'surface-cancelled', workspaceId: harness.identity.workspaceId,
      targets: [{ ...target, newText: 'possibly-applied\n' }],
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    controller.abort(new Error('caller disconnected'));
    await expect(pending).rejects.toThrow(/caller disconnected/u);
    expect(harness.authority.readAgentInputSnapshot(
      'surface-cancelled-session', context, 'surface-cancelled.txt', harness.identity.workspaceId,
    )).toMatchObject({ status: 'unavailable' });
  } finally {
    subscription.close();
    await harness.cleanup();
  }
});

it('queues a document mutation behind a Host subtree operation without locking unrelated paths', async () => {
  const harness = await createDocumentAuthorityHarness();
  let releaseDirectory: (() => void) | undefined;
  let announceDirectory: (() => void) | undefined;
  const directoryStarted = new Promise<void>((resolve) => { announceDirectory = resolve; });
  const directoryRelease = new Promise<void>((resolve) => { releaseDirectory = resolve; });
  try {
    const held = harness.authority.runResourceOperation(
      harness.identity.workspaceId,
      [{ resourceId: 'nested', scope: 'subtree' }],
      async () => {
        announceDirectory?.();
        await directoryRelease;
      },
    );
    await directoryStarted;
    let nestedSettled = false;
    const nested = harness.authority.write({
      resource: harness.resource('nested/note.txt'),
      token: harness.token(),
      content: 'nested',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    }).finally(() => { nestedSettled = true; });
    const unrelated = harness.authority.write({
      resource: harness.resource('other.txt'),
      token: harness.token(),
      content: 'unrelated',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    });
    await expect(unrelated).resolves.toMatchObject({ status: 'written' });
    expect(nestedSettled).toBe(false);
    releaseDirectory?.();
    await held;
    await expect(nested).resolves.toMatchObject({ status: 'written' });
  } finally {
    releaseDirectory?.();
    await harness.cleanup();
  }
});

it.skipIf(process.platform !== 'win32')('uses one Host resource queue for Windows case aliases', async () => {
  const harness = await createDocumentAuthorityHarness();
  let release: (() => void) | undefined;
  let announce: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { announce = resolve; });
  const heldUntil = new Promise<void>((resolve) => { release = resolve; });
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'Case-Alias.txt'), 'base');
    const original = await harness.authority.read(harness.resource('Case-Alias.txt'));
    if (original.status !== 'ready') throw new Error('Expected the case-alias fixture to be readable');
    const held = harness.authority.runResourceOperation(
      harness.identity.workspaceId,
      [{ resourceId: 'Case-Alias.txt', scope: 'exact' }],
      async () => {
        announce?.();
        await heldUntil;
      },
    );
    await started;
    let settled = false;
    const aliasedWrite = harness.authority.write({
      resource: harness.resource('CASE-ALIAS.TXT'),
      token: harness.token(),
      content: 'updated',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: original.revision,
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release?.();
    await held;
    await expect(aliasedWrite).resolves.toMatchObject({ status: 'written' });
  } finally {
    release?.();
    await harness.cleanup();
  }
});

const createPeerAuthority = (
  harness: DocumentAuthorityHarness,
  options: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> = {},
): DocumentAuthority => createDocumentAuthority({
  hostId: harness.authority.hostId,
  dataDir: harness.dataDir,
  isTrusted: async () => true,
  isAllowedRoot: async () => true,
  ...options,
});

it('keeps a persisted workspace identity available while its root is temporarily offline', async () => {
  const harness = await createDocumentAuthorityHarness();
  const offlineRoot = `${harness.workspaceRoot}.offline`;
  let peer: DocumentAuthority | undefined;
  try {
    await fs.promises.rename(harness.workspaceRoot, offlineRoot);
    peer = createPeerAuthority(harness);
    const onlineRoot = path.join(harness.root, 'online-workspace');
    await fs.promises.mkdir(onlineRoot);

    await expect(peer.resolveWorkspace({ workspaceId: harness.identity.workspaceId })).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      hostId: harness.identity.hostId,
      epoch: harness.identity.epoch,
    });
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).rejects.toMatchObject({
      code: 'workspace-unavailable',
      statusCode: 503,
    });
    const onlineIdentity = await peer.resolveWorkspace({ path: onlineRoot });
    expect(onlineIdentity.workspaceId).not.toBe(harness.identity.workspaceId);
    await expect(peer.inspectWorkspace(onlineIdentity.workspaceId)).resolves.toMatchObject({
      root: await fs.promises.realpath(onlineRoot),
    });

    await fs.promises.rename(offlineRoot, harness.workspaceRoot);
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      root: await fs.promises.realpath(harness.workspaceRoot),
    });
  } finally {
    if (fs.existsSync(offlineRoot) && !fs.existsSync(harness.workspaceRoot)) {
      await fs.promises.rename(offlineRoot, harness.workspaceRoot);
    }
    await Promise.allSettled([peer?.dispose(), harness.cleanup()]);
  }
});

it('keeps an admitted workspace usable after the mutable root selection changes', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness, { isAllowedRoot: async () => false });
  const unregisteredRoot = path.join(harness.root, 'unregistered-workspace');
  try {
    await fs.promises.mkdir(unregisteredRoot);

    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).resolves.toMatchObject({
      workspaceId: harness.identity.workspaceId,
      root: await fs.promises.realpath(harness.workspaceRoot),
    });
    await expect(peer.resolveWorkspace({ path: unregisteredRoot })).rejects.toMatchObject({
      code: 'path-escape',
      statusCode: 403,
    });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('notifies a workspace observer after a path receives its Host identity', async () => {
  const harness = await createDocumentAuthorityHarness();
  const onWorkspaceResolved = vi.fn();
  const peer = createPeerAuthority(harness, { onWorkspaceResolved });
  try {
    const resolved = await peer.resolveWorkspace({ path: harness.workspaceRoot });
    await vi.waitFor(() => expect(onWorkspaceResolved).toHaveBeenCalledWith(resolved));
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('rejects a registered path whose canonical filesystem identity changes', async () => {
  const harness = await createDocumentAuthorityHarness();
  const replacementRoot = path.join(harness.root, 'replacement-workspace');
  const registeredRoot = await fs.promises.realpath(harness.workspaceRoot);
  await fs.promises.mkdir(replacementRoot);
  const replacementCanonicalRoot = await fs.promises.realpath(replacementRoot);
  const fsPromises = new Proxy(fs.promises, {
    get(target, property, receiver) {
      if (property === 'realpath') return async (value: fs.PathLike) => (
        path.resolve(String(value)) === path.resolve(registeredRoot)
        ? replacementCanonicalRoot
        : fs.promises.realpath(value)
      );
      const member = Reflect.get(target, property, receiver) as unknown;
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  const peer = createPeerAuthority(harness, { fsPromises });
  try {
    await expect(peer.inspectWorkspace(harness.identity.workspaceId)).rejects.toMatchObject({
      code: 'untrusted',
      statusCode: 403,
    });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('coordinates writer, maintenance, and epoch fencing across authority instances', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'cross-instance-writer' });
    await expect(peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
      .rejects.toMatchObject({ code: 'active-writer', currentEpoch: harness.identity.epoch });

    await peer.setMaintenance(harness.identity.workspaceId, true);
    await expect(harness.authority.registerWriter(harness.token(), { purpose: 'maintenance-rejected' }))
      .rejects.toMatchObject({ code: 'maintenance', currentEpoch: harness.identity.epoch });

    await writer.close();
    const advanced = await peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
    const stalePath = path.join(harness.workspaceRoot, 'stale-token.txt');
    expect(await harness.authority.write({
      token: harness.token(),
      resource: harness.resource('stale-token.txt'),
      content: 'must not write',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: null,
    })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
    await expect(fs.promises.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('keeps maintenance process-owned and releases it during authority shutdown', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    await expect(peer.setMaintenance(harness.identity.workspaceId, false))
      .rejects.toMatchObject({ code: 'maintenance' });

    await harness.authority.dispose();
    await expect(peer.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('reclaims maintenance owned by a terminated Host process', async () => {
  const firstProcess = { pid: 41001, platform: process.platform, kill: () => true as const };
  const harness = await createDocumentAuthorityHarness({ authority: { processLike: firstProcess } });
  const terminatedProcessView = {
    pid: 41002,
    platform: process.platform,
    kill: () => {
      throw Object.assign(new Error('process does not exist'), { code: 'ESRCH' });
    },
  };
  const peer = createPeerAuthority(harness, { processLike: terminatedProcessView });
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    await expect(peer.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('migrates ownerless v2 maintenance to an unlocked process-owned state', async () => {
  const harness = await createDocumentAuthorityHarness();
  let restarted: DocumentAuthority | undefined;
  try {
    await harness.authority.dispose();
    const statePath = path.join(harness.dataDir, 'documents', 'mutation-authority.json');
    const stored = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as {
      schemaVersion: number;
      workspaces: Record<string, { maintenance: boolean; maintenanceOwner?: unknown }>;
    };
    const workspace = stored.workspaces[harness.identity.workspaceId];
    if (!workspace) throw new Error('Expected stored workspace mutation state');
    stored.schemaVersion = 2;
    workspace.maintenance = true;
    delete workspace.maintenanceOwner;
    await fs.promises.writeFile(statePath, JSON.stringify(stored));

    restarted = createPeerAuthority(harness);
    await expect(restarted.inspectMutation(harness.identity.workspaceId))
      .resolves.toMatchObject({ maintenance: false });
    const migrated = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      workspaces: {
        [harness.identity.workspaceId]: { maintenance: false, maintenanceOwner: null },
      },
    });
  } finally {
    await Promise.allSettled([restarted?.dispose(), harness.cleanup()]);
  }
});

it('dispose removes only its authority instance writers from durable state', async () => {
  const harness = await createDocumentAuthorityHarness();
  const peer = createPeerAuthority(harness);
  try {
    await harness.authority.registerWriter(harness.token(), { purpose: 'disposed-instance' });
    const peerWriter = await peer.registerWriter(harness.token(), { purpose: 'retained-peer' });
    await harness.authority.dispose();

    const afterDispose = await peer.inspectMutation(harness.identity.workspaceId);
    expect(afterDispose.activeWriters.map((writer) => writer.purpose)).toEqual(['retained-peer']);
    await expect(peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
      .rejects.toMatchObject({ code: 'active-writer' });
    await peerWriter.close();
    const advanced = await peer.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
    expect(advanced.epoch).toBe(harness.identity.epoch + 1);
  } finally {
    await Promise.allSettled([peer.dispose(), harness.cleanup()]);
  }
});

it('uses a fresh watch source as the baseline after each watcher rebuild', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    const firstCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const firstResult = await harness.authority.completeCapture(firstCapture);
    expect(firstResult.stable).toBe(true);

    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'between-captures.txt'), 'fresh source');
    const secondCapture = await harness.authority.beginCapture(harness.identity.workspaceId);
    const secondResult = await harness.authority.completeCapture(secondCapture);
    expect(secondResult.stable).toBe(true);
    const firstWatch = firstCapture.watch as WatchPosition | null;
    const secondWatch = secondCapture.watch as WatchPosition | null;
    const resultWatch = secondResult.state.watch as WatchPosition | null;
    if (!firstWatch || !secondWatch || !resultWatch) throw new Error('Expected capture watch positions');
    expect(secondWatch.sourceId).not.toBe(firstWatch.sourceId);
    expect(resultWatch.sourceId).toBe(secondWatch.sourceId);
  } finally {
    await harness.cleanup();
  }
});

it('allows only an explicit restore capture to validate under maintenance', async () => {
  const harness = await createDocumentAuthorityHarness();
  try {
    await harness.authority.setMaintenance(harness.identity.workspaceId, true);
    const ordinary = await harness.authority.beginCapture(harness.identity.workspaceId);
    expect(await harness.authority.completeCapture(ordinary)).toMatchObject({
      stable: false,
      reasons: expect.arrayContaining(['maintenance']),
    });
    const restore = await harness.authority.beginCapture(harness.identity.workspaceId, {
      allowMaintenance: true,
    });
    expect(await harness.authority.completeCapture(restore)).toMatchObject({ stable: true, reasons: [] });
    await harness.authority.setMaintenance(harness.identity.workspaceId, false);
  } finally {
    await harness.cleanup();
  }
});

it('excludes the dispatching round admission without ignoring real writer activity during capture', async () => {
  const harness = await createDocumentAuthorityHarness();
  const round = await harness.authority.registerWriter(harness.token(), { purpose: 'pi-agent-run:agent.prompt' });
  try {
    const options = { ignoredWriterIds: [round.writerId] };
    const quiet = await harness.authority.beginCapture(harness.identity.workspaceId, options);
    expect(await harness.authority.completeCapture(quiet)).toMatchObject({ stable: true });
    const capture = await harness.authority.beginCapture(harness.identity.workspaceId, options);
    const observations: Promise<unknown>[] = [];
    const unsubscribe = harness.authority.subscribeMutationState(workspaceId => {
      observations.push(harness.authority.inspectMutation(workspaceId));
    });
    const writer = await harness.authority.registerWriter(harness.token(), { purpose: 'documents-write' });
    await writer.close();
    unsubscribe();
    const states = await Promise.all(observations);
    expect(states.at(-1)).toMatchObject({ activeWriters: [{ writerId: round.writerId }] });
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(await harness.authority.completeCapture(capture)).toMatchObject({
      stable: false, reasons: expect.arrayContaining(['writer-activity']),
    });
  } finally {
    await round.close();
    await harness.cleanup();
  }
});

it('coordinates a dirty-state barrier with every connected document surface', async () => {
  const harness = await createDocumentAuthorityHarness();
  const events: Record<string, unknown>[] = [];
  const surface = harness.authority.registerDirtySurface({
    generation: 7,
    ownerId: 'surface-1',
    workspaceId: harness.identity.workspaceId,
  }, (event) => {
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      events.push(event as Record<string, unknown>);
    }
  });
  try {
    const pending = harness.authority.beginDirtyStateBarrier(
      harness.identity.workspaceId,
      ['note.txt'],
    );
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      action: 'acquire',
      kind: 'dirty-state-barrier',
      paths: ['note.txt'],
    })));
    const acquire = events.find((event) => event.action === 'acquire');
    if (!acquire || typeof acquire.barrierId !== 'string') throw new Error('Expected dirty-state acquire event');
    expect(await harness.authority.acknowledgeDirtyStateBarrier({
      barrierId: acquire.barrierId,
      generation: 7,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ acknowledged: false });
    await harness.authority.publishDirtyBuffers({
      generation: 7,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 3,
        resource: harness.resource('note.txt'),
      }],
      workspaceId: harness.identity.workspaceId,
    });
    expect(await harness.authority.acknowledgeDirtyStateBarrier({
      barrierId: acquire.barrierId,
      generation: 7,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    })).toEqual({ acknowledged: true });
    const barrier = await pending;
    expect(await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))
      .toMatchObject([{ ownerId: 'surface-1', resources: [{ localEditRevision: 3 }] }]);
    await barrier.release();
    expect(events).toContainEqual(expect.objectContaining({
      action: 'release',
      barrierId: acquire.barrierId,
    }));
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('releases a cancelled dirty-state barrier without waiting for a surface acknowledgement', async () => {
  const harness = await createDocumentAuthorityHarness();
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const surface = harness.authority.registerDirtySurface({
    generation: 1, ownerId: 'surface-cancel', workspaceId: harness.identity.workspaceId,
  }, event => {
    const value = event as Record<string, unknown>;
    events.push(value);
    if (value.action === 'acquire') acquired();
  });
  try {
    const cancelled = new DOMException('Capture cancelled', 'AbortError');
    const pending = harness.authority.beginDirtyStateBarrier(harness.identity.workspaceId, ['.'], { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(cancelled);
    await ready;
    controller.abort(cancelled);
    await rejected;
    expect(events).toContainEqual(expect.objectContaining({
      action: 'release', barrierId: events[0]!.barrierId,
    }));
  } finally { controller.abort(); surface.close(); await harness.cleanup(); }
});

it('stops answering a path from its captured draft once a write is observed', async () => {
  const harness = await createDocumentAuthorityHarness();
  const surface = harness.authority.registerDirtySurface({
    generation: 1,
    ownerId: 'surface-owner',
    workspaceId: harness.identity.workspaceId,
  }, () => undefined);
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'disk text\n');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'other.ts'), 'other disk\n');
    const disk = await harness.authority.read(harness.resource('draft.ts'));
    const otherDisk = await harness.authority.read(harness.resource('other.ts'));
    if (disk.status !== 'ready' || otherDisk.status !== 'ready') throw new Error('Expected draft fixtures');
    const publication = {
      generation: 1,
      ownerId: 'surface-owner',
      resources: [
        { baseRevision: disk.revision, localEditRevision: 2, resource: harness.resource('draft.ts') },
        { baseRevision: otherDisk.revision, localEditRevision: 1, resource: harness.resource('other.ts') },
      ],
      workspaceId: harness.identity.workspaceId,
    };
    await harness.authority.publishDirtyBuffers(publication);
    const context = await harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-1',
      resources: publication.resources.map((resource) => ({ ...resource, content: 'unsaved draft\n' })),
    });
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'unsaved draft\n',
    });
    expect(harness.authority.agentInputDraftPaths('session-1', context, harness.identity.workspaceId)).toEqual(['draft.ts', 'other.ts']);

    // A native tool write lands on disk; the agent must read back its own work.
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'agent write\n');
    await harness.authority.observeAgentWrite(
      harness.identity.workspaceId,
      path.join(harness.workspaceRoot, 'draft.ts'),
    );
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'draft.ts', harness.identity.workspaceId))
      .toEqual({ status: 'disk', superseded: true });
    expect(harness.authority.agentInputDraftPaths('session-1', context, harness.identity.workspaceId)).toEqual(['other.ts']);
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'other.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'unsaved draft\n',
    });
    // Enumeration and the dispatch baseline follow the same rule.
    const overlay = harness.authority.overlayAgentInputSnapshot('session-1', context, '', harness.identity.workspaceId);
    if (overlay.status !== 'ready') throw new Error('Expected a ready overlay');
    expect(overlay.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)).toEqual(['other.ts']);
    expect(harness.authority.cloneAgentInputSnapshot('session-1', context)).toMatchObject({
      status: 'ready',
      supersededResources: [harness.resource('draft.ts')],
      resources: [{ resource: { resourceId: 'other.ts' } }],
    });

    // A path written outside the workspace root supersedes nothing here.
    await harness.authority.observeAgentWrite(
      harness.identity.workspaceId,
      path.join(harness.workspaceRoot, '..', 'outside.ts'),
    );
    expect(harness.authority.agentInputDraftPaths('session-1', context, harness.identity.workspaceId)).toEqual(['other.ts']);

    // A Documents-mediated write supersedes the same way.
    await harness.authority.write({
      resource: harness.resource('other.ts'),
      token: harness.token(undefined, { kind: 'web-route', id: 'editor' }),
      content: 'saved by the editor\n',
      encoding: 'utf-8',
      bom: false,
      expectedRevision: otherDisk.revision,
      operationId: randomUUID(),
    });
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'other.ts', harness.identity.workspaceId))
      .toEqual({ status: 'disk', superseded: true });
    expect(harness.authority.agentInputDraftPaths('session-1', context, harness.identity.workspaceId)).toEqual([]);
    expect(harness.authority.overlayAgentInputSnapshot('session-1', context, '', harness.identity.workspaceId)).toEqual({ status: 'disk' });

    // An expired capture still refuses disk for its known dirty paths.
    harness.authority.dropAgentInputSnapshots('session-1');
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'unavailable' });
    expect(harness.authority.agentInputDraftPaths('session-1', context, harness.identity.workspaceId)).toEqual(['draft.ts', 'other.ts']);
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('edits the fixed surface buffer and refuses a later user edit without touching disk', async () => {
  const harness = await createDocumentAuthorityHarness();
  const durableRecoveryStore = createInMemoryRecoveryDurablePort();
  const inspected = await harness.authority.inspectWorkspace(harness.identity.workspaceId);
  harness.authority.bindDurableMutationStorage(async (_workspaceId, operation) => operation({
    durableRecoveryStore,
    fileStore: createRecoveryFileStore(),
    identity: {
      authorityId: harness.authority.hostId,
      canonicalRoot: inspected.root,
      filesystemProfile: 'test',
      workspaceId: harness.identity.workspaceId,
    },
    // This sequential surface-CAS fixture supplies its own backend seam. Routing
    // it back into Documents would recursively re-enter the injected storage.
    // Actual kernel nesting/coverage is exercised by file-resource-audit.test.ts.
    resourceOperationGate: {
      run: (_resources, callback) => callback(),
    },
    root: path.join(harness.dataDir, 'agent-mutation-objects'),
  }));
  const live = new Map<string, LiveSurfaceBuffer>();
  const surface = attachLiveSurfaceCompleter(harness.authority, {
    generation: 1,
    live,
    ownerId: 'surface-owner',
    workspaceId: harness.identity.workspaceId,
  });
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'A\n');
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'other.ts'), 'disk-only\n');
    const disk = await harness.authority.read(harness.resource('draft.ts'));
    if (disk.status !== 'ready') throw new Error('Expected draft fixture');
    const binding = {
      baseRevision: disk.revision,
      localEditRevision: 2,
      documentInstanceId: 'document-instance',
      bufferHash: hashSurfaceText('B\n'),
      encoding: 'utf-8' as const,
      bom: false,
      lineEnding: 'lf' as const,
      resource: harness.resource('draft.ts'),
    };
    live.set('draft.ts', { ...binding, content: 'B\n' });
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-owner',
      resources: [binding],
      workspaceId: harness.identity.workspaceId,
    });
    const context = await harness.authority.captureAgentInputSnapshot({
      generation: 1,
      ownerId: 'surface-owner',
      sessionId: 'session-1',
      resources: [{ ...binding, content: 'B\n' }],
    });
    harness.authority.commitAgentInputSnapshot('session-1', context);

    const first = await harness.authority.applyAgentSurfaceWrite('session-1', harness.identity.workspaceId, context, [{
      resourceId: 'draft.ts',
      action: 'edit',
      edits: [{ oldText: 'B\n', newText: 'C\n' }],
    }]);
    expect(first).toMatchObject({ status: 'applied' });
    if (first.status === 'disk') throw new Error('expected a surface write');
    expect(first.results[0]).toMatchObject({ target: 'surface', status: 'applied' });
    expect(live.get('draft.ts')?.content).toBe('C\n');
    expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'), 'utf8')).toBe('A\n');
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'C\n',
      source: 'surface-draft',
    });
    const second = await harness.authority.applyAgentSurfaceWrite('session-1', harness.identity.workspaceId, context, [{
      resourceId: 'draft.ts',
      action: 'edit',
      edits: [{ oldText: 'C\n', newText: 'E\n' }],
    }]);
    expect(second).toMatchObject({ status: 'applied' });
    expect(live.get('draft.ts')?.content).toBe('E\n');
    expect(harness.authority.readAgentInputSnapshot('session-1', context, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'E\n',
    });

    live.set('draft.ts', {
      ...binding,
      content: 'D\n',
      localEditRevision: 9,
      bufferHash: hashSurfaceText('D\n'),
    });
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-owner',
      resources: [{
        ...binding,
        localEditRevision: 9,
        bufferHash: hashSurfaceText('D\n'),
      }],
      workspaceId: harness.identity.workspaceId,
    });
    const stale = await harness.authority.applyAgentSurfaceWrite('session-1', harness.identity.workspaceId, context, [{
      resourceId: 'draft.ts',
      action: 'edit',
      edits: [{ oldText: 'E\n', newText: 'F\n' }],
    }]);
    expect(stale.status).toBe('conflict');
    expect(live.get('draft.ts')?.content).toBe('D\n');
    expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'), 'utf8')).toBe('A\n');

    const diskOnly = await harness.authority.applyAgentSurfaceWrite('session-1', harness.identity.workspaceId, context, [{
      resourceId: 'other.ts',
      action: 'write',
      content: 'from-agent\n',
    }]);
    expect(diskOnly).toMatchObject({ status: 'applied', results: [{ path: 'other.ts', status: 'applied', target: 'disk' }] });
    expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'other.ts'), 'utf8')).toBe('from-agent\n');
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('captures immutable agent input snapshots only from the complete current dirty publication', async () => {
  const harness = await createDocumentAuthorityHarness();
  const surface = harness.authority.registerDirtySurface({
    generation: 7,
    ownerId: 'surface-owner',
    workspaceId: harness.identity.workspaceId,
  }, () => undefined);
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'disk text\n');
    const disk = await harness.authority.read(harness.resource('draft.ts'));
    if (disk.status !== 'ready') throw new Error('Expected draft fixture');
    const publication = {
      generation: 7,
      ownerId: 'surface-owner',
      resources: [{
        baseRevision: disk.revision,
        localEditRevision: 2,
        resource: harness.resource('draft.ts'),
      }],
      workspaceId: harness.identity.workspaceId,
    };
    await harness.authority.publishDirtyBuffers(publication);
    const first = await harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-1',
      resources: publication.resources.map((resource) => ({ ...resource, content: 'fixed draft\n' })),
    });
    expect(first).toMatchObject({ source: 'surface', snapshot: { status: 'ready' } });
    expect(harness.authority.readAgentInputSnapshot('session-1', first, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'fixed draft\n',
      source: 'surface-draft',
    });
    expect(harness.authority.cloneAgentInputSnapshot('session-1', first)).toMatchObject({
      status: 'ready',
      resources: [{
        baseRevision: disk.revision,
        content: 'fixed draft\n',
        encoding: 'utf-8',
        bom: false,
        localEditRevision: 2,
        resource: harness.resource('draft.ts'),
        revision: expect.stringMatching(/^surface-draft:/),
      }],
    });
    expect(harness.authority.cloneAgentInputSnapshot('wrong-session', first)).toMatchObject({ status: 'unavailable' });
    if (first.source !== 'surface') throw new Error('Expected a surface snapshot');
    expect(harness.authority.cloneAgentInputSnapshot('session-1', {
      ...first,
      roots: [{ workspaceId: harness.identity.workspaceId, dirtyPaths: ['different.ts'] }],
    })).toMatchObject({ status: 'unavailable' });
    expect(harness.authority.commitAgentInputSnapshot('wrong-session', first)).toEqual({ committed: false });

    await harness.authority.publishDirtyBuffers({
      ...publication,
      resources: publication.resources.map((resource) => ({ ...resource, localEditRevision: 3 })),
    });
    await expect(harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-1',
      resources: publication.resources.map((resource) => ({ ...resource, content: 'stale capture\n' })),
    })).rejects.toMatchObject({ code: 'stale-completion', statusCode: 409 });
    expect(harness.authority.readAgentInputSnapshot('session-1', first, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'fixed draft\n',
    });

    const secondPublication = {
      ...publication,
      resources: publication.resources.map((resource) => ({ ...resource, localEditRevision: 3 })),
    };
    const second = await harness.authority.captureAgentInputSnapshot({
      ...secondPublication,
      sessionId: 'session-1',
      resources: secondPublication.resources.map((resource) => ({ ...resource, content: 'new fixed draft\n' })),
    });
    expect(harness.authority.commitAgentInputSnapshot('session-1', first)).toEqual({ committed: true });
    expect(harness.authority.commitAgentInputSnapshot('session-1', second)).toEqual({ committed: true });
    expect(harness.authority.readAgentInputSnapshot('session-1', first, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'unavailable' });
    expect(harness.authority.readAgentInputSnapshot('session-1', second, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'new fixed draft\n',
    });
    const pendingCleared = await harness.authority.captureAgentInputSnapshot({
      ...secondPublication,
      sessionId: 'session-1',
      resources: secondPublication.resources.map((resource) => ({ ...resource, content: 'clear pending draft\n' })),
    });
    await harness.authority.clearDirtyBuffers({
      generation: 7,
      ownerId: 'surface-owner',
      workspaceId: harness.identity.workspaceId,
    });
    expect(harness.authority.readAgentInputSnapshot('session-1', pendingCleared, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'unavailable' });
    expect(harness.authority.readAgentInputSnapshot('session-1', second, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'ready' });
    await harness.authority.publishDirtyBuffers(secondPublication);
    const pending = await harness.authority.captureAgentInputSnapshot({
      ...secondPublication,
      sessionId: 'session-1',
      resources: secondPublication.resources.map((resource) => ({ ...resource, content: 'pending draft\n' })),
    });
    surface.close();
    expect(harness.authority.readAgentInputSnapshot('session-1', pending, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'unavailable' });
    expect(harness.authority.readAgentInputSnapshot('session-1', second, 'draft.ts', harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      content: 'new fixed draft\n',
    });
    harness.authority.dropAgentInputSnapshots('session-1');
    expect(harness.authority.readAgentInputSnapshot('session-1', second, 'draft.ts', harness.identity.workspaceId)).toMatchObject({ status: 'unavailable' });
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('preserves explicit surface snapshot encoding and BOM metadata while rejecting invalid types', async () => {
  const harness = await createDocumentAuthorityHarness();
  const surface = harness.authority.registerDirtySurface({
    generation: 7,
    ownerId: 'surface-owner',
    workspaceId: harness.identity.workspaceId,
  }, () => undefined);
  try {
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'metadata.txt'), 'disk\r\n');
    const disk = await harness.authority.read(harness.resource('metadata.txt'));
    if (disk.status !== 'ready') throw new Error('Expected metadata fixture');
    const publication = {
      generation: 7,
      ownerId: 'surface-owner',
      resources: [{
        baseRevision: disk.revision,
        localEditRevision: 1,
        resource: harness.resource('metadata.txt'),
      }],
      workspaceId: harness.identity.workspaceId,
    };
    await harness.authority.publishDirtyBuffers(publication);
    const context = await harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-metadata',
      resources: [{
        ...publication.resources[0]!,
        content: 'draft\r\n',
        encoding: 'utf-8',
        bom: true,
      }],
    });
    expect(harness.authority.cloneAgentInputSnapshot('session-metadata', context)).toMatchObject({
      status: 'ready',
      resources: [{
        content: 'draft\r\n',
        encoding: 'utf-8',
        bom: true,
      }],
    });

    await expect(harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-invalid-encoding',
      resources: [{
        ...publication.resources[0]!,
        content: 'draft',
        encoding: 7,
        bom: false,
      }],
    })).rejects.toMatchObject({ code: 'failed', statusCode: 400 });
    await expect(harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-unsupported-encoding',
      resources: [{
        ...publication.resources[0]!,
        content: 'draft',
        encoding: 'utf-16le',
        bom: false,
      }],
    })).rejects.toMatchObject({ code: 'failed', statusCode: 400 });
    await expect(harness.authority.captureAgentInputSnapshot({
      ...publication,
      sessionId: 'session-invalid-bom',
      resources: [{
        ...publication.resources[0]!,
        content: 'draft',
        encoding: 'utf-8',
        bom: 'true',
      }],
    })).rejects.toMatchObject({ code: 'failed', statusCode: 400 });
  } finally {
    surface.close();
    await harness.cleanup();
  }
});

it('closes an asynchronously started obsolete watcher after close and reopen', async () => {
  let gate = false;
  const releases: Array<() => void> = [];
  let starts = 0;
  let closes = 0;
  const fsModule: WorkspaceWatchFs = {
    watch(rootPath, options, listener) {
      starts += 1;
      const watcher = fs.watch(rootPath, options, listener);
      const close = watcher.close.bind(watcher);
      let closed = false;
      watcher.close = () => {
        if (!closed) {
          closed = true;
          closes += 1;
        }
        return close();
      };
      return watcher;
    },
  };
  const harness = await createDocumentAuthorityHarness({
    authority: {
      fsModule,
      isTrusted: async () => {
        if (gate) await new Promise<void>((resolve) => releases.push(resolve));
        return true;
      },
    },
  });
  try {
    gate = true;
    const obsolete = harness.authority.watch(harness.identity.workspaceId, () => undefined);
    obsolete.close();
    const current = harness.authority.watch(harness.identity.workspaceId, () => undefined);
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    for (const release of releases.splice(0)) release();
    while (starts < 2 || closes < 1 || !harness.authority.hasWatch(harness.identity.workspaceId)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    current.close();
    expect(closes).toBe(2);
  } finally {
    await harness.cleanup();
  }
});

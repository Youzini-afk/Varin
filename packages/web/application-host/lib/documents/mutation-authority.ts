import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { DocumentAuthorityError } from './errors.js';

const SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 2;
const WRITER_MODES = new Set<string>(['controlled', 'process', 'external']);

// ── Types ────────────────────────────────────────────────────────────────

export interface MutationOwner {
  kind: string;
  id: string;
  generation?: number;
}

interface MaintenanceOwner {
  pid: number;
  authorityInstanceId: string;
  acquiredAt: string;
}

interface ActiveWriter {
  writerId: string;
  pid: number;
  authorityInstanceId: string;
  epoch: number;
  mode: string;
  owner: MutationOwner;
  purpose: string;
  startedAt: string;
}

interface WorkspaceMutationEntry {
  epoch: number;
  maintenance: boolean;
  maintenanceOwner: MaintenanceOwner | null;
  mutationRevision: number;
  writerRevision: number;
  activeWriters: Record<string, ActiveWriter>;
}

interface MutationDocument {
  schemaVersion: number;
  hostId: string;
  workspaces: Record<string, WorkspaceMutationEntry>;
}

export interface MutationToken {
  workspaceId: string;
  epoch: number;
  owner: unknown;
}

export interface WatchPosition {
  sourceId: string;
  generation: number;
  sequence: number;
}

export interface WatchEvent {
  sourceId: string;
  generation: number;
  sequence: number;
}

interface WorkspaceRuntime {
  workspaceId: string;
  reconciliationRequired: boolean;
  watch: WatchPosition | null;
  watchRevision: number;
  lastDurableWitness: { epoch: number; maintenance: boolean; mutationRevision: number; writerRevision: number } | null;
}

export interface RegisterWriterOptions {
  mode?: string;
  purpose?: string;
}

export interface AdvanceEpochOptions {
  expectedEpoch?: number;
  maintenance?: boolean;
}

export interface CaptureToken {
  captureId: string;
  workspaceId: string;
  epoch: number;
  mutationRevision: number;
  writerRevision: number;
  activeWriterIds: string[];
  ignoredWriterIds?: string[];
  allowMaintenance?: boolean;
  maintenance: boolean;
  watchRevision: number;
  watch: WatchPosition | null;
}

interface MutationOperationResult {
  changed?: boolean;
  result?: unknown;
}

interface WorkspaceMutationAuthorityOptions {
  dataDir: string;
  hostId: string;
  fsModule?: unknown;
  fsPromises?: unknown;
  pathModule?: typeof path;
  processLike?: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>;
}

// ── Internal helpers ─────────────────────────────────────────────────────

const liveAuthorityInstances = new Set<string>();

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const malformedState = (): DocumentAuthorityError => new DocumentAuthorityError('Workspace mutation authority state is malformed', {
  code: 'failed',
  statusCode: 500,
});

const assertOwner = (owner: unknown): MutationOwner => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new DocumentAuthorityError('Workspace mutation owner is required', { code: 'failed', statusCode: 400 });
  }
  const o = owner as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !o.kind.trim() || typeof o.id !== 'string' || !o.id.trim()) {
    throw new DocumentAuthorityError('Workspace mutation owner is malformed', { code: 'failed', statusCode: 400 });
  }
  if (o.generation !== undefined && (!Number.isSafeInteger(o.generation) || (o.generation as number) < 0)) {
    throw new DocumentAuthorityError('Workspace mutation owner generation is malformed', { code: 'failed', statusCode: 400 });
  }
  return {
    kind: (o.kind as string).trim(),
    id: (o.id as string).trim(),
    ...(o.generation === undefined ? {} : { generation: o.generation as number }),
  };
};

const assertStoredOwner = (owner: unknown): MutationOwner => {
  try {
    return assertOwner(owner);
  } catch {
    throw malformedState();
  }
};

const defaultEntry = (): WorkspaceMutationEntry => ({
  epoch: 1,
  maintenance: false,
  maintenanceOwner: null,
  mutationRevision: 1,
  writerRevision: 1,
  activeWriters: {},
});

const assertMaintenanceOwner = (owner: unknown): MaintenanceOwner => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || !positiveInteger((owner as Record<string, unknown>).pid)
    || typeof (owner as Record<string, unknown>).authorityInstanceId !== 'string' || !(owner as Record<string, unknown>).authorityInstanceId
    || typeof (owner as Record<string, unknown>).acquiredAt !== 'string' || !(owner as Record<string, unknown>).acquiredAt) {
    throw malformedState();
  }
  return owner as MaintenanceOwner;
};

const assertDocument = (value: unknown, hostId: string): { document: MutationDocument; migrated: boolean } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformedState();
  const v = value as Record<string, unknown>;
  if (![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(v.schemaVersion as number)
    || v.hostId !== hostId
    || !v.workspaces
    || typeof v.workspaces !== 'object'
    || Array.isArray(v.workspaces)) {
    throw malformedState();
  }

  const doc = v as unknown as MutationDocument;
  for (const [workspaceId, entry] of Object.entries(doc.workspaces)) {
    if (!workspaceId || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !positiveInteger(entry.epoch)
      || !positiveInteger(entry.mutationRevision)
      || typeof entry.maintenance !== 'boolean'
      || !positiveInteger(entry.writerRevision)
      || !entry.activeWriters
      || typeof entry.activeWriters !== 'object'
      || Array.isArray(entry.activeWriters)) {
      throw malformedState();
    }
    for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
      if (!writerId || !writer || typeof writer !== 'object' || Array.isArray(writer)
        || writer.writerId !== writerId
        || !positiveInteger(writer.pid)
        || typeof writer.authorityInstanceId !== 'string' || !writer.authorityInstanceId
        || !positiveInteger(writer.epoch)
        || !WRITER_MODES.has(writer.mode)
        || typeof writer.purpose !== 'string' || !writer.purpose
        || typeof writer.startedAt !== 'string' || !writer.startedAt) {
        throw malformedState();
      }
      assertStoredOwner(writer.owner);
    }
    if (doc.schemaVersion === SCHEMA_VERSION) {
      if (entry.maintenance) assertMaintenanceOwner(entry.maintenanceOwner);
      else if (entry.maintenanceOwner !== null) throw malformedState();
    }
  }
  const migrated = doc.schemaVersion === LEGACY_SCHEMA_VERSION;
  if (migrated) {
    doc.schemaVersion = SCHEMA_VERSION;
    for (const entry of Object.values(doc.workspaces)) {
      if (entry.maintenance) entry.writerRevision += 1;
      entry.maintenance = false;
      entry.maintenanceOwner = null;
    }
  }
  return { document: doc, migrated };
};

const processMayBeAlive = (processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>, pid: number): boolean => {
  if (pid === processLike.pid) return true;
  if (typeof processLike.kill !== 'function') return true;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
};

const writerMayBeAlive = (processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>, writer: ActiveWriter): boolean => {
  if (writer.pid === processLike.pid) {
    return liveAuthorityInstances.has(writer.authorityInstanceId);
  }
  return processMayBeAlive(processLike, writer.pid);
};

const cleanDeadWriters = (entry: WorkspaceMutationEntry, processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>): boolean => {
  let removed = false;
  for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
    if (writerMayBeAlive(processLike, writer)) continue;
    delete entry.activeWriters[writerId];
    removed = true;
  }
  if (removed) entry.writerRevision += 1;
  return removed;
};

const cleanDeadMaintenance = (entry: WorkspaceMutationEntry, processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>): boolean => {
  if (!entry.maintenance) {
    if (entry.maintenanceOwner === null) return false;
    entry.maintenanceOwner = null;
    return true;
  }
  if (entry.maintenanceOwner && writerMayBeAlive(processLike, entry.maintenanceOwner as unknown as ActiveWriter)) return false;
  entry.maintenance = false;
  entry.maintenanceOwner = null;
  entry.writerRevision += 1;
  return true;
};

const durableWitness = (entry: WorkspaceMutationEntry) => ({
  epoch: entry.epoch,
  maintenance: entry.maintenance,
  mutationRevision: entry.mutationRevision,
  writerRevision: entry.writerRevision,
});

const sameWorkspaceContentWitness = (
  left: { epoch: number; mutationRevision: number } | null,
  right: { epoch: number; mutationRevision: number },
): boolean => left !== null
  && left.epoch === right.epoch
  && left.mutationRevision === right.mutationRevision;

const publicState = (runtime: WorkspaceRuntime, entry: WorkspaceMutationEntry) => ({
  workspaceId: runtime.workspaceId,
  epoch: entry.epoch,
  mutationRevision: entry.mutationRevision,
  maintenance: entry.maintenance,
  reconciliationRequired: runtime.reconciliationRequired,
  writerRevision: entry.writerRevision,
  activeWriters: Object.values(entry.activeWriters)
    .sort((left, right) => left.writerId.localeCompare(right.writerId))
    .map((writer) => ({
      writerId: writer.writerId,
      epoch: writer.epoch,
      mode: writer.mode,
      owner: { ...writer.owner },
      purpose: writer.purpose,
      startedAt: writer.startedAt,
    })),
  watch: runtime.watch ? { ...runtime.watch } : null,
});

// ── Factory ──────────────────────────────────────────────────────────────

export const createWorkspaceMutationAuthority = ({
  dataDir,
  hostId,
  fsModule,
  fsPromises,
  pathModule = path,
  processLike = process,
}: WorkspaceMutationAuthorityOptions) => {
  const store = createSettingsFileStore({
    filePath: pathModule.join(dataDir, 'documents', 'mutation-authority.json'),
    defaultValue: {
      schemaVersion: SCHEMA_VERSION,
      hostId,
      workspaces: {},
    },
    ...(fsModule !== undefined ? { fsModule: fsModule as never } : {}),
    ...(fsPromises !== undefined ? { fsPromises: fsPromises as never } : {}),
    pathModule,
    processLike,
  });
  const authorityInstanceId = randomUUID();
  const runtimes = new Map<string, WorkspaceRuntime>();
  const queues = new Map<string, Promise<unknown>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  liveAuthorityInstances.add(authorityInstanceId);

  const ownsMaintenance = (entry: WorkspaceMutationEntry): boolean => entry.maintenanceOwner?.authorityInstanceId === authorityInstanceId
    && entry.maintenanceOwner.pid === processLike.pid;
  const maintenanceOwner = (): MaintenanceOwner => ({
    acquiredAt: new Date().toISOString(),
    authorityInstanceId,
    pid: processLike.pid,
  });
  const maintenanceConflict = (entry: WorkspaceMutationEntry): DocumentAuthorityError => new DocumentAuthorityError(
    'Workspace maintenance is owned by another live Host process',
    { code: 'maintenance', statusCode: 409, currentEpoch: entry.epoch },
  );

  const assertAvailable = (): void => {
    if (disposed) {
      throw new DocumentAuthorityError('Workspace mutation authority is disposed', {
        code: 'failed',
        statusCode: 500,
      });
    }
  };

  const ensureRuntime = (workspaceId: string): WorkspaceRuntime => {
    let runtime = runtimes.get(workspaceId);
    if (!runtime) {
      runtime = {
        workspaceId,
        reconciliationRequired: true,
        watch: null,
        watchRevision: 1,
        lastDurableWitness: null,
      };
      runtimes.set(workspaceId, runtime);
    }
    return runtime;
  };

  const syncRuntime = (runtime: WorkspaceRuntime, entry: WorkspaceMutationEntry): void => {
    const next = durableWitness(entry);
    if (runtime.lastDurableWitness && !sameWorkspaceContentWitness(runtime.lastDurableWitness, next)) {
      runtime.reconciliationRequired = true;
    }
    runtime.lastDurableWitness = next;
  };

  const mutateWorkspace = (
    workspaceId: string,
    operation: (entry: WorkspaceMutationEntry) => MutationOperationResult | void = () => ({ changed: false }),
  ) => store.transact((raw) => {
    const normalized = assertDocument(raw, hostId);
    const { document } = normalized;
    let changed = normalized.migrated;
    let entry = document.workspaces[workspaceId];
    if (!entry) {
      entry = defaultEntry();
      document.workspaces[workspaceId] = entry;
      changed = true;
    }
    if (cleanDeadWriters(entry, processLike)) changed = true;
    if (cleanDeadMaintenance(entry, processLike)) changed = true;
    const outcome = operation(entry) ?? {};
    changed ||= outcome.changed === true;
    return {
      document: document as unknown as Record<string, unknown>,
      result: {
        entry: structuredClone(entry),
        value: outcome.result,
      },
      write: changed,
    };
  });

  const run = <Result>(workspaceId: string, operation: (runtime: WorkspaceRuntime) => Promise<Result>): Promise<Result> => {
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return Promise.reject(new DocumentAuthorityError('workspaceId is required', { code: 'failed', statusCode: 400 }));
    }
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      assertAvailable();
      return operation(ensureRuntime(workspaceId));
    });
    queues.set(workspaceId, current);
    void current.finally(() => {
      if (queues.get(workspaceId) === current) queues.delete(workspaceId);
    }).catch(() => undefined);
    return current as Promise<Result>;
  };

  const validateTokenShape = (workspaceId: string, token: unknown): MutationOwner => {
    if (!token || typeof token !== 'object' || Array.isArray(token)
      || (token as Record<string, unknown>).workspaceId !== workspaceId
      || !positiveInteger((token as Record<string, unknown>).epoch)) {
      throw new DocumentAuthorityError('Workspace mutation token is malformed', { code: 'failed', statusCode: 400 });
    }
    return assertOwner((token as Record<string, unknown>).owner);
  };

  const validateAdmission = (entry: WorkspaceMutationEntry, token: MutationToken): void => {
    if (token.epoch !== entry.epoch) {
      throw new DocumentAuthorityError('Workspace mutation epoch is stale', {
        code: 'stale-epoch',
        statusCode: 409,
        currentEpoch: entry.epoch,
      });
    }
    if (entry.maintenance) {
      throw new DocumentAuthorityError('Workspace is in maintenance mode', {
        code: 'maintenance',
        statusCode: 409,
        currentEpoch: entry.epoch,
      });
    }
  };

  const inspect = (workspaceId: string) => run(workspaceId, async (runtime) => {
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return publicState(runtime, entry);
  });

  const registerWriter = (token: MutationToken | undefined, options: RegisterWriterOptions = {}) => run(token?.workspaceId ?? '', async (runtime) => {
    const owner = validateTokenShape(runtime.workspaceId, token);
    const writerId = randomUUID();
    const writer: ActiveWriter = {
      writerId,
      pid: processLike.pid,
      authorityInstanceId,
      epoch: token!.epoch,
      mode: options.mode && WRITER_MODES.has(options.mode) ? options.mode : 'controlled',
      owner,
      purpose: typeof options.purpose === 'string' && options.purpose ? options.purpose : 'workspace-mutation',
      startedAt: new Date().toISOString(),
    };
    const { entry } = await mutateWorkspace(runtime.workspaceId, (current) => {
      validateAdmission(current, token!);
      current.activeWriters[writerId] = writer;
      current.writerRevision += 1;
      return { changed: true };
    });
    syncRuntime(runtime, entry);
    let closed = false;
    let mutationRecorded = false;
    return {
      writerId,
      owner,
      async markMutated() {
        if (closed || mutationRecorded) return;
        const recorded = await run(runtime.workspaceId, async (currentRuntime) => {
          const transaction = await mutateWorkspace(runtime.workspaceId, (current) => {
            if (!current.activeWriters[writerId]) return { changed: false, result: false };
            current.mutationRevision += 1;
            return { changed: true, result: true };
          });
          syncRuntime(currentRuntime, transaction.entry);
          return transaction.value;
        });
        if (recorded) mutationRecorded = true;
      },
      async close() {
        if (closed) return;
        await run(runtime.workspaceId, async (currentRuntime) => {
          const transaction = await mutateWorkspace(runtime.workspaceId, (current) => {
            if (!current.activeWriters[writerId]) return { changed: false };
            delete current.activeWriters[writerId];
            current.writerRevision += 1;
            return { changed: true };
          });
          syncRuntime(currentRuntime, transaction.entry);
        });
        closed = true;
      },
    };
  });

  const observeWatchEvent = (workspaceId: string, event: WatchEvent | unknown) => run(workspaceId, async (runtime) => {
    runtime.reconciliationRequired = true;
    runtime.watchRevision += 1;
    if (!event || typeof event !== 'object'
      || typeof (event as Record<string, unknown>).sourceId !== 'string' || !(event as Record<string, unknown>).sourceId
      || !positiveInteger((event as Record<string, unknown>).generation)
      || !positiveInteger((event as Record<string, unknown>).sequence)) {
      return null;
    }
    const e = event as WatchEvent;
    runtime.watch = {
      sourceId: e.sourceId,
      generation: e.generation,
      sequence: e.sequence,
    };
    return { ...runtime.watch };
  });

  const setWatchBaseline = (workspaceId: string, position: WatchPosition | null) => run(workspaceId, async (runtime) => {
    if (!position || typeof position.sourceId !== 'string' || !position.sourceId
      || !positiveInteger(position.generation)
      || !Number.isSafeInteger(position.sequence)
      || position.sequence < 0) {
      runtime.reconciliationRequired = true;
      runtime.watchRevision += 1;
    } else {
      const authorityChanged = runtime.watch
        && (runtime.watch.sourceId !== position.sourceId || runtime.watch.generation !== position.generation);
      const positionChanged = !runtime.watch
        || runtime.watch.sourceId !== position.sourceId
        || runtime.watch.generation !== position.generation
        || runtime.watch.sequence !== position.sequence;
      runtime.watch = { ...position };
      if (positionChanged) runtime.watchRevision += 1;
      if (authorityChanged) runtime.reconciliationRequired = true;
    }
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return publicState(runtime, entry);
  });

  const beginCapture = (workspaceId: string, options: { allowMaintenance?: boolean; ignoredWriterIds?: readonly string[] } = {}) => run(workspaceId, async (runtime) => {
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return {
      captureId: randomUUID(),
      workspaceId,
      epoch: entry.epoch,
      mutationRevision: entry.mutationRevision,
      writerRevision: entry.writerRevision,
      activeWriterIds: Object.keys(entry.activeWriters).sort(),
      ...(options.ignoredWriterIds?.length ? { ignoredWriterIds: [...options.ignoredWriterIds] } : {}),
      allowMaintenance: options.allowMaintenance === true,
      maintenance: entry.maintenance,
      watchRevision: runtime.watchRevision,
      watch: runtime.watch ? { ...runtime.watch } : null,
    };
  });

  const completeCapture = (capture: CaptureToken | undefined) => run(capture?.workspaceId ?? '', async (runtime) => {
    if (!capture || typeof capture.captureId !== 'string' || !capture.captureId
      || !Array.isArray(capture.activeWriterIds)) {
      throw new DocumentAuthorityError('Workspace capture token is malformed', { code: 'failed', statusCode: 400 });
    }
    const { entry } = await mutateWorkspace(runtime.workspaceId);
    syncRuntime(runtime, entry);
    const reasons: string[] = [];
    if (capture.epoch !== entry.epoch) reasons.push('epoch-changed');
    if (capture.mutationRevision !== entry.mutationRevision) reasons.push('mutation-observed');
    if (capture.writerRevision !== entry.writerRevision) reasons.push('writer-activity');
    if ((capture.maintenance || entry.maintenance) && capture.allowMaintenance !== true) reasons.push('maintenance');
    const ignored = new Set(capture.ignoredWriterIds ?? []);
    if (capture.activeWriterIds.some(id => !ignored.has(id))
      || Object.keys(entry.activeWriters).some(id => !ignored.has(id))) reasons.push('active-writer');
    const beforeWatch = capture.watch;
    const afterWatch = runtime.watch;
    if (beforeWatch?.sourceId !== afterWatch?.sourceId) reasons.push('watch-source-changed');
    else if (beforeWatch?.generation !== afterWatch?.generation) reasons.push('watch-generation-changed');
    else if (beforeWatch?.sequence !== afterWatch?.sequence || capture.watchRevision !== runtime.watchRevision) {
      reasons.push('watch-sequence-changed');
    }
    const stable = reasons.length === 0;
    if (stable) runtime.reconciliationRequired = false;
    return {
      captureId: capture.captureId,
      workspaceId: runtime.workspaceId,
      stable,
      reasons,
      state: publicState(runtime, entry),
    };
  });

  const advanceEpoch = (workspaceId: string, options: AdvanceEpochOptions = {}) => run(workspaceId, async (runtime) => {
    const transaction = await mutateWorkspace(workspaceId, (entry) => {
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== entry.epoch) {
        throw new DocumentAuthorityError('Workspace mutation epoch is stale', {
          code: 'stale-epoch',
          statusCode: 409,
          currentEpoch: entry.epoch,
        });
      }
      if (Object.keys(entry.activeWriters).length > 0) {
        throw new DocumentAuthorityError('Workspace has active controlled writers', {
          code: 'active-writer',
          statusCode: 409,
          currentEpoch: entry.epoch,
        });
      }
      if (entry.maintenance && !ownsMaintenance(entry)) throw maintenanceConflict(entry);
      entry.epoch += 1;
      entry.mutationRevision += 1;
      entry.writerRevision += 1;
      entry.maintenance = options.maintenance !== false;
      entry.maintenanceOwner = entry.maintenance
        ? (ownsMaintenance(entry) ? entry.maintenanceOwner : maintenanceOwner())
        : null;
      return { changed: true };
    });
    syncRuntime(runtime, transaction.entry);
    runtime.reconciliationRequired = true;
    return publicState(runtime, transaction.entry);
  });

  const setMaintenance = (workspaceId: string, enabled: unknown) => run(workspaceId, async (runtime) => {
    const next = Boolean(enabled);
    const transaction = await mutateWorkspace(workspaceId, (entry) => {
      if (entry.maintenance === next) {
        if (!next || ownsMaintenance(entry)) return { changed: false };
        throw maintenanceConflict(entry);
      }
      if (!next && !ownsMaintenance(entry)) throw maintenanceConflict(entry);
      entry.maintenance = next;
      entry.maintenanceOwner = next ? maintenanceOwner() : null;
      entry.writerRevision += 1;
      return { changed: true };
    });
    syncRuntime(runtime, transaction.entry);
    return publicState(runtime, transaction.entry);
  });

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      await Promise.allSettled([...queues.values()]);
      await store.transact((raw) => {
        const normalized = assertDocument(raw, hostId);
        const { document } = normalized;
        let changed = normalized.migrated;
        for (const entry of Object.values(document.workspaces)) {
          let removed = false;
          for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
            if (writer.pid !== processLike.pid || writer.authorityInstanceId !== authorityInstanceId) continue;
            delete entry.activeWriters[writerId];
            removed = true;
          }
          if (entry.maintenanceOwner?.authorityInstanceId === authorityInstanceId) {
            entry.maintenance = false;
            entry.maintenanceOwner = null;
            removed = true;
          }
          if (removed) {
            entry.writerRevision += 1;
            changed = true;
          }
        }
        return { document: document as unknown as Record<string, unknown>, result: undefined, write: changed };
      });
      liveAuthorityInstances.delete(authorityInstanceId);
      runtimes.clear();
    })();
    return disposePromise;
  };

  return {
    inspect,
    registerWriter,
    observeWatchEvent,
    setWatchBaseline,
    beginCapture,
    completeCapture,
    advanceEpoch,
    setMaintenance,
    dispose,
  };
};

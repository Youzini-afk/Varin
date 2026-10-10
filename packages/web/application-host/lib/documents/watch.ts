import { randomUUID } from 'node:crypto';
import type { WatchOptions } from 'node:fs';
import type path from 'node:path';

interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

export interface WatchEvent {
  sourceId: string;
  generation: number;
  kind: string;
  sequence: number;
  resource?: DocumentResource;
  reason?: string;
}

export interface WatchPosition {
  sourceId: string;
  generation: number;
  sequence: number;
}

export interface WorkspaceWatcher {
  readonly sourceId: string;
  readonly generation: number;
  readonly position: WatchPosition;
  overflow(): void;
  reconnect(): void;
  authorityChanged(): void;
  settle(): Promise<void>;
  close(): void;
}

export interface NativeWatcher {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface WorkspaceWatchFs {
  watch(
    rootPath: string,
    options: WatchOptions,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ): NativeWatcher;
}

export interface WorkspaceWatchFsPromises {
  stat(filePath: string): Promise<Pick<import('node:fs').Stats, 'isFile'>>;
}

export interface WorkspaceWatcherOptions {
  workspaceId: string;
  rootPath: string;
  fsModule: WorkspaceWatchFs;
  fsPromises: WorkspaceWatchFsPromises;
  pathModule: typeof path;
  overflowLimit?: number;
  onEvent: (event: WatchEvent) => void;
  sourceId?: string;
}

const toResource = (workspaceId: string, relativePath: string): DocumentResource => ({
  workspaceId,
  resourceId: relativePath.replace(/\\/g, '/'),
});

const mergeEventType = (previous: string, next: string): string => (
  previous === 'rename' || next === 'rename' ? 'rename' : 'change'
);

/**
 * Translate the host filesystem watch into invalidation events. File bodies and
 * revisions deliberately stay out of this path: consumers re-read through the
 * document authority, which is the only component allowed to establish a new
 * authoritative revision.
 */
export const createWorkspaceWatcher = ({
  workspaceId,
  rootPath,
  fsModule,
  fsPromises,
  pathModule,
  overflowLimit,
  onEvent,
  sourceId = randomUUID(),
}: WorkspaceWatcherOptions): WorkspaceWatcher => {
  let sequence = 0;
  let generation = 1;
  let closed = false;
  let watcher: ReturnType<typeof fsModule.watch> | null = null;
  let reconnectScheduled = false;
  let batch = new Map<string, string>();
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain: Promise<unknown> = Promise.resolve();

  const nextSequence = (): number => {
    sequence += 1;
    return sequence;
  };

  const relativeFrom = (absolutePath: string): string | null => {
    const relative = pathModule.relative(rootPath, absolutePath).replace(/\\/g, '/');
    if (!relative || relative === '.' || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const emit = (event: Omit<WatchEvent, 'sourceId' | 'generation'>): void => {
    if (closed) return;
    onEvent({ sourceId, generation, ...event });
  };

  const reset = (reason: string): void => {
    batch.clear();
    generation += 1;
    sequence = 0;
    emit({ kind: 'reset', sequence: nextSequence(), reason });
  };

  const flushBatch = async (): Promise<void> => {
    const current = batch;
    const capturedGeneration = generation;
    batch = new Map();
    if (current.size === 0 || closed) return;

    for (const [absolutePath, eventType] of current) {
      const resourceId = relativeFrom(absolutePath);
      if (!resourceId) continue;
      const resource = toResource(workspaceId, resourceId);
      let stat: Awaited<ReturnType<WorkspaceWatchFsPromises['stat']>> | null = null;
      try {
        stat = await fsPromises.stat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      if (closed || capturedGeneration !== generation) return;

      if (!stat) {
        emit({ kind: 'deleted', sequence: nextSequence(), resource });
      } else if (stat.isFile()) {
        emit({
          kind: eventType === 'rename' ? 'created' : 'changed',
          sequence: nextSequence(),
          resource,
        });
      } else {
        // A directory can arrive atomically with descendants. Preserve the entry
        // invalidation so exact-path observers can recheck descendants through
        // their resource owner; this is not a claim about any file's content.
        emit({ kind: 'invalidated', sequence: nextSequence(), resource, reason: 'entry-changed' });
      }
    }
  };

  const reportBatchFailure = (): void => {
    if (closed) return;
    reset('authority-changed');
  };

  const scheduleFlush = (): void => {
    if (batchTimer || closed) return;
    batchTimer = setTimeout(() => {
      batchTimer = null;
      flushChain = flushChain.then(flushBatch, flushBatch).catch(reportBatchFailure);
    }, 20);
  };

  const settle = async (): Promise<void> => {
    if (closed) return;
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = null;
    flushChain = flushChain.then(flushBatch, flushBatch).catch(reportBatchFailure);
    await flushChain;
  };

  const queuePath = (eventType: string, filename: string): void => {
    if (closed) return;
    if (!filename) {
      reset('authority-changed');
      return;
    }
    const absolutePath = pathModule.resolve(rootPath, filename);
    const previous = batch.get(absolutePath);
    batch.set(absolutePath, previous ? mergeEventType(previous, eventType) : eventType);
    if (overflowLimit !== undefined && Number.isSafeInteger(overflowLimit) && overflowLimit > 0 && batch.size > overflowLimit) {
      reset('overflow');
      return;
    }
    scheduleFlush();
  };

  const start = (): void => {
    watcher = fsModule.watch(rootPath, { recursive: true, persistent: false } as WatchOptions, (eventType, filename) => {
      queuePath(eventType === 'rename' ? 'rename' : 'change', typeof filename === 'string' ? filename : '');
    });
    watcher.on('error', () => {
      if (closed || reconnectScheduled) return;
      reconnectScheduled = true;
      watcher?.close();
      watcher = null;
      setTimeout(() => {
        reconnectScheduled = false;
        if (closed) return;
        try {
          start();
          reset('reconnected');
        } catch {
          reset('authority-changed');
        }
      }, 0);
    });
  };

  start();

  return {
    get sourceId() {
      return sourceId;
    },
    get generation() {
      return generation;
    },
    get position() {
      return { sourceId, generation, sequence };
    },
    overflow() {
      reset('overflow');
    },
    reconnect() {
      watcher?.close();
      watcher = null;
      start();
      reset('reconnected');
    },
    authorityChanged() {
      reset('authority-changed');
    },
    settle,
    close() {
      closed = true;
      if (batchTimer) clearTimeout(batchTimer);
      batchTimer = null;
      batch.clear();
      watcher?.close();
      watcher = null;
    },
  };
};

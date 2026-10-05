import type { Thread, ThreadOccupancy, ThreadParent, ThreadRun, WorkspaceThreadSpace } from '@varin/protocol';

export interface HarnessThreadSnapshot {
  thread: Thread;
  activeRun: ThreadRun | null;
}

export interface HarnessThreadProjection {
  workspaceId: string;
  parent: ThreadParent;
  includeArchived: boolean;
  threads: HarnessThreadSnapshot[];
  researchRoot: HarnessThreadSnapshot | null;
  researchBranches: HarnessThreadSnapshot[];
}

export type HarnessThreadState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'stalled'
  | 'looping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'dirty'
  | 'merge-ready'
  | 'conflict'
  | 'merged'
  | 'archived';

export const projectHarnessThreadState = ({ thread, activeRun }: HarnessThreadSnapshot): HarnessThreadState => {
  if (thread.lifecycle === 'archived') return 'archived';
  if (thread.integration === 'merged') return 'merged';
  if (thread.integration === 'conflict') return 'conflict';
  if (thread.lifecycle === 'queued') return 'queued';
  if (thread.attention === 'user' || thread.attention === 'permission') return 'waiting';
  if (thread.attention === 'stalled') return 'stalled';
  if (thread.attention === 'looping') return 'looping';
  if (thread.lifecycle === 'settled') {
    if (activeRun?.outcome === 'failure') return 'failed';
    if (activeRun?.outcome === 'cancelled') return 'cancelled';
    if (activeRun?.outcome === 'lost') return 'interrupted';
    if (thread.integration === 'merge-ready') return 'merge-ready';
    if (thread.integration === 'dirty') return 'dirty';
    return 'completed';
  }
  if (activeRun?.workerState === 'lost') return 'interrupted';
  if (activeRun?.workerState === 'starting') return 'starting';
  return 'running';
};

export const sameHarnessThreadParent = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

export const harnessThreadSessionId = (entry: HarnessThreadSnapshot): string | undefined => (
  entry.activeRun?.sessionId ?? entry.thread.report?.transcriptRef.sessionId
);

export const harnessThreadTitle = (entry: HarnessThreadSnapshot): string => (
  entry.thread.brief.trim().split(/\r?\n/)[0] || entry.thread.preset || entry.thread.id
);

export const isEndedHarnessThread = (entry: HarnessThreadSnapshot): boolean => (
  ['completed', 'cancelled', 'merged', 'archived'].includes(projectHarnessThreadState(entry))
);

export const mergeHarnessThreadSnapshot = (
  current: HarnessThreadSnapshot[],
  incoming: HarnessThreadSnapshot,
  options?: { includeArchived?: boolean },
): HarnessThreadSnapshot[] => {
  const existing = current.find((entry) => entry.thread.id === incoming.thread.id);
  if (existing && existing.thread.eventSeq > incoming.thread.eventSeq) return current;
  const next = current.filter((entry) => entry.thread.id !== incoming.thread.id);
  const keepArchived = options?.includeArchived === true || incoming.thread.lifecycle !== 'archived';
  if (!incoming.thread.hidden && keepArchived) next.push(incoming);
  return next.sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
};

export const harnessThreadsAtEntry = (
  threads: readonly HarnessThreadSnapshot[],
  entryId: string,
): HarnessThreadSnapshot[] => threads.filter(({ thread }) => thread.forkPoint?.entryId === entryId);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseParent = (value: unknown): ThreadParent => {
  if (
    !isRecord(value)
    || (value.kind !== 'session' && value.kind !== 'thread')
    || typeof value.id !== 'string'
  ) throw new Error('Malformed thread parent');
  return value as unknown as ThreadParent;
};

const parseSnapshot = (value: unknown): HarnessThreadSnapshot => {
  if (!isRecord(value) || !isRecord(value.thread)) throw new Error('Malformed thread snapshot');
  const thread = value.thread;
  if (
    typeof thread.id !== 'string'
    || typeof thread.workspaceId !== 'string'
    || typeof thread.eventSeq !== 'number'
    || (thread.kind !== 'discussion' && thread.kind !== 'implementation')
    || !isRecord(thread.manifest)
    || !Array.isArray(thread.manifest.tools)
    || !thread.manifest.tools.every((tool) => typeof tool === 'string')
    || !Array.isArray(thread.manifest.scope)
    || !thread.manifest.scope.every((scope) => typeof scope === 'string')
  ) throw new Error('Malformed thread record');
  parseParent(thread.parent);
  if (
    value.activeRun !== null
    && (
      !isRecord(value.activeRun)
      || typeof value.activeRun.id !== 'string'
      || (value.activeRun.sessionId !== null && typeof value.activeRun.sessionId !== 'string')
    )
  ) throw new Error('Malformed thread run');
  return { thread: thread as unknown as Thread, activeRun: value.activeRun as ThreadRun | null };
};

export const parseHarnessThreadProjection = (
  value: unknown,
  options?: { includeArchived?: boolean },
): HarnessThreadProjection => {
  if (!isRecord(value) || typeof value.workspaceId !== 'string' || !Array.isArray(value.threads)) {
    throw new Error('Malformed thread list response');
  }
  const includeArchived = options?.includeArchived === true || value.includeArchived === true;
  const researchRoot = value.researchRoot == null ? null : parseSnapshot(value.researchRoot);
  if (value.researchBranches !== undefined && !Array.isArray(value.researchBranches)) {
    throw new Error('Malformed research branch list');
  }
  const researchBranches = (Array.isArray(value.researchBranches) ? value.researchBranches : []).map(parseSnapshot);
  if (researchBranches.some(({ thread }) => (
    !researchRoot || thread.workspaceId !== value.workspaceId
      || thread.parent.kind !== 'thread' || thread.parent.id !== researchRoot.thread.id
  ))) throw new Error('Research branches do not belong to the reported root');
  return {
    workspaceId: value.workspaceId,
    parent: parseParent(value.parent),
    includeArchived,
    researchRoot,
    researchBranches: researchBranches.filter((item) => (
      !item.thread.hidden && (includeArchived || item.thread.lifecycle !== 'archived')
    )),
    threads: value.threads.map(parseSnapshot).filter((item) => (
      !item.thread.hidden && (includeArchived || item.thread.lifecycle !== 'archived')
    )),
  };
};

const parseMeasurement = (value: unknown): { logicalBytes: number | null; allocatedBytes: number | null; unknown: boolean } => {
  if (!isRecord(value) || typeof value.unknown !== 'boolean') throw new Error('Malformed space measurement');
  const logical = value.logicalBytes;
  const allocated = value.allocatedBytes;
  if (logical !== null && typeof logical !== 'number') throw new Error('Malformed space measurement');
  if (allocated !== null && typeof allocated !== 'number') throw new Error('Malformed space measurement');
  return {
    logicalBytes: logical === null ? null : logical,
    allocatedBytes: allocated === null ? null : allocated,
    unknown: value.unknown,
  };
};

export const parseHarnessThreadSpace = (value: unknown): WorkspaceThreadSpace => {
  if (
    !isRecord(value)
    || typeof value.workspaceId !== 'string'
    || !Array.isArray(value.threads)
    || typeof value.uniqueObjectUnknown !== 'boolean'
    || typeof value.note !== 'string'
    || (value.status !== 'ok'
      && value.status !== 'over-budget'
      && value.status !== 'low-free'
      && value.status !== 'enospc'
      && value.status !== 'unknown')
  ) {
    throw new Error('Malformed thread space response');
  }
  const uniqueLogical = value.uniqueObjectLogicalBytes;
  const materializedLogical = value.materializedLogicalBytes;
  const freeBytes = value.freeBytes;
  if (uniqueLogical !== null && typeof uniqueLogical !== 'number') throw new Error('Malformed thread space response');
  if (materializedLogical !== null && typeof materializedLogical !== 'number') throw new Error('Malformed thread space response');
  if (freeBytes !== null && typeof freeBytes !== 'number') throw new Error('Malformed thread space response');
  return {
    workspaceId: value.workspaceId,
    uniqueObjectLogicalBytes: uniqueLogical === null ? null : uniqueLogical,
    uniqueObjectUnknown: value.uniqueObjectUnknown,
    materializedLogicalBytes: materializedLogical === null ? null : materializedLogical,
    freeBytes: freeBytes === null ? null : freeBytes,
    status: value.status,
    note: value.note,
    threads: value.threads.map((entry): ThreadOccupancy => {
      if (
        !isRecord(entry)
        || typeof entry.threadId !== 'string'
        || typeof entry.reclaimable !== 'boolean'
        || !Array.isArray(entry.keepReasons)
        || !entry.keepReasons.every((reason) => typeof reason === 'string')
      ) throw new Error('Malformed thread occupancy');
      const reclaimableLogical = entry.reclaimableLogicalBytes;
      if (reclaimableLogical !== null && typeof reclaimableLogical !== 'number') {
        throw new Error('Malformed thread occupancy');
      }
      return {
        threadId: entry.threadId,
        materialized: parseMeasurement(entry.materialized),
        exclusiveObjects: parseMeasurement(entry.exclusiveObjects),
        sharedObjects: parseMeasurement(entry.sharedObjects),
        reclaimable: entry.reclaimable,
        reclaimableLogicalBytes: reclaimableLogical === null ? null : reclaimableLogical,
        keepReasons: entry.keepReasons,
      };
    }),
    ...(isRecord(value.budget) ? {
      budget: {
        ...(typeof value.budget.maxBytes === 'number' ? { maxBytes: value.budget.maxBytes } : {}),
        ...(typeof value.budget.minFreeRatio === 'number' ? { minFreeRatio: value.budget.minFreeRatio } : {}),
      },
    } : {}),
  };
};

export const parseHarnessThreadList = (value: unknown): HarnessThreadSnapshot[] => (
  parseHarnessThreadProjection(value).threads
);

export const parseHarnessThreadMutation = (value: unknown): HarnessThreadProjection & HarnessThreadSnapshot => {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') throw new Error('Malformed thread mutation response');
  const snapshot = parseSnapshot(value);
  return {
    workspaceId: value.workspaceId,
    parent: parseParent(value.parent),
    includeArchived: isRecord(value.thread) && value.thread.lifecycle === 'archived',
    threads: [snapshot],
    researchRoot: null,
    researchBranches: [],
    ...snapshot,
  };
};

import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_DELETE_KEEP_RECENT = 5;
const AUTO_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const sessionActivityTime = (session: ThreadSummary): number => {
  return session.updated_at_ms;
};

export interface BuildThreadCleanupCandidatesOptions {
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
  sessions: readonly ThreadSummary[];
}

export const buildThreadCleanupCandidates = ({
  currentSessionId,
  cutoffDays,
  keepRecent = AUTO_DELETE_KEEP_RECENT,
  now = Date.now(),
  sessions,
}: BuildThreadCleanupCandidatesOptions): string[] => {
  if (cutoffDays <= 0) return [];
  const cutoffTime = now - cutoffDays * DAY_MS;
  const sorted = [...sessions]
    .filter((session) => !session.archived && !session.bot_id && session.deleted_at_ms === null)
    .sort((left, right) => sessionActivityTime(right) - sessionActivityTime(left));
  const protectedIds = new Set(
    sorted.slice(0, Math.max(0, keepRecent)).map((session) => session.thread_id),
  );
  return sorted
    .filter((session) => (
      Boolean(session.thread_id)
      && session.thread_id !== currentSessionId
      && !session.pinned
      && !session.branches.some(branch => branch.active_run_id !== null)
      && !protectedIds.has(session.thread_id)
      && sessionActivityTime(session) > 0
      && sessionActivityTime(session) < cutoffTime
    ))
    .map((session) => session.thread_id);
};

export interface ThreadCleanupResult {
  action: 'archive' | 'delete';
  completedIds: string[];
  failedIds: string[];
  skippedReason?: 'disabled' | 'loading' | 'cooldown' | 'no-candidates' | 'running' | 'host-changed';
}

interface ThreadCleanupOptions {
  autoRun?: boolean;
  enabled?: boolean;
}

export const useThreadAutoCleanup = (enabledOrOptions?: boolean | ThreadCleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean'
    ? enabledOrOptions
    : (options?.enabled ?? true);
  const currentSessionId = useThreadStore((state) => state.selectedIdentity?.threadId ?? null);
  const catalogLoaded = useThreadStore((state) => state.catalogLoaded);
  const catalogLoading = useThreadStore((state) => state.catalogLoading);
  const activeSessions = useThreadStore(state => state.threads);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const setAutoDeleteLastRunAt = useUIStore((state) => state.setAutoDeleteLastRunAt);
  const [isRunning, setIsRunning] = React.useState(false);
  const runningRef = React.useRef(false);
  const needsGlobalCatalog = enabled && (!autoRun || autoDeleteEnabled);

  React.useEffect(() => {
    if (!needsGlobalCatalog || catalogLoading || catalogLoaded) return;
    void useThreadStore.getState().loadCatalog().catch(() => undefined);
  }, [catalogLoaded, catalogLoading, needsGlobalCatalog]);

  const candidates = React.useMemo(() => buildThreadCleanupCandidates({
    currentSessionId,
    cutoffDays: autoDeleteAfterDays,
    sessions: activeSessions,
  }), [activeSessions, autoDeleteAfterDays, currentSessionId]);

  const runCleanup = React.useCallback(async (
    { force = false }: { force?: boolean } = {},
  ): Promise<ThreadCleanupResult> => {
    if (runningRef.current) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'running' };
    }
    if ((!autoDeleteEnabled || autoDeleteAfterDays <= 0) && !force) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'disabled' };
    }
    if (useThreadStore.getState().catalogLoading) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'loading' };
    }
    const now = Date.now();
    if (!force && autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'cooldown' };
    }

    const host = useThreadStore.getState().hostKey;
    const generation = getRuntimeEndpointGeneration();
    const isCurrent = () => host === useThreadStore.getState().hostKey && generation === getRuntimeEndpointGeneration();
    await useThreadStore.getState().loadCatalog();
    if (!isCurrent()) return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'host-changed' };
    const sessions = useThreadStore.getState().threads;
    const candidateIds = buildThreadCleanupCandidates({
      currentSessionId: useThreadStore.getState().selectedIdentity?.threadId ?? null,
      cutoffDays: autoDeleteAfterDays,
      now,
      sessions,
    });
    if (candidateIds.length === 0) {
      setAutoDeleteLastRunAt(now);
      return { action: sessionRetentionAction, completedIds: [], failedIds: [], skippedReason: 'no-candidates' };
    }

    runningRef.current = true;
    setIsRunning(true);
    try {
      const completedIds: string[] = [];
      const failedIds: string[] = [];
      for (const sessionId of candidateIds) {
        if (!isCurrent()) return { action: sessionRetentionAction, completedIds, failedIds, skippedReason: 'host-changed' };
        try {
          const state = useThreadStore.getState();
          if (sessionRetentionAction === 'archive') await state.updateThread(sessionId, { archived: true });
          else await state.deleteThread(sessionId);
          completedIds.push(sessionId);
        } catch {
          failedIds.push(sessionId);
        }
      }
      return { action: sessionRetentionAction, completedIds, failedIds };
    } finally {
      runningRef.current = false;
      setIsRunning(false);
      if (isCurrent()) setAutoDeleteLastRunAt(Date.now());
    }
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    sessionRetentionAction,
    setAutoDeleteLastRunAt,
  ]);

  React.useEffect(() => {
    if (
      !enabled
      || !autoRun
      || !autoDeleteEnabled
      || autoDeleteAfterDays <= 0
      || catalogLoading
      || !catalogLoaded
      || activeSessions.length === 0
    ) return;
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) return;
    void runCleanup();
  }, [
    activeSessions.length,
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    catalogLoaded,
    catalogLoading,
    enabled,
    runCleanup,
  ]);

  return {
    action: sessionRetentionAction,
    candidates,
    isRunning,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    runCleanup,
  };
};

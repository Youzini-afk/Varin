import React from 'react';
import type { ThreadSummary } from '@varin/protocol';
import { isWebRuntime } from '@/lib/desktop';
import { PWA_RECENT_THREADS_STORAGE_KEY } from '@/lib/pwa';
import { useThreadStore } from '@/stores/useThreadStore';

type RecentSessionShortcut = {
  threadId: string;
  branchId: string;
  title: string;
};

type ManifestSyncWindow = Window & {
  __VARIN_UPDATE_PWA_MANIFEST__?: () => void;
};

const MAX_RECENT_SHORTCUTS = 3;

const normalizeRecentTitle = (value: string | undefined, fallback: string): string => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, 48);
};

export const buildThreadRecentShortcuts = (
  sessions: ThreadSummary[],
  currentSessionId: string | null,
): RecentSessionShortcut[] => {
  const activeSessions = sessions.filter((session) => !session.archived && !session.bot_id && session.deleted_at_ms === null);
  const ordered = currentSessionId
    ? [
        ...activeSessions.filter((session) => session.thread_id === currentSessionId),
        ...activeSessions.filter((session) => session.thread_id !== currentSessionId),
      ]
    : activeSessions;

  const shortcuts: RecentSessionShortcut[] = [];
  const seen = new Set<string>();

  for (const session of ordered) {
    const sessionId = typeof session.thread_id === 'string' ? session.thread_id.trim() : '';
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }

    seen.add(sessionId);
    shortcuts.push({
      threadId: sessionId,
      branchId: session.main_branch_id,
      title: normalizeRecentTitle(
        session.title,
        `Conversation ${shortcuts.length + 1}`,
      ),
    });

    if (shortcuts.length >= MAX_RECENT_SHORTCUTS) {
      break;
    }
  }

  return shortcuts;
};

export const usePwaManifestSync = () => {
  const sessions = useThreadStore((state) => state.threads);
  const currentSessionId = useThreadStore((state) => state.selectedIdentity?.threadId ?? null);

  const recentShortcuts = React.useMemo(() => {
    return buildThreadRecentShortcuts(sessions, currentSessionId);
  }, [currentSessionId, sessions]);

  const signature = React.useMemo(() => JSON.stringify(recentShortcuts), [recentShortcuts]);
  const hasRecentShortcuts = recentShortcuts.length > 0;

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime()) {
      return;
    }

    try {
      if (!hasRecentShortcuts) {
        localStorage.removeItem(PWA_RECENT_THREADS_STORAGE_KEY);
      } else {
        localStorage.setItem(PWA_RECENT_THREADS_STORAGE_KEY, signature);
      }
    } catch {
      return;
    }

    const win = window as ManifestSyncWindow;
    win.__VARIN_UPDATE_PWA_MANIFEST__?.();
  }, [hasRecentShortcuts, signature]);
};

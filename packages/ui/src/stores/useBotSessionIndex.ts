import { create } from 'zustand';
import type { SessionSummary } from '@varin/protocol';
import { listBotSessionIds } from '@/lib/botSessionIndexApi';

interface BotSessionIndexState {
  runtimeKey: string | null;
  ids: ReadonlySet<string> | null;
  loading: boolean;
  error: string | null;
}

export const useBotSessionIndex = create<BotSessionIndexState>(() => ({
  runtimeKey: null,
  ids: null,
  loading: false,
  error: null,
}));

let generation = 0;
let pending: { runtimeKey: string; promise: Promise<void> } | null = null;

/** The catalog is authoritative; an unresolved read must not expose Bot chats in ordinary modes. */
export const refreshBotSessionIndex = (runtimeKey: string, force = false): Promise<void> => {
  if (pending?.runtimeKey === runtimeKey) return pending.promise;
  const current = useBotSessionIndex.getState();
  if (!force && current.runtimeKey === runtimeKey && current.ids !== null) return Promise.resolve();
  const requestGeneration = ++generation;
  useBotSessionIndex.setState({ runtimeKey, ids: null, loading: true, error: null });
  const promise = listBotSessionIds().then((sessionIds) => {
    if (requestGeneration !== generation) return;
    useBotSessionIndex.setState({ ids: new Set(sessionIds), loading: false, error: null });
  }).catch((cause: unknown) => {
    if (requestGeneration !== generation) return;
    useBotSessionIndex.setState({ loading: false, error: cause instanceof Error ? cause.message : String(cause) });
  }).finally(() => {
    if (pending?.promise === promise) pending = null;
  });
  pending = { runtimeKey, promise };
  return promise;
};

export const regularPiSessions = (
  sessions: readonly SessionSummary[],
  index: Pick<BotSessionIndexState, 'runtimeKey' | 'ids'>,
  runtimeKey: string,
): SessionSummary[] => index.runtimeKey === runtimeKey && index.ids !== null
  ? sessions.filter((session) => !index.ids!.has(session.id))
  : [];

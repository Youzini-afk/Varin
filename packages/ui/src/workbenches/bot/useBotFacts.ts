import React from 'react';
import { getRuntimeEndpointGeneration, type BotMemoryItem, type ScheduledTask, type ThreadsAPI } from '@varin/application-client';
import { listBotMemory, listBotSchedules } from '@/lib/bots';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import type { BotSessionFeed, BotSessionView } from './botPresentation';

/** A read that has not answered yet, answered, or failed. Failure keeps the last good value visible. */
export type BotRead<T> = { status: 'loading'; value: T | null } | { status: 'ready'; value: T } | { status: 'failed'; value: T | null; error: string };

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const FEED_LIMIT = 40;

function useRead<T>(key: string | null, revision: number, read: (signal: AbortSignal) => Promise<T>): [BotRead<T>, () => void] {
  const [state, setState] = React.useState<{ key: string | null; read: BotRead<T> }>({ key, read: { status: 'loading', value: null } });
  const [retry, setRetry] = React.useReducer((value: number) => value + 1, 0);
  const reader = React.useRef(read);
  reader.current = read;
  React.useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setState(current => current.key === key ? { key, read: current.read.status === 'failed' ? { status: 'loading', value: current.read.value } : current.read } : { key, read: { status: 'loading', value: null } });
    void reader.current(controller.signal).then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setState({ key, read: { status: 'ready', value } });
    }, cause => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setState(current => ({ key, read: { status: 'failed', value: current.key === key ? current.read.value : null, error: message(cause) } }));
    });
    return () => controller.abort();
  }, [key, revision, retry]);
  return [state.key === key ? state.read : { status: 'loading', value: null }, setRetry];
}

/**
 * The panel's reads for one Bot: each conversation's collaboration feed, current memory and
 * the Bot's Calendar tasks. They refresh on the matching Host events and when `revision` moves.
 */
export function useBotFacts({ botId, sessions, threads, revision, enabled }: {
  botId: string | null;
  sessions: readonly BotSessionView[];
  threads: ThreadsAPI | undefined;
  revision: number;
  enabled: boolean;
}) {
  const [memoryRevision, refreshMemory] = React.useReducer((value: number) => value + 1, 0);
  const [scheduleRevision, refreshSchedules] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => enabled && botId ? subscribeVarinEvents(event => {
    if (event.type === 'harness-knowledge-changed' && event.scope === 'bot' && (!event.workspaceId || event.workspaceId === botId)) refreshMemory();
    if (event.type === 'scheduled-task-changed' || (event.type === 'scheduled-task-ran' && event.projectId === `bot:${botId}`)) refreshSchedules();
    if (event.type === 'stream-ready') { refreshMemory(); refreshSchedules(); }
  }) : undefined, [enabled, botId]);

  const sessionKey = sessions.map(session => session.identity.threadId).join('|');
  // Conversations move on every streamed event; their feeds are re-read once activity settles.
  const cursorKey = sessions.map(session => session.thread.activity_cursor).join('|');
  const [feedTick, bumpFeeds] = React.useReducer((value: number) => value + 1, 0);
  const firstCursor = React.useRef(true);
  React.useEffect(() => {
    if (firstCursor.current) { firstCursor.current = false; return undefined; }
    const timer = setTimeout(bumpFeeds, 1200);
    return () => clearTimeout(timer);
  }, [cursorKey]);
  const feedSessions = React.useRef(sessions);
  feedSessions.current = sessions;
  const [feeds, retryFeeds] = useRead<BotSessionFeed[]>(enabled && botId && threads?.messages ? `${botId}\u0000${sessionKey}` : null, revision + feedTick, async signal => {
    const api = threads?.messages;
    if (!api) return [];
    return Promise.all(feedSessions.current.map(async session => ({
      sessionThreadId: session.identity.threadId,
      page: await api.feed(session.identity, { limit: FEED_LIMIT }, signal),
    })));
  });
  const [memory, retryMemory] = useRead<BotMemoryItem[]>(enabled && botId ? botId : null, revision + memoryRevision, signal => listBotMemory(botId!, signal));
  const [tasks, retryTasks] = useRead<ScheduledTask[]>(enabled && botId ? botId : null, revision + scheduleRevision, signal => listBotSchedules(botId!, signal));
  return { feeds, memory, tasks, retryFeeds, retryMemory, retryTasks, refreshMemory, refreshSchedules };
}

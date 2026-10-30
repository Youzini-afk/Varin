import React from 'react';
import { getRuntimeEndpointGeneration, type BotMemoryItem, type BotPresence, type ScheduledTask } from '@varin/application-client';
import type { BotActivityPage } from '@varin/protocol';
import { listBotMemory, listBotSchedules, readBotActivity, readBotPresence } from '@/lib/bots';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import type { BotActivityView } from './botPresentation';

/** A read that has not answered yet, answered, or failed. Failure keeps the last good value visible. */
export type BotRead<T> = { status: 'loading'; value: T | null } | { status: 'ready'; value: T } | { status: 'failed'; value: T | null; error: string };

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** The Host's default page size; "earlier" asks for the same amount again. */
const ACTIVITY_PAGE = 30;
/** Work changes arrive in bursts; the newest page is read again once they settle. */
const ACTIVITY_SETTLE_MS = 600;

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

const participantsOf = (...lists: ReadonlyArray<BotActivityView['participants']>) =>
  [...new Map(lists.flatMap(list => list.map(participant => [participant.threadId, participant] as const))).values()];

/**
 * Put a fresh newest page in front of what is loaded. Page boundaries are original event cursors,
 * so older loaded events stay valid when the fresh page reaches down to them; when more facts
 * arrived than one page holds, the gap cannot be proven empty and only the fresh page is kept.
 */
export function withNewestPage(loaded: BotActivityView | null, page: BotActivityPage): BotActivityView {
  const fresh: BotActivityView = { events: page.events, participants: page.participants, before: page.before };
  const newestLoaded = loaded?.events[0]?.cursor;
  if (!loaded || page.before === null || newestLoaded === undefined || newestLoaded < page.before) return fresh;
  return {
    events: [...page.events, ...loaded.events.filter(event => event.cursor < page.before!)],
    participants: participantsOf(loaded.participants, page.participants),
    before: loaded.before,
  };
}

/** Append an older page below what is loaded. */
export function withEarlierPage(loaded: BotActivityView, page: BotActivityPage): BotActivityView {
  const oldest = loaded.events.at(-1)?.cursor ?? Infinity;
  return {
    events: [...loaded.events, ...page.events.filter(event => event.cursor < oldest)],
    participants: participantsOf(loaded.participants, page.participants),
    before: page.before,
  };
}

type ActivityState = { botId: string | null; read: BotRead<BotActivityView>; earlier: { loading: boolean; error: string | null } };
const IDLE = { loading: false, error: null };

/** The Bot's activity: the newest page, read again after work changes settle, plus earlier pages on request. */
function useBotActivity(botId: string | null, revision: number) {
  const [settled, settle] = React.useReducer((value: number) => value + 1, 0);
  const [retry, retryActivity] = React.useReducer((value: number) => value + 1, 0);
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    const timer = setTimeout(settle, ACTIVITY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [revision]);
  const [state, setState] = React.useState<ActivityState>({ botId, read: { status: 'loading', value: null }, earlier: IDLE });
  React.useEffect(() => {
    if (!botId) return undefined;
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setState(current => current.botId === botId
      ? { ...current, read: current.read.status === 'failed' ? { status: 'loading', value: current.read.value } : current.read }
      : { botId, read: { status: 'loading', value: null }, earlier: IDLE });
    void readBotActivity(botId, { limit: ACTIVITY_PAGE }, controller.signal).then(page => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setState(current => current.botId === botId ? { ...current, read: { status: 'ready', value: withNewestPage(current.read.value, page) } } : current);
    }, (cause: unknown) => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setState(current => current.botId === botId ? { ...current, read: { status: 'failed', value: current.read.value, error: message(cause) } } : current);
    });
    return () => controller.abort();
  }, [botId, settled, retry]);
  const loaded = state.botId === botId ? state.read.value : null;
  const loading = state.botId === botId && state.earlier.loading;
  const loadEarlier = React.useCallback(() => {
    if (!botId || !loaded || loaded.before === null || loading) return;
    const before = loaded.before;
    const host = getRuntimeEndpointGeneration();
    setState(current => current.botId === botId ? { ...current, earlier: { loading: true, error: null } } : current);
    void readBotActivity(botId, { before, limit: ACTIVITY_PAGE }).then(page => {
      if (host !== getRuntimeEndpointGeneration()) return;
      setState(current => {
        if (current.botId !== botId) return current;
        // A newer read that replaced the loaded window makes this page part of a different view.
        const view = current.read.value;
        if (!view || view.before !== before) return { ...current, earlier: IDLE };
        return { ...current, read: { ...current.read, value: withEarlierPage(view, page) }, earlier: IDLE };
      });
    }, (cause: unknown) => {
      if (host === getRuntimeEndpointGeneration()) setState(current => current.botId === botId ? { ...current, earlier: { loading: false, error: message(cause) } } : current);
    });
  }, [botId, loaded, loading]);
  const activity: BotRead<BotActivityView> = state.botId === botId ? state.read : { status: 'loading', value: null };
  return { activity, retryActivity, loadEarlier, earlier: state.botId === botId ? state.earlier : IDLE };
}

/**
 * The panel's reads for one Bot: its activity across all conversations, current memory and the
 * Bot's Calendar tasks. They refresh on the matching Host events and when `revision` moves.
 */
export function useBotFacts({ botId, revision, enabled }: { botId: string | null; revision: number; enabled: boolean }) {
  const [memoryRevision, refreshMemory] = React.useReducer((value: number) => value + 1, 0);
  const [scheduleRevision, refreshSchedules] = React.useReducer((value: number) => value + 1, 0);
  React.useEffect(() => enabled && botId ? subscribeVarinEvents(event => {
    if (event.type === 'harness-knowledge-changed' && event.scope === 'bot' && (!event.workspaceId || event.workspaceId === botId)) refreshMemory();
    if (event.type === 'scheduled-task-changed' || (event.type === 'scheduled-task-ran' && event.projectId === `bot:${botId}`)) refreshSchedules();
    if (event.type === 'stream-ready') { refreshMemory(); refreshSchedules(); }
  }) : undefined, [enabled, botId]);
  const { activity, retryActivity, loadEarlier, earlier } = useBotActivity(enabled ? botId : null, revision);
  const [memory, retryMemory] = useRead<BotMemoryItem[]>(enabled && botId ? botId : null, revision + memoryRevision, signal => listBotMemory(botId!, signal));
  const [tasks, retryTasks] = useRead<ScheduledTask[]>(enabled && botId ? botId : null, revision + scheduleRevision, signal => listBotSchedules(botId!, signal));
  return { activity, memory, tasks, retryActivity, loadEarlier, earlier, retryMemory, retryTasks, refreshMemory, refreshSchedules };
}

/**
 * The Host's presence projection for each listed Bot: read once, then replaced by every
 * `bot-presence` push. A failed read keeps the last projection it had.
 */
export function useBotPresence(botIds: readonly string[], enabled: boolean): ReadonlyMap<string, BotRead<BotPresence>> {
  const [reads, setReads] = React.useState<ReadonlyMap<string, BotRead<BotPresence>>>(new Map());
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const key = botIds.join('\u0000');
  React.useEffect(() => enabled ? subscribeVarinEvents(event => {
    if (event.type === 'bot-presence') setReads(current => current.has(event.botId) ? new Map(current).set(event.botId, { status: 'ready', value: event.presence }) : current);
    if (event.type === 'stream-ready') refresh();
  }) : undefined, [enabled]);
  React.useEffect(() => {
    if (!enabled) return undefined;
    const ids = key ? key.split('\u0000') : [];
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setReads(current => new Map(ids.map(id => {
      const known = current.get(id);
      return [id, known ? { status: 'loading' as const, value: known.value } : { status: 'loading' as const, value: null }];
    })));
    for (const id of ids) {
      void readBotPresence(id, controller.signal).then(presence => {
        if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setReads(current => current.has(id) ? new Map(current).set(id, { status: 'ready', value: presence }) : current);
      }, (cause: unknown) => {
        if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setReads(current => current.has(id) ? new Map(current).set(id, { status: 'failed', value: current.get(id)?.value ?? null, error: message(cause) }) : current);
      });
    }
    return () => controller.abort();
  }, [enabled, key, revision]);
  return reads;
}

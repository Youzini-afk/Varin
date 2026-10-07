import React from 'react';
import { create } from 'zustand';
import type { ComputerAutomationProjection } from '@/lib/computers';
import { readComputerAutomation, stopComputerAutomation } from '@/lib/computers';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { usePiSessionStore } from './usePiSessionStore';

type View = { state: ComputerAutomationProjection['state'] | null; activities: ComputerAutomationProjection['activities']; busy: boolean; error: string | null };
const EMPTY: View = { state: null, activities: [], busy: false, error: null };
const useProjection = create<{ views: Record<string, View> }>(() => ({ views: {} }));
const watchers = new Map<string, { refs: number; close(): void; refresh(): Promise<void> }>();
const update = (key: string, change: (view: View) => View) => useProjection.setState(store => ({ views: { ...store.views, [key]: change(store.views[key] ?? EMPTY) } }));
const belongs = (view: View, sessionId?: string | null, selected?: string) => Boolean(sessionId && (sessionId === selected || sessionId === view.state?.rootSessionId
  || view.state?.leases.some(item => item.actor.sessionId === sessionId) || view.state?.requests.some(item => item.actor.sessionId === sessionId)));

function watch(key: string, sessionId: string) {
  const existing = watchers.get(key);
  if (existing) { existing.refs += 1; return existing; }
  let active = true, read = 0, stateRevision = 0, activityRevision = 0;
  const refresh = async () => {
    const started = ++read, stateAt = stateRevision, activityAt = activityRevision;
    try {
      const snapshot = await readComputerAutomation(sessionId);
      if (active && started === read) update(key, view => ({ ...view, error: null,
        state: stateAt === stateRevision ? snapshot.state : view.state,
        activities: activityAt === activityRevision ? snapshot.activities : view.activities }));
    } catch (error) { if (active && started === read) update(key, view => ({ ...view, error: error instanceof Error ? error.message : String(error) })); }
  };
  const unsubscribe = subscribeVarinEvents(event => {
    const view = useProjection.getState().views[key] ?? EMPTY;
    if (event.type === 'stream-ready') { void refresh(); return; }
    if (event.type === 'computer-automation' && (event.state.rootSessionId === sessionId || event.state.rootSessionId === view.state?.rootSessionId)) {
      if (view.state && view.state.runId !== event.state.runId) { void refresh(); return; }
      stateRevision += 1; update(key, current => ({ ...current, state: event.state }));
    } else if (event.type === 'computer-activity') {
      const known = view.activities.some(item => item.desktopId === event.desktopId);
      if (known || belongs(view, event.activity.sessionId, sessionId)) {
        activityRevision += 1;
        update(key, current => ({ ...current, activities: [...current.activities.filter(item => item.desktopId !== event.desktopId),
          ...(belongs(current, event.activity.sessionId, sessionId) ? [{ desktopId: event.desktopId, activity: event.activity }] : [])] }));
      }
    } else if (event.type === 'harness-thread-changed' && (belongs(view, event.activeRun?.sessionId, sessionId)
      || event.thread.parent.kind === 'session' && belongs(view, event.thread.parent.id, sessionId))) void refresh();
  });
  const watcher = { refs: 1, refresh, close() { active = false; unsubscribe(); watchers.delete(key); useProjection.setState(store => { const views = { ...store.views }; delete views[key]; return { views }; }); } };
  watchers.set(key, watcher); void refresh(); return watcher;
}

/** One live projection per viewed conversation, shared by the overview and its small desktop launcher. */
export function useComputerAutomation(sessionId: string) {
  const runtimeKey = usePiSessionStore(state => state.runtimeKey);
  const key = JSON.stringify([runtimeKey, sessionId]);
  const view = useProjection(state => state.views[key] ?? EMPTY);
  React.useEffect(() => { const watcher = watch(key, sessionId); return () => { watcher.refs -= 1; if (!watcher.refs) watcher.close(); }; }, [key, sessionId]);
  const stop = React.useCallback(async () => {
    update(key, current => ({ ...current, busy: true, error: null }));
    try {
      const result = await stopComputerAutomation(useProjection.getState().views[key]?.state?.rootSessionId ?? sessionId);
      const current = useProjection.getState().views[key]?.state;
      if (current && current.runId !== result.state.runId) await watchers.get(key)?.refresh();
      else if (watchers.has(key)) update(key, current => ({ ...current, state: result.state }));
    } catch (error) { await watchers.get(key)?.refresh(); update(key, current => ({ ...current, error: error instanceof Error ? error.message : String(error) })); }
    finally { if (watchers.has(key)) update(key, current => ({ ...current, busy: false })); }
  }, [key, sessionId]);
  return { ...view, stop };
}

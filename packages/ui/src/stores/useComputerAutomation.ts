import React from 'react';
import { create } from 'zustand';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ThreadComputerAPI } from '@varin/application-client';
import { computerWorkKey, sameComputerExecution, sameComputerWork, type ComputerAutomationProjection, type ComputerExecutionRef, type ComputerWorkRef } from '@varin/protocol';
import { readComputerAutomation, stopComputerAutomation } from '@/lib/computers';
import { useI18n } from '@/lib/i18n';
import { computerErrorText } from '@/lib/computerErrors';
import { subscribeVarinEvents } from '@/lib/varinEvents';

type View = { state: ComputerAutomationProjection['state'] | null; activities: ComputerAutomationProjection['activities']; busy: boolean; error: unknown | null };
const EMPTY: View = { state: null, activities: [], busy: false, error: null };
const useProjection = create<{ views: Record<string, View> }>(() => ({ views: {} }));
type Watcher = { refs: number; close(): void; refresh(): Promise<void>; stop(execution: ComputerExecutionRef, desktopId?: string): Promise<void> };
const watchers = new Map<string, Watcher>();
const update = (key: string, change: (view: View) => View) => useProjection.setState(store => ({ views: { ...store.views, [key]: change(store.views[key] ?? EMPTY) } }));
const belongs = (view: View, work: ComputerWorkRef | undefined, selected: ComputerWorkRef) => Boolean(work && (sameComputerWork(work, selected)
  || view.state && sameComputerWork(work, view.state.rootWork)
  || view.state?.leases.some(item => sameComputerWork(item.actor.execution.work, work))
  || view.state?.requests.some(item => sameComputerWork(item.actor.execution.work, work))
  || view.state?.cleanups.some(item => sameComputerWork(item.execution.work, work))));

function watch(key: string, work: ComputerWorkRef, host: number, api?: ThreadComputerAPI) {
  const existing = watchers.get(key);
  if (existing) { existing.refs += 1; return existing; }
  let active = true, read = 0, stateRevision = 0, activityRevision = 0;
  let reading: AbortController | undefined;
  const current = () => active && host === getRuntimeEndpointGeneration();
  const refresh = async () => {
    reading?.abort();
    const controller = new AbortController(); reading = controller;
    const started = ++read, stateAt = stateRevision, activityAt = activityRevision;
    try {
      const snapshot = work.runtime === 'agent' && api ? await api.state(work, controller.signal) : await readComputerAutomation(work, controller.signal);
      if (!sameComputerWork(snapshot.state.work, work)) throw new Error('Computer state belongs to another conversation');
      if (current() && started === read) {
        const publishState = stateAt === stateRevision;
        if (publishState) stateRevision += 1;
        update(key, view => ({ ...view, error: null,
          state: publishState ? snapshot.state : view.state,
          activities: activityAt === activityRevision ? snapshot.activities : view.activities }));
      }
    } catch (error) { if (current() && started === read && !controller.signal.aborted) update(key, view => ({ ...view, error })); }
  };
  const unsubscribe = subscribeVarinEvents(event => {
    if (!current()) return;
    const view = useProjection.getState().views[key] ?? EMPTY;
    if (event.type === 'stream-ready') { void refresh(); return; }
    if (event.type === 'computer-automation') {
      if (sameComputerWork(event.state.work, work)) {
        stateRevision += 1; update(key, current => ({ ...current, state: event.state }));
      } else if (sameComputerWork(event.state.rootWork, work) || view.state && sameComputerWork(event.state.rootWork, view.state.rootWork)) {
        // Family events are facts for their own work. Read our projection instead of relabelling them.
        stateRevision += 1; void refresh();
      }
    } else if (event.type === 'computer-activity') {
      const activityWork = event.activity.execution?.work ?? (event.activity.sessionId ? { runtime: 'pi' as const, sessionId: event.activity.sessionId } : undefined);
      const known = view.activities.some(item => item.desktopId === event.desktopId);
      if (known || belongs(view, activityWork, work)) {
        activityRevision += 1;
        update(key, current => ({ ...current, activities: [...current.activities.filter(item => item.desktopId !== event.desktopId),
          ...(belongs(current, activityWork, work) ? [{ desktopId: event.desktopId, activity: event.activity }] : [])] }));
      }
    } else if (event.type === 'harness-thread-changed' && work.runtime === 'pi'
      && (event.activeRun?.sessionId && belongs(view, { runtime: 'pi', sessionId: event.activeRun.sessionId }, work)
        || event.thread.parent.kind === 'session' && belongs(view, { runtime: 'pi', sessionId: event.thread.parent.id }, work))) void refresh();
  });
  const watcher: Watcher = {
    refs: 1, refresh,
    async stop(execution, desktopId) {
      if (!current() || useProjection.getState().views[key]?.busy) return;
      const stateAt = stateRevision, readAt = read;
      const displayed = useProjection.getState().views[key]?.state;
      const preservesExecution = (before: ComputerExecutionRef | null | undefined, after: ComputerExecutionRef | null) =>
        before == null ? after === null : after === null ? sameComputerExecution(before, execution) : sameComputerExecution(before, after);
      // Retain the button's exact execution, even if another Run starts before its response.
      update(key, view => ({ ...view, busy: true, error: null }));
      try {
        const result = execution.work.runtime === 'agent' && api
          ? await api.stop(execution.work, { runId: execution.runId, desktopId })
          : await stopComputerAutomation(execution, desktopId);
        if (!current()) return;
        if (stateAt === stateRevision && readAt === read && sameComputerWork(result.state.work, work)
          && preservesExecution(displayed?.currentExecution, result.state.currentExecution)
          && preservesExecution(displayed?.currentRootExecution, result.state.currentRootExecution)) {
          ++read; reading?.abort(); stateRevision += 1;
          update(key, view => ({ ...view, state: result.state }));
        } else await refresh();
      } catch (error) {
        if (!current()) return;
        await refresh();
        if (current()) update(key, view => ({ ...view, error }));
      } finally { if (current()) update(key, view => ({ ...view, busy: false })); }
    },
    close() {
      active = false; reading?.abort(); unsubscribe(); watchers.delete(key);
      useProjection.setState(store => { const views = { ...store.views }; delete views[key]; return { views }; });
    },
  };
  watchers.set(key, watcher); void refresh(); return watcher;
}

/** One read-only projection per Host and work, shared by its overview and desktop launcher. */
export function useComputerAutomation(work: ComputerWorkRef, api?: ThreadComputerAPI, observedRunId?: string | null) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const workKey = computerWorkKey(work);
  const key = JSON.stringify([host, workKey]);
  // A caller may construct its DTO during render; identity is defined by the protocol key.
  const selected = React.useMemo(() => work, [workKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useProjection(state => state.views[key] ?? EMPTY);
  React.useEffect(() => {
    const watcher = watch(key, selected, host, api);
    return () => { watcher.refs -= 1; if (!watcher.refs) watcher.close(); };
  }, [key, selected, host, api]);
  const previousRun = React.useRef({ key, observedRunId });
  React.useEffect(() => {
    if (previousRun.current.key === key && previousRun.current.observedRunId !== observedRunId) void watchers.get(key)?.refresh();
    previousRun.current = { key, observedRunId };
  }, [key, observedRunId]);
  const execution = view.state?.currentRootExecution ?? view.state?.currentExecution ?? null;
  const stop = React.useCallback(async (target: ComputerExecutionRef | null = execution, desktopId?: string) => {
    if (target && host === getRuntimeEndpointGeneration()) await watchers.get(key)?.stop(target, desktopId);
  }, [key, host, execution]);
  const refresh = React.useCallback(async () => { if (host === getRuntimeEndpointGeneration()) await watchers.get(key)?.refresh(); }, [host, key]);
  return { ...view, error: view.error === null ? null : computerErrorText(view.error, t), activities: view.activities.filter(entry => entry.activity.status === 'running'), stop, refresh };
}

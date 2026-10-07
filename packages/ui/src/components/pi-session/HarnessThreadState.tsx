import React from 'react';
import { isAttachedRootPurpose, type ThreadParent } from '@varin/protocol';
import { runtimeFetch } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { mergeHarnessThreadSnapshot, parseHarnessThreadProjection, sameHarnessThreadParent, type HarnessThreadSnapshot } from './harnessThreadPresentation';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from './HarnessThreadStateContext';

const mergeRoots = (current: HarnessThreadSnapshot[], additions: HarnessThreadSnapshot[]) => {
  const byId = new Map(current.map(snapshot => [snapshot.thread.id, snapshot]));
  for (const next of additions) if ((byId.get(next.thread.id)?.thread.eventSeq ?? -1) <= next.thread.eventSeq) byId.set(next.thread.id, next);
  return [...byId.values()];
};

export const HarnessThreadStateProvider: React.FC<{ children: React.ReactNode; parentSessionId: string | null; workspaceId: string | null }> = ({ children, parentSessionId, workspaceId }) => {
  const [threads, setThreads] = React.useState<HarnessThreadSnapshot[]>([]);
  const [rootThreads, setRootThreads] = React.useState<HarnessThreadSnapshot[]>([]);
  const rootsRef = React.useRef<HarnessThreadSnapshot[]>([]);
  const [branches, setBranches] = React.useState<HarnessThreadSnapshot[]>([]);
  const [peers, setPeers] = React.useState<HarnessThreadSnapshot[]>([]);
  const peersRef = React.useRef<HarnessThreadSnapshot[]>([]);
  const commitPeers = React.useCallback((next: HarnessThreadSnapshot[]) => { peersRef.current = next; setPeers(next); }, []);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [scope, setScope] = React.useState<{ parent: ThreadParent; workspaceId: string }>({ parent: { kind: 'session', id: parentSessionId ?? '' }, workspaceId: workspaceId ?? '' });
  const scopeRef = React.useRef(scope);
  const eventRevision = React.useRef(0);
  const selectedParentRef = React.useRef(parentSessionId);
  selectedParentRef.current = parentSessionId;

  const commitScope = React.useCallback((next: { parent: ThreadParent; workspaceId: string }) => {
    scopeRef.current = next;
    setScope(current => current.workspaceId === next.workspaceId && sameHarnessThreadParent(current.parent, next.parent) ? current : next);
  }, []);
  const commitRoots = React.useCallback((next: HarnessThreadSnapshot[]) => { rootsRef.current = next; setRootThreads(next); }, []);
  const merge = React.useCallback((snapshot: HarnessThreadSnapshot) => {
    eventRevision.current += 1;
    commitPeers(mergeRoots(peersRef.current, [snapshot]));
    if (isAttachedRootPurpose(snapshot.thread.purpose)) { commitRoots(mergeRoots(rootsRef.current, [snapshot])); return; }
    if (snapshot.thread.parent.kind === 'thread' && rootsRef.current.some(root => root.thread.id === snapshot.thread.parent.id)) {
      setBranches(current => mergeHarnessThreadSnapshot(current, snapshot, { includeArchived: true }));
    } else if (sameHarnessThreadParent(snapshot.thread.parent, scopeRef.current.parent)) {
      setThreads(current => mergeHarnessThreadSnapshot(current, snapshot, { includeArchived: true }));
    }
  }, [commitRoots, commitPeers]);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    if (!parentSessionId) return;
    const revisionAtStart = eventRevision.current;
    const response = await runtimeFetch('/api/harness/sessions/' + encodeURIComponent(parentSessionId) + '/threads?archived=1', { signal });
    if (!response.ok) throw new Error(await response.text() || 'Unable to read tasks');
    const projection = parseHarnessThreadProjection(await response.json(), { includeArchived: true });
    if (signal?.aborted || selectedParentRef.current !== parentSessionId) return;
    setLoadError(null);
    commitScope({ workspaceId: projection.workspaceId, parent: projection.parent });
    commitRoots(eventRevision.current === revisionAtStart ? projection.rootThreads : mergeRoots(rootsRef.current, projection.rootThreads));
    commitPeers(eventRevision.current === revisionAtStart ? projection.peers : mergeRoots(peersRef.current, projection.peers));
    setBranches(current => eventRevision.current === revisionAtStart ? projection.branches : projection.branches.reduce((list, snapshot) => mergeHarnessThreadSnapshot(list, snapshot, { includeArchived: true }), current));
    setThreads(current => {
      const ordinary = projection.threads.filter(({ thread }) => !isAttachedRootPurpose(thread.purpose));
      return eventRevision.current === revisionAtStart ? ordinary : ordinary.reduce((list, snapshot) => mergeHarnessThreadSnapshot(list, snapshot, { includeArchived: true }), current);
    });
  }, [commitRoots, commitPeers, commitScope, parentSessionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    eventRevision.current = 0; setThreads([]); commitRoots([]); commitPeers([]); setBranches([]); setLoadError(null);
    commitScope({ workspaceId: workspaceId ?? '', parent: { kind: 'session', id: parentSessionId ?? '' } });
    if (!parentSessionId) return () => controller.abort();
    const load = () => { void reload(controller.signal).catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error)); }); };
    load();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready') { load(); return; }
      if (event.type !== 'harness-thread-changed' || event.workspaceId !== scopeRef.current.workspaceId
        || (!sameHarnessThreadParent(event.parent, scopeRef.current.parent)
          && !(event.parent.kind === 'thread' && [...rootsRef.current, ...peersRef.current].some(root => root.thread.id === event.parent.id))
          && !peersRef.current.some(peer => peer.thread.id === event.thread.id))) return;
      merge({ thread: event.thread, activeRun: event.activeRun });
    });
    return () => { controller.abort(); unsubscribe(); };
  }, [commitRoots, commitPeers, commitScope, merge, parentSessionId, reload, workspaceId]);

  const value = React.useMemo<HarnessThreadStateValue>(() => ({ merge, parent: scope.parent, reload, threads, rootThreads, branches, peers, loadError, workspaceId: scope.workspaceId }),
    [merge, reload, scope.parent, scope.workspaceId, threads, rootThreads, branches, peers, loadError]);
  return <HarnessThreadStateContext.Provider value={value}>{children}</HarnessThreadStateContext.Provider>;
};

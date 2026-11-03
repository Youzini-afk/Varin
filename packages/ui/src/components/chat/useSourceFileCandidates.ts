import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadsAPI, type ThreadIdentity, type ThreadSource, type ThreadDraftSkillOptions, type ThreadSourceFileEntry } from '@varin/application-client';

/** Each type owns its paging and failures; no group can replace another group's visible results. */
export function useSourceFileCandidates({ api, identity, source, pendingSource, scope, query, requestedQuery, type, revision }: {
  api?: ThreadsAPI; identity?: ThreadIdentity; source?: ThreadSource; pendingSource?: ThreadDraftSkillOptions['source']; scope: string;
  query: string; requestedQuery: string; type: 'file' | 'directory'; revision: number;
}) {
  const generation = React.useRef({ scope, requestedQuery, id: 0 });
  if (generation.current.scope !== scope || generation.current.requestedQuery !== requestedQuery) generation.current = { scope, requestedQuery, id: generation.current.id + 1 };
  const requestGeneration = generation.current.id;
  const [cursor, setCursor] = React.useState<{ generation: number; value: string }>();
  const currentCursor = cursor?.generation === requestGeneration ? cursor.value : undefined;
  const [result, setResult] = React.useState<{ scope: string; query: string; rows: ThreadSourceFileEntry[]; loading: boolean; error?: string; next?: string | null }>();
  React.useEffect(() => {
    if (!api || !identity && !pendingSource || query !== requestedQuery) return;
    const controller = new AbortController(), host = getRuntimeEndpointGeneration();
    setResult(previous => ({ scope, query, rows: previous?.scope === scope && previous.query === query ? previous.rows : [], loading: true }));
    const options = { query, type, limit: 60, ...(currentCursor ? { cursor: currentCursor } : {}) };
    const request = identity ? api.sources.files(identity, { ...options, ...(source ? { source } : {}) }, controller.signal)
      : api.sources.draftFiles({ ...options, source: pendingSource! }, controller.signal);
    void request.then(page => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      setResult(previous => ({ scope, query, loading: false, next: page.nextCursor,
        rows: [...new Map([...(currentCursor && previous?.scope === scope && previous.query === query ? previous.rows : []), ...page.entries].map(item => [item.path, item])).values()] }));
    }, failure => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setResult(previous => ({ scope, query, loading: false,
        rows: previous?.scope === scope && previous.query === query ? previous.rows : [], error: failure instanceof Error ? failure.message : String(failure) }));
    });
    return () => controller.abort();
  }, [api, identity, source, pendingSource, scope, query, requestedQuery, type, currentCursor, revision]);
  const visible = result?.scope === scope && result.query === requestedQuery ? result : undefined;
  return { rows: visible?.rows ?? [], loading: visible?.loading, error: visible?.error, more: visible?.next ? () => setCursor({ generation: requestGeneration, value: visible.next! }) : undefined };
}

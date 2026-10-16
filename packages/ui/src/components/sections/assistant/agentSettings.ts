import React from 'react';
import { runtimeFetch, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { AgentPersonalizationCatalog } from '@varin/protocol';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export function useAgentSettings() {
  const [catalog, setCatalog] = React.useState<AgentPersonalizationCatalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const runtime = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [catalogOwner, setCatalogOwner] = React.useState<number | null>(null);
  const generation = React.useRef(0);
  const pending = React.useRef<AbortController | null>(null);
  const writing = React.useRef<symbol | null>(null);
  const live = React.useRef(true);
  const isCurrent = () => live.current && runtime === getRuntimeEndpointGeneration();
  const load = React.useCallback(async () => {
    if (!live.current || runtime !== getRuntimeEndpointGeneration()) return;
    const current = ++generation.current;
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    try {
      const response = await runtimeFetch('/api/agent-personalization', { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (generation.current === current && !controller.signal.aborted && runtime === getRuntimeEndpointGeneration()) {
        setCatalog(result); setCatalogOwner(runtime); setError(null);
      }
    } catch (failure) { if (!controller.signal.aborted && runtime === getRuntimeEndpointGeneration()) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [runtime]);
  React.useEffect(() => {
    live.current = true; writing.current = null;
    setCatalog(null); setError(null); setBusy(false); void load();
    const unsubscribe = subscribeVarinEvents(event => { if (event.type === 'agent-personalization-changed') void load(); });
    return () => { live.current = false; generation.current += 1; pending.current?.abort(); unsubscribe(); };
  }, [load, runtime]);
  const update = async (part: string, body: unknown, method = 'PUT'): Promise<boolean> => {
    if (writing.current || !isCurrent()) return false;
    const operation = Symbol(); writing.current = operation;
    setBusy(true); setError(null);
    try {
      const response = await runtimeFetch(`/api/agent-personalization/${part}`, { method,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (!isCurrent()) return false;
      await load(); return isCurrent();
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally { if (writing.current === operation) { writing.current = null; if (isCurrent()) setBusy(false); } }
  };
  return { catalog: catalogOwner === runtime ? catalog : null, error, busy, runtime, load, update };
}

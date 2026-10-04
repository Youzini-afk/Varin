import React from 'react';
import { runtimeFetch, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { AgentPersonalizationCatalog } from '@varin/protocol';
import { subscribeVarinEvents } from '@/lib/varinEvents';

export function useAgentSettings() {
  const [catalog, setCatalog] = React.useState<AgentPersonalizationCatalog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [runtime, setRuntime] = React.useState(getRuntimeKey);
  const generation = React.useRef(0);
  const pending = React.useRef<AbortController | null>(null);
  const load = React.useCallback(async () => {
    const current = ++generation.current;
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    try {
      const response = await runtimeFetch('/api/agent-personalization', { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (generation.current === current && !controller.signal.aborted) { setCatalog(result); setError(null); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, []);
  React.useEffect(() => {
    setCatalog(null); setBusy(false); void load();
    const unsubscribe = subscribeVarinEvents(event => { if (event.type === 'agent-personalization-changed') void load(); });
    const stop = subscribeRuntimeEndpointChanged(() => setRuntime(getRuntimeKey()));
    return () => { pending.current?.abort(); unsubscribe(); stop(); };
  }, [load, runtime]);
  const update = async (part: string, body: unknown, method = 'PUT'): Promise<boolean> => {
    const owner = getRuntimeKey();
    setBusy(true); setError(null);
    try {
      const response = await runtimeFetch(`/api/agent-personalization/${part}`, { method,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (owner !== getRuntimeKey()) return false;
      await load(); return true;
    } catch (failure) {
      if (owner === getRuntimeKey()) setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally { if (owner === getRuntimeKey()) setBusy(false); }
  };
  return { catalog, error, busy, runtime, load, update };
}

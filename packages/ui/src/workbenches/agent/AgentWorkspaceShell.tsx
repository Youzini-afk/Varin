import React from 'react';
import type { NativeThreadIdentity } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Button } from '@/components/ui/button';
import { NativeThreadConversation } from '@/components/native-thread/NativeThreadConversation';
import { RegularChatView } from '@/components/views/RegularChatView';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { MainLayout } from '@/components/layout/MainLayout';
import { MobileWorkspaceShell } from '@/apps/mobileWorkspaceShell';
import { switchRuntimeEndpointSafely, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';

export const MOBILE_WORKSPACE_DISCONNECTED_EVENT = 'varin:mobile-workspace-disconnected';

export const AgentWorkspaceShell: React.FC<Record<string, unknown>> = () => {
  const { nativeThreads } = useRuntimeAPIs();
  const [selected, setSelected] = React.useState<NativeThreadIdentity>();
  const [available, setAvailable] = React.useState<NativeThreadIdentity[]>([]);
  const [error, setError] = React.useState<string>();
  const createKey = React.useRef<string | undefined>(undefined);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => { setSelected(undefined); setAvailable([]); setError(undefined); createKey.current = undefined; }), []);
  React.useEffect(() => usePiSessionStore.subscribe((state, previous) => {
    if (state.currentSessionId !== previous.currentSessionId) setSelected(undefined);
  }), []);
  const load = async () => {
    if (!nativeThreads) return;
    try {
      const threads = await nativeThreads.list();
      setAvailable(threads.flatMap(thread => thread.branches.map(branch => ({ runtime: 'nativeThread' as const, threadId: thread.thread_id, branchId: branch.branch_id }))));
    } catch (value) { setError(value instanceof Error ? value.message : 'Native threads unavailable'); }
  };
  if (varinSurfaceRuntime.surface === 'mobile') {
    return (
      <MobileWorkspaceShell
        onActiveConnectionDeleted={() => {
          void switchRuntimeEndpointSafely({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' })
            .then(() => window.dispatchEvent(new Event(MOBILE_WORKSPACE_DISCONNECTED_EVENT)))
            .catch((error) => console.error('[Mobile] Failed to persist state before disconnect:', error));
        }}
      />
    );
  }
  return <div className="flex h-full min-h-0 flex-col">
    {nativeThreads && <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
      <Button variant="ghost" size="sm" onClick={() => { void (async () => {
        try { createKey.current ??= crypto.randomUUID(); setSelected(await nativeThreads.create(createKey.current)); createKey.current = undefined; setError(undefined); await load(); }
        catch (value) { setError(value instanceof Error ? value.message : 'Native thread creation failed'); }
      })(); }}>New native thread</Button>
      <select aria-label="Conversation runtime" className="min-w-0 rounded bg-background text-xs" value={selected?.branchId ?? ''}
        onFocus={() => void load()} onChange={event => setSelected(available.find(value => value.branchId === event.target.value))}>
        <option value="">Existing conversations</option>
        {available.map(value => <option key={value.branchId} value={value.branchId}>nativeThread · {value.threadId.slice(-12)}</option>)}
        {selected && !available.some(value => value.branchId === selected.branchId) && <option value={selected.branchId}>nativeThread · {selected.threadId.slice(-12)}</option>}
      </select>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>}
    <div className="min-h-0 flex-1"><MainLayout renderConversation={active => selected && nativeThreads
      ? <NativeThreadConversation api={nativeThreads} identity={selected} />
      : <RegularChatView active={active} />} /></div>
  </div>;
};

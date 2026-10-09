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
  const hostGeneration = React.useRef(0);
  const navigationGeneration = React.useRef(0);
  const creating = React.useRef(false);
  const [createPending, setCreatePending] = React.useState(false);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => { hostGeneration.current += 1; navigationGeneration.current += 1; setSelected(undefined); setAvailable([]); setError(undefined); createKey.current = undefined; creating.current = false; setCreatePending(false); }), []);
  React.useEffect(() => usePiSessionStore.subscribe((state, previous) => {
    if (state.currentSessionId !== previous.currentSessionId) { navigationGeneration.current += 1; setSelected(undefined); }
  }), []);
  const load = async () => {
    if (!nativeThreads) return;
    const generation = hostGeneration.current;
    try {
      const threads = await nativeThreads.list();
      if (generation !== hostGeneration.current) return;
      setAvailable(threads.flatMap(thread => thread.branches.map(branch => ({ runtime: 'nativeThread' as const, threadId: thread.thread_id, branchId: branch.branch_id }))));
    } catch (value) { if (generation === hostGeneration.current) setError(value instanceof Error ? value.message : 'Native threads unavailable'); }
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
      <Button variant="ghost" size="sm" disabled={createPending} onClick={() => { void (async () => {
        if (creating.current) return;
        creating.current = true; setCreatePending(true);
        const generation = hostGeneration.current;
        const navigation = ++navigationGeneration.current;
        try {
          createKey.current ??= crypto.randomUUID();
          const created = await nativeThreads.create(createKey.current);
          if (generation !== hostGeneration.current) return;
          createKey.current = undefined; setError(undefined);
          if (navigation === navigationGeneration.current) setSelected(created);
          await load();
        } catch (value) { if (generation === hostGeneration.current) setError(value instanceof Error ? value.message : 'Native thread creation failed'); }
        finally { if (generation === hostGeneration.current) { creating.current = false; setCreatePending(false); } }
      })(); }}>New native thread</Button>
      <select aria-label="Conversation runtime" className="min-w-0 rounded bg-background text-xs" value={selected?.branchId ?? ''}
        onFocus={() => void load()} onChange={event => { navigationGeneration.current += 1; setSelected(available.find(value => value.branchId === event.target.value)); }}>
        <option value="">Existing conversations</option>
        {available.map(value => <option key={value.branchId} value={value.branchId}>nativeThread · {value.threadId.slice(-12)} · branch {value.branchId.slice(-8)}</option>)}
        {selected && !available.some(value => value.branchId === selected.branchId) && <option value={selected.branchId}>nativeThread · {selected.threadId.slice(-12)} · branch {selected.branchId.slice(-8)}</option>}
      </select>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>}
    <div className="min-h-0 flex-1"><MainLayout renderConversation={active => selected && nativeThreads
      ? <NativeThreadConversation key={selected.branchId} api={nativeThreads} identity={selected} onBranchCreated={created => { navigationGeneration.current += 1; setSelected(created); void load(); }} />
      : <RegularChatView active={active} />} /></div>
  </div>;
};

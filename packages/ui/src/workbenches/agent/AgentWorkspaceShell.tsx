import { useDirectoryStore } from '@/stores/useDirectoryStore';
import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { Button } from '@/components/ui/button';
import { ThreadConversation } from '@/components/thread/ThreadConversation';
import { RegularChatView } from '@/components/views/RegularChatView';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { MainLayout } from '@/components/layout/MainLayout';
import { MobileWorkspaceShell } from '@/apps/mobileWorkspaceShell';
import { switchRuntimeEndpointSafely, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';

export const MOBILE_WORKSPACE_DISCONNECTED_EVENT = 'varin:mobile-workspace-disconnected';

export const AgentWorkspaceShell: React.FC<Record<string, unknown>> = () => {
  const { threads: threadAPI } = useRuntimeAPIs();
  const workspacePath = useDirectoryStore(state => state.currentDirectory);
  const [selected, setSelected] = React.useState<ThreadIdentity>();
  const [available, setAvailable] = React.useState<ThreadIdentity[]>([]);
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
    if (!threadAPI) return;
    const generation = hostGeneration.current;
    try {
      const threads = await threadAPI.list();
      if (generation !== hostGeneration.current) return;
      setAvailable(threads.flatMap(thread => thread.branches.map(branch => ({ runtime: 'agent' as const, threadId: thread.thread_id, branchId: branch.branch_id }))));
    } catch (value) { if (generation === hostGeneration.current) setError(value instanceof Error ? value.message : 'Threads unavailable'); }
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
    {threadAPI && <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1">
      <Button variant="ghost" size="sm" disabled={createPending} onClick={() => { void (async () => {
        if (creating.current) return;
        creating.current = true; setCreatePending(true);
        const generation = hostGeneration.current;
        const navigation = ++navigationGeneration.current;
        try {
          createKey.current ??= crypto.randomUUID();
          const created = await threadAPI.create(createKey.current);
          if (generation !== hostGeneration.current) return;
          createKey.current = undefined; setError(undefined);
          if (navigation === navigationGeneration.current) setSelected(created);
          await load();
        } catch (value) { if (generation === hostGeneration.current) setError(value instanceof Error ? value.message : 'Thread creation failed'); }
        finally { if (generation === hostGeneration.current) { creating.current = false; setCreatePending(false); } }
      })(); }}>New conversation</Button>
      <select aria-label="Conversation runtime" className="min-w-0 rounded bg-background text-xs" value={selected?.branchId ?? ''}
        onFocus={() => void load()} onChange={event => { navigationGeneration.current += 1; setSelected(available.find(value => value.branchId === event.target.value)); }}>
        <option value="">Existing conversations</option>
        {available.map(value => <option key={value.branchId} value={value.branchId}>Conversation · {value.threadId.slice(-12)} · branch {value.branchId.slice(-8)}</option>)}
        {selected && !available.some(value => value.branchId === selected.branchId) && <option value={selected.branchId}>Conversation · {selected.threadId.slice(-12)} · branch {selected.branchId.slice(-8)}</option>}
      </select>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </div>}
    <div className="min-h-0 flex-1"><MainLayout renderConversation={active => selected && threadAPI
      ? <ThreadConversation key={selected.branchId} api={threadAPI} identity={selected} initialWorkspacePath={workspacePath} onBranchCreated={created => { navigationGeneration.current += 1; setSelected(created); void load(); }} />
      : <RegularChatView active={active} />} /></div>
  </div>;
};

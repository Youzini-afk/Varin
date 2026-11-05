import React from 'react';
import { create } from 'zustand';
import {
  createExternalAgentsHttpAPI,
  getRuntimeEndpointGeneration,
  type ExternalAgentSettings,
  type ExternalConversation,
  type ExternalConversationSnapshot,
  type ExternalDelegation,
} from '@varin/application-client';
import { useThreadStore } from './useThreadStore';
import { useUIStore } from './useUIStore';
import { useDirectoryStore } from './useDirectoryStore';

export const useExternalAgentStore = create<{
  host: number;
  settings: ExternalAgentSettings | null;
  conversations: ExternalConversation[];
  children: ExternalDelegation[];
  selectedId: string | null;
  snapshots: Record<string, Pick<ExternalConversationSnapshot, 'contextUsage' | 'turns' | 'observationEpoch' | 'observationRevision'> & { source?: object }>;
  setSnapshot(snapshot: ExternalConversationSnapshot, host: number, source?: object): void;
  clearSnapshot(id: string, host: number, source?: object): void;
  error: string | null;
  refresh(): Promise<void>;
  select(id: string): void;
  update(
    id: string,
    patch: { title?: string; pinned?: boolean; archived?: boolean; deleted?: boolean },
  ): Promise<void>;
}>((set, get) => ({
  host: -1,
  settings: null,
  conversations: [],
  children: [],
  selectedId: null,
  snapshots: {},
  error: null,
  setSnapshot(snapshot, host, source) {
    if (host !== getRuntimeEndpointGeneration() || host !== get().host) return;
    const id = snapshot.conversation.id, previous = get().snapshots[id];
    if (previous?.observationEpoch === snapshot.observationEpoch &&
        previous.observationRevision > snapshot.observationRevision) return;
    set(state => ({ snapshots: { ...state.snapshots, [id]: {
      contextUsage: snapshot.contextUsage, turns: snapshot.turns, source,
      observationEpoch: snapshot.observationEpoch, observationRevision: snapshot.observationRevision,
    } } }));
  },
  clearSnapshot(id, host, source) {
    if (host !== get().host || get().snapshots[id]?.source !== source) return;
    set(state => { const snapshots = { ...state.snapshots }; delete snapshots[id]; return { snapshots }; });
  },
  async refresh() {
    const generation = getRuntimeEndpointGeneration();
    if (generation !== get().host)
      set({ host: generation, settings: null, conversations: [], children: [], selectedId: null, snapshots: {} });
    const api = createExternalAgentsHttpAPI(generation);
    try {
      const [settings, conversations, children] = await Promise.all([
        api.settings(),
        api.list(),
        api.children(),
      ]);
      if (generation === getRuntimeEndpointGeneration())
        set({ settings, conversations, children, error: null });
    } catch (error) {
      if (generation === getRuntimeEndpointGeneration())
        set({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  select(id) {
    if (get().host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
    const conversation = get().conversations.find((v) => v.id === id);
    if (!conversation) throw new Error('External conversation is unavailable');
    useThreadStore.setState({ selectedIdentity: null, selectedDraftKey: null });
    set({ selectedId: id });
    useDirectoryStore.getState().setDirectory(conversation.cwd);
    useUIStore.getState().setActiveMainTab('chat');
    useUIStore.getState().closeMainSurfaces();
  },
  async update(id, patch) {
    const generation = getRuntimeEndpointGeneration();
    if (get().host !== generation) throw new Error('Application Host changed');
    const conversation = get().conversations.find((v) => v.id === id);
    if (!conversation) throw new Error('External conversation is unavailable');
    const result = await createExternalAgentsHttpAPI(generation).update(id, conversation.revision, patch);
    if (generation !== getRuntimeEndpointGeneration()) return;
    set((state) => ({
      conversations: state.conversations.flatMap((v) =>
        v.id === id ? (result.deleted ? [] : [result]) : [v],
      ),
      selectedId: result.deleted && state.selectedId === id ? null : state.selectedId,
    }));
  },
}));
useThreadStore.subscribe((state, previous) => {
  if (state.hostKey !== previous.hostKey)
    useExternalAgentStore.setState({
      host: -1,
      settings: null,
      conversations: [],
      children: [],
      selectedId: null,
      snapshots: {},
    });
  else if (
    (state.selectedIdentity !== previous.selectedIdentity && state.selectedIdentity) ||
    (state.selectedDraftKey !== previous.selectedDraftKey && state.selectedDraftKey)
  )
    useExternalAgentStore.setState({ selectedId: null });
});

/** One shared Host subscription, regardless of how many views need the directory. */
let users = 0;
let release: (() => void) | undefined;
let activeHost = -1;
function acquire() {
  const host = getRuntimeEndpointGeneration();
  if (!release || activeHost !== host) {
    release?.();
    activeHost = host;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false,
      dirty = false;
    const refresh = async () => {
      dirty = true;
      if (refreshing) return;
      refreshing = true;
      try {
        while (dirty && !controller.signal.aborted) {
          dirty = false;
          await useExternalAgentStore.getState().refresh();
        }
      } finally {
        refreshing = false;
      }
    };
    const observe = async () => {
      await refresh();
      if (controller.signal.aborted) return;
      try {
        await createExternalAgentsHttpAPI(host).observe(
          '*',
          (event) => {
            if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
            if (event.kind === 'unavailable') useExternalAgentStore.setState({ error: event.message });
            else if (event.kind === 'refresh') void refresh();
          },
          controller.signal,
        );
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(() => void observe(), 1500);
      }
    };
    void observe();
    release = () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }
  users++;
  return () => {
    if (--users === 0) {
      release?.();
      release = undefined;
    }
  };
}
export function useExternalAgents() {
  const host = useThreadStore((state) => state.hostKey);
  React.useEffect(acquire, [host]);
  return useExternalAgentStore((state) => state.host === getRuntimeEndpointGeneration() ? state.settings : null);
}
export async function openConversationFromNavigation(target: {
  threadId: string;
  branchId?: string;
  directory?: string | null;
}) {
  if (useExternalAgentStore.getState().conversations.some((v) => v.id === target.threadId)) {
    const { openExternalConversationFromNavigation } = await import('@/lib/agent-runtime/threadNavigation');
    await openExternalConversationFromNavigation(target.threadId);
  } else {
    const { openThreadFromNavigation } = await import('@/lib/agent-runtime/threadNavigation');
    await openThreadFromNavigation(target);
  }
}

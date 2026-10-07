import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';

export interface WebSource {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  fetchedAt: number;
  toolCallId: string;
  tool: 'webfetch' | 'websearch' | 'research_search' | 'materials' | 'research_decide' | 'document_read';
  /** Fixed content snapshot id when the Host pinned the fetched body. */
  snapshotId?: string;
  contentHash?: string;
  /** Physical hash of an original PDF, distinct from extracted text identity. */
  sourceHash?: string;
  document?: { kind: 'pdf'; pageCount?: number };
  /** Scholarly record identity for research_search entries. */
  provider?: string;
  paperId?: string;
  /** Relation edge kind when the paper arrived via a relations expansion. */
  relation?: string;
  pinned: boolean;
}

interface WebSourcesState {
  sources: WebSource[];
  dismissedIds: string[];
  addSource: (source: Omit<WebSource, 'id' | 'pinned'>) => void;
  syncSessionSources: (sessionId: string, sources: Array<Omit<WebSource, 'id' | 'pinned'>>) => void;
  pinSource: (id: string) => void;
  unpinSource: (id: string) => void;
  deleteSource: (id: string) => void;
  clearSession: (sessionId: string) => void;
}

const sourceId = (source: Pick<WebSource, 'sessionId' | 'toolCallId' | 'url'>): string => (
  `${source.sessionId}\0${source.toolCallId}\0${source.url}`
);

export const useWebSourcesStore = create<WebSourcesState>()((set) => ({
  sources: [],
  dismissedIds: [],
  addSource: (source) => set((state) => {
    const id = sourceId(source);
    if (state.dismissedIds.includes(id) || state.sources.some((entry) => entry.id === id)) return state;
    return { sources: [...state.sources, { ...source, id, pinned: false }] };
  }),
  syncSessionSources: (sessionId, incoming) => set(state => {
    const existing = new Map(state.sources.filter(source => source.sessionId === sessionId).map(source => [source.id, source]));
    const projected = new Map<string, WebSource>();
    for (const source of incoming) {
      const id = sourceId(source);
      if (state.dismissedIds.includes(id)) continue;
      const previous = existing.get(id);
      const next = { ...source, id, pinned: previous?.pinned ?? false };
      projected.set(id, previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    // Explicitly pinned materials survive branch navigation. Unpinned rows
    // follow the current transcript, including removals and metadata updates.
    const sources = [...state.sources.filter(source => source.sessionId !== sessionId
      || source.pinned && !projected.has(source.id)), ...projected.values()];
    return sources.length === state.sources.length && sources.every((source, index) => source === state.sources[index]) ? state : { sources };
  }),
  pinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: true } : s),
  })),
  unpinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: false } : s),
  })),
  deleteSource: (id) => set((state) => ({
    sources: state.sources.filter((s) => s.id !== id),
    dismissedIds: state.dismissedIds.includes(id) ? state.dismissedIds : [...state.dismissedIds, id],
  })),
  clearSession: (sessionId) => set((state) => ({
    sources: state.sources.filter((s) => s.sessionId !== sessionId),
    dismissedIds: state.dismissedIds.filter((id) => !id.startsWith(`${sessionId}\0`)),
  })),
}));

let sourceRuntimeKey = getRuntimeKey();
subscribeRuntimeEndpointChanged(() => {
  const next = getRuntimeKey();
  if (next === sourceRuntimeKey) return;
  sourceRuntimeKey = next;
  useWebSourcesStore.setState({ sources: [], dismissedIds: [] });
});

// Leaf selectors per stores/DOCUMENTATION.md selector rules
export const useWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore(useShallow((state) => state.sources.filter((s) => s.sessionId === sessionId)));

export const usePinnedWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore(useShallow((state) => state.sources.filter((s) => s.sessionId === sessionId && s.pinned)));

import type { ThreadSummary } from '@varin/protocol';
import { create } from 'zustand';
import { useThreadDraftStore } from './useThreadDraftStore';
import {
  getRuntimeApiBaseUrl, getRuntimeKey,
  subscribeRuntimeEndpointWillChange, subscribeRuntimeEndpointChanged,
  type ThreadIdentity, type ThreadsAPI,
} from '@varin/application-client';

/** Endpoint and user-selected Host identity are both needed: labels may be reused. */
export const threadHostKey = (): string => JSON.stringify([getRuntimeApiBaseUrl(), getRuntimeKey()]);
export const threadIdentityKey = (host: string, identity: ThreadIdentity): string => JSON.stringify([host, identity.threadId, identity.branchId]);
const composerKeys = new Map<string, string>();
/** A local composer keeps its attachment and animation identity when its first send creates a Thread. */
export const threadComposerKey = (host: string, identity: ThreadIdentity): string => composerKeys.get(threadIdentityKey(host, identity)) ?? threadIdentityKey(host, identity);
export const selectedComposerKey = (state: Pick<ThreadNavigationState, 'hostKey' | 'selectedIdentity' | 'selectedDraftKey'>): string | null =>
  state.selectedIdentity ? threadComposerKey(state.hostKey, state.selectedIdentity) : state.selectedDraftKey;

type ThreadMetadata = Pick<ThreadSummary, 'title' | 'pinned' | 'archived'>;
interface ThreadNavigationState {
  hostKey: string;
  selectedIdentity: ThreadIdentity | null;
  selectedDraftKey: string | null;
  threads: ThreadSummary[];
  catalogLoaded: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
  loadCatalog(): Promise<void>;
  resolveThread(target: { threadId: string; branchId?: string }): Promise<{ identity: ThreadIdentity; botId: string | null }>;
  selectThread(identity: { threadId: string; branchId?: string }): Promise<ThreadIdentity>;
  openDraft(options?: { workspacePath?: string }): string;
  materializeDraft(draftKey: string): Promise<ThreadIdentity>;
  updateThread(threadId: string, patch: Partial<ThreadMetadata>): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  markRead(threadId: string, throughCursor: number): Promise<void>;
}

let boundAPI: ThreadsAPI | undefined;
let binding = 0;
let catalogRequest = 0;
let navigation = 0;
const deleted = new Set<string>();
let catalogPending: Promise<void> | undefined;
let catalogAgain = false;
const selections = new Map<string, ThreadIdentity>();
const draftSelections = new Map<string, string>();
const materializations = new Map<string, Promise<ThreadIdentity>>();
const selectedBranches = new Map<string, string>();
const mutationKeys = new Map<string, string>();
const requireAPI = () => { if (!boundAPI) throw new Error('Thread catalog is unavailable'); return boundAPI; };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function resolveCatalogIdentity(hostKey: string, thread: ThreadSummary, target: { threadId: string; branchId?: string }): ThreadIdentity {
  const remembered = selectedBranches.get(JSON.stringify([hostKey, target.threadId]));
  const branchId = target.branchId ?? (thread.branches.some(branch => branch.branch_id === remembered) ? remembered! : thread.main_branch_id);
  if (!thread.branches.some(branch => branch.branch_id === branchId)) throw new Error('Conversation branch is unavailable');
  return { runtime: 'agent', threadId: target.threadId, branchId };
}

/** Command receipts may precede newer events; merge independent Catalog clocks monotonically. */
function mergeSummary(previous: ThreadSummary | undefined, incoming: ThreadSummary): ThreadSummary {
  if (!previous) return incoming;
  const activity_cursor = Math.max(previous.activity_cursor, incoming.activity_cursor);
  const read_cursor = Math.max(previous.read_cursor, incoming.read_cursor);
  const newerMetadata = previous.revision > incoming.revision;
  return { ...incoming,
    ...(newerMetadata ? { title: previous.title, pinned: previous.pinned, archived: previous.archived, revision: previous.revision } : {}),
    ...(previous.activity_cursor > incoming.activity_cursor ? { branches: previous.branches, observer_project_ids: previous.observer_project_ids } : {}),
    deleted_at_ms: previous.deleted_at_ms ?? incoming.deleted_at_ms,
    updated_at_ms: Math.max(previous.updated_at_ms, incoming.updated_at_ms),
    activity_cursor, read_cursor, unread: activity_cursor > read_cursor,
  };
}

export const useThreadStore = create<ThreadNavigationState>((set, get) => ({
  hostKey: threadHostKey(), selectedIdentity: null, selectedDraftKey: null, threads: [], catalogLoaded: false,
  catalogLoading: false, catalogError: null,
  async loadCatalog() {
    if (catalogPending) { catalogAgain = true; return catalogPending; }
    const api = requireAPI(); const owner = binding; const request = ++catalogRequest;
    set({ catalogLoading: true });
    const pending = (async () => {
      try {
        do {
          catalogAgain = false;
          const threads = await api.list({ archived: 'include' });
          if (owner !== binding || request !== catalogRequest) return;
          const current = get();
          const merged = threads.filter(thread => !deleted.has(thread.thread_id)).map(thread => mergeSummary(current.threads.find(value => value.thread_id === thread.thread_id), thread));
          const selected = current.selectedIdentity;
          const retained = selected && merged.find(thread => thread.thread_id === selected.threadId && thread.branches.some(branch => branch.branch_id === selected.branchId));
          set({ threads: merged, catalogLoaded: true, catalogError: null,
            ...(selected && !retained ? { selectedIdentity: null } : {}) });
        } while (catalogAgain && owner === binding);
      } catch (error) {
        if (owner === binding && request === catalogRequest) set({ catalogError: errorMessage(error) });
        throw error;
      } finally { if (owner === binding && request === catalogRequest) { catalogPending = undefined; set({ catalogLoading: false }); } }
    })();
    catalogPending = pending; return pending;
  },
  async resolveThread(target) {
    requireAPI(); const owner = binding;
    let thread = get().threads.find(thread => thread.thread_id === target.threadId);
    if (!thread) { await get().loadCatalog(); thread = get().threads.find(thread => thread.thread_id === target.threadId); }
    if (owner !== binding) throw new Error('Conversation navigation was superseded');
    if (!thread) throw new Error('Conversation is unavailable on this Host');
    const identity = resolveCatalogIdentity(get().hostKey, thread, target);
    return { identity, botId: thread.bot_id };
  },
  async selectThread(target) {
    requireAPI();
    const owner = binding; const next = ++navigation;
    const thread = get().threads.find(thread => thread.thread_id === target.threadId);
    const identity = thread ? resolveCatalogIdentity(get().hostKey, thread, target) : (await get().resolveThread(target)).identity;
    if (owner !== binding || next !== navigation) throw new Error('Conversation navigation was superseded');
    // Catalog identity is authoritative; snapshot execution remains owned by ThreadProjection.
    const branchId = identity.branchId;
    selectedBranches.set(JSON.stringify([get().hostKey, target.threadId]), branchId);
    selections.set(get().hostKey, identity); draftSelections.delete(get().hostKey); set({ selectedIdentity: identity, selectedDraftKey: null });
    return identity;
  },
  openDraft(options) {
    const host = get().hostKey;
    navigation += 1;
    const key = JSON.stringify([host, 'draft', crypto.randomUUID()]);
    useThreadDraftStore.getState().patch(key, { workspacePath: options?.workspacePath });
    selections.delete(host); draftSelections.set(host, key);
    set({ selectedIdentity: null, selectedDraftKey: key });
    return key;
  },
  async materializeDraft(draftKey) {
    const api = requireAPI(); const owner = binding; const host = get().hostKey;
    const draft = useThreadDraftStore.getState().drafts[draftKey];
    if (!draft || JSON.parse(draftKey)[0] !== host) throw new Error('Conversation draft is unavailable on this Host');
    if (draft.identity) {
      if (get().selectedDraftKey === draftKey) {
        selections.set(host, draft.identity); draftSelections.delete(host);
        set({ selectedIdentity: draft.identity, selectedDraftKey: null });
      }
      return draft.identity;
    }
    const running = materializations.get(draftKey);
    if (running) return running;
    const pending = (async () => {
      // The local draft ID is also the stable creation key after a lost response.
      const identity = await api.create(draftKey);
      composerKeys.set(threadIdentityKey(host, identity), draftKey);
      useThreadDraftStore.getState().patch(draftKey, { identity });
      if (owner !== binding) throw new Error('Application Host changed during conversation creation');
      await get().loadCatalog().catch(() => {});
      if (owner === binding && get().selectedDraftKey === draftKey) {
        selections.set(host, identity); draftSelections.delete(host);
        set({ selectedIdentity: identity, selectedDraftKey: null });
      }
      return identity;
    })();
    materializations.set(draftKey, pending);
    try { return await pending; } finally { if (materializations.get(draftKey) === pending) materializations.delete(draftKey); }
  },
  async updateThread(threadId, patch) {
    const api = requireAPI(); const owner = binding;
    const thread = get().threads.find(thread => thread.thread_id === threadId);
    if (!thread) throw new Error('Conversation is unavailable');
    const fingerprint = JSON.stringify([get().hostKey, threadId, thread.revision, patch]);
    const key = mutationKeys.get(fingerprint) ?? crypto.randomUUID(); mutationKeys.set(fingerprint, key);
    const updated = await api.update({ runtime: 'agent', threadId, expectedRevision: thread.revision, key, ...patch });
    if (owner !== binding) return;
    mutationKeys.delete(fingerprint);
    set(state => ({ threads: state.threads.map(value => value.thread_id === threadId ? mergeSummary(value, updated) : value) }));
  },
  async deleteThread(threadId) {
    const api = requireAPI(); const owner = binding;
    const thread = get().threads.find(thread => thread.thread_id === threadId);
    if (!thread) throw new Error('Conversation is unavailable');
    const fingerprint = JSON.stringify([get().hostKey, threadId, thread.revision, 'delete']);
    const key = mutationKeys.get(fingerprint) ?? crypto.randomUUID(); mutationKeys.set(fingerprint, key);
    await api.delete({ runtime: 'agent', threadId, expectedRevision: thread.revision, key });
    if (owner !== binding) return;
    mutationKeys.delete(fingerprint); deleted.add(threadId);
    if (get().selectedIdentity?.threadId === threadId) selections.delete(get().hostKey);
    set(state => ({ threads: state.threads.filter(value => value.thread_id !== threadId), selectedIdentity: state.selectedIdentity?.threadId === threadId ? null : state.selectedIdentity }));
  },
  async markRead(threadId, throughCursor) {
    const api = requireAPI(); const owner = binding;
    const thread = get().threads.find(thread => thread.thread_id === threadId);
    if (!thread || thread.read_cursor >= throughCursor) return;
    const updated = await api.markRead({ runtime: 'agent', threadId, key: crypto.randomUUID(), throughCursor });
    if (owner === binding) set(state => ({ threads: state.threads.map(value => value.thread_id === threadId && value.read_cursor < updated.read_cursor ? { ...value, read_cursor: updated.read_cursor, unread: value.activity_cursor > updated.read_cursor } : value) }));
  },
}));

/** One binding per mounted Surface, with abort and epoch fencing before Host replacement. */
export function bindThreadStore(api: ThreadsAPI): () => void {
  let stopped = false;
  let abort = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    deleted.clear(); binding += 1; navigation += 1; catalogRequest += 1; catalogPending = undefined; catalogAgain = false;
    abort.abort(); if (retry) clearTimeout(retry); abort = new AbortController();
    boundAPI = api;
    const hostKey = threadHostKey();
    useThreadStore.setState({ hostKey, selectedIdentity: null, selectedDraftKey: draftSelections.get(hostKey) ?? null, threads: [], catalogLoaded: false, catalogLoading: false, catalogError: null });
  };
  const start = () => {
    reset(); const owner = binding; let cursor = 0; let dirty = false; let refreshing = false;
    const refresh = async () => {
      dirty = true; if (refreshing) return; refreshing = true;
      try { while (dirty && owner === binding && !stopped) { dirty = false; await useThreadStore.getState().loadCatalog(); } }
      finally { refreshing = false; }
    };
    const observe = async () => {
      if (stopped || owner !== binding) return;
      try {
        await refresh();
        if (stopped || owner !== binding) return;
        const restored = selections.get(threadHostKey());
        if (!useThreadStore.getState().selectedIdentity && !useThreadStore.getState().selectedDraftKey && restored) await useThreadStore.getState().selectThread(restored).catch(() => {});
        await api.observe(cursor, event => {
          if ('cursor' in event && !('stream' in event) && event.cursor > cursor && owner === binding) {
            cursor = event.cursor; void refresh().catch(() => {});
          }
        }, { signal: abort.signal });
      } catch (error) { if (owner === binding && !abort.signal.aborted) useThreadStore.setState({ catalogError: errorMessage(error) }); }
      if (!stopped && owner === binding && !abort.signal.aborted) retry = setTimeout(() => void observe(), 1000);
    };
    void observe();
  };
  const willChange = subscribeRuntimeEndpointWillChange(reset);
  const changed = subscribeRuntimeEndpointChanged(start);
  start();
  return () => { stopped = true; willChange(); changed(); abort.abort(); if (retry) clearTimeout(retry); binding += 1; boundAPI = undefined; catalogPending = undefined; catalogAgain = false; };
}

import { countUiWork } from '@/lib/performance-observation';
import type { ThreadSummary } from '@varin/protocol';
import { create } from 'zustand';
import { useThreadDraftStore, type ThreadDraft } from './useThreadDraftStore';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import {
  getRuntimeApiBaseUrl, getRuntimeKey, getThreadObservationBus,
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

type ThreadMetadata = Pick<ThreadSummary, 'title' | 'pinned' | 'archived'> & { titleMode?: 'automatic' | 'manual' };
interface ThreadNavigationState {
  hostKey: string;
  selectedIdentity: ThreadIdentity | null;
  selectedDraftKey: string | null;
  threads: ThreadSummary[];
  catalogLoaded: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
  loadCatalog(): Promise<void>;
  refreshThreads(threadIds: readonly string[]): Promise<void>;
  resolveThread(target: { threadId: string; branchId?: string }): Promise<{ identity: ThreadIdentity; botId: string | null; parentThreadId: string | null }>;
  selectThread(identity: { threadId: string; branchId?: string }): Promise<ThreadIdentity>;
  openDraft(options?: Pick<ThreadDraft, 'workspacePath' | 'sourceSelection' | 'organization' | 'projectId' | 'botId'>): string;
  materializeDraft(draftKey: string, options?: { waitForCatalog?: boolean }): Promise<ThreadIdentity>;
  updateThread(threadId: string, patch: Partial<ThreadMetadata>): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  deleteBranch(identity: ThreadIdentity): Promise<ThreadIdentity>;
  markRead(threadId: string, throughCursor: number): Promise<void>;
}

let boundAPI: ThreadsAPI | undefined;
let binding = 0;
let catalogRequest = 0;
let navigation = 0;
const deleted = new Set<string>();
const deletedBranches = new Set<string>();
let catalogPending: Promise<void> | undefined;
let catalogAgain = false;
let inspectPending: Promise<void> | undefined;
const dirtyThreads = new Set<string>();
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
    title_mode: newerMetadata ? previous.title_mode : incoming.title_mode ?? previous.title_mode,
    ...(newerMetadata ? { title: previous.title, pinned: previous.pinned, archived: previous.archived, revision: previous.revision } : {}),
    ...(previous.activity_cursor > incoming.activity_cursor ? {
      branches: incoming.revision <= previous.revision
        ? previous.branches
        : incoming.branches.map(branch => previous.branches.find(current => current.branch_id === branch.branch_id) ?? branch),
      observer_project_ids: previous.observer_project_ids,
    } : {}),
    deleted_at_ms: previous.deleted_at_ms ?? incoming.deleted_at_ms,
    updated_at_ms: Math.max(previous.updated_at_ms, incoming.updated_at_ms),
    activity_cursor, read_cursor, unread: activity_cursor > read_cursor,
  };
}

const sortSummaries = (threads: ThreadSummary[]): ThreadSummary[] => threads.sort((a, b) =>
  Number(b.pinned) - Number(a.pinned) || b.updated_at_ms - a.updated_at_ms || a.thread_id.localeCompare(b.thread_id));

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
          const selectedNavigation = navigation;
          if (import.meta.env.DEV) countUiWork('catalog.list');
          const threads = await api.list({ archived: 'include' });
          if (owner !== binding || request !== catalogRequest) return;
          const current = get();
          const previous = new Map(current.threads.map(thread => [thread.thread_id, thread]));
          const merged = threads.filter(thread => !deleted.has(thread.thread_id)).map(thread => {
            const summary = mergeSummary(previous.get(thread.thread_id), thread);
            return deletedBranches.size ? { ...summary, branches: summary.branches.filter(branch => !deletedBranches.has(branch.branch_id)) } : summary;
          });
          const selected = current.selectedIdentity;
          const selectedThread = selected && merged.find(thread => thread.thread_id === selected.threadId);
          const retained = selectedThread && selectedThread.branches.some(branch => branch.branch_id === selected?.branchId);
          const fallback = selectedThread ? { runtime: 'agent' as const, threadId: selectedThread.thread_id, branchId: selectedThread.main_branch_id } : null;
          // A list started before navigation cannot invalidate a newly accepted
          // creation or selection. A subsequent current read still owns removal.
          const reconcileSelection = selected && !retained && selectedNavigation === navigation;
          if (reconcileSelection && fallback) selections.set(current.hostKey, fallback);
          set({ threads: sortSummaries(merged), catalogLoaded: true, catalogError: null,
            ...(reconcileSelection ? { selectedIdentity: fallback } : {}) });
        } while (catalogAgain && owner === binding);
      } catch (error) {
        if (owner === binding && request === catalogRequest) set({ catalogError: errorMessage(error) });
        throw error;
      } finally { if (owner === binding && request === catalogRequest) { catalogPending = undefined; set({ catalogLoading: false }); } }
    })();
    catalogPending = pending; return pending;
  },
  refreshThreads(threadIds) {
    for (const id of threadIds) dirtyThreads.add(id);
    if (inspectPending) return inspectPending;
    const api = requireAPI(), owner = binding;
    const pending = Promise.resolve().then(async () => {
      while (dirtyThreads.size && owner === binding) {
        // A complete read owns membership. Resolve deltas after it, not in a race
        // that can remove a newly accepted creation from an older list response.
        if (catalogPending) await catalogPending;
        if (owner !== binding) return;
        const ids = [...dirtyThreads]; dirtyThreads.clear();
        const generation = catalogRequest, selectedNavigation = navigation;
        try {
          if (import.meta.env.DEV) countUiWork('catalog.inspectMany');
          const updates = await api.inspectMany(ids);
          if (owner !== binding) return;
          if (generation !== catalogRequest) { for (const id of ids) dirtyThreads.add(id); continue; }
          const state = get(), previous = new Map(state.threads.map(thread => [thread.thread_id, thread]));
          for (const id of ids) previous.delete(id);
          const old = new Map(state.threads.map(thread => [thread.thread_id, thread]));
          for (const incoming of updates) {
            if (deleted.has(incoming.thread_id) || incoming.deleted_at_ms !== null) continue;
            const summary = mergeSummary(old.get(incoming.thread_id), incoming);
            previous.set(incoming.thread_id, deletedBranches.size ? { ...summary, branches: summary.branches.filter(branch => !deletedBranches.has(branch.branch_id)) } : summary);
          }
          const selected = state.selectedIdentity;
          const updatedSelection = selected && ids.includes(selected.threadId) && selectedNavigation === navigation;
          const target = selected ? previous.get(selected.threadId) : undefined;
          const fallback = updatedSelection && !target?.branches.some(branch => branch.branch_id === selected.branchId)
            ? target ? { runtime: 'agent' as const, threadId: target.thread_id, branchId: target.main_branch_id } : null : selected;
          if (updatedSelection && fallback !== selected) {
            if (fallback) selections.set(state.hostKey, fallback); else selections.delete(state.hostKey);
          }
          set({ threads: sortSummaries([...previous.values()]), ...(state.catalogLoaded ? { catalogError: null } : {}),
            ...(updatedSelection ? { selectedIdentity: fallback } : {}) });
        } catch (error) {
          if (owner === binding) { for (const id of ids) dirtyThreads.add(id); set({ catalogError: errorMessage(error) }); }
          throw error;
        }
      }
    }).finally(() => { if (inspectPending === pending) inspectPending = undefined; });
    inspectPending = pending;
    return pending;
  },
  async resolveThread(target) {
    requireAPI(); const owner = binding;
    let thread = get().threads.find(thread => thread.thread_id === target.threadId);
    if (!thread || target.branchId && !thread.branches.some(branch => branch.branch_id === target.branchId)) {
      await get().refreshThreads([target.threadId]); thread = get().threads.find(thread => thread.thread_id === target.threadId);
    }
    if (owner !== binding) throw new Error('Conversation navigation was superseded');
    if (!thread) throw new Error('Conversation is unavailable on this Host');
    const identity = resolveCatalogIdentity(get().hostKey, thread, target);
    return { identity, botId: thread.bot_id, parentThreadId: thread.parent_thread_id };
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
    useThreadDraftStore.getState().patch(key, options ? structuredClone(options) : {});
    selections.delete(host); draftSelections.set(host, key);
    set({ selectedIdentity: null, selectedDraftKey: key });
    return key;
  },
  async materializeDraft(draftKey, options) {
    const api = requireAPI(); const owner = binding; const host = get().hostKey; const selectedNavigation = navigation;
    const draft = useThreadDraftStore.getState().drafts[draftKey];
    if (!draft || JSON.parse(draftKey)[0] !== host) throw new Error('Conversation draft is unavailable on this Host');
    if (draft.identity) {
      if (get().selectedDraftKey === draftKey) {
        navigation += 1;
        selections.set(host, draft.identity); draftSelections.delete(host);
        set({ selectedIdentity: draft.identity, selectedDraftKey: null });
      }
      return draft.identity;
    }
    const running = materializations.get(draftKey);
    if (running) return running;
    const pending = (async () => {
      // The local draft ID is also the stable creation key after a lost response.
      const identity = draft.botId
        ? (await (() => { const bots = getRegisteredRuntimeAPIs()?.bots; if (!bots) throw new Error('Bot service is unavailable'); return bots.sessions.create(draft.botId!, { key: draftKey, ...(draft.organization ? { organization: draft.organization } : {}) }); })()).identity
        : await (draft.organization ? api.create(draftKey, { organization: draft.organization }) : api.create(draftKey));
      composerKeys.set(threadIdentityKey(host, identity), draftKey);
      useThreadDraftStore.getState().patch(draftKey, { identity });
      if (owner !== binding) throw new Error('Application Host changed during conversation creation');
      const selectCreated = () => {
        if (owner === binding && selectedNavigation === navigation && get().selectedDraftKey === draftKey) {
          navigation += 1;
          selections.set(host, identity); draftSelections.delete(host);
          set({ selectedIdentity: identity, selectedDraftKey: null });
        }
      };
      // Creation is authoritative. First send mounts the real conversation and
      // its observer immediately; an older sidebar read cannot undo that navigation.
      if (options?.waitForCatalog === false) selectCreated();
      const catalogReady = get().refreshThreads([identity.threadId]).catch(() => {});
      if (options?.waitForCatalog !== false) { await catalogReady; selectCreated(); }
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
    set(state => ({ threads: sortSummaries(state.threads.map(value => value.thread_id === threadId ? mergeSummary(value, updated) : value)) }));
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
  async deleteBranch(identity) {
    const api = requireAPI();
    const owner = binding;
    const host = get().hostKey;
    const fingerprint = JSON.stringify([host, identity.threadId, identity.branchId, 'delete-branch']);
    const key = mutationKeys.get(fingerprint) ?? crypto.randomUUID();
    mutationKeys.set(fingerprint, key);
    const summary = await api.deleteBranch({ ...identity, key });
    if (owner !== binding) throw new Error('Application Host changed during branch deletion');
    mutationKeys.delete(fingerprint);
    deletedBranches.add(identity.branchId);
    const fallback = { ...identity, branchId: summary.main_branch_id };
    const current = get();
    const selected = current.selectedIdentity;
    const switchBranch = selected?.threadId === identity.threadId && selected.branchId === identity.branchId;
    if (switchBranch) selections.set(host, fallback);
    set({
      threads: current.threads.map(thread => {
        if (thread.thread_id !== identity.threadId) return thread;
        const updated = mergeSummary(thread, summary);
        return { ...updated, branches: updated.branches.filter(branch => !deletedBranches.has(branch.branch_id)) };
      }),
      ...(switchBranch ? { selectedIdentity: fallback } : {}),
    });
    return fallback;
  },
  async markRead(threadId, throughCursor) {
    const api = requireAPI(); const owner = binding;
    const thread = get().threads.find(thread => thread.thread_id === threadId);
    if (!thread || thread.read_cursor >= throughCursor) return;
    const updated = await api.markRead({ runtime: 'agent', threadId, key: crypto.randomUUID(), throughCursor });
    if (owner === binding) set(state => ({ threads: state.threads.map(value => value.thread_id === threadId && value.read_cursor < updated.read_cursor ? { ...value, read_cursor: updated.read_cursor, unread: value.activity_cursor > updated.read_cursor } : value) }));
  },
}));

/** One binding per mounted Surface; all views share the Host observation bus. */
export function bindThreadStore(api: ThreadsAPI): () => void {
  let stopped = false;
  let stopObservation: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    deleted.clear(); deletedBranches.clear(); dirtyThreads.clear(); inspectPending = undefined;
    binding += 1; navigation += 1; catalogRequest += 1; catalogPending = undefined; catalogAgain = false;
    stopObservation?.(); stopObservation = undefined;
    if (retry) clearTimeout(retry); retry = undefined;
    boundAPI = api;
    const hostKey = threadHostKey();
    useThreadStore.setState({ hostKey, selectedIdentity: null, selectedDraftKey: draftSelections.get(hostKey) ?? null, threads: [], catalogLoaded: false, catalogLoading: false, catalogError: null });
  };
  const start = () => {
    reset(); const owner = binding;
    const current = () => !stopped && owner === binding;
    const refresh = async (full = false): Promise<void> => {
      if (!current()) return;
      try {
        if (full || !useThreadStore.getState().catalogLoaded) await useThreadStore.getState().loadCatalog();
        if (current() && dirtyThreads.size) await useThreadStore.getState().refreshThreads([]);
        if (!current()) return;
        const restored = selections.get(threadHostKey());
        if (!useThreadStore.getState().selectedIdentity && !useThreadStore.getState().selectedDraftKey && restored)
          await useThreadStore.getState().selectThread(restored).catch(() => {});
      } catch (error) {
        if (!current()) return;
        useThreadStore.setState({ catalogError: errorMessage(error) });
        if (!retry) retry = setTimeout(() => { retry = undefined; void refresh(full); }, 1000);
      }
    };
    // Catalog summaries include branch/run state and visible activity. Metadata
    // unrelated to a Thread cannot invalidate this directory.
    stopObservation = getThreadObservationBus(api).subscribe({ kinds: ['thread.*', 'branch.*', 'run.*', 'assistant.output', 'history.appended', 'permission.opened', 'question.opened'] }, event => {
      if (!current()) return;
      if ('stream' in event) { if (event.stream === 'resync') void refresh(true); return; }
      if (!event.thread_id) return;
      dirtyThreads.add(event.thread_id);
      void refresh();
    });
    void refresh(true);
  };
  const willChange = subscribeRuntimeEndpointWillChange(reset);
  const changed = subscribeRuntimeEndpointChanged(start);
  start();
  return () => {
    stopped = true; willChange(); changed(); stopObservation?.(); if (retry) clearTimeout(retry);
    binding += 1; boundAPI = undefined; catalogPending = undefined; catalogAgain = false; inspectPending = undefined; dirtyThreads.clear();
  };
}

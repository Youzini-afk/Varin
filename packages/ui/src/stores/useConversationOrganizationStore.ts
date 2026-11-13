import { countUiWork } from '@/lib/performance-observation';
import React from 'react';
import { create } from 'zustand';
import { getRuntimeEndpointGeneration, ConversationOrganizationError, type ConversationOrganizationMetadataItem, type ConversationOrganizationMetadataResult, type ConversationOrganizationAPI, type ConversationOrganizationCommand, type ConversationOrganizationOperation, type ConversationOrganizationReceipt, type ConversationOrganizationSnapshot, type ConversationOrganizationQuery, type BotSummary, type ConversationOrganizationEvent } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useThreadStore } from './useThreadStore';
import { useExternalAgentStore } from './useExternalAgentStore';

export interface OrganizationPage { query: ConversationOrganizationQuery; snapshot: ConversationOrganizationSnapshot | null; loading: boolean; error: string | null }
export interface OrganizationMetadataIntent {
  input: { key: string; items: ConversationOrganizationMetadataItem[] };
  names?: Record<string, string>;
  results: ConversationOrganizationMetadataResult[]; pending: boolean;
}
interface OrganizationState {
  host: number; snapshot: ConversationOrganizationSnapshot | null; loading: boolean; error: string | null;
  pages: Record<string, OrganizationPage>;
  pending: Record<string, ConversationOrganizationCommand>; failed: Record<string, ConversationOrganizationCommand>;
  metadata: Record<string, OrganizationMetadataIntent>;
  bots: BotSummary[] | null; botsError: string | null;
}
export const organizationQueryKey = (query: ConversationOrganizationQuery): string => JSON.stringify(Object.entries({ ...query, pageNodes: true }).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
const rootQuery: ConversationOrganizationQuery = { pageNodes: true, rootOnly: true, archived: 'exclude', excludeBotConversations: true };
export const useConversationOrganizationStore = create<OrganizationState>(() => ({ host: -1, snapshot: null, loading: false, error: null, pages: {}, pending: {}, failed: {}, metadata: {}, bots: null, botsError: null }));
let binding: { host: number; api: ConversationOrganizationAPI; controller: AbortController; refresh(): Promise<void>; load(query: ConversationOrganizationQuery, more?: boolean): Promise<void>; users: number; stop(): void } | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Stable identities merge light metadata; ancestor context never consumes a page slot. */
export function mergeOrganizationSnapshots(snapshots: ConversationOrganizationSnapshot[]): ConversationOrganizationSnapshot | null {
  const ordered = [...snapshots].sort((a, b) => a.cursor - b.cursor);
  const latest = ordered.at(-1); if (!latest) return null;
  const containers = new Map<string, ConversationOrganizationSnapshot['containers'][number]>();
  const entries = new Map<string, ConversationOrganizationSnapshot['conversations'][number]>();
  const items = new Map<string, NonNullable<ConversationOrganizationSnapshot['items']>[number]>();
  for (const snapshot of ordered) {
    for (const container of snapshot.containers) {
      const previous = containers.get(container.id);
      if (!previous || container.revision >= previous.revision && container.childrenRevision >= previous.childrenRevision) containers.set(container.id, container);
    }
    for (const entry of snapshot.conversations) {
      const key = JSON.stringify([entry.conversation.kind, entry.conversation.id]), previous = entries.get(key);
      if (!previous || entry.position.revision >= previous.position.revision && entry.revision >= previous.revision) entries.set(key, entry);
    }
    for (const item of snapshot.items ?? []) items.set(JSON.stringify([item.kind, item.id]), item);
  }
  return { ...latest, containers: [...containers.values()], conversations: [...entries.values()],
    ...(ordered.some(snapshot => snapshot.items !== undefined) ? { items: [...items.values()] } : {}), nextCursor: null };
}
const mergePages = (pages: Record<string, OrganizationPage>) => mergeOrganizationSnapshots(Object.values(pages).flatMap(page => page.snapshot ?? []));
/** A view uses only its own page membership, never another search/picker's cached results. */
export function organizationViewSnapshot(pages: Record<string, OrganizationPage>, query: ConversationOrganizationQuery, expanded: (object: { kind: 'container' | 'native' | 'external'; id: string }) => boolean): ConversationOrganizationSnapshot | null {
  const snapshots: ConversationOrganizationSnapshot[] = [];
  const visited = new Set<string>();
  const collect = (scope: ConversationOrganizationQuery) => {
    const key = organizationQueryKey(scope); if (visited.has(key)) return; visited.add(key);
    const snapshot = pages[key]?.snapshot; if (!snapshot) return; snapshots.push(snapshot);
    if (scope.conversationTree) {
      // Retain already loaded descendants while folding; reads are started only by opened rows.
      for (const entry of snapshot.conversations) if (entry.hasChildren) {
        collect({ ...scope, conversationTree: { parent: entry.conversation } });
      }
      return;
    }
    if (query.query || query.kind === 'conversations') return;
    const memberIds = snapshot.items ? new Set(snapshot.items.filter(item => item.kind === 'container').map(item => item.id)) : null;
    for (const container of snapshot.containers) if ((!memberIds || memberIds.has(container.id)) && expanded({ kind: 'container', id: container.id })) {
      collect({ pageNodes: true, containerId: container.id, archived: query.archived, ...(query.botId ? { botId: query.botId } : {}), ...(query.excludeBotConversations ? { excludeBotConversations: true } : {}) });
    }
  };
  collect(query);
  return mergeOrganizationSnapshots(snapshots);
}
const appendPage = (previous: ConversationOrganizationSnapshot, next: ConversationOrganizationSnapshot): ConversationOrganizationSnapshot => ({ ...mergeOrganizationSnapshots([previous, next])!, nextCursor: next.nextCursor });
const pageLength = (snapshot: ConversationOrganizationSnapshot | null | undefined) => snapshot?.items?.length ?? snapshot?.conversations.length ?? 0;
export async function refreshConversationOrganization(): Promise<void> { await binding?.refresh(); }
export async function loadOrganizationPage(query: ConversationOrganizationQuery, more = false): Promise<void> {
  const owner = binding; if (!owner || owner.host !== getRuntimeEndpointGeneration()) return;
  const page = useConversationOrganizationStore.getState().pages[organizationQueryKey(query)];
  if (!more && (page?.snapshot || page?.loading)) return;
  await owner.load({ ...query, pageNodes: true }, more);
}
/** Full reads exist only for an explicit operation's fixed scope, not for background navigation. */
export async function readOrganizationActionScope(query: ConversationOrganizationQuery, signal?: AbortSignal): Promise<ConversationOrganizationSnapshot> {
  const owner = binding;
  if (!owner || owner.host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
  const requestSignal = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal;
  const valid = () => {
    requestSignal.throwIfAborted();
    if (binding !== owner || owner.host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
  };
  const scope = { ...query, pageNodes: true };
  valid();
  let result = await owner.api.read(scope, requestSignal); valid();
  while (result.nextCursor) {
    const next = await owner.api.read({ ...scope, cursor: result.nextCursor }, requestSignal); valid();
    // Catalog cursors bind the relevant scope generation; unrelated branch edits may proceed.
    result = appendPage(result, next);
  }
  return result;
}
/** Commands retain their original acceptance key on ambiguous failure; no optimistic authority. */
export async function submitOrganization(operation: ConversationOrganizationOperation, retry?: ConversationOrganizationCommand): Promise<ConversationOrganizationReceipt | undefined> {
  const owner = binding;
  if (!owner || owner.host !== getRuntimeEndpointGeneration()) throw new Error('Conversation organization is unavailable on this Host');
  const command = retry ?? Object.values({ ...useConversationOrganizationStore.getState().failed, ...useConversationOrganizationStore.getState().pending }).find(command => JSON.stringify(command.operation) === JSON.stringify(operation)) ?? { key: crypto.randomUUID(), operation };
  if (useConversationOrganizationStore.getState().pending[command.key]) return;
  useConversationOrganizationStore.setState(state => ({ pending: { ...state.pending, [command.key]: command }, error: null }));
  try {
    const receipt = await owner.api.command(command, owner.controller.signal);
    if (!currentMutationHost(owner.host)) return;
    useConversationOrganizationStore.setState(state => { const failed = { ...state.failed }; delete failed[command.key]; return { failed }; });
    await refreshConversationOrganization(); return receipt;
  } catch (error) {
    if (!currentMutationHost(owner.host)) return;
    const known = error instanceof ConversationOrganizationError && !['unknown_outcome', 'unavailable'].includes(error.code);
    useConversationOrganizationStore.setState(state => {
      const failed = { ...state.failed };
      if (known) delete failed[command.key];
      else failed[command.key] = command;
      return { error: message(error), failed };
    });
    await refreshConversationOrganization(); throw error;
  } finally {
    if (currentMutationHost(owner.host)) useConversationOrganizationStore.setState(state => { const pending = { ...state.pending }; delete pending[command.key]; return { pending }; });
  }
}
const currentMutationHost = (host: number) => host === getRuntimeEndpointGeneration() && useConversationOrganizationStore.getState().host === host;
const metadataKey = (item: { conversation: { kind: string; id: string } }) => JSON.stringify([item.conversation.kind, item.conversation.id]);
export const unresolvedOrganizationMetadata = (intent: OrganizationMetadataIntent) => intent.input.items.filter(item => !intent.results.some(result => metadataKey(result) === metadataKey(item) && result.status === 'succeeded'));
/** UI delivery intent only: original owners retain authority, acceptance and per-item receipts. */
export async function submitOrganizationMetadata(items: ConversationOrganizationMetadataItem[], retryKey?: string): Promise<void> {
  const owner = binding;
  if (!owner || !currentMutationHost(owner.host)) throw new Error('Conversation organization is unavailable on this Host');
  const state = useConversationOrganizationStore.getState();
  const existing = retryKey ? state.metadata[retryKey] : Object.values(state.metadata).find(intent => unresolvedOrganizationMetadata(intent).length && (JSON.stringify(intent.input.items) === JSON.stringify(items) || JSON.stringify(unresolvedOrganizationMetadata(intent)) === JSON.stringify(items)));
  if (retryKey && !existing) throw new Error('The original metadata intent is unavailable on this Host');
  const intent: OrganizationMetadataIntent = existing ?? { input: { key: crypto.randomUUID(), items: structuredClone(items) }, names: Object.fromEntries(items.flatMap(item => {
    const entry = state.snapshot?.conversations.find(entry => metadataKey(entry) === metadataKey(item));
    return entry ? [[metadataKey(item), entry.title]] : [];
  })), results: [], pending: false };
  if (intent.pending) return;
  const remaining = unresolvedOrganizationMetadata(intent); if (!remaining.length) return;
  const key = intent.input.key;
  useConversationOrganizationStore.setState(state => ({ metadata: { ...state.metadata, [key]: { ...intent, pending: true } } }));
  const settle = (received: ConversationOrganizationMetadataResult[]) => {
    if (!currentMutationHost(owner.host)) return;
    useConversationOrganizationStore.setState(state => {
      const current = state.metadata[key]; if (!current) return state;
      const results = new Map(current.results.map(result => [metadataKey(result), result]));
      for (const item of remaining) results.set(metadataKey(item), received.find(result => metadataKey(result) === metadataKey(item)) ?? { conversation: item.conversation, status: 'unknown' });
      const settled = { ...current, results: [...results.values()], pending: false };
      const metadata = { ...state.metadata };
      // Retain partial receipts until every original item is confirmed, then retire the UI intent.
      if (unresolvedOrganizationMetadata(settled).length) metadata[key] = settled;
      else delete metadata[key];
      return { metadata };
    });
  };
  try {
    const result = await owner.api.metadata({ key, items: remaining }, owner.controller.signal);
    settle(result.items);
  } catch (error) {
    settle(remaining.map(item => ({ conversation: item.conversation, status: 'unknown', message: message(error) })));
    if (currentMutationHost(owner.host)) throw error;
  } finally {
    if (currentMutationHost(owner.host)) {
      await refreshConversationOrganization();
      const nativeIds = remaining.flatMap(item => item.conversation.kind === 'native' ? [item.conversation.id] : []);
      if (currentMutationHost(owner.host) && nativeIds.length) await useThreadStore.getState().refreshThreads(nativeIds);
      if (currentMutationHost(owner.host) && remaining.some(item => item.conversation.kind === 'external')) await useExternalAgentStore.getState().refresh();
    }
  }
}
export function useConversationOrganization(active?: boolean): void;
export function useConversationOrganization<T>(active: boolean, selector: (state: OrganizationState) => T): T;
export function useConversationOrganization<T>(active = true, selector?: (state: OrganizationState) => T) {
  const { conversationOrganization: api, bots } = useRuntimeAPIs(); const hostKey = useThreadStore(state => state.hostKey);
  React.useEffect(() => {
    if (!api || !active) return;
    const host = getRuntimeEndpointGeneration();
    if (!binding || binding.host !== host || binding.api !== api) {
      binding?.stop(); const controller = new AbortController();
      const requests = new Map<string, Promise<void>>();
      const dirty = new Map<string, ConversationOrganizationQuery>(), failedReads = new Map<string, ConversationOrganizationQuery>();
      let refreshing: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
      const valid = () => binding === owner && !controller.signal.aborted && host === getRuntimeEndpointGeneration();
      const load = (query: ConversationOrganizationQuery, more = false): Promise<void> => {
        const key = organizationQueryKey(query), running = requests.get(key); if (running) return running;
        const previous = useConversationOrganizationStore.getState().pages[key];
        if (more && !previous?.snapshot?.nextCursor) return Promise.resolve();
        useConversationOrganizationStore.setState(state => ({ pages: { ...state.pages, [key]: { query, snapshot: previous?.snapshot ?? null, loading: true, error: null } } }));
        const request = (async () => {
          try {
            if (import.meta.env.DEV) countUiWork('organization.refresh');
            let page = await api.read({ ...query, ...(more ? { cursor: previous!.snapshot!.nextCursor! } : {}) }, controller.signal);
            // Refresh only the window the person already loaded, never every continuation.
            while (!more && page.nextCursor && pageLength(page) < pageLength(previous?.snapshot) && valid()) {
              const next = await api.read({ ...query, cursor: page.nextCursor }, controller.signal);
              page = appendPage(page, next);
            }
            if (!valid()) return;
            failedReads.delete(key);
            const snapshot = more ? appendPage(previous!.snapshot!, page) : page;
            useConversationOrganizationStore.setState(state => { const pages = { ...state.pages, [key]: { query, snapshot, loading: false, error: null } }; return { pages, snapshot: mergePages(pages), loading: false }; });
          } catch (error) {
            if (valid()) {
              useConversationOrganizationStore.setState(state => ({ loading: false, pages: { ...state.pages, [key]: { query, snapshot: previous?.snapshot ?? null, loading: false, error: message(error) } }, error: message(error) }));
              failedReads.set(key, query);
              if (!timer) timer = setTimeout(() => { timer = undefined; void refresh([...failedReads.values()]); }, 1500);
            }
          }
        })().finally(() => requests.delete(key));
        requests.set(key, request); return request;
      };
      const refresh = (queries?: readonly ConversationOrganizationQuery[]): Promise<void> => {
        const scopes = queries ?? Object.values(useConversationOrganizationStore.getState().pages).map(page => page.query);
        for (const query of scopes.length || queries ? scopes : [rootQuery]) dirty.set(organizationQueryKey(query), query);
        if (refreshing) return refreshing;
        refreshing = Promise.resolve().then(async () => {
          while (dirty.size && valid()) {
            const batch = [...dirty.values()]; dirty.clear();
            for (const query of batch) {
              if (!valid()) return;
              // If a foreground page read was already underway when invalidated,
              // wait and reread it; joining its older result can miss this event.
              await requests.get(organizationQueryKey(query));
              if (valid()) await load(query);
            }
          }
        }).finally(() => { refreshing = null; }); return refreshing;
      };
      const owner = { host, api, controller, refresh, load, users: 0, stop() { controller.abort(); stopEvents(); if (timer) clearTimeout(timer); } };
      binding = owner;
      useConversationOrganizationStore.setState(state => state.host === host
        ? { loading: true }
        : { host, snapshot: null, pages: {}, loading: true, error: null, pending: {}, failed: {}, metadata: {}, bots: null, botsError: null });
      const loadBots = async () => { try { const values = await bots?.list(controller.signal); if (valid()) useConversationOrganizationStore.setState({ bots: values ?? [], botsError: null }); } catch (error) { if (valid()) useConversationOrganizationStore.setState({ botsError: message(error) }); } };
      const stopEvents = subscribeVarinEvents(event => { if (event.type === 'bot-changed' || event.type === 'stream-ready') void loadBots(); });
      const onEvent = (event: ConversationOrganizationEvent) => {
        if (!valid()) return;
        if ('stream' in event) { if (event.stream === 'resync') void refresh(); return; }
        const pages = Object.values(useConversationOrganizationStore.getState().pages);
        const metadata = ['organization.changed', 'thread.created', 'thread.updated', 'thread.deleted', 'external.created', 'external.changed', 'external.child_accepted'].includes(event.kind);
        const activity = ['run.accepted', 'run.changed', 'run.cancel_requested', 'assistant.output', 'history.appended', 'permission.opened', 'question.opened'].includes(event.kind);
        if (metadata) void refresh(pages.length ? pages.map(page => page.query) : [rootQuery]);
        // Activity cannot change manual classification. Only already-loaded recent
        // windows depend on it, including ancestor activity in conversation trees.
        else if (activity && event.thread_id) void refresh(pages.filter(page => page.query.sort === 'recent').map(page => page.query));
      };
      // Subscribe before loading. Bus readiness/resync closes the initial read race
      // and reconnects without owning another polling/retry loop in this store.
      void api.observe(0, onEvent, { signal: controller.signal }).catch(error => {
        if (valid()) useConversationOrganizationStore.setState({ error: message(error) });
      });
      if (Object.keys(useConversationOrganizationStore.getState().pages).length) void refresh();
      else void load(rootQuery);
      void loadBots();
    }
    const owner = binding; owner.users++;
    return () => { if (--owner.users === 0) { owner.stop(); if (binding === owner) binding = null; } };
  }, [api, bots, hostKey, active]);
  return useConversationOrganizationStore<T | undefined>(selector ?? (() => undefined));
}

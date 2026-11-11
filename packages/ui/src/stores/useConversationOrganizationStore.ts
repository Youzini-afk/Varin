import React from 'react';
import { create } from 'zustand';
import { getRuntimeEndpointGeneration, ConversationOrganizationError, type ConversationOrganizationAPI, type ConversationOrganizationCommand, type ConversationOrganizationOperation, type ConversationOrganizationReceipt, type ConversationOrganizationSnapshot, type ConversationOrganizationQuery, type BotSummary } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useThreadStore } from './useThreadStore';

export interface OrganizationPage { query: ConversationOrganizationQuery; snapshot: ConversationOrganizationSnapshot | null; loading: boolean; error: string | null }
interface OrganizationState {
  host: number; snapshot: ConversationOrganizationSnapshot | null; loading: boolean; error: string | null;
  pages: Record<string, OrganizationPage>;
  pending: Record<string, ConversationOrganizationCommand>; failed: Record<string, ConversationOrganizationCommand>;
  bots: BotSummary[] | null; botsError: string | null;
}
export const organizationQueryKey = (query: ConversationOrganizationQuery): string => JSON.stringify(Object.entries(query).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)));
const rootQuery: ConversationOrganizationQuery = { rootOnly: true, archived: 'exclude' };
export const useConversationOrganizationStore = create<OrganizationState>(() => ({ host: -1, snapshot: null, loading: false, error: null, pages: {}, pending: {}, failed: {}, bots: null, botsError: null }));
let binding: { host: number; api: ConversationOrganizationAPI; controller: AbortController; refresh(): Promise<void>; load(query: ConversationOrganizationQuery, more?: boolean): Promise<void>; users: number; stop(): void } | null = null;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** The newest directory metadata is authoritative; loaded query pages contribute only conversation refs. */
function mergePages(pages: Record<string, OrganizationPage>): ConversationOrganizationSnapshot | null {
  const snapshots = Object.values(pages).flatMap(page => page.snapshot ?? []).sort((a, b) => a.cursor - b.cursor);
  const latest = snapshots.at(-1); if (!latest) return null;
  const entries = new Map<string, ConversationOrganizationSnapshot['conversations'][number]>();
  for (const snapshot of snapshots) for (const entry of snapshot.conversations) {
    const key = JSON.stringify(entry.conversation), previous = entries.get(key);
    if (!previous || entry.position.revision >= previous.position.revision && entry.revision >= previous.revision) entries.set(key, entry);
  }
  return { ...latest, conversations: [...entries.values()], nextCursor: null };
}
export async function refreshConversationOrganization(): Promise<void> { await binding?.refresh(); }
export async function loadOrganizationPage(query: ConversationOrganizationQuery, more = false): Promise<void> {
  const owner = binding; if (!owner || owner.host !== getRuntimeEndpointGeneration()) return;
  const page = useConversationOrganizationStore.getState().pages[organizationQueryKey(query)];
  if (!more && (page?.snapshot || page?.loading)) return;
  await owner.load(query, more);
}
/** Full reads exist only for an explicit operation's fixed scope, not for background navigation. */
export async function readOrganizationActionScope(query: ConversationOrganizationQuery): Promise<ConversationOrganizationSnapshot> {
  const owner = binding;
  if (!owner || owner.host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed');
  let result = await owner.api.read(query, owner.controller.signal);
  while (result.nextCursor) {
    const next = await owner.api.read({ ...query, cursor: result.nextCursor }, owner.controller.signal);
    result = { ...next, conversations: [...result.conversations, ...next.conversations] };
  }
  if (binding !== owner) throw new Error('Application Host changed');
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
    if (binding !== owner) return;
    useConversationOrganizationStore.setState(state => { const failed = { ...state.failed }; delete failed[command.key]; return { failed }; });
    await owner.refresh(); return receipt;
  } catch (error) {
    if (binding !== owner) return;
    const known = error instanceof ConversationOrganizationError && !['unknown_outcome', 'unavailable'].includes(error.code);
    useConversationOrganizationStore.setState(state => ({ error: message(error), failed: known ? state.failed : { ...state.failed, [command.key]: command } }));
    await owner.refresh(); throw error;
  } finally {
    if (binding === owner) useConversationOrganizationStore.setState(state => { const pending = { ...state.pending }; delete pending[command.key]; return { pending }; });
  }
}
export function useConversationOrganization() {
  const apis = useRuntimeAPIs(); const hostKey = useThreadStore(state => state.hostKey);
  React.useEffect(() => {
    const api = apis.conversationOrganization; if (!api) return;
    const host = getRuntimeEndpointGeneration();
    if (!binding || binding.host !== host || binding.api !== api) {
      binding?.stop(); const controller = new AbortController();
      const requests = new Map<string, Promise<void>>();
      let refreshing: Promise<void> | null = null, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
      const valid = () => binding === owner && !controller.signal.aborted && host === getRuntimeEndpointGeneration();
      const load = (query: ConversationOrganizationQuery, more = false): Promise<void> => {
        const key = organizationQueryKey(query), running = requests.get(key); if (running) return running;
        const previous = useConversationOrganizationStore.getState().pages[key];
        if (more && !previous?.snapshot?.nextCursor) return Promise.resolve();
        useConversationOrganizationStore.setState(state => ({ pages: { ...state.pages, [key]: { query, snapshot: previous?.snapshot ?? null, loading: true, error: null } } }));
        const request = (async () => {
          try {
            let page = await api.read({ ...query, ...(more ? { cursor: previous!.snapshot!.nextCursor! } : {}) }, controller.signal);
            // Refresh only the window the person already loaded, never every continuation.
            while (!more && page.nextCursor && page.conversations.length < (previous?.snapshot?.conversations.length ?? 0) && valid()) {
              const next = await api.read({ ...query, cursor: page.nextCursor }, controller.signal);
              page = { ...next, conversations: [...page.conversations, ...next.conversations] };
            }
            if (!valid()) return;
            const snapshot = more ? { ...page, conversations: [...previous!.snapshot!.conversations, ...page.conversations] } : page;
            useConversationOrganizationStore.setState(state => { const pages = { ...state.pages, [key]: { query, snapshot, loading: false, error: null } }; return { pages, snapshot: mergePages(pages), loading: false }; });
          } catch (error) {
            if (valid()) useConversationOrganizationStore.setState(state => ({ loading: false, pages: { ...state.pages, [key]: { query, snapshot: previous?.snapshot ?? null, loading: false, error: message(error) } }, error: message(error) }));
          }
        })().finally(() => requests.delete(key));
        requests.set(key, request); return request;
      };
      const refresh = (): Promise<void> => {
        dirty = true; if (refreshing) return refreshing;
        refreshing = (async () => {
          while (dirty && valid()) {
            dirty = false;
            const queries = Object.values(useConversationOrganizationStore.getState().pages).map(page => page.query);
            for (const query of queries.length ? queries : [rootQuery]) { if (!valid()) return; await load(query); }
          }
        })().finally(() => { refreshing = null; }); return refreshing;
      };
      const owner = { host, api, controller, refresh, load, users: 0, stop() { controller.abort(); stopEvents(); if (timer) clearTimeout(timer); } };
      binding = owner;
      useConversationOrganizationStore.setState({ host, snapshot: null, pages: {}, loading: true, error: null, pending: {}, failed: {}, bots: null, botsError: null });
      const loadBots = async () => { try { const bots = await apis.bots?.list(controller.signal); if (valid()) useConversationOrganizationStore.setState({ bots: bots ?? [], botsError: null }); } catch (error) { if (valid()) useConversationOrganizationStore.setState({ botsError: message(error) }); } };
      const stopEvents = subscribeVarinEvents(event => { if (event.type === 'bot-changed' || event.type === 'stream-ready') void loadBots(); });
      const observe = async () => {
        await refresh(); await loadBots(); if (!valid()) return;
        try { await api.observe(useConversationOrganizationStore.getState().snapshot?.cursor ?? 0, event => { if (valid() && event.cursor > (useConversationOrganizationStore.getState().snapshot?.cursor ?? 0)) void refresh(); }, { signal: controller.signal }); }
        catch (error) { if (valid()) useConversationOrganizationStore.setState({ error: message(error) }); }
        if (valid()) timer = setTimeout(() => void observe(), 1500);
      };
      void observe();
    }
    const owner = binding; owner.users++;
    return () => { if (--owner.users === 0) { owner.stop(); if (binding === owner) binding = null; } };
  }, [apis, hostKey]);
  return useConversationOrganizationStore();
}

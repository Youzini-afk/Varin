import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, type UiHostAction, type UiSource, type UiSourceIdentity, type UiViewState, type ThreadIdentity } from '@varin/application-client';
export interface UiDisplay { content?: UiSource['content']; source: UiSourceIdentity; files: Record<string, string>; assets: UiSource['assets']; entry: string; title: string; committed: boolean; status: string }
export interface UiSession {
  key: string; identity: ThreadIdentity; host: number; source?: UiSource;
  viewRef?: string; state?: UiViewState; placement: 'inline' | 'panel';
  sourceEntryId?: string;
  /** Mounted view flush only; durable storage remains owned by the Host. */
  flushState?: () => Promise<void>;
  display?: UiDisplay;
  cardMounted?: boolean;
  panelDirectory?: string;
  panelView?: 'source' | 'preview';
  panelMounted?: boolean;
  inlineTarget?: string;
  inlineEntryId?: string;
  embedAncestors?: readonly string[];
  interacting?: boolean;
  /** Presentation of an unresolved explicit send; the original input owner holds its admission key. */
  pendingHostActions?: Record<string, { action: UiHostAction; input: import('./compose').UiComposeInput }>;
  inlineSize?: { width: number; height: number };
}
const sessions = new Map<string, UiSession>();
const listeners = new Set<() => void>();
let revision = 0;
export function notifyUiSessions() { revision++; for (const listener of listeners) listener(); }
export function listUiSessions() { return [...sessions.values()]; }
subscribeRuntimeEndpointWillChange(() => { sessions.clear(); revision++; for (const listener of listeners) listener(); });
export const subscribeUiSessions = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const uiSessionsRevision = () => revision;
export function uiSession(key: string, identity: ThreadIdentity, host: number) {
  let session = sessions.get(key);
  if (!session) { session = { key, identity, host, placement: 'inline' }; sessions.set(key, session); }
  return session;
}
export const getUiSession = (key: string) => sessions.get(key);
export function moveUiSession(session: UiSession, placement: UiSession['placement']) {
  session.placement = placement; revision++; for (const listener of listeners) listener();
}
export function openUiSessionPanel(session: UiSession, view: 'source' | 'preview') {
  session.panelView = view;
  moveUiSession(session, view === 'source' ? 'inline' : 'panel');
}
export function updateUiSession(session: UiSession, display: UiDisplay) {
  session.display = display; revision++; for (const listener of listeners) listener();
}

/** Save mounted views before the original branch owner freezes a fork snapshot.
 * Never creates sessions, registers sources, or reads another conversation's view. */
export async function flushUiSessions(identity: ThreadIdentity, host: number): Promise<void> {
  const check = () => { if (host !== getRuntimeEndpointGeneration()) throw new Error('Host changed; reopen this content.'); };
  check();
  const selected = [...sessions.values()].filter(session => session.host === host && session.identity.runtime === identity.runtime
    && session.identity.threadId === identity.threadId && session.identity.branchId === identity.branchId);
  for (const session of selected) { check(); await session.flushState?.(); check(); }
}

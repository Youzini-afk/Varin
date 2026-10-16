import { subscribeRuntimeEndpointWillChange, type UiSource, type UiSourceIdentity, type UiViewState, type ThreadIdentity } from '@varin/application-client';
export interface UiDisplay { source: UiSourceIdentity; files: Record<string, string>; assets: UiSource['assets']; entry: string; title: string; committed: boolean; status: string }
export interface UiSession {
  key: string; identity: ThreadIdentity; host: number; source?: UiSource;
  viewRef?: string; state?: UiViewState; placement: 'inline' | 'panel';
  sourceEntryId?: string;
  display?: UiDisplay;
  cardMounted?: boolean;
  panelDirectory?: string;
}
const sessions = new Map<string, UiSession>();
const listeners = new Set<() => void>();
let revision = 0;
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
export function updateUiSession(session: UiSession, display: UiDisplay) {
  session.display = display; revision++; for (const listener of listeners) listener();
}

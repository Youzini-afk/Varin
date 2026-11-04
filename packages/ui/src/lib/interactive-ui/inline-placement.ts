import { getUiSession, notifyUiSessions, type UiSession } from './sessions';
import { useTimelineViewStore } from '@/components/conversation/timelineViewStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
export interface UiInlineAnchor { key: string; element: HTMLElement; kind: 'tool' | 'embed'; cwd: string }
const anchors = new Map<string, Map<string, UiInlineAnchor>>();
const active = new Map<string, UiInlineAnchor>();
export function registerUiInlineAnchor(session: UiSession, anchor: UiInlineAnchor) {
  const entries = anchors.get(session.key) ?? new Map<string, UiInlineAnchor>();
  entries.set(anchor.key, anchor); anchors.set(session.key, entries); notifyUiSessions();
  return () => { if (entries.get(anchor.key) === anchor) entries.delete(anchor.key); if (!entries.size) anchors.delete(session.key); notifyUiSessions(); };
}
export function uiInlineAnchor(session: UiSession): UiInlineAnchor | undefined {
  const entries = anchors.get(session.key), previous = active.get(session.key);
  // Focused inputs stay where the user is working. A new prose reference is a
  // location link until the frame reports that editing has ended.
  if (session.interacting && previous && entries?.get(previous.key) === previous) return previous;
  const chosen = session.inlineTarget ? entries?.get(session.inlineTarget) : [...entries?.values() ?? []].find(item => item.kind === 'tool') ?? entries?.values().next().value;
  if (chosen) active.set(session.key, chosen); else active.delete(session.key);
  return chosen;
}
export function mountedUiInlineSessions(prefix: string): UiSession[] {
  return [...anchors.keys()].filter(key => key.startsWith(prefix)).flatMap(key => { const session = getUiSession(key); return session ? [session] : []; });
}
export function locateInlineUi(session: UiSession) {
  const target = uiInlineAnchor(session);
  if (!target && session.inlineEntryId) useTimelineViewStore.getState().anchor(threadComposerKey(threadHostKey(), session.identity), session.inlineEntryId);
  target?.element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  target?.element.focus({ preventScroll: true });
}
export function inlineViewportClip(element: HTMLElement) {
  let top = 0, left = 0, right = innerWidth, bottom = innerHeight;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
  }
  return { top, left, right, bottom };
}
export function clearUiInlinePlacement() { anchors.clear(); active.clear(); }

import type { PiAssistantMessage } from '@varin/protocol';
import { piContentText } from './extensionPresentation';
import { projectPiSortedTurn } from './piSortedTurnProjection';
import type { PiTimelineEntry, PiTimelineItem, PiTimelineRow } from './piTimelineProjection';

export interface PiMessageNavigationTarget {
  index: number;
  rowId: string;
  role: 'user' | 'assistant';
  round: number;
}
export interface PiMessageMarker extends PiMessageNavigationTarget { id: string }
export interface PiLiveNavigationState { rowId: string; hasAssistant: boolean }

/** A whole Agent response has one pointer whenever any part is displayed. */
export function piNavigationHasAssistant(entries: readonly PiTimelineEntry[], live: PiAssistantMessage | undefined, sorted: boolean): boolean {
  if (!sorted) return Boolean(live) || entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const projection = projectPiSortedTurn(entries, live);
  return projection.answersBySourceId.size > 0 || projection.activityAnchorId !== undefined;
}

const cachedRoles = new WeakMap<PiTimelineRow, Map<boolean, readonly PiMessageMarker['role'][]>>();
export function projectPiMessageNavigation(items: readonly PiTimelineRow[], sorted: boolean, live?: PiLiveNavigationState): PiMessageMarker[] {
  let round = 0;
  return items.flatMap((row, index) => {
    let roles = cachedRoles.get(row)?.get(sorted);
    if (!roles) {
      const assistantEntries = row.kind === 'turn' ? row.turn.entries : row.kind === 'entry' ? [row.entry] : [];
      const user = row.kind === 'turn' ? row.turn.userEntry?.id ?? 'user'
        : row.kind === 'entry' && row.entry.type === 'message' && row.entry.message.role === 'user' ? row.entry.id : undefined;
      roles = [
        ...(user ? ['user' as const] : []),
        ...(piNavigationHasAssistant(assistantEntries, undefined, sorted) ? ['assistant' as const] : []),
      ];
      const modes = cachedRoles.get(row) ?? new Map();
      modes.set(sorted, roles);
      cachedRoles.set(row, modes);
    }
    if (live?.rowId === row.id && live.hasAssistant && !roles.includes('assistant')) roles = [...roles, 'assistant'];
    if (!roles.length) return [];
    round += 1;
    return roles.map(role => ({ role, round, index, rowId: row.id, id: JSON.stringify([row.id, role]) }));
  });
}

export function readPiMessageNavigationText(item: PiTimelineItem, target: PiMessageNavigationTarget): string {
  if (item.id !== target.rowId) return '';
  if (target.role === 'user') return item.kind === 'turn' ? piContentText(item.turn.user.content)
    : item.kind === 'entry' && item.entry.type === 'message' && item.entry.message.role === 'user' ? piContentText(item.entry.message.content) : '';
  const messages = (item.kind === 'turn' ? item.turn.entries : item.kind === 'entry' ? [item.entry] : [])
    .flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []);
  const live = item.kind === 'live-assistant' ? item.message : item.kind === 'turn' ? item.turn.liveAssistant : undefined;
  if (live) messages.push(live);
  const text = (message: PiAssistantMessage) => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim() || message.errorMessage || '';
  // Final prose describes the complete response; running rounds use their latest progress text.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.stopReason !== 'pending' && message.stopReason !== 'toolUse'
      && !message.content.some(part => part.type === 'toolCall')) {
      const answer = text(message);
      if (answer) return answer;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const progress = text(messages[index]!);
    if (progress) return progress;
  }
  return messages.at(-1)?.content.flatMap(part => part.type === 'toolCall' ? [part.name] : []).join(' · ') ?? '';
}

/** Reads only mounted messages, rather than walking the entire conversation. */
export function piNavigationRowElement(viewport: HTMLElement, rowId: string): HTMLElement | undefined {
  return [...viewport.querySelectorAll<HTMLElement>('[data-turn-entry]')].find(element => element.dataset.turnEntry === rowId);
}
export function piNavigationMessageElement(viewport: HTMLElement, target: PiMessageNavigationTarget): HTMLElement | undefined {
  const row = piNavigationRowElement(viewport, target.rowId);
  if (target.role === 'user') return row?.querySelector<HTMLElement>('[data-pi-user-message]') ?? undefined;
  return row?.querySelector<HTMLElement>('[data-pi-message-role="assistant"]') ?? undefined;
}

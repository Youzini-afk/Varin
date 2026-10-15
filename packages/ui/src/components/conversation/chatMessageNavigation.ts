import type { ChatAssistantMessage } from './types';
import { chatContentText } from './extensionPresentation';
import { projectChatSortedTurn } from './chatSortedTurnProjection';
import type { ChatTimelineEntry, ChatTimelineItem, ChatTimelineRow } from './chatTimelineProjection';

export interface ChatMessageNavigationTarget {
  index: number;
  rowId: string;
  role: 'user' | 'assistant';
  round: number;
}
export interface ChatMessageMarker extends ChatMessageNavigationTarget { id: string }
export interface ChatLiveNavigationState { rowId: string; hasAssistant: boolean }

/** A whole Agent response has one pointer whenever any part is displayed. */
export function chatNavigationHasAssistant(entries: readonly ChatTimelineEntry[], live: ChatAssistantMessage | undefined, sorted: boolean): boolean {
  if (!sorted) return Boolean(live) || entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant');
  const projection = projectChatSortedTurn(entries, live);
  return projection.answersBySourceId.size > 0 || projection.activityAnchorId !== undefined;
}

const cachedRoles = new WeakMap<ChatTimelineRow, Map<boolean, readonly ChatMessageMarker['role'][]>>();
export function projectChatMessageNavigation(items: readonly ChatTimelineRow[], sorted: boolean, live?: ChatLiveNavigationState): ChatMessageMarker[] {
  let round = 0;
  return items.flatMap((row, index) => {
    let roles = cachedRoles.get(row)?.get(sorted);
    if (!roles) {
      const assistantEntries = row.kind === 'turn' ? row.turn.entries : row.kind === 'entry' ? [row.entry] : [];
      const user = row.kind === 'turn' ? row.turn.userEntry?.id ?? 'user'
        : row.kind === 'entry' && row.entry.type === 'message' && row.entry.message.role === 'user' ? row.entry.id : undefined;
      roles = [
        ...(user ? ['user' as const] : []),
        ...(chatNavigationHasAssistant(assistantEntries, undefined, sorted) ? ['assistant' as const] : []),
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

export function readChatMessageNavigationText(item: ChatTimelineItem, target: ChatMessageNavigationTarget): string {
  if (item.id !== target.rowId) return '';
  if (target.role === 'user') return item.kind === 'turn' ? chatContentText(item.turn.user.content)
    : item.kind === 'entry' && item.entry.type === 'message' && item.entry.message.role === 'user' ? chatContentText(item.entry.message.content) : '';
  const messages = (item.kind === 'turn' ? item.turn.entries : item.kind === 'entry' ? [item.entry] : [])
    .flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []);
  const live = item.kind === 'live-assistant' ? item.message : item.kind === 'turn' ? item.turn.liveAssistant : undefined;
  if (live) messages.push(live);
  const text = (message: ChatAssistantMessage) => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim() || message.errorMessage || '';
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
export function chatNavigationRowElement(viewport: HTMLElement, rowId: string): HTMLElement | undefined {
  return [...viewport.querySelectorAll<HTMLElement>('[data-turn-entry]')].find(element => element.dataset.turnEntry === rowId);
}
export function chatNavigationMessageElement(viewport: HTMLElement, target: ChatMessageNavigationTarget): HTMLElement | undefined {
  const row = chatNavigationRowElement(viewport, target.rowId);
  if (target.role === 'user') return row?.querySelector<HTMLElement>('[data-conversation-user-message]') ?? undefined;
  return row?.querySelector<HTMLElement>('[data-conversation-message-role="assistant"]') ?? undefined;
}

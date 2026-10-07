import type { PiAssistantMessage } from '@varin/protocol';
import { piContentText } from './extensionPresentation';
import { PI_SORTED_LIVE_ASSISTANT_ID, projectPiSortedTurn } from './piSortedTurnProjection';
import type { PiTimelineEntry, PiTimelineItem, PiTimelineRow } from './piTimelineProjection';

export interface PiMessageNavigationTarget {
  index: number;
  rowId: string;
  sourceId: string;
  role: 'user' | 'assistant';
}
export interface PiMessageMarker extends PiMessageNavigationTarget { id: string }
export interface PiLiveNavigationSources { rowId: string; sourceIds: readonly string[] }

/** Same visible assistant articles as the sorted renderer; folded activity has one anchor. */
export function piNavigationAssistantSources(entries: readonly PiTimelineEntry[], live: PiAssistantMessage | undefined, sorted: boolean): string[] {
  const sources = entries.flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? [entry.id] : []);
  if (live) sources.push(PI_SORTED_LIVE_ASSISTANT_ID);
  if (!sorted) return sources;
  const projection = projectPiSortedTurn(entries, live);
  return sources.filter(id => projection.answersBySourceId.has(id) || projection.activityAnchorId === id);
}

const cachedSources = new WeakMap<PiTimelineRow, Map<boolean, readonly { sourceId: string; role: PiMessageMarker['role'] }[]>>();
export function projectPiMessageNavigation(items: readonly PiTimelineRow[], sorted: boolean, live?: PiLiveNavigationSources): PiMessageMarker[] {
  return items.flatMap((row, index) => {
    let sources = cachedSources.get(row)?.get(sorted);
    if (!sources) {
      const assistantEntries = row.kind === 'turn' ? row.turn.entries : row.kind === 'entry' ? [row.entry] : [];
      const user = row.kind === 'turn' ? row.turn.userEntry?.id ?? 'user'
        : row.kind === 'entry' && row.entry.type === 'message' && row.entry.message.role === 'user' ? row.entry.id : undefined;
      sources = [
        ...(user ? [{ sourceId: user, role: 'user' as const }] : []),
        ...piNavigationAssistantSources(assistantEntries, undefined, sorted).map(sourceId => ({ sourceId, role: 'assistant' as const })),
      ];
      const modes = cachedSources.get(row) ?? new Map();
      modes.set(sorted, sources);
      cachedSources.set(row, modes);
    }
    if (live?.rowId === row.id) sources = [
      ...sources.filter(source => source.role === 'user'),
      ...live.sourceIds.map(sourceId => ({ sourceId, role: 'assistant' as const })),
    ];
    return sources.map(source => ({ ...source, index, rowId: row.id, id: JSON.stringify([row.id, source.sourceId]) }));
  });
}

export function readPiMessageNavigationText(item: PiTimelineItem, target: PiMessageNavigationTarget): string {
  if (item.id !== target.rowId) return '';
  if (target.role === 'user') return item.kind === 'turn' ? piContentText(item.turn.user.content)
    : item.kind === 'entry' && item.entry.type === 'message' && item.entry.message.role === 'user' ? piContentText(item.entry.message.content) : '';
  const message = target.sourceId === PI_SORTED_LIVE_ASSISTANT_ID
    ? item.kind === 'live-assistant' ? item.message : item.kind === 'turn' ? item.turn.liveAssistant : undefined
    : (item.kind === 'turn' ? item.turn.entries : item.kind === 'entry' ? [item.entry] : [])
      .find(entry => entry.id === target.sourceId && entry.type === 'message' && entry.message.role === 'assistant');
  const assistant = message && 'role' in message ? message
    : message?.type === 'message' && message.message.role === 'assistant' ? message.message : undefined;
  if (!assistant) return '';
  return assistant.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n').trim()
    || assistant.content.flatMap(part => part.type === 'toolCall' ? [part.name] : []).join(' · ')
    || assistant.errorMessage || '';
}

/** Reads only mounted messages, rather than walking the entire conversation. */
export function piNavigationRowElement(viewport: HTMLElement, rowId: string): HTMLElement | undefined {
  return [...viewport.querySelectorAll<HTMLElement>('[data-turn-entry]')].find(element => element.dataset.turnEntry === rowId);
}
export function piNavigationMessageElement(viewport: HTMLElement, target: PiMessageNavigationTarget): HTMLElement | undefined {
  const row = piNavigationRowElement(viewport, target.rowId);
  if (target.role === 'user') return row?.querySelector<HTMLElement>('[data-pi-user-message]') ?? undefined;
  return row && [...row.querySelectorAll<HTMLElement>('[data-pi-message-role="assistant"]')]
    .find(element => element.dataset.piEntryId === target.sourceId);
}

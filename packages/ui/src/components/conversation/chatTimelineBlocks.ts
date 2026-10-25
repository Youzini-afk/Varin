import { CHAT_SORTED_LIVE_ASSISTANT_ID, projectChatSortedTurn, type ChatSortedTurnProjection } from './chatSortedTurnProjection';
import { resolveChatTimelineItem, type ChatTimelineEntry, type ChatTimelineProjection, type ChatTimelineTurn } from './chatTimelineProjection';
import type { ChatAssistantMessage, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { projectChatDialogue, type DialogueItem } from './chatDialogueProjection';

export interface ChatTimelineBlockGroup {
  id: string;
  ownerId: string;
  runId: string;
  entries: readonly ChatTimelineEntry[];
  liveId?: string;
  sorted: ChatSortedTurnProjection;
  customIds: ReadonlySet<string>;
}
export type ChatTimelineBlock = {
  id: string;
  ownerId: string;
} & (
  | { kind: 'user'; turn: ChatTimelineTurn }
  | { kind: 'chrome' | 'footer' | 'activity-header' | 'live-assistant'; group: ChatTimelineBlockGroup }
  | { kind: 'entry'; entry: ChatTimelineEntry; group: ChatTimelineBlockGroup }
  | { kind: 'activity'; activityId: string; sourceId: string; group: ChatTimelineBlockGroup }
  | { kind: 'dialogue'; itemId: string; group: ChatTimelineBlockGroup }
);
export interface ChatTimelineBlocks {
  items: readonly ChatTimelineBlock[];
  groups: ReadonlyMap<string, ChatTimelineBlockGroup>;
}
export type ChatTimelineBlockAliases = Map<string, { runId: string; id: string }>;
type ToolResults = ReadonlyMap<string, ChatToolResultMessage>;
const sortedLive = new WeakMap<ChatTimelineBlockGroup, { live?: ChatAssistantMessage; executions?: Record<string, ChatToolExecutionState>; results?: ToolResults; value: ChatSortedTurnProjection }>();
const EMPTY_CUSTOM_IDS: ReadonlySet<string> = new Set();
const dialogues = new WeakMap<ChatTimelineBlockGroup, { live?: ChatAssistantMessage; showThinking: boolean; executions?: Record<string, ChatToolExecutionState>; results?: ToolResults; items: DialogueItem[] }>();
const sameEntries = (a: readonly ChatTimelineEntry[], b: readonly ChatTimelineEntry[]) => a.length === b.length && a.every((entry, i) => entry === b[i]);

export function blockGroupLive(group: ChatTimelineBlockGroup, projection: Pick<ChatTimelineProjection, 'liveAssistant'>): ChatAssistantMessage | undefined {
  return group.liveId === projection.liveAssistant?.id ? projection.liveAssistant : undefined;
}
export function blockGroupSorted(group: ChatTimelineBlockGroup, projection: Pick<ChatTimelineProjection, 'liveAssistant'> & { resultByCallId?: ToolResults }, executions?: Record<string, ChatToolExecutionState>) {
  const live = blockGroupLive(group, projection);
  if (!live && !executions && !projection.resultByCallId) return group.sorted;
  const previous = sortedLive.get(group);
  if (previous && previous.live === live && previous.executions === executions && previous.results === projection.resultByCallId) return previous.value;
  const value = projectChatSortedTurn(group.entries.filter(entry => !group.customIds.has(entry.id)), live, executions, projection.resultByCallId);
  sortedLive.set(group, { live, executions, results: projection.resultByCallId, value });
  return value;
}

export function blockGroupDialogue(group: ChatTimelineBlockGroup, projection: Pick<ChatTimelineProjection, 'liveAssistant'> & { resultByCallId?: ToolResults }, showThinking = true, executions?: Record<string, ChatToolExecutionState>) {
  const live = blockGroupLive(group, projection), previous = dialogues.get(group);
  if (previous && previous.live === live && previous.showThinking === showThinking && previous.executions === executions && previous.results === projection.resultByCallId) return previous.items;
  const items = projectChatDialogue(group.entries, live, { showThinking, customIds: group.customIds, executions, results: projection.resultByCallId });
  dialogues.set(group, { live, showThinking, executions, results: projection.resultByCallId, items });
  return items;
}

/** Logical turns retain navigation/copy semantics. Only these small, native-ID
 * blocks are measured and mounted; loading a missing prompt cannot rename them. */
export function projectChatTimelineBlocks(
  projection: ChatTimelineProjection,
  { sorted, dialogue = false, expanded, previous, customIds = EMPTY_CUSTOM_IDS, showThinking = true, aliases = new Map(), executions }: {
    sorted: boolean;
    dialogue?: boolean;
    executions?: Record<string, ChatToolExecutionState>;
    expanded(groupId: string): boolean;
    previous?: ChatTimelineBlocks;
    customIds?: ReadonlySet<string>;
    showThinking?: boolean;
    aliases?: ChatTimelineBlockAliases;
  },
): ChatTimelineBlocks {
  const items: ChatTimelineBlock[] = [];
  const groups = new Map<string, ChatTimelineBlockGroup>();
  const priorItems = new Map(previous?.items.map(item => [item.id, item]));
  const priorByEntry = new Map<string, ChatTimelineBlockGroup>();
  const priorByOwner = new Map<string, ChatTimelineBlockGroup>();
  for (const group of previous?.groups.values() ?? []) {
    priorByOwner.set(`${group.ownerId}:run:${group.runId}`, group);
    for (const entry of group.entries) priorByEntry.set(entry.id, group);
  }
  const add = (item: ChatTimelineBlock) => {
    const prior = priorItems.get(item.id);
    const keys = Object.keys(item) as Array<keyof ChatTimelineBlock>;
    items.push(prior && keys.every(key => prior[key] === item[key]) ? prior : item);
  };
  const appendGroup = (ownerId: string, entries: readonly ChatTimelineEntry[], liveId?: string) => {
    const runId = entries.find(entry => entry.runId)?.runId ?? (liveId ? projection.liveAssistant?.runId : undefined) ?? ownerId;
    const candidateId = `${ownerId}:run:${runId}`;
    // Discovering the user at a page boundary reparents the section but keeps
    // its measured header/footer keys and disclosure choice as well as its bodies.
    let prior = priorByOwner.get(candidateId) ?? entries.map(entry => priorByEntry.get(entry.id)).find(group => group?.runId === runId && !groups.has(group.id));
    if (prior && groups.has(prior.id)) prior = undefined;
    const remembered = entries.map(entry => aliases.get(entry.id)).find(alias => alias?.runId === runId && !groups.has(alias.id));
    const id = prior?.id ?? remembered?.id ?? candidateId;
    const group = prior && prior.ownerId === ownerId && prior.liveId === liveId && prior.customIds === customIds && sameEntries(prior.entries, entries)
      ? prior : { id, ownerId, runId, entries, liveId, customIds, sorted: projectChatSortedTurn(entries.filter(entry => !customIds.has(entry.id))) };
    groups.set(id, group);
    for (const entry of entries) aliases.set(entry.id, { runId, id });
    const base = { ownerId, group };
    const hasAssistant = entries.some(entry => entry.type === 'message' && entry.message.role === 'assistant') || liveId || !entries.length;
    if (hasAssistant) add({ ...base, kind: 'chrome', id: `chrome:${id}` });
    if (dialogue) {
      for (const item of blockGroupDialogue(group, projection, showThinking, executions)) {
        const sourceId = item.kind === 'process' ? item.activities[0]?.sourceId : item.sourceId;
        add({ ...base, ownerId: ownerId.startsWith('entry:') && sourceId ? `entry:${sourceId}` : ownerId,
          kind: 'dialogue', id: `dialogue:${item.id}`, itemId: item.id });
      }
      add({ ...base, kind: 'footer', id: `footer:${id}` });
      return;
    }
    const presentation = sorted ? blockGroupSorted(group, projection, executions) : undefined;
    const activity = presentation?.activity.filter(item => (showThinking || item.kind !== 'thinking') && !(item.kind === 'tool' && item.standalone));
    if (activity?.length) {
      add({ ...base, kind: 'activity-header', id: `activity-header:${id}` });
      if (expanded(id)) for (const item of activity) add({ ...base, ownerId: ownerId.startsWith('entry:') ? `entry:${item.sourceId}` : ownerId, kind: 'activity', id: `activity:${item.id}`, activityId: item.id, sourceId: item.sourceId });
    }
    for (const item of presentation?.activity ?? []) if (item.kind === 'tool' && item.standalone) {
      add({ ...base, ownerId: ownerId.startsWith('entry:') ? 'entry:' + item.sourceId : ownerId, kind: 'activity', id: 'activity:' + item.id, activityId: item.id, sourceId: item.sourceId });
    }
    for (const entry of entries) {
      if (entry.type === 'run_usage') continue; // The separate footer owns the Run summary.
      if (sorted && entry.type === 'message' && entry.message.role === 'assistant' && !customIds.has(entry.id) && !presentation?.answersBySourceId.has(entry.id)) continue;
      if (!sorted && entry.type === 'message' && entry.message.role === 'assistant' && !customIds.has(entry.id) && !showThinking && !entry.message.errorMessage && entry.message.content.every(part => part.type === 'thinking')) continue;
      add({ ...base, ownerId: ownerId.startsWith('entry:') ? `entry:${entry.id}` : ownerId, kind: 'entry', id: `entry:${entry.id}`, entry });
    }
    const live = blockGroupLive(group, projection);
    const visibleLive = live?.errorMessage || live?.content.some(part => part.type !== 'thinking' || showThinking);
    if (liveId && visibleLive && (!sorted || presentation?.answersBySourceId.has(CHAT_SORTED_LIVE_ASSISTANT_ID))) add({ ...base, kind: 'live-assistant', id: `live-assistant:${liveId}` });
    add({ ...base, kind: 'footer', id: `footer:${id}` });
  };
  // Orphans at a page boundary form the same native Run segment, rather than
  // one pseudo-turn/footer per record. Body IDs survive discovery of its user.
  let orphan: ChatTimelineEntry[] = [];
  const flush = () => {
    if (orphan.length) appendGroup(`entry:${orphan.slice().reverse().find(entry => entry.type !== 'run_usage')?.id ?? orphan.at(-1)!.id}`, orphan);
    orphan = [];
  };
  for (const row of projection.items) {
    const item = resolveChatTimelineItem(row, projection.liveItem);
    if (!item) continue;
    if (item.kind === 'entry') {
      if (orphan.length && orphan[0]!.runId !== item.entry.runId) flush();
      orphan.push(item.entry); continue;
    }
    flush();
    if (item.kind === 'live-assistant') { appendGroup(item.id, [], item.message.id); continue; }
    const { turn } = item;
    add({ id: turn.id, ownerId: turn.id, kind: 'user', turn: row.kind === 'turn' ? row.turn : turn });
    let segment: ChatTimelineEntry[] = [];
    const segments: ChatTimelineEntry[][] = [];
    for (const entry of turn.entries) {
      if (segment.length && entry.runId !== segment[0]!.runId) { segments.push(segment); segment = []; }
      segment.push(entry);
    }
    if (segment.length) segments.push(segment);
    const live = turn.liveAssistant;
    if (live && (!segments.length || live.runId && segments.at(-1)![0]!.runId !== live.runId)) segments.push([]);
    if (!segments.length) segments.push([]);
    for (const [index, entries] of segments.entries()) appendGroup(turn.id, entries, index === segments.length - 1 ? live?.id : undefined);
  }
  flush();
  return { items: previous && previous.items.length === items.length && items.every((item, i) => item === previous.items[i]) ? previous.items : items, groups };
}

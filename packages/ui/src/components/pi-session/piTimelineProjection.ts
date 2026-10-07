import type {
  PiAssistantMessage,
  PiModelChangeEntry,
  PiSessionEntry,
  PiSessionInfoEntry,
  PiSessionMessageEntry,
  PiThinkingLevelChangeEntry,
  PiToolResultMessage,
  PiUserMessage,
} from '@varin/protocol';
import { VARIN_RECOVERY_NAVIGATION_MARKER_TYPE } from '@varin/protocol';

type PiTimelineControlEntry = Extract<
  PiSessionEntry,
  { type: 'model_change' | 'thinking_level_change' | 'session_info' }
>;

export type PiTimelineEntry = Exclude<PiSessionEntry, PiTimelineControlEntry>;

export interface PiTimelineTurnMetadata {
  model?: PiModelChangeEntry;
  sessionInfo?: PiSessionInfoEntry;
  thinking?: PiThinkingLevelChangeEntry;
}

export interface PiTimelineTurn {
  entries: readonly PiTimelineEntry[];
  id: string;
  liveAssistant?: PiAssistantMessage;
  liveUser: boolean;
  metadata: PiTimelineTurnMetadata;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  user: PiUserMessage;
  userEntry?: PiSessionMessageEntry;
}

export type PiTimelineItem =
  | {
      entry: PiTimelineEntry;
      id: string;
      kind: 'entry';
      resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
    }
  | {
      id: string;
      kind: 'live-assistant';
      message: PiAssistantMessage;
      resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
    }
  | { id: string; kind: 'turn'; turn: PiTimelineTurn };

type PiTimelinePersistentItem = Exclude<PiTimelineItem, { kind: 'live-assistant' }>;

// Virtual-list rows change only with history or transient row identity. The live
// payload is resolved separately so a text delta never replaces the whole data array.
export type PiTimelineRow = PiTimelinePersistentItem | { id: string; kind: 'live-assistant' };

export interface PiTimelineLiveItem {
  row: PiTimelineRow;
  item: PiTimelineItem;
}

export interface PiTimelineProjection {
  items: readonly PiTimelineRow[];
  liveItem?: PiTimelineLiveItem;
  liveAssistant?: PiAssistantMessage;
  liveUser?: PiUserMessage;
  /** Stable history before live user/assistant overlays are applied. */
  persistentItems: readonly PiTimelinePersistentItem[];
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  /** Flat visible entries used by a single virtual turn row's presentation. */
  visibleEntries: readonly PiTimelineEntry[];
}

interface PiTimelinePersistentProjection {
  assistantIdentities: ReadonlySet<string>;
  items: readonly PiTimelinePersistentItem[];
  pendingMetadata: PiTimelineTurnMetadata;
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>;
  visibleEntries: readonly PiTimelineEntry[];
  userTimestamps: ReadonlySet<number>;
}

interface PiTimelineTurnDraft {
  entries: PiTimelineEntry[];
  metadata: PiTimelineTurnMetadata;
  user: PiUserMessage;
  userEntry: PiSessionMessageEntry;
}

const assistantIdentity = (message: PiAssistantMessage): string =>
  JSON.stringify([message.timestamp, message.provider, message.model]);

// A live text delta cannot change immutable history. Keep this source identity
// on the previous projection, so it is reclaimed with the view/session rather
// than retained in an app-wide history cache.
const projectionSources = new WeakMap<PiTimelineProjection, {
  entries: readonly PiSessionEntry[];
  liveToolCallIds: readonly string[];
  persistent: PiTimelinePersistentProjection;
  standaloneLiveAssistantId: string | undefined;
}>();

const isTimelineControlEntry = (entry: PiSessionEntry): entry is PiTimelineControlEntry => (
  entry.type === 'model_change'
  || entry.type === 'thinking_level_change'
  || entry.type === 'session_info'
);

const isVisibleTimelineEntry = (
  entry: PiSessionEntry,
  knownToolCallIds: ReadonlySet<string>,
): entry is PiTimelineEntry => {
  if (isTimelineControlEntry(entry)) return false;
  if (entry.type === 'custom' && entry.customType === 'varin.session-features/v1') return false;
  if (entry.type === 'custom' && entry.customType === 'varin.user-question') return false;
  if (entry.type === 'custom' && entry.customType === VARIN_RECOVERY_NAVIGATION_MARKER_TYPE) return false;
  if (entry.type === 'custom_message' && !entry.display) return false;
  if (entry.type === 'message' && entry.message.role === 'custom' && !entry.message.display) return false;
  if (
    entry.type === 'message'
    && entry.message.role === 'toolResult'
    && knownToolCallIds.has(entry.message.toolCallId)
  ) return false;
  return true;
};

const sameEntries = (
  left: readonly PiTimelineEntry[],
  right: readonly PiTimelineEntry[],
): boolean => (
  left.length === right.length && left.every((entry, index) => entry === right[index])
);

const sameMetadata = (
  left: PiTimelineTurnMetadata,
  right: PiTimelineTurnMetadata,
): boolean => (
  left.model === right.model
  && left.sessionInfo === right.sessionInfo
  && left.thinking === right.thinking
);

const EMPTY_RESULT_MAP: ReadonlyMap<string, PiToolResultMessage> = new Map();

const sameResultMaps = (
  left: ReadonlyMap<string, PiToolResultMessage>,
  right: ReadonlyMap<string, PiToolResultMessage>,
): boolean => (
  left.size === right.size
  && [...left].every(([id, result]) => right.get(id) === result)
);

const stableResultMap = (
  next: ReadonlyMap<string, PiToolResultMessage>,
  previous: ReadonlyMap<string, PiToolResultMessage> | undefined,
): ReadonlyMap<string, PiToolResultMessage> => {
  if (next.size === 0) return EMPTY_RESULT_MAP;
  return previous && sameResultMaps(next, previous) ? previous : next;
};

const resultsForMessages = (
  entries: readonly PiTimelineEntry[],
  resultByCallId: ReadonlyMap<string, PiToolResultMessage>,
  liveAssistant?: PiAssistantMessage,
): ReadonlyMap<string, PiToolResultMessage> => {
  const results = new Map<string, PiToolResultMessage>();
  const collect = (message: PiAssistantMessage): void => {
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const result = resultByCallId.get(content.id);
      if (result) results.set(content.id, result);
    }
  };
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message.role === 'assistant') collect(entry.message);
  }
  if (liveAssistant) collect(liveAssistant);
  return results.size === 0 ? EMPTY_RESULT_MAP : results;
};

const persistentProjection = (
  entries: readonly PiSessionEntry[],
  liveAssistant: PiAssistantMessage | undefined,
  previous: PiTimelineProjection | undefined,
): PiTimelinePersistentProjection => {
  const assistantIdentities = new Set<string>();
  const userTimestamps = new Set<number>();
  const knownToolCallIds = new Set<string>();
  const resultByCallId = new Map<string, PiToolResultMessage>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'assistant') {
      assistantIdentities.add(assistantIdentity(entry.message));
      for (const content of entry.message.content) {
        if (content.type === 'toolCall') knownToolCallIds.add(content.id);
      }
    } else if (entry.message.role === 'toolResult') {
      resultByCallId.set(entry.message.toolCallId, entry.message);
    } else if (entry.message.role === 'user') {
      userTimestamps.add(entry.message.timestamp);
    }
  }
  if (liveAssistant) {
    for (const content of liveAssistant.content) {
      if (content.type === 'toolCall') knownToolCallIds.add(content.id);
    }
  }

  const drafts: Array<
    | { entry: PiTimelineEntry; kind: 'entry' }
    | { kind: 'turn'; turn: PiTimelineTurnDraft }
  > = [];
  let pendingMetadata: PiTimelineTurnMetadata = {};
  let currentTurn: PiTimelineTurnDraft | undefined;
  const visibleEntries: PiTimelineEntry[] = [];

  for (const entry of entries) {
    if (entry.type === 'model_change') {
      pendingMetadata = { ...pendingMetadata, model: entry };
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      pendingMetadata = { ...pendingMetadata, thinking: entry };
      continue;
    }
    if (entry.type === 'session_info') {
      pendingMetadata = { ...pendingMetadata, sessionInfo: entry };
      continue;
    }
    if (!isVisibleTimelineEntry(entry, knownToolCallIds)) continue;
    visibleEntries.push(entry);

    if (entry.type === 'message' && entry.message.role === 'user') {
      currentTurn = {
        entries: [],
        metadata: pendingMetadata,
        user: entry.message,
        userEntry: entry,
      };
      pendingMetadata = {};
      drafts.push({ kind: 'turn', turn: currentTurn });
      continue;
    }

    if (currentTurn) currentTurn.entries.push(entry);
    else drafts.push({ entry, kind: 'entry' });
  }

  const stableGlobalResults = stableResultMap(resultByCallId, previous?.resultByCallId);
  const previousById = new Map(previous?.persistentItems.map((item) => [item.id, item]) ?? []);
  const items = drafts.map<PiTimelinePersistentItem>((draft) => {
    if (draft.kind === 'entry') {
      const id = `entry:${draft.entry.id}`;
      const prior = previousById.get(id);
      const itemResults = stableResultMap(
        resultsForMessages([draft.entry], stableGlobalResults),
        prior?.kind === 'entry' ? prior.resultByCallId : undefined,
      );
      return prior?.kind === 'entry'
        && prior.entry === draft.entry
        && prior.resultByCallId === itemResults
        ? prior
        : { entry: draft.entry, id, kind: 'entry', resultByCallId: itemResults };
    }

    const id = `turn:${draft.turn.userEntry.id}`;
    const prior = previousById.get(id);
    const turnResults = stableResultMap(
      resultsForMessages(draft.turn.entries, stableGlobalResults),
      prior?.kind === 'turn' ? prior.turn.resultByCallId : undefined,
    );
    if (
      prior?.kind === 'turn'
      && prior.turn.userEntry === draft.turn.userEntry
      && !prior.turn.liveAssistant
      && sameEntries(prior.turn.entries, draft.turn.entries)
      && sameMetadata(prior.turn.metadata, draft.turn.metadata)
      && prior.turn.resultByCallId === turnResults
    ) return prior;
    return {
      id,
      kind: 'turn',
      turn: {
        entries: draft.turn.entries,
        id,
        liveUser: false,
        metadata: draft.turn.metadata,
        resultByCallId: turnResults,
        user: draft.turn.user,
        userEntry: draft.turn.userEntry,
      },
    };
  });

  return { assistantIdentities, items, pendingMetadata, resultByCallId: stableGlobalResults, visibleEntries, userTimestamps };
};

const resultsIncludingLiveAssistant = (
  results: ReadonlyMap<string, PiToolResultMessage>,
  allResults: ReadonlyMap<string, PiToolResultMessage>,
  message: PiAssistantMessage,
): ReadonlyMap<string, PiToolResultMessage> => {
  let combined: Map<string, PiToolResultMessage> | undefined;
  for (const content of message.content) {
    if (content.type !== 'toolCall') continue;
    const result = allResults.get(content.id);
    if (!result || results.get(content.id) === result) continue;
    combined ??= new Map(results);
    combined.set(content.id, result);
  }
  return combined ?? results;
};

export const projectPiTimeline = (
  entries: readonly PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
  liveUser?: PiUserMessage,
  previous?: PiTimelineProjection,
): PiTimelineProjection => {
  const liveToolCallIds = liveAssistant?.content.flatMap(content => content.type === 'toolCall' ? [content.id] : []) ?? [];
  const source = previous ? projectionSources.get(previous) : undefined;
  const persistent = source?.entries === entries
    && source.liveToolCallIds.length === liveToolCallIds.length
    && source.liveToolCallIds.every((id, index) => id === liveToolCallIds[index])
    ? source.persistent
    : persistentProjection(entries, liveAssistant, previous);
  const persistedAssistant = liveAssistant !== undefined
    && persistent.assistantIdentities.has(assistantIdentity(liveAssistant));
  const projectedLiveAssistant = persistedAssistant ? undefined : liveAssistant;
  const persistedUser = liveUser !== undefined && persistent.userTimestamps.has(liveUser.timestamp);
  const projectedLiveUser = persistedUser ? undefined : liveUser;
  // Once a user turn exists, every later visible entry belongs to that turn.
  const standaloneLiveAssistantId = projectedLiveAssistant && !projectedLiveUser
    && persistent.items.at(-1)?.kind !== 'turn'
    ? `live-assistant:${projectedLiveAssistant.timestamp}`
    : undefined;
  let items: readonly PiTimelineRow[];
  if (previous && source?.persistent === persistent && previous.liveUser === projectedLiveUser
    && source.standaloneLiveAssistantId === standaloneLiveAssistantId) {
    items = previous.items;
  } else if (projectedLiveUser) {
    const id = `turn:live-user:${projectedLiveUser.timestamp}`;
    items = [...persistent.items, {
      id,
      kind: 'turn',
      turn: {
        entries: [],
        id,
        liveUser: true,
        metadata: persistent.pendingMetadata,
        resultByCallId: EMPTY_RESULT_MAP,
        user: projectedLiveUser,
      },
    }];
  } else if (standaloneLiveAssistantId) {
    items = [...persistent.items, { id: standaloneLiveAssistantId, kind: 'live-assistant' }];
  } else {
    items = persistent.items;
  }

  let liveItem: PiTimelineLiveItem | undefined;
  const tail = items.at(-1);
  if (projectedLiveAssistant && tail && tail.kind !== 'entry') {
    const previousItem = previous?.liveItem?.item;
    const previousResults = previousItem?.kind === 'turn'
      ? previousItem.turn.resultByCallId
      : previousItem?.kind === 'live-assistant' ? previousItem.resultByCallId : undefined;
    // The persistent source includes the live call IDs. Its unchanged identity
    // proves both completed results and live-result membership are unchanged.
    const results = source?.persistent === persistent && previous?.liveItem?.row === tail && previousResults
      ? previousResults
      : stableResultMap(resultsIncludingLiveAssistant(
        tail.kind === 'turn' ? tail.turn.resultByCallId : EMPTY_RESULT_MAP,
        persistent.resultByCallId,
        projectedLiveAssistant,
      ), previousResults);
    liveItem = {
      row: tail,
      item: tail.kind === 'turn' ? {
        ...tail,
        turn: { ...tail.turn, liveAssistant: projectedLiveAssistant, resultByCallId: results },
      } : {
        id: tail.id,
        kind: 'live-assistant',
        message: projectedLiveAssistant,
        resultByCallId: results,
      },
    };
  }

  const projection: PiTimelineProjection = {
    items,
    ...(liveItem ? { liveItem } : {}),
    ...(projectedLiveAssistant ? { liveAssistant: projectedLiveAssistant } : {}),
    ...(projectedLiveUser ? { liveUser: projectedLiveUser } : {}),
    persistentItems: persistent.items,
    resultByCallId: persistent.resultByCallId,
    visibleEntries: persistent.visibleEntries,
  };
  projectionSources.set(projection, { entries, liveToolCallIds, persistent, standaloneLiveAssistantId });
  return projection;
};

/**
 * A virtual container may retain its previous assigned row while calling the
 * current renderer. Live content belongs to the exact row object, never merely
 * its ID; a retired standalone row has no payload and renders nothing.
 */
export const resolvePiTimelineItem = (
  row: PiTimelineRow,
  liveItem?: PiTimelineLiveItem,
): PiTimelineItem | undefined => {
  if (liveItem?.row === row) return liveItem.item;
  return row.kind === 'live-assistant' ? undefined : row;
};

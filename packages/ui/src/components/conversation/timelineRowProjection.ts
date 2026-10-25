import type { ConversationPresentation } from './ConversationContext';
import type { ChatTimelineBlock } from './chatTimelineBlocks';
import type { ChatTimelineProjection } from './chatTimelineProjection';
import type { ChatAssistantMessage } from './types';

type RowProjection = Pick<ChatTimelineProjection, 'liveAssistant' | 'resultByCallId'>;
type RowState = { projection: RowProjection; presentation: ConversationPresentation };
const rows = new WeakMap<object, RowState>();
const rowInputs = new WeakMap<object, { source: ChatTimelineProjection; context: ConversationPresentation }>();
const groupCalls = new WeakMap<object, Set<string>>();
const executionChildren = new WeakMap<object, Map<string, string[]>>();

const callsIn = (message: ChatAssistantMessage | undefined, ids: Set<string>) => {
  for (const part of message?.content ?? []) if (part.type === 'toolCall') ids.add(part.id);
};
const sameRecord = <T>(left: Record<string, T> | undefined, right: Record<string, T>) => Boolean(left)
  && Object.keys(left!).length === Object.keys(right).length && Object.keys(right).every(key => left![key] === right[key]);

/** Stable history rows receive only their live message, results and executions.
 * Parent/child gateway executions remain together. A changing unrelated tool
 * cannot invalidate a row's React memo or its nested context consumers. */
export function projectTimelineRow(block: ChatTimelineBlock, source: ChatTimelineProjection, context: ConversationPresentation): RowState {
  const group = 'group' in block ? block.group : undefined;
  const owner = group ?? block;
  const previous = rows.get(owner);
  const input = rowInputs.get(owner);
  if (previous && input?.source === source && input.context === context) return previous;
  rowInputs.set(owner, { source, context });
  let base = groupCalls.get(owner);
  if (!base) {
    base = new Set();
    for (const entry of group?.entries ?? []) {
      if (entry.type !== 'message') continue;
      if (entry.message.role === 'assistant') callsIn(entry.message, base);
      if (entry.message.role === 'toolResult') base.add(entry.message.toolCallId);
    }
    groupCalls.set(owner, base);
  }
  const liveAssistant = group?.liveId === source.liveAssistant?.id ? source.liveAssistant : undefined;
  const ids = new Set(base);
  callsIn(liveAssistant, ids);
  let children = executionChildren.get(context.toolExecutions);
  if (!children) {
    children = new Map();
    for (const [id, execution] of Object.entries(context.toolExecutions)) {
      if (!execution.parentToolCallId) continue;
      const list = children.get(execution.parentToolCallId) ?? [];
      list.push(id); children.set(execution.parentToolCallId, list);
    }
    executionChildren.set(context.toolExecutions, children);
  }
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child);
  const toolExecutions: ConversationPresentation['toolExecutions'] = {};
  const uiCards: NonNullable<ConversationPresentation['uiCards']> = {};
  const results = new Map<string, NonNullable<ReturnType<typeof source.resultByCallId.get>>>();
  for (const id of ids) {
    if (context.toolExecutions[id]) toolExecutions[id] = context.toolExecutions[id]!;
    if (context.uiCards?.[id]) {
      const card = context.uiCards[id]!;
      const before = previous?.presentation.uiCards?.[id];
      uiCards[id] = before && before.call === card.call && before.result === card.result && before.compact === card.compact ? before : card;
    }
    const result = source.resultByCallId.get(id);
    if (result) results.set(id, result);
  }
  const resultByCallId = previous && previous.projection.resultByCallId.size === results.size
    && [...results].every(([id, value]) => previous.projection.resultByCallId.get(id) === value) ? previous.projection.resultByCallId : results;
  const projection = previous?.projection.liveAssistant === liveAssistant && previous?.projection.resultByCallId === resultByCallId
    ? previous.projection : { liveAssistant, resultByCallId };
  const next = { ...context,
    toolExecutions: sameRecord(previous?.presentation.toolExecutions, toolExecutions) ? previous!.presentation.toolExecutions : toolExecutions,
    uiCards: sameRecord(previous?.presentation.uiCards, uiCards) ? previous!.presentation.uiCards : uiCards,
  };
  const presentation = previous && Object.keys(next).length === Object.keys(previous.presentation).length
    && (Object.keys(next) as Array<keyof ConversationPresentation>).every(key => previous.presentation[key] === next[key]) ? previous.presentation : next;
  if (previous?.projection === projection && previous.presentation === presentation) return previous;
  const value = { projection, presentation };
  rows.set(owner, value);
  return value;
}

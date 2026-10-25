import { viewedImages } from './viewedImages';
import type { ChatAssistantMessage, ChatTextContent, ChatThinkingContent, ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import type { ChatTimelineEntry } from './chatTimelineProjection';
import { presentInvocation } from './toolInvocation';
import { isStandaloneTool, standaloneDescendants } from './standaloneTools';

type Source = { id: string; sourceId: string; streaming: boolean; extrasId?: string };
export type DialogueActivity = Source & (
  | { kind: 'thinking'; content: ChatThinkingContent }
  | { kind: 'tool'; call: ChatToolCall }
  | { kind: 'entry'; entry: ChatTimelineEntry }
);
export type DialogueProcess = {
  kind: 'process'; id: string; activities: DialogueActivity[];
  /** A later spoken message seals this segment, even while the Run continues. */
  tail: boolean;
};
export type DialogueItem = DialogueProcess | (Source & (
  | { kind: 'text'; content: ChatTextContent; contentIndex: number; offset: number }
  | { kind: 'tool'; call: ChatToolCall }
  | { kind: 'entry'; entry: ChatTimelineEntry }
  | { kind: 'error'; text: string }
));

/** Presentation only: public prose stays in place; ordinary activity between
 * spoken messages has one disclosure. Delegations and questions keep their own row. */
export function projectChatDialogue(entries: readonly ChatTimelineEntry[], live?: ChatAssistantMessage,
  { showThinking = true, customIds = new Set<string>(), executions, results }: {
    showThinking?: boolean; customIds?: ReadonlySet<string>; executions?: Record<string, ChatToolExecutionState>; results?: ReadonlyMap<string, ChatToolResultMessage>;
  } = {}): DialogueItem[] {
  const items: DialogueItem[] = [];
  const seen = new Set<string>();
  let process: DialogueProcess | undefined;
  let runId: string | null | undefined;
  const delegated = standaloneDescendants(executions);
  const seal = () => { if (process) process.tail = false; process = undefined; };
  const append = (activity: DialogueActivity) => {
    if (!process) { process = { kind: 'process', id: `process:${activity.id}`, activities: [], tail: true }; items.push(process); }
    process.activities.push(activity);
  };
  const message = (value: ChatAssistantMessage, sourceId: string, live = false) => {
    let offset = 0;
    value.content.forEach((content, index) => {
      const id = content.type === 'toolCall' ? `tool:${content.id}` : `${content.type}:${content.id ?? `${value.id}:${index}`}`;
      const source: Source = { id, sourceId, streaming: live && value.stopReason === 'pending',
        ...(!live && index === value.content.length - 1 ? { extrasId: sourceId } : {}) };
      if (seen.has(id)) { if (content.type === 'text') offset += content.text.length + 1; return; }
      seen.add(id);
      if (content.type === 'text') {
        if (content.text.trim()) { seal(); items.push({ ...source, kind: 'text', content, contentIndex: index, offset }); }
        offset += content.text.length + 1;
      } else if (content.type === 'thinking') {
        if (showThinking && (content.redacted || content.thinking.trim())) append({ ...source, kind: 'thinking', content,
          streaming: source.streaming && index === value.content.length - 1 });
      } else {
        const call = presentInvocation(content);
        const tool = { ...source, kind: 'tool' as const, call, streaming: source.streaming && !call.interrupted };
        if (isStandaloneTool(call.name, executions?.[call.id], results?.get(call.id))) {
          if (call.name === 'send' || viewedImages(call.name, results?.get(call.id), executions?.[call.id]).length) seal();
          items.push(tool);
        }
        else append(tool);
        // A dispatch inside script_run has the same native child owner. Keep it
        // visible beside the parent process instead of burying it in the script.
        for (const child of delegated.get(call.id) ?? []) {
          const id = `tool:${child.id}`;
          if (seen.has(id)) continue;
          if (child.name === 'send') seal();
          seen.add(id); items.push({ id, sourceId, streaming: false, kind: 'tool', call: child });
        }
      }
    });
    if (value.errorMessage && value.stopReason !== 'aborted') {
      seal(); items.push({ id: `error:${value.id}`, kind: 'error', sourceId, text: value.errorMessage, streaming: false });
    }
  };
  for (const entry of entries) {
    if (entry.type === 'run_usage') continue;
    if (runId !== entry.runId) { seal(); runId = entry.runId; }
    if (!customIds.has(entry.id) && entry.type === 'message' && entry.message.role === 'assistant') {
      message(entry.message, entry.id); continue;
    }
    if (entry.type === 'message' && entry.message.role === 'system') continue;
    const item: DialogueActivity & { kind: 'entry' } = { id: `entry:${entry.id}`, kind: 'entry', entry, sourceId: entry.id, streaming: false };
    const standalone = customIds.has(entry.id) || entry.type === 'custom_message' && ['thread-message', 'question-answer'].includes(entry.customType)
      || entry.type === 'message' && (entry.message.role === 'user'
        || entry.message.role === 'custom' && ['thread-message', 'media'].includes(entry.message.customType));
    if (standalone) { seal(); items.push(item); } else append(item);
  }
  if (live) {
    if (live.runId && live.runId !== runId) seal();
    message(live, `live:${live.id}`, true);
  }
  return items;
}

export function dialogueContains(item: DialogueItem, sourceId: string, callId?: string): boolean {
  const matches = (part: Exclude<DialogueItem, DialogueProcess> | DialogueActivity) =>
    part.sourceId === sourceId || callId !== undefined && part.kind === 'tool' && part.call.id === callId;
  return item.kind === 'process' ? item.activities.some(matches) : matches(item);
}

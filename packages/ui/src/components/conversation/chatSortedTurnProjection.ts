import type { ChatAssistantMessage, ChatTextContent, ChatThinkingContent, ChatToolCall, ChatToolExecutionState } from './types';
import type { ChatTimelineEntry } from './chatTimelineProjection';
import { presentInvocation } from './toolInvocation';
import { isStandaloneTool, standaloneDescendants } from './standaloneTools';

export const CHAT_SORTED_LIVE_ASSISTANT_ID = 'live-assistant';

export type ChatSortedTurnActivityItem =
  | {
      content: ChatThinkingContent;
      id: string;
      kind: 'thinking';
      sourceId: string;
      streaming: boolean;
    }
  | {
      content: ChatTextContent;
      id: string;
      kind: 'justification';
      sourceId: string;
      streaming: boolean;
    }
  | {
      call: ChatToolCall;
      id: string;
      kind: 'tool';
      standalone?: boolean;
      sourceId: string;
      streaming: boolean;
    };

export interface ChatSortedTurnProjection {
  activity: readonly ChatSortedTurnActivityItem[];
  activityAnchorId?: string;
  answersBySourceId: ReadonlyMap<string, ChatAssistantMessage>;
}

interface AssistantSource {
  id: string;
  message: ChatAssistantMessage;
}

const assistantSources = (
  entries: readonly ChatTimelineEntry[],
  liveAssistant?: ChatAssistantMessage,
): AssistantSource[] => {
  const sources = entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
      ? [{ id: entry.id, message: entry.message }]
      : []
  ));
  if (liveAssistant) {
    sources.push({ id: CHAT_SORTED_LIVE_ASSISTANT_ID, message: liveAssistant });
  }
  return sources;
};

export const projectChatSortedTurn = (
  entries: readonly ChatTimelineEntry[],
  liveAssistant?: ChatAssistantMessage,
  executions?: Record<string, ChatToolExecutionState>,
): ChatSortedTurnProjection => {
  const activity: ChatSortedTurnActivityItem[] = [];
  const answersBySourceId = new Map<string, ChatAssistantMessage>();
  let activityAnchorId: string | undefined;
  const descendants = standaloneDescendants(executions), seen = new Set<string>();

  for (const source of assistantSources(entries, liveAssistant)) {
    const { message } = source;
    const streaming = message.stopReason === 'pending';
    const hasToolCall = message.content.some((content) => content.type === 'toolCall');
    const answerContent: ChatTextContent[] = [];

    for (let index = 0; index < message.content.length; index += 1) {
      const content = message.content[index];
      if (content.type === 'thinking') {
        if (!content.redacted && !content.thinking.trim()) continue;
        activityAnchorId ??= source.id;
        activity.push({
          content,
          id: `${message.id}:thinking:${index}`,
          kind: 'thinking',
          sourceId: source.id,
          streaming: streaming && index === message.content.length - 1,
        });
        continue;
      }
      if (content.type === 'toolCall') {
        const call = presentInvocation(content);
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        activityAnchorId ??= source.id;
        activity.push({
          call,
          standalone: isStandaloneTool(call.name),
          id: 'tool:' + call.id,
          kind: 'tool',
          sourceId: source.id,
          streaming,
        });
        for (const child of descendants.get(call.id) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          activity.push({ call: child, id: 'tool:' + child.id, kind: 'tool', standalone: true, sourceId: source.id, streaming: false });
        }
        continue;
      }
      if (!content.text.trim()) continue;
      if (hasToolCall || message.stopReason === 'toolUse') {
        activityAnchorId ??= source.id;
        activity.push({
          content,
          id: `${source.id}:justification:${index}`,
          kind: 'justification',
          sourceId: source.id,
          streaming,
        });
      } else {
        answerContent.push(content);
      }
    }

    if (answerContent.length > 0 || message.errorMessage) {
      answersBySourceId.set(source.id, { ...message, content: answerContent });
    }
  }

  return {
    activity,
    ...(activityAnchorId ? { activityAnchorId } : {}),
    answersBySourceId,
  };
};

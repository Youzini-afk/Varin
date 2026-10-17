import type { ChatAssistantMessage, ChatTextContent, ChatThinkingContent, ChatToolCall } from './types';
import type { ChatTimelineEntry } from './chatTimelineProjection';

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
): ChatSortedTurnProjection => {
  const activity: ChatSortedTurnActivityItem[] = [];
  const answersBySourceId = new Map<string, ChatAssistantMessage>();
  let activityAnchorId: string | undefined;

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
          id: `${source.id}:thinking:${index}`,
          kind: 'thinking',
          sourceId: source.id,
          streaming: streaming && index === message.content.length - 1,
        });
        continue;
      }
      if (content.type === 'toolCall') {
        activityAnchorId ??= source.id;
        activity.push({
          call: content,
          id: `${source.id}:tool:${content.id}`,
          kind: 'tool',
          sourceId: source.id,
          streaming,
        });
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

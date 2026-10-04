import type {
  PiAssistantMessage,
  PiTextContent,
  PiThinkingContent,
  PiToolCall,
} from '@varin/protocol';
import type { PiTimelineEntry } from './piTimelineProjection';

export const PI_SORTED_LIVE_ASSISTANT_ID = 'live-assistant';

export type PiSortedTurnActivityItem =
  | {
      content: PiThinkingContent;
      id: string;
      kind: 'thinking';
      sourceId: string;
      streaming: boolean;
    }
  | {
      content: PiTextContent;
      id: string;
      kind: 'justification';
      sourceId: string;
      streaming: boolean;
    }
  | {
      call: PiToolCall;
      id: string;
      kind: 'tool';
      sourceId: string;
      streaming: boolean;
    };

export interface PiSortedTurnProjection {
  activity: readonly PiSortedTurnActivityItem[];
  activityAnchorId?: string;
  answersBySourceId: ReadonlyMap<string, PiAssistantMessage>;
}

interface AssistantSource {
  id: string;
  message: PiAssistantMessage;
}

const assistantSources = (
  entries: readonly PiTimelineEntry[],
  liveAssistant?: PiAssistantMessage,
): AssistantSource[] => {
  const sources = entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
      ? [{ id: entry.id, message: entry.message }]
      : []
  ));
  if (liveAssistant) {
    sources.push({ id: PI_SORTED_LIVE_ASSISTANT_ID, message: liveAssistant });
  }
  return sources;
};

const isTerminalAnswer = (message: PiAssistantMessage): boolean => (
  message.stopReason !== 'pending' && message.stopReason !== 'toolUse'
);

export const projectPiSortedTurn = (
  entries: readonly PiTimelineEntry[],
  liveAssistant?: PiAssistantMessage,
): PiSortedTurnProjection => {
  const activity: PiSortedTurnActivityItem[] = [];
  const answersBySourceId = new Map<string, PiAssistantMessage>();
  let activityAnchorId: string | undefined;

  for (const source of assistantSources(entries, liveAssistant)) {
    const { message } = source;
    const streaming = message.stopReason === 'pending';
    const hasToolCall = message.content.some((content) => content.type === 'toolCall');
    const answerContent: PiTextContent[] = [];

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
      } else if (isTerminalAnswer(message)) {
        answerContent.push(content);
      }
    }

    if (isTerminalAnswer(message) && (answerContent.length > 0 || message.errorMessage)) {
      answersBySourceId.set(source.id, { ...message, content: answerContent });
    }
  }

  return {
    activity,
    ...(activityAnchorId ? { activityAnchorId } : {}),
    answersBySourceId,
  };
};

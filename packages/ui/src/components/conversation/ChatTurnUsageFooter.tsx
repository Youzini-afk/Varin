import React from 'react';
import type { ChatAssistantMessage, ChatSessionEntry, ChatUsage } from './types';
import {
  aggregateChatUsage,
  assistantMessagesForTurn,
} from './usagePresentation';
import { ChatAssistantUsageFooter } from './ChatAssistantUsageFooter';
import { ChatGenerationSpeed } from './ChatGenerationSpeed';

export const ChatTurnUsageFooter: React.FC<{
  actions?: React.ReactNode;
  entries?: readonly ChatSessionEntry[];
  usages?: readonly ChatUsage[];
  liveAssistant?: ChatAssistantMessage;
  liveGeneration?: import('@/lib/agent-runtime/thread-projection').ProgressActivity;
  /** The turn is running; a footer that saw it run arrives with motion when it ends. */
  turnActive?: boolean;
}> = ({ actions, entries = [], usages: providedUsages, liveAssistant, liveGeneration, turnActive = false }) => {
  // History footers are static. Only a turn that finished while this footer
  // was mounted staggers its actions in and rolls its numbers.
  const sawActive = React.useRef(turnActive);
  if (turnActive) sawActive.current = true;
  const arriving = sawActive.current && !turnActive;
  const usages = providedUsages ?? assistantMessagesForTurn(entries, liveAssistant).flatMap(message => message.usage ? [message.usage] : []);
  const groups = ['actual', 'estimated', 'missing'].flatMap(measurement => {
    const usage = aggregateChatUsage(usages.filter(usage => usage.measurement === measurement));
    return usage ? [usage] : [];
  });
  if (!groups.length && !actions && !liveGeneration?.generation) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5" data-conversation-turn-footer data-arriving={arriving || undefined}>
      {actions}
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {groups.map(usage => (
        <ChatAssistantUsageFooter
          key={usage.measurement}
          usage={usage}
          animate={arriving}
        />
      ))}
      <ChatGenerationSpeed usages={usages} live={liveGeneration} active={turnActive} />
      </div>
    </div>
  );
};

import React from 'react';
import type { ChatAssistantMessage, ChatSessionEntry, ChatUsage } from './types';
import {
  aggregateChatUsage,
  assistantMessagesForTurn,
  assistantTokensPerSecond,
} from './usagePresentation';
import { ChatAssistantUsageFooter } from './ChatAssistantUsageFooter';

export const ChatTurnUsageFooter: React.FC<{
  actions?: React.ReactNode;
  entries?: readonly ChatSessionEntry[];
  usages?: readonly ChatUsage[];
  liveAssistant?: ChatAssistantMessage;
  outputDurationsMs?: Readonly<Record<string, number>>;
}> = ({ actions, entries = [], usages: providedUsages, liveAssistant, outputDurationsMs }) => {
  const usages = providedUsages ?? assistantMessagesForTurn(entries, liveAssistant).flatMap(message => message.usage ? [message.usage] : []);
  const groups = ['actual', 'estimated', 'missing'].flatMap(measurement => {
    const usage = aggregateChatUsage(usages.filter(usage => usage.measurement === measurement));
    return usage ? [usage] : [];
  });
  if (!groups.length && !actions) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5" data-conversation-turn-footer>
      {actions}
      <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {groups.map(usage => (
        <ChatAssistantUsageFooter
          key={usage.measurement}
          tokensPerSecond={assistantTokensPerSecond(entries, liveAssistant, outputDurationsMs)}
          usage={usage}
        />
      ))}
      </div>
    </div>
  );
};

import React from 'react';
import type {
  PiAssistantMessage,
  PiSessionEntry,
} from '@varin/protocol';
import {
  aggregateAssistantUsage,
  assistantMessagesForTurn,
  assistantTokensPerSecond,
  projectPiUsagePresentation,
} from '@/lib/pi-runtime/usagePresentation';
import { PiAssistantUsageFooter } from './PiAssistantUsageFooter';

const isPiAssistantTurnComplete = (
  entries: readonly PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
): boolean => {
  const last = assistantMessagesForTurn(entries, liveAssistant).at(-1);
  return last !== undefined && last.stopReason !== 'pending' && last.stopReason !== 'toolUse';
};

export const PiTurnUsageFooter: React.FC<{
  actions?: React.ReactNode;
  entries: readonly PiSessionEntry[];
  liveAssistant?: PiAssistantMessage;
  outputDurationsMs?: Readonly<Record<string, number>>;
}> = ({ actions, entries, liveAssistant, outputDurationsMs }) => {
  const usage = isPiAssistantTurnComplete(entries, liveAssistant)
    ? aggregateAssistantUsage(entries, liveAssistant)
    : undefined;
  if (!projectPiUsagePresentation(usage) && !actions) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5" data-pi-turn-footer>
      {actions}
      {usage ? (
        <PiAssistantUsageFooter
          tokensPerSecond={assistantTokensPerSecond(entries, liveAssistant, outputDurationsMs)}
          usage={usage}
        />
      ) : null}
    </div>
  );
};

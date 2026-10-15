import React from 'react';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { useI18n } from '@/lib/i18n';
import { VarinLogo } from '@/components/ui/VarinLogo';
import type { ChatAssistantWaitingPresentation } from './chatAssistantWaiting';
import type { ChatTimelineTurn } from './chatTimelineProjection';

export const ChatTurnAssistantChrome: React.FC<{
  waiting?: ChatAssistantWaitingPresentation;
  turn: ChatTimelineTurn;
}> = ({ turn, waiting }) => {
  const { t } = useI18n();
  const assistants = turn.entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []
  ));
  if (turn.liveAssistant) assistants.push(turn.liveAssistant);
  const last = assistants.at(-1);
  if (!last && !waiting) return null;
  const working = waiting !== undefined || turn.liveAssistant?.stopReason === 'pending';

  const modelLabel = last?.model
    ? [last.provider, last.responseModel || last.model].filter(Boolean).join('/')
    : waiting?.model
      ? `${waiting.model.provider}/${waiting.model.id}`
      : undefined;

  return (
    <header
      className="flex min-h-6 items-center gap-2 typography-meta text-muted-foreground"
      aria-live={working ? 'polite' : undefined}
      role={working ? 'status' : undefined}
    >
      <VarinLogo width={14} height={14} className="shrink-0" isAnimated={working} decorative />
      <span className="font-medium text-foreground/85">Varin</span>
      {modelLabel ? <span className="truncate">{modelLabel}</span> : null}
      {working ? (
        <span className="min-w-0 truncate text-muted-foreground/80">
          · {t('chat.assistant.working')}<BusyDots />
        </span>
      ) : null}
    </header>
  );
};

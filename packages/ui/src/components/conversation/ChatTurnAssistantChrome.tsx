import React from 'react';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { useI18n } from '@/lib/i18n';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { useModelCatalogStore } from '@/stores/useModelCatalogStore';
import { VarinLogo } from '@/components/ui/VarinLogo';
import type { ChatAssistantWaitingPresentation } from './chatAssistantWaiting';
import type { ChatTimelineTurn } from './chatTimelineProjection';
import type { ChatAssistantMessage, ChatSessionEntry } from './types';

export const ChatTurnAssistantChrome: React.FC<{
  waiting?: ChatAssistantWaitingPresentation;
  turn?: ChatTimelineTurn;
  entries?: readonly ChatSessionEntry[];
  liveAssistant?: ChatAssistantMessage;
}> = ({ turn, entries = turn?.entries ?? [], liveAssistant = turn?.liveAssistant, waiting }) => {
  const { t } = useI18n();
  const assistants = entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []
  ));
  if (liveAssistant) assistants.push(liveAssistant);
  const last = assistants.at(-1);
  const modelId = last?.model ?? waiting?.model?.id;
  const providerId = last?.provider ?? waiting?.model?.provider;
  const configured = useModelCatalogStore(state => state.channels.find(channel => channel.id === providerId)?.models.find(model => model.id === modelId));
  if (!last && !waiting) return null;
  const working = waiting !== undefined || liveAssistant?.stopReason === 'pending';

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
      {modelLabel ? <span className="flex min-w-0 items-center gap-1.5" title={modelLabel}><ModelLogo requestModelId={last?.responseModel || configured?.requestModelId} modelId={modelId} displayName={configured?.name} /><span className="truncate">{configured?.name || last?.responseModel || modelId}</span></span> : null}
      {working ? (
        <span className="min-w-0 truncate text-muted-foreground/80">
          · {t('chat.assistant.working')}<BusyDots />
        </span>
      ) : null}
    </header>
  );
};

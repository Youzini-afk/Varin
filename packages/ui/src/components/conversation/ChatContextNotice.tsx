import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { contextPhaseLabels, type ContextPhase } from '@/lib/contextPresentation';
import { useConversationPresentation } from './ConversationContext';
import { cn } from '@/lib/utils';
import '../context/context-manager.css';

export function ChatContextNotice({ jobRunId, phase, blocking }: { jobRunId: string; phase: ContextPhase; blocking: boolean }) {
  const { t } = useI18n();
  const conversation = useConversationPresentation();
  const busy = phase === 'preparing' || phase === 'waiting';
  return <div className="context-chat-notice" data-phase={phase} data-blocking={blocking}>
    <button type="button" onClick={() => conversation.openContext?.(jobRunId)}>
      <Icon name={busy ? 'loader-4' : phase === 'failed' ? 'error-warning' : phase === 'ready' ? 'check' : 'stack'} className={cn('size-3.5 shrink-0', busy && 'animate-spin')} />
      <span>{t(contextPhaseLabels[phase])}</span><Icon name="arrow-right-s" className="size-3 shrink-0" />
    </button>
    {blocking && <p>{t(phase === 'failed' ? 'contextManager.blockedFailure' : 'contextManager.blockedHint')}</p>}
  </div>;
}

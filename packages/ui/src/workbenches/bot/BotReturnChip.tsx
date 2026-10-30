import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { returnToBot, useBotReturn } from '@/lib/bots';
import { useThreadStore } from '@/stores/useThreadStore';
import { BotFigure } from './BotFigure';

/** The Bot's work open in the workbench: which Bot handed it over, if the user came from there. */
function useReturnPoint() {
  const point = useBotReturn(state => state.point);
  const thread = useThreadStore(state => state.threads.find(candidate => candidate.thread_id === state.selectedIdentity?.threadId));
  return point && thread?.bot_id === point.botId ? { point, delegated: thread.parent_thread_id !== null } : null;
}

/** "← Varin · Everyday" in the workbench title bar, back to the conversation that dispatched the work (§6). */
export function BotReturnChip() {
  const { t } = useI18n();
  const current = useReturnPoint();
  const [leaving, setLeaving] = React.useState(false);
  if (!current) return null;
  const { point } = current;
  return <button type="button" className="bot-return-chip app-region-no-drag" disabled={leaving}
    aria-label={t('bot.return.back', { name: point.botName, session: point.sessionTitle })}
    onClick={() => { setLeaving(true); void returnToBot(point).finally(() => setLeaving(false)); }}>
    <Icon name="arrow-left-s" className="size-3.5 shrink-0" />
    <BotFigure state="idle" size={15} still />
    <span className="truncate">{point.botName} · {point.sessionTitle}</span>
  </button>;
}

/** "Delegated by Varin" under the title of the Bot's delegated work. */
export function BotDelegatedNote() {
  const { t } = useI18n();
  const current = useReturnPoint();
  if (!current?.delegated) return null;
  return <span className="min-w-0 truncate">{t('bot.return.delegated', { name: current.point.botName })}</span>;
}

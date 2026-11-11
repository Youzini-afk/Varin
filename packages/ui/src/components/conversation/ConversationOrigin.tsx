import { useI18n } from '@/lib/i18n';
import React from 'react';
import type { ConversationOrganizationEntry } from '@varin/application-client';
import { useConversationOrganizationStore } from '@/stores/useConversationOrganizationStore';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { Icon } from '@/components/icon/Icon';
import { openThreadFromNavigation, openExternalConversationFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { toast } from '@/components/ui';

/** All directory views consume the Catalog's original provenance, never the latest requester. */
export function ConversationOrigin({ origin, main = false }: { origin: ConversationOrganizationEntry['origin']; main?: boolean }) {
  const { t } = useI18n();
  const bots = useConversationOrganizationStore(state => state.bots);
  const error = useConversationOrganizationStore(state => state.botsError);
  const id = main ? origin.directBotId : origin.botId;
  if (!id || !main && origin.directBotId === id) return null;
  const bot = bots?.find(bot => bot.id === id);
  const label = bot?.name ?? (error ? t('organization.botUnreadable', { id }) : bots ? t('organization.botMissing', { id }) : t('organization.botLoading'));
  const figure = bot ? <BotFigure bot={bot} state="idle" size={main ? 22 : 16} still /> : <Icon name="user" className={main ? 'size-5' : 'size-4'} />;
  if (main || !origin.conversation) return <span title={label} aria-label={label} className="shrink-0">{figure}</span>;
  return <button type="button" className="shrink-0 rounded-sm focus-visible:ring-2 focus-visible:ring-primary" title={`${t('organization.origin')} · ${label}`} aria-label={t('organization.openOrigin', { name: label })} onClick={event => {
    event.stopPropagation(); const target = origin.conversation!;
    void (target.kind === 'native' ? openThreadFromNavigation({ threadId: target.id }) : openExternalConversationFromNavigation(target.id)).catch(error => toast.error(String(error)));
  }}>{figure}</button>;
}

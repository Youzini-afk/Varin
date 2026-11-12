import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { useConversationOrganizationStore } from '@/stores/useConversationOrganizationStore';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { useI18n } from '@/lib/i18n';

export function OrganizationCreateMenu({ onCreate }: { onCreate(botId?: string | null): void }) {
  const { t } = useI18n();
  const bots = useConversationOrganizationStore(state => state.host === getRuntimeEndpointGeneration() ? state.bots : null);
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="organization-icon-button size-6" aria-label={t('organization.newWithBot')}><Icon name="arrow-down-s" className="size-3" /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-48"><DropdownMenuItem onClick={() => onCreate(null)}><Icon name="chat-new" className="size-4" />{t('organization.newConversation')}</DropdownMenuItem>
      {!!bots?.length && <DropdownMenuSeparator />}{bots?.map(bot => <DropdownMenuItem key={bot.id} disabled={bot.archived || !!bot.deletion || bot.activity?.state === 'asleep'} onClick={() => onCreate(bot.id)}><BotFigure bot={bot} state="idle" size={18} still />{t('organization.newWithName', { name: bot.name })}</DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

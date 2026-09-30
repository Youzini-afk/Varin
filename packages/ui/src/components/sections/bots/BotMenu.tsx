import React from 'react';
import type { BotSummary } from '@/lib/bots';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export type BotMenuAction = 'pin' | 'rename' | 'profile' | 'memory' | 'sleep' | 'wake' | 'archive' | 'restore' | 'retry';
export function BotMenu({ bot, disabled, onAction, children }: {
  bot: BotSummary; disabled: boolean; onAction(action: BotMenuAction): void; children: React.ReactNode;
}) {
  const { t } = useI18n();
  const state = bot.activity?.state ?? 'awake';
  const transitioning = state === 'sleeping' || state === 'waking';
  const actions: Array<{ id: BotMenuAction; icon: IconName; label: string; disabled?: boolean } | null> = bot.archived ? [
    { id: 'restore', icon: 'history', label: t('settings.bots.restore') },
    { id: 'profile', icon: 'settings-3', label: t('settings.bots.section.profile') },
    { id: 'memory', icon: 'brain', label: t('settings.bots.memory') },
  ] : [
    { id: 'pin', icon: 'pushpin', label: t(bot.pinnedAt ? 'settings.bots.unpin' : 'settings.bots.pin') },
    { id: 'rename', icon: 'edit', label: t('settings.bots.rename') },
    null,
    { id: 'profile', icon: 'settings-3', label: t('settings.bots.section.profile') },
    { id: 'memory', icon: 'brain', label: t('settings.bots.memory') },
    null,
    { id: state === 'awake' || state === 'sleep-failed' ? 'sleep' : 'wake',
      icon: state === 'awake' || state === 'sleep-failed' ? 'moon' : 'play',
      label: t(state === 'awake' ? 'settings.bots.sleep' : state === 'sleep-failed' ? 'settings.bots.sleepRetry' : 'settings.bots.wake'), disabled: transitioning },
    { id: 'archive', icon: 'archive', label: t('settings.bots.archive'), disabled: transitioning },
  ];
  const items = (dropdown: boolean) => {
    const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
    const Separator = dropdown ? DropdownMenuSeparator : ContextMenuSeparator;
    return actions.map((action, index) => action ? <Item key={action.id} disabled={disabled || action.disabled} onSelect={() => onAction(action.id)}>
      <Icon name={action.icon} className="size-4" />{action.label}
    </Item> : <Separator key={`separator-${index}`} />);
  };
  return <ContextMenu>
    <ContextMenuTrigger asChild>
      <div className="group flex items-center rounded-md focus-within:bg-interactive-hover data-[state=open]:bg-interactive-hover">
        {children}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label={`${bot.name} · ${t('settings.bots.actions')}`} className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100">
            <Icon name="more" className="size-4" />
          </button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">{items(true)}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>{items(false)}</ContextMenuContent>
  </ContextMenu>;
}

import React from 'react';
import type { BotSummary } from '@/lib/bots';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export type BotMenuAction = 'pin' | 'rename' | 'profile' | 'memory' | 'sleep' | 'wake' | 'archive' | 'restore' | 'retry' | 'delete';
export function BotMenu({ bot, disabled, onAction, children, persistentActions = false, onMove }: {
  bot: BotSummary; disabled: boolean; onAction(action: BotMenuAction): void; children: React.ReactNode; persistentActions?: boolean; onMove?(): void;
}) {
  const { t } = useI18n();
  const pending = React.useRef<BotMenuAction | 'move' | null>(null);
  const returnFocus = React.useRef(true);
  const opened = (open: boolean) => { if (open) { pending.current = null; returnFocus.current = true; } };
  const complete = (open: boolean) => {
    if (open || !pending.current) return;
    const action = pending.current; pending.current = null; if (action === 'move') onMove?.(); else onAction(action);
  };
  const state = bot.activity?.state ?? 'awake';
  const transitioning = state === 'sleeping' || state === 'waking';
  const actions: Array<{ id: BotMenuAction; icon: IconName; label: string; disabled?: boolean } | null> = bot.deletion ? [
    { id: 'retry', icon: 'refresh', label: t(bot.deletion.error ? 'settings.bots.deleteRetry' : 'settings.bots.deleting'), disabled: !bot.deletion.error },
  ] : bot.archived ? [
    { id: 'restore', icon: 'history', label: t('settings.bots.restore') },
    { id: 'profile', icon: 'settings-3', label: t('settings.bots.section.profile') },
    { id: 'memory', icon: 'brain', label: t('settings.bots.memory') },
    null,
    { id: 'delete', icon: 'delete-bin', label: t('settings.bots.delete'), disabled: transitioning },
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
    null,
    { id: 'delete', icon: 'delete-bin', label: t('settings.bots.delete'), disabled: transitioning },
  ];
  const items = (dropdown: boolean) => {
    const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
    const Separator = dropdown ? DropdownMenuSeparator : ContextMenuSeparator;
    return <>{onMove && !bot.deletion ? <><Item disabled={disabled} onClick={() => { pending.current = 'move'; returnFocus.current = false; }}><Icon name="folder" className="size-4" />{t('bot.groups.move')}</Item><Separator /></> : null}{actions.map((action, index) => action ? <Item key={action.id} className={action.id === 'delete' ? 'text-destructive' : undefined} disabled={disabled || action.disabled} onClick={() => {
      pending.current = action.id;
      returnFocus.current = !['rename', 'profile', 'memory', 'delete'].includes(action.id);
    }}>
      <Icon name={action.icon} className="size-4" />{action.label}
    </Item> : <Separator key={`separator-${index}`} />)}</>;
  };
  return <ContextMenu onOpenChange={opened} onOpenChangeComplete={complete}>
    <ContextMenuTrigger asChild>
      <div className="group flex items-center rounded-md focus-within:bg-interactive-hover data-[state=open]:bg-interactive-hover">
        {children}
        <DropdownMenu onOpenChange={opened} onOpenChangeComplete={complete}>
          <DropdownMenuTrigger asChild><button type="button" disabled={disabled} aria-label={`${bot.name} · ${t('settings.bots.actions')}`} className={`mr-1 rounded p-1 text-muted-foreground hover:text-foreground focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 ${persistentActions ? 'opacity-100' : 'opacity-0'}`}>
            <Icon name="more" className="size-4" />
          </button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" finalFocus={() => returnFocus.current}>{items(true)}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent finalFocus={() => returnFocus.current}>{items(false)}</ContextMenuContent>
  </ContextMenu>;
}

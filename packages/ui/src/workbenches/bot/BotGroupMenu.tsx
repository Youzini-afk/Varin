import React from 'react';
import type { BotGroup } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { BotOrganizationController } from './useBotOrganization';
import type { BotOrganizationDialogState } from './BotOrganizationDialog';

export function BotGroupMenu({ group, children, organization, onDialog }: React.PropsWithChildren<{ group: BotGroup; organization: BotOrganizationController; onDialog(value: BotOrganizationDialogState): void }>) {
  const { t } = useI18n();
  const deferred = React.useRef<(() => void) | null>(null);
  const focus = React.useRef(true);
  const complete = (open: boolean) => { if (!open) { const action = deferred.current; deferred.current = null; action?.(); } };
  const groups = organization.value.groups, index = groups.findIndex(item => item.id === group.id);
  const items = (dropdown: boolean) => {
    const Item = dropdown ? DropdownMenuItem : ContextMenuItem, Separator = dropdown ? DropdownMenuSeparator : ContextMenuSeparator;
    return <>
      <Item disabled={organization.pending} onClick={() => { focus.current = false; deferred.current = () => onDialog({ kind: 'rename', group }); }}><Icon name="edit" className="size-4" />{t('bot.groups.rename')}</Item>
      <Item disabled={organization.pending || index <= 0} onClick={() => { deferred.current = () => { void organization.change({ kind: 'move-group', id: group.id, beforeId: groups[index - 1]!.id }); }; }}><Icon name="arrow-up" className="size-4" />{t('bot.groups.up')}</Item>
      <Item disabled={organization.pending || index === groups.length - 1} onClick={() => { deferred.current = () => { void organization.change({ kind: 'move-group', id: group.id, beforeId: groups[index + 2]?.id ?? null }); }; }}><Icon name="arrow-down" className="size-4" />{t('bot.groups.down')}</Item>
      <Separator />
      <Item disabled={organization.pending} onClick={() => { focus.current = false; deferred.current = () => onDialog({ kind: 'remove', group }); }}><Icon name="delete-bin" className="size-4" />{t('bot.groups.remove')}</Item>
    </>;
  };
  const opened = (open: boolean) => { if (open) { deferred.current = null; focus.current = true; } };
  return <ContextMenu onOpenChange={opened} onOpenChangeComplete={complete}>
    <ContextMenuTrigger asChild><div className="group bot-group-heading">{children}
      <DropdownMenu onOpenChange={opened} onOpenChangeComplete={complete}>
        <DropdownMenuTrigger asChild><button type="button" aria-label={`${group.name} · ${t('settings.bots.actions')}`} disabled={organization.pending} className="bot-group-more"><Icon name="more" className="size-4" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="start" finalFocus={() => focus.current}>{items(true)}</DropdownMenuContent>
      </DropdownMenu>
    </div></ContextMenuTrigger>
    <ContextMenuContent finalFocus={() => focus.current}>{items(false)}</ContextMenuContent>
  </ContextMenu>;
}

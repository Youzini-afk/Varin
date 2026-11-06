import React from 'react';
import type { ThreadIdentity } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import type { BotSessionView } from './botPresentation';

export type BotSessionAction = 'open' | 'tree' | 'fork' | 'rename' | 'automatic-title' | 'pin' | 'copy' | 'archive' | 'restore' | 'delete';

/** Session metadata belongs to the conversation; branch actions retain the exact clicked branch. */
export function BotSessionMenu({ session, identity, label, disabled, onAction, children }: React.PropsWithChildren<{
  session: BotSessionView; identity: ThreadIdentity; label: string; disabled: boolean;
  onAction(action: BotSessionAction): void;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const pending = React.useRef<BotSessionAction | null>(null);
  const returnFocus = React.useRef(true);
  const change = (visible: boolean) => {
    setOpen(visible);
    if (visible) { pending.current = null; returnFocus.current = true; }
  };
  const branch = session.thread.branches.find(item => item.branch_id === identity.branchId);
  const main = identity.branchId === session.thread.main_branch_id;
  const complete = (visible: boolean) => {
    if (visible || !pending.current) return;
    const action = pending.current; pending.current = null;
    onAction(action);
  };
  const items = (dropdown: boolean) => {
    const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
    const Separator = dropdown ? DropdownMenuSeparator : ContextMenuSeparator;
    const select = (action: BotSessionAction) => () => {
      pending.current = action;
      returnFocus.current = action !== 'rename' && action !== 'delete';
    };
    return <>
      <Item disabled={disabled} onClick={select('open')}><Icon name="chat-3" className="size-4" />{t(main ? 'bot.session.menu.open' : 'bot.session.menu.openBranch')}</Item>
      <Item disabled={disabled} onClick={select('tree')}><Icon name="git-branch" className="size-4" />{t('chat.tree.title')}</Item>
      <Item disabled={disabled || session.thread.archived || !branch?.head} onClick={select('fork')}><Icon name="git-branch" className="size-4" />{t('bot.session.menu.fork')}</Item>
      {main ? <>
        <Separator />
        <Item disabled={disabled} onClick={select('rename')}><Icon name="edit" className="size-4" />{t('sessions.sidebar.session.menu.rename')}</Item>
        {session.thread.title_mode === 'manual' ? <Item disabled={disabled} onClick={select('automatic-title')}><Icon name="refresh" className="size-4" />{t('sessions.sidebar.session.menu.resumeTitles')}</Item> : null}
        <Item disabled={disabled} onClick={select('pin')}><Icon name={session.thread.pinned ? 'unpin' : 'pushpin'} className="size-4" />{t(session.thread.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')}</Item>
      </> : null}
      <Separator />
      <Item onClick={select('copy')}><Icon name="file-copy" className="size-4" />{t(main ? 'sessions.sidebar.session.menu.copyId' : 'bot.session.menu.copyBranchId')}</Item>
      {main ? <>
        <Separator />
        <Item disabled={disabled} onClick={select(session.thread.archived ? 'restore' : 'archive')}>
          <Icon name={session.thread.archived ? 'inbox-unarchive' : 'inbox-archive'} className="size-4" />
          {t(session.thread.archived ? 'sessions.sidebar.session.menu.restore' : 'sessions.sidebar.bulkActions.archive')}
        </Item>
        <Item className="text-destructive" disabled={disabled} onClick={select('delete')}>
          <Icon name="delete-bin" className="size-4" />{t('sessions.sidebar.dialogs.deleteSession.titleAction')}
        </Item>
      </> : null}
    </>;
  };
  return <ContextMenu onOpenChange={change} onOpenChangeComplete={complete}>
    <ContextMenuTrigger asChild>
      <div className="bot-session-menu group/session relative" data-menu-open={open || undefined} onKeyDown={event => {
        if (event.defaultPrevented || event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault(); event.stopPropagation();
        const target = event.target as HTMLElement, rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
      }}>
        {children}
        <DropdownMenu onOpenChange={change} onOpenChangeComplete={complete}>
          <DropdownMenuTrigger asChild><button type="button" disabled={disabled} aria-label={t('bot.session.menu.actions', { name: label })}
            className="bot-session-menu-button absolute right-1 top-1/2 -translate-y-1/2 rounded-[var(--radius-item)] p-1 text-muted-foreground transition-opacity hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 group-focus-within/session:opacity-100 [@media(hover:none)]:opacity-100">
            <Icon name="more" className="size-3.5" />
          </button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" finalFocus={() => returnFocus.current}>{items(true)}</DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="min-w-48" finalFocus={() => returnFocus.current}>{items(false)}</ContextMenuContent>
  </ContextMenu>;
}

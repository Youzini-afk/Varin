import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { piContentText } from './extensionPresentation';
import type { PiTimelineRow } from './piTimelineProjection';

/** History navigation follows row changes, independently of the streaming answer. */
export const PiPromptNavigator = React.memo(({
  items,
  onSelect,
}: {
  items: readonly PiTimelineRow[];
  onSelect(index: number): void;
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const turns = React.useMemo(() => items.flatMap((item, index) => (
    item.kind === 'turn' ? [{ item, index }] : []
  )), [items]);
  if (turns.length < 2) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={t('settings.chat.navigator')} title={t('settings.chat.navigator')}
          className="absolute right-3 top-2 z-20 flex size-7 items-center justify-center rounded-md border border-border/50 bg-background/95 text-muted-foreground shadow-sm hover:text-foreground">
          <Icon name="list-check-2" className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 max-w-[min(24rem,85vw)] overflow-y-auto">
        {open ? turns.map(({ item, index }) => (
          <DropdownMenuItem key={item.id} onSelect={() => onSelect(index)}>
            <span className="truncate">{piContentText(item.turn.user.content).trim() || '…'}</span>
          </DropdownMenuItem>
        )) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

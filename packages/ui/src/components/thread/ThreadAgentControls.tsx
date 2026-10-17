import React from 'react';
import type { WorkFocusId } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';

/** Agent identifies the execution backend. Varin is the currently available backend. */
export function ThreadAgentControls({ workFocus, disabled, pending, onWorkFocusChange }: {
  workFocus: WorkFocusId; disabled: boolean; pending?: boolean;
  onWorkFocusChange(workFocus: WorkFocusId): void;
}) {
  const { t } = useI18n();
  const buttonClass = 'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-40';
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className={buttonClass} aria-label={`${t('chat.modelControls.selectAgent')}: Varin`} title="Varin">
        <VarinLogo decorative width={14} height={14} className="shrink-0" /><span>Varin</span><Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
      </button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="min-w-40" portalToBody>
      <DropdownMenuItem><VarinLogo decorative width={16} height={16} className="shrink-0" /><span className="flex-1">Varin</span><Icon name="check" className="size-3.5" /></DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <DropdownMenu><DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} className={buttonClass} aria-label={`${t('workFocus.label')}: ${t(`workFocus.${workFocus}`)}`} title={pending ? t('workFocus.nextTurn') : t(`workFocus.${workFocus}Description`)}>
        <Icon name={workFocus === 'research' ? 'workspace-research' : 'workspace-general'} className="size-3.5 shrink-0" /><span className="whitespace-nowrap">{t(`workFocus.${workFocus}`)}</span><Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
      </button>
    </DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="w-64" portalToBody>
      {(['code', 'research'] as const).map(focus => <DropdownMenuItem key={focus} className="items-start gap-2" onSelect={() => onWorkFocusChange(focus)}>
        <Icon name={focus === 'research' ? 'workspace-research' : 'workspace-general'} className="mt-0.5 size-4 shrink-0" /><span className="flex-1"><span className="block">{t(`workFocus.${focus}`)}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`workFocus.${focus}Description`)}</span></span>{workFocus === focus && <Icon name="check" className="size-3.5 shrink-0" />}
      </DropdownMenuItem>)}
      {pending && <p className="border-t border-border/50 px-2 py-2 typography-micro text-muted-foreground">{t('workFocus.nextTurn')}</p>}
    </DropdownMenuContent></DropdownMenu>
  </>;
}

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { useI18n } from '@/lib/i18n';
import { useSettingsTitlebar } from '@/components/sections/shared/kit/shell-context';
import { SwapText } from '@/components/motion/SwapText';

const BUTTON = 'app-region-no-drag inline-flex h-7 items-center gap-1.5 rounded-lg pl-[7px] pr-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

/** Titlebar content while settings owns the canvas: return, breadcrumb and the connected Varin service. */
export function SettingsTitlebar({ leftInset }: { leftInset: string }) {
  const { t } = useI18n();
  const state = useSettingsTitlebar();
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const inPage = state?.compact && state.stage === 'page';
  const back = inPage ? state?.back : state?.close;
  return <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch" style={{ paddingLeft: leftInset }}>
    {usesFramelessChrome && side === 'left' ? <WindowsWindowControls visible position="left" /> : null}
    <span className="pl-1" />
    {back ? <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={BUTTON} onClick={back}>
          <Icon name="arrow-left-s" className="size-4" />{inPage ? t('settings.view.home.title') : t('settings.shell.back')}
        </button>
      </TooltipTrigger>
      <TooltipContent><p>{inPage ? t('settings.view.actions.backToSettings') : t('settings.shell.backHint')}</p></TooltipContent>
    </Tooltip> : null}
    {inPage ? null : <span className="ml-1 flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
      <span>{t('settings.view.home.title')}</span>
      <span className="opacity-60">/</span>
    </span>}
    {state?.title ? <SwapText text={state.title} hold={0} className="min-w-0 truncate text-[13px] font-medium text-foreground" /> : null}
    <span className="flex-1" />
    {state?.host ? <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={`${BUTTON} gap-[7px] px-2.5 text-[12.5px]`} onClick={state.host.open}>
          <span className="size-[7px] shrink-0 rounded-full" style={{ background: state.host.state === 'ok' ? 'var(--status-success)' : 'var(--status-warning)' }} />
          <span className="max-w-[14rem] truncate">{state.host.name}</span>
        </button>
      </TooltipTrigger>
      {state.host.hint ? <TooltipContent><p>{state.host.hint}</p></TooltipContent> : null}
    </Tooltip> : null}
  </div>;
}

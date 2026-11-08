import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { useI18n } from '@/lib/i18n';
import type { BotSummary } from '@varin/application-client';
import { BotFigure } from './BotFigure';
import type { BotFigureState, BotStateLine } from './botPresentation';
import React from 'react';
import { Popover } from '@base-ui/react/popover';
import type { BotPanelModel } from './botPanelModel';
import { useBotWorkspaceNavigation } from './botWorkspaceViews';
import { BotWorkStatusLabel } from './BotActivityPane';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Button } from '@/components/ui/button';

/**
 * A persistent status capsule: preview real work, then open its original view or the full panel.
 */
export function BotMobileTitle({ bot, figure, line, open, onToggle, model }: {
  bot: BotSummary;
  figure: BotFigureState;
  line: BotStateLine;
  open: boolean;
  onToggle(): void;
  model?: BotPanelModel | null;
}) {
  const { t } = useI18n();
  const state = t(line.key, line.params);
  const navigation = useBotWorkspaceNavigation();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const work = model?.work.filter(item => item.lead && item.status && item.sessionThreadId === model.session?.identity.threadId) ?? [];
  return <Popover.Root open={previewOpen} onOpenChange={setPreviewOpen}><Popover.Trigger render={<button type="button" className="bot-mobile-title bot-mobile-capsule" data-open={previewOpen || undefined}
    aria-label={`${t(open ? 'bot.mobile.closePanel' : 'bot.mobile.openPanel', { name: bot.name })}, ${state}`}>
    <BotFigure bot={bot} state={figure} size={26} still />
    <span className="bot-mobile-title-text">
      <span className="bot-mobile-title-name">{bot.name}</span>
      <span className="bot-mobile-title-state" data-tone={line.tone === 'warn' ? 'warn' : undefined}><SwapText text={state} resize className="min-w-0" /></span>
    </span>
    <Icon name="arrow-down-s" className="bot-mobile-title-caret size-4" />
  </button>} />
    <Popover.Portal><Popover.Positioner side="bottom" align="center" sideOffset={8} className="z-40"><Popover.Popup className="bot-mobile-work-preview">
      <Popover.Title className="typography-ui-label">{bot.name}</Popover.Title><Popover.Description className="mt-1 typography-meta text-muted-foreground">{state}</Popover.Description>
      <div className="bot-capsule-work">
        {model?.needs.map(need => <button key={need.key} type="button" onClick={() => { setPreviewOpen(false); model.openNeed(need); }}><Icon name="question" className="size-4 text-status-warning" /><span>{need.name}<small>{t(need.kind === 'permission' ? 'bot.overview.needPermission' : 'bot.overview.needQuestion')}</small></span><Icon name="arrow-right-s" className="size-4" /></button>)}
        {work.slice(0, 3).map(item => <button key={item.key} type="button" onClick={() => { setPreviewOpen(false); navigation?.open({ kind: 'work', key: item.key, identity: item.identity, title: item.name }); }}><AgentAvatar identity={item.identity.threadId} avatar={item.avatar} role="lead" size={24} /><span>{item.name}<small>{item.status && <BotWorkStatusLabel status={item.status} />}</small></span><Icon name="arrow-right-s" className="size-4" /></button>)}
        {!work.length && !model?.needs.length && <p className="typography-meta text-muted-foreground">{t('bot.workspace.emptyWork')}</p>}
      </div>
      <footer className="flex justify-end"><Button variant="outline" size="sm" onClick={() => { setPreviewOpen(false); onToggle(); }}>{t(open ? 'bot.mobile.closePanel' : 'bot.mobile.openPanel', { name: bot.name })}</Button></footer>
    </Popover.Popup></Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}

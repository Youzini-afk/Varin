import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { useI18n } from '@/lib/i18n';
import type { BotSummary } from '@varin/application-client';
import { BotFigure } from './BotFigure';
import type { BotFigureState, BotStateLine } from './botPresentation';

/**
 * The phone title bar's centre (§8): the Bot's figure at 26px, its name and the state line.
 * Pressing it opens the bottom sheet with the Bot area and tabs; pressing again closes it.
 */
export function BotMobileTitle({ bot, figure, line, open, onToggle }: {
  bot: BotSummary;
  figure: BotFigureState;
  line: BotStateLine;
  open: boolean;
  onToggle(): void;
}) {
  const { t } = useI18n();
  const state = t(line.key, line.params);
  return <button type="button" className="bot-mobile-title" aria-expanded={open} data-open={open || undefined} onClick={onToggle}
    aria-label={`${t(open ? 'bot.mobile.closePanel' : 'bot.mobile.openPanel', { name: bot.name })}, ${state}`}>
    <BotFigure state={figure} size={26} still />
    <span className="bot-mobile-title-text">
      <span className="bot-mobile-title-name">{bot.name}</span>
      <span className="bot-mobile-title-state" data-tone={line.tone === 'warn' ? 'warn' : undefined}><SwapText text={state} className="min-w-0" /></span>
    </span>
    <Icon name="arrow-down-s" className="bot-mobile-title-caret size-4" />
  </button>;
}

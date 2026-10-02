import React from 'react';
import { DEFAULT_CHAT_CONTENT_WIDTH } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SettingsChipGroup } from '../shared/SettingsSection';
import { SettingsInfoHint } from '../shared/SettingsInfoHint';

export const ChatWidthSettings: React.FC = () => {
  const { t } = useI18n();
  const width = useUIStore(state => state.chatContentWidth);
  const setWidth = useUIStore(state => state.setChatContentWidth);
  const [draft, setDraft] = React.useState(String(width));
  const inputId = React.useId();
  const sliderId = React.useId();
  React.useEffect(() => setDraft(String(width)), [width]);

  const apply = (value: number) => {
    setWidth(value);
    void updateDesktopSettings({ chatContentWidth: value });
  };
  const commitDraft = () => {
    const value = Number(draft);
    if (draft.trim() && Number.isSafeInteger(value) && value > 0) apply(value);
    else setDraft(String(width));
  };
  // These are comfortable drag bounds, not storage/API limits. Typed widths
  // outside this range stay valid and extend the slider to their value.
  const sliderMin = width > 0 ? Math.min(640, width) : 640;
  const sliderMax = Math.max(1440, width);

  return <div data-settings-item="chat.content-width" className="rounded-xl border border-border/70 bg-muted/15 p-4 @xl:p-5">
    <div className="mb-4 flex items-center gap-2">
      <label htmlFor={inputId} className="typography-ui-label font-medium">{t('settings.chat.width.title')}</label>
      <SettingsInfoHint>{t('settings.chat.width.hint')}</SettingsInfoHint>
      <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2 typography-meta"
        disabled={width === DEFAULT_CHAT_CONTENT_WIDTH} onClick={() => apply(DEFAULT_CHAT_CONTENT_WIDTH)}>
        <Icon name="restart" className="size-3.5" />{t('settings.common.actions.reset')}
      </Button>
    </div>
    <SettingsChipGroup aria-label={t('settings.chat.width.title')} value={String(width)} onChange={value => apply(Number(value))}
      options={[
        { value: '768', label: t('settings.chat.width.compact') },
        { value: '960', label: t('settings.chat.width.comfortable') },
        { value: '1152', label: t('settings.chat.width.wide') },
        { value: '0', label: t('settings.chat.width.full') },
      ]} />
    <div className="mt-5 flex flex-wrap items-center gap-4">
      <input id={sliderId} type="range" aria-label={t('settings.chat.width.title')}
        min={sliderMin} max={sliderMax} step="1" value={width || DEFAULT_CHAT_CONTENT_WIDTH}
        disabled={width === 0} onChange={event => apply(Number(event.target.value))}
        className="h-6 min-w-32 flex-1 cursor-pointer accent-[var(--primary-base)] disabled:cursor-default disabled:opacity-35" />
      <div className="flex items-center gap-2">
        <Input id={inputId} type="text" inputMode="numeric" value={width === 0 ? t('settings.chat.width.full') : draft}
          disabled={width === 0} onChange={event => setDraft(event.target.value)} onBlur={commitDraft}
          onKeyDown={event => { if (event.key === 'Enter') { commitDraft(); event.currentTarget.blur(); } }}
          className="h-8 w-24 text-right tabular-nums" />
        <span className="w-5 typography-meta text-muted-foreground">{width === 0 ? '' : 'px'}</span>
      </div>
    </div>
  </div>;
};

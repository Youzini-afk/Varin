import React from 'react';
import { DEFAULT_CHAT_CONTENT_WIDTH } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { SettingsFieldRow } from '../shared/SettingsSection';

export const ChatWidthSettings: React.FC = () => {
  const { t } = useI18n();
  const width = useUIStore(state => state.chatContentWidth);
  const setWidth = useUIStore(state => state.setChatContentWidth);
  const [draft, setDraft] = React.useState(String(width));
  const inputId = React.useId();
  React.useEffect(() => setDraft(String(width)), [width]);
  const apply = (value: number) => { setWidth(value); void updateDesktopSettings({ chatContentWidth: value }); };
  const commitDraft = () => {
    const value = Number(draft);
    if (draft.trim() && Number.isSafeInteger(value) && value > 0 && value !== width) apply(value);
    else setDraft(String(width));
  };
  const options = [
    { value: 768, label: t('settings.chat.width.compact') },
    { value: 960, label: t('settings.chat.width.comfortable') },
    { value: 1152, label: t('settings.chat.width.wide') },
    { value: 0, label: t('settings.chat.width.full') },
  ];
  return <div data-settings-item="chat.content-width">
    <SettingsFieldRow label={t('settings.chat.width.title')} info={t('settings.chat.width.hint')}>
      <Select value={String(width)} onValueChange={value => apply(Number(value))}>
        <SelectTrigger size="settings" className="w-40" aria-label={t('settings.chat.width.title')}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(option => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}
          {!options.some(option => option.value === width) && <SelectItem value={String(width)}>{width} px</SelectItem>}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {width > 0 && <SettingsFieldRow label={<label htmlFor={inputId}>{t('settings.chat.width.title')} (px)</label>} controlClassName="flex-wrap">
      {/* Drag bounds are comfort presets, not storage limits; typed widths extend them. */}
      <input type="range" aria-label={t('settings.chat.width.title')} min={Math.min(640, width)} max={Math.max(1440, width)} step="1" value={width}
        onChange={event => apply(Number(event.target.value))} className="hidden h-6 w-24 cursor-pointer accent-[var(--primary-base)] @3xl:block" />
      <Input id={inputId} type="text" inputMode="numeric" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitDraft}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="h-8 w-20 text-right tabular-nums" />
      <Button type="button" variant="ghost" size="icon" className="size-8" disabled={width === DEFAULT_CHAT_CONTENT_WIDTH} onClick={() => apply(DEFAULT_CHAT_CONTENT_WIDTH)} aria-label={t('settings.common.actions.reset')}><Icon name="restart" className="size-3.5" /></Button>
    </SettingsFieldRow>}
  </div>;
};

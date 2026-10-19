import React from 'react';
import { formatMessageTime, isTimeZone } from '@varin/protocol';
import { SettingsSection, SettingsCheckboxRow, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { canonicalizeTimezone } from '@/lib/timezones';
import { AutoSaveInput } from './AutoSaveInput';
import type { HarnessSettingsPageProps } from './harness-settings-state';

export function MessageTimeSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const settings = harness.context.messageTime;
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = React.useMemo(() => [...new Set(['UTC', deviceZone, ...Intl.supportedValuesOf('timeZone')])].sort(), [deviceZone]);
  const zoneList = React.useId();
  const set = (patch: Partial<typeof settings>) => update({ context: { messageTime: patch } });
  return <SettingsSection title={t('settings.page.harness.context.messageTime.title')} settingsItem="harness.context.messageTime">
    <SettingsCheckboxRow checked={settings.enabled} onChange={enabled => set({ enabled })}
      label={t('settings.page.harness.context.messageTime.enabled')}
      description={t('settings.page.harness.context.messageTime.description')} />
    <SettingsFieldRow label={t('settings.page.harness.context.messageTime.timeZone')}>
      <div className="w-full space-y-2 @xl:w-80">
        <Select value={settings.timeZone === null ? 'device' : 'custom'} disabled={!settings.enabled}
          onValueChange={mode => set({ timeZone: mode === 'device' ? null : deviceZone })}>
          <SelectTrigger size="settings" className="w-full" aria-label={t('settings.page.harness.context.messageTime.timeZone')}>
            <SelectValue>{settings.timeZone === null
              ? t('settings.page.harness.context.messageTime.device', { timeZone: deviceZone })
              : t('settings.page.harness.context.messageTime.custom')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="device">{t('settings.page.harness.context.messageTime.device', { timeZone: deviceZone })}</SelectItem>
            <SelectItem value="custom">{t('settings.page.harness.context.messageTime.custom')}</SelectItem>
          </SelectContent>
        </Select>
        {settings.timeZone !== null && <>
          <AutoSaveInput value={settings.timeZone} disabled={!settings.enabled} list={zoneList}
            aria-label={t('settings.page.harness.context.messageTime.custom')}
            placeholder={t('settings.page.harness.context.messageTime.search')}
            validate={value => isTimeZone(value.trim()) ? null : t('settings.page.harness.context.messageTime.invalid')}
            onCommit={value => set({ timeZone: canonicalizeTimezone(value.trim()) })} />
          <datalist id={zoneList}>{[...new Set([...zones, settings.timeZone])].map(zone => <option key={zone} value={zone} />)}</datalist>
        </>}
      </div>
    </SettingsFieldRow>
    {settings.enabled && <p className="typography-meta text-muted-foreground" aria-label={t('settings.page.harness.context.messageTime.preview')}>
      {t('settings.page.harness.context.messageTime.preview')}: <span className="break-all font-mono">Message sent at: {formatMessageTime(Date.now(), settings.timeZone ?? deviceZone)}</span>
    </p>}
  </SettingsSection>;
}

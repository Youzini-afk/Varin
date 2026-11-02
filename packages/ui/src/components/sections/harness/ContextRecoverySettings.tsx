import React from 'react';
import type { CompactionRecoverySettings } from '@varin/protocol';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/i18n';
import { SettingsFieldRow } from '../shared/SettingsSection';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';

/** Preserved legacy preferences are not an operating control. No write callback
 * exists until the native ContextJob owner actually consumes these settings. */
export function ContextRecoverySettings({ value }: { value: CompactionRecoverySettings }) {
  const { t } = useI18n();
  return <SettingsDisclosure title={t('settings.page.harness.context.recovery.title')} settingsItem="harness.context.compactionRecovery">
    <p className="mb-3 typography-meta text-muted-foreground">{t('settings.page.harness.context.recovery.description')}</p>
    <SettingsFieldRow label={t('settings.page.harness.context.recovery.enabled')}>
      <Switch checked={value.enabled} disabled aria-label={t('settings.page.harness.context.recovery.enabled')} />
    </SettingsFieldRow>
    <SettingsFieldRow label={t('settings.page.harness.context.recovery.streamIdle')}>
      <Input className="w-28" type="number" disabled readOnly value={String(value.streamIdleMs / 1000)} aria-label={t('settings.page.harness.context.recovery.streamIdle')} />
      <span className="typography-meta text-muted-foreground">s</span>
    </SettingsFieldRow>
    <SettingsFieldRow label={t('settings.page.harness.context.recovery.responseWait')}>
      <Input className="w-28" type="number" disabled readOnly value={String(value.responseWaitMs / 1000)} aria-label={t('settings.page.harness.context.recovery.responseWait')} />
      <span className="typography-meta text-muted-foreground">s</span>
    </SettingsFieldRow>
    <SettingsFieldRow label={t('settings.page.harness.context.recovery.retries')}>
      <Input className="w-28" type="number" disabled readOnly value={String(value.maxRetries)} aria-label={t('settings.page.harness.context.recovery.retries')} />
    </SettingsFieldRow>
  </SettingsDisclosure>;
}

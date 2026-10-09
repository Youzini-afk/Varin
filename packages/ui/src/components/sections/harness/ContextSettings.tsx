import React from 'react';
import { SettingsSection, SettingsCheckboxRow, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';

export function ContextSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const recovery = harness.context.compactionRecovery;
  const validSeconds = (value: string): string | null => {
    const millis = Math.round(Number(value) * 1000);
    return Number.isSafeInteger(millis) && millis > 0 && millis <= 2_147_483_647
      ? null : t('settings.harness.positiveNumber');
  };
  const validRetries = (value: string): string | null => value.trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? null : t('settings.page.harness.context.recovery.retries.invalid');
  const setRecovery = (patch: Partial<typeof recovery>) => update({ context: { compactionRecovery: patch } });
  return <>
    <SettingsSection settingsItem="harness.models.agentPlanning">
      <HarnessModelField harness={harness} update={update} slot="agentPlanning" />
    </SettingsSection>
    <SettingsSection settingsItem="harness.context">
      <SettingsCheckboxRow checked={harness.context.backgroundPreparation}
        onChange={(backgroundPreparation) => update({ context: { backgroundPreparation } })}
        ariaLabel={t('settings.page.harness.context.backgroundPreparation')}
        label={t('settings.page.harness.context.backgroundPreparation')}
        description={t('settings.page.harness.context.backgroundPreparation.description')} />
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.context.recovery.title')}
      description={t('settings.page.harness.context.recovery.description')} settingsItem="harness.context.compactionRecovery">
      <SettingsCheckboxRow checked={recovery.enabled} onChange={(enabled) => setRecovery({ enabled })}
        ariaLabel={t('settings.page.harness.context.recovery.enabled')}
        label={t('settings.page.harness.context.recovery.enabled')}
        description={t('settings.page.harness.context.recovery.enabled.description')} />
      <SettingsFieldRow label={t('settings.page.harness.context.recovery.streamIdle')}
        description={t('settings.page.harness.context.recovery.streamIdle.description')}>
        <AutoSaveInput className="w-28" type="number" disabled={!recovery.enabled}
          aria-label={t('settings.page.harness.context.recovery.streamIdle')}
          value={String(recovery.streamIdleMs / 1000)} validate={validSeconds}
          onCommit={(value) => setRecovery({ streamIdleMs: Math.round(Number(value) * 1000) })} />
        <span className="typography-meta text-muted-foreground">s</span>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.context.recovery.responseWait')}
        description={t('settings.page.harness.context.recovery.responseWait.description')}>
        <AutoSaveInput className="w-28" type="number" disabled={!recovery.enabled}
          aria-label={t('settings.page.harness.context.recovery.responseWait')}
          value={String(recovery.responseWaitMs / 1000)} validate={validSeconds}
          onCommit={(value) => setRecovery({ responseWaitMs: Math.round(Number(value) * 1000) })} />
        <span className="typography-meta text-muted-foreground">s</span>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.context.recovery.retries')}
        description={t('settings.page.harness.context.recovery.retries.description')}>
        <AutoSaveInput className="w-28" type="number" disabled={!recovery.enabled}
          aria-label={t('settings.page.harness.context.recovery.retries')}
          value={String(recovery.maxRetries)} validate={validRetries}
          onCommit={(value) => setRecovery({ maxRetries: Number(value) })} />
      </SettingsFieldRow>
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.nextStep.title')} settingsItem="harness.next-step" contentClassName="space-y-3">
      <SettingsCheckboxRow checked={harness.nextStep.enabled && harness.models.nextStep?.enabled !== false}
        onChange={enabled => update({ nextStep: { enabled }, models: { nextStep: { enabled } } })}
        label={t('settings.page.harness.nextStep.enabled')} description={t('settings.page.harness.nextStep.description')} />
      <HarnessModelField harness={harness} update={update} slot="nextStep" enableControl={false} />
    </SettingsSection>
  </>;
}

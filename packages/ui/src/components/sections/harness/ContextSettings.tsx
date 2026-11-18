import React from 'react';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ContextRecoverySettings } from './ContextRecoverySettings';
import { MessageTimeSettings } from './MessageTimeSettings';
import { ContextBudgetSettings } from './ContextBudgetSettings';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { SettingsPageLink } from '@/components/sections/shared/SettingsPageLink';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@varin/application-client';
import { beginAgentProfilesHost, selectAgentProfile, setAgentProfilesQuery } from '../agents/agent-profiles-store';

export function ContextSettings({ harness, update, reserveRatio, onReserveRatioChange }: HarnessSettingsPageProps & {
  reserveRatio: number;
  onReserveRatioChange(ratio: number): void;
}) {
  const { t } = useI18n();
  return <>
    <SettingsSection title={t('settings.contextScale.title')} settingsItem="harness.context" divider={false}>
      <SettingsCheckboxRow checked={harness.context.backgroundPreparation}
        onChange={(backgroundPreparation) => update({ context: { backgroundPreparation } })}
        label={t('settings.page.harness.context.backgroundPreparation')} description={t('settings.page.harness.context.backgroundPreparation.description')} />
      <ContextBudgetSettings reserveRatio={reserveRatio} preparationWaterline={harness.context.preparationWaterline}
        backgroundPreparation={harness.context.backgroundPreparation} onReserveRatioChange={onReserveRatioChange}
        onPreparationWaterlineChange={preparationWaterline => update({ context: { preparationWaterline } })} />
    </SettingsSection>
    <SettingsSection settingsItem="harness.models.contextCompaction">
      <SettingsPageLink page="agents" description={t('settings.agents.context.configureDescription')} onNavigate={() => {
        beginAgentProfilesHost(JSON.stringify([getRuntimeKey(), getRuntimeEndpointGeneration()]));
        setAgentProfilesQuery(''); selectAgentProfile('varin:builtin:contextCompaction');
      }}>{t('settings.harness.role.contextCompaction')}</SettingsPageLink>
    </SettingsSection>
    <ContextRecoverySettings value={harness.context.compactionRecovery} />
    <SettingsDisclosure title={t('settings.experience.messageTime')}><MessageTimeSettings harness={harness} update={update} /></SettingsDisclosure>
  </>;
}

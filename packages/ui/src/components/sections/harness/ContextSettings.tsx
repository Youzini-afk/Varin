import React from 'react';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { ContextRecoverySettings } from './ContextRecoverySettings';
import { HarnessModelField } from './HarnessModelField';
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
    <SettingsSection settingsItem="harness.models.agentPlanning">
      <HarnessModelField harness={harness} update={update} slot="agentPlanning" />
    </SettingsSection>
    <ContextRecoverySettings value={harness.context.compactionRecovery} />
    <SettingsSection title={t('settings.page.harness.nextStep.title')} settingsItem="harness.next-step" contentClassName="space-y-3">
      <SettingsCheckboxRow checked={harness.nextStep.enabled && harness.models.nextStep?.enabled !== false}
        onChange={enabled => update({ nextStep: { enabled }, models: { nextStep: { enabled } } })}
        label={t('settings.page.harness.nextStep.enabled')} description={t('settings.page.harness.nextStep.description')} />
      <HarnessModelField harness={harness} update={update} slot="nextStep" enableControl={false} />
    </SettingsSection>
    <SettingsDisclosure title={t('settings.experience.messageTime')}><MessageTimeSettings harness={harness} update={update} /></SettingsDisclosure>
  </>;
}

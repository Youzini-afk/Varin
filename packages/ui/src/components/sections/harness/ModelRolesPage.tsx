import { HostSettingsScope } from '../shared/SettingsScope';
import React from 'react';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@varin/application-client';
import { parseHarnessWebSearchSettings } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { SettingsPageLink } from '../shared/SettingsPageLink';
import { Button } from '@/components/ui/button';
import { beginAgentProfilesHost, selectAgentProfile, setAgentProfilesQuery, selectDelegationModelSelection } from '../agents/agent-profiles-store';
import { DefaultsSettings } from '../varin/DefaultsSettings';
import { HarnessModelField } from './HarnessModelField';
import { useHarnessSettings } from './useHarnessSettings';
import { AssistanceModel } from './WebAssistanceSettings';
import { FastDecisionSettings, InferenceSettings } from './RetrievalSettings';
import { ImageToolsSettings } from './ImageToolsSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';

function WithHarness({ children }: {children(props: HarnessSettingsPageProps): React.ReactNode}) {
  const { t } = useI18n();
  const { harness, update, status, error, retry, targetKey } = useHarnessSettings();
  return <>
    {status === 'loading' && <p role="status" className="typography-meta">{t('common.loading')}</p>}
    {error && <p role="alert" className="typography-meta text-destructive">{error} <Button size="sm" variant="outline" onClick={() => void retry()}>{t('settings.harness.retry')}</Button></p>}
    {harness && <React.Fragment key={targetKey}>{children({harness, update})}</React.Fragment>}
  </>;
}

/** Loaded on the feature page only if its actual selected driver declares this role. */
export function PlanningModelSettings() {
  const { t } = useI18n();
  return <div className="mt-3 border-t border-border/60 pt-3"><p className="typography-micro text-muted-foreground">{t('settings.scope.hostGlobalHint')}</p>
    <WithHarness>{props => <HarnessModelField {...props} slot="agentPlanning" />}</WithHarness></div>;
}

/** Both entrances edit the existing Host fields. No mirrored registry of model choices. */
export function ModelRolesPage() {
  const { t } = useI18n();
  const state = (enabled: boolean) => t(enabled ? 'settings.roles.on' : 'settings.roles.off');
  return <SettingsPageLayout title={t('settings.roles.title')} description={t('settings.roles.description')} scope={<HostSettingsScope />} showSaveStatus>
    <DefaultsSettings modelsOnly />
    <WithHarness>{props => <>
      <SettingsDisclosure title={t('settings.harness.role.contextCompaction')}>
        <HarnessModelField {...props} slot="contextCompaction" enableControl={false} />
        <SettingsPageLink page="agents" onNavigate={() => {
          beginAgentProfilesHost(JSON.stringify([getRuntimeKey(), getRuntimeEndpointGeneration()]));
          setAgentProfilesQuery(''); selectAgentProfile('varin:builtin:contextCompaction');
        }}>{t('settings.agents.context.configureDescription')}</SettingsPageLink>
      </SettingsDisclosure>
      <SettingsDisclosure settingsItem="roles.web" title={t('settings.page.harness.page.web.title')}>
        <p className="typography-micro text-muted-foreground">{t('settings.page.harness.web.assistance.selectionEnabled')} · {state(parseHarnessWebSearchSettings(props.harness.web?.search)?.smartSelection === true)}</p>
        <AssistanceModel {...props} purpose="web-selection" slot="webSelection" />
        <p className="mt-4 typography-micro text-muted-foreground">{t('settings.page.harness.web.assistance.readingEnabled')} · {state(props.harness.web?.readingAssistance === true)}</p>
        <AssistanceModel {...props} purpose="web-reading" slot="reader" />
        <SettingsPageLink page="harness-web">{t('settings.page.harness.page.web.title')}</SettingsPageLink>
      </SettingsDisclosure>
      <SettingsDisclosure title={t('settings.harness.role.nextStep')} summary={state(props.harness.nextStep.enabled && props.harness.models.nextStep?.enabled !== false)}>
        <HarnessModelField {...props} slot="nextStep" enableControl={false} />
        <SettingsPageLink page="chat">{t('settings.page.chat.title')}</SettingsPageLink>
      </SettingsDisclosure>
      <SettingsDisclosure settingsItem="harness.delegationModelSelection" title={t('settings.delegationModelSelection.title')} summary={state(props.harness.delegationModelSelection.enabled)}>
        <p className="typography-ui-label">{props.harness.delegationModelSelection.model ? props.harness.delegationModelSelection.model.modelId + ' · ' + props.harness.delegationModelSelection.model.providerId : t('settings.harness.models.noModel')}</p>
        <SettingsPageLink page="agents" onNavigate={() => {
          beginAgentProfilesHost(JSON.stringify([getRuntimeKey(), getRuntimeEndpointGeneration()]));
          selectDelegationModelSelection();
        }}>{t('settings.delegationModelSelection.title')}</SettingsPageLink>
      </SettingsDisclosure>
      <SettingsDisclosure title={t('settings.page.harness.section.fastDecision')}><FastDecisionSettings {...props} embedded /></SettingsDisclosure>
      <SettingsDisclosure title={t('settings.page.harness.page.retrieval.title')}><HarnessModelField {...props} slot="explore" enableControl={false} /><InferenceSettings {...props} kind="rerank" /><SettingsPageLink page="harness-retrieval">{t('settings.page.harness.page.retrieval.title')}</SettingsPageLink></SettingsDisclosure>
      <SettingsDisclosure title={t('settings.page.harness.section.embedding')}><InferenceSettings {...props} kind="embedding" embedded /><SettingsPageLink page="harness-embeddings">{t('settings.page.harness.page.embeddings.title')}</SettingsPageLink></SettingsDisclosure>
      <SettingsDisclosure title={t('settings.page.images.title')}><ImageToolsSettings {...props} /></SettingsDisclosure>
      <SettingsDisclosure title={t('settings.varin.extensions.driver.title')}><HarnessModelField {...props} slot="agentPlanning" /><SettingsPageLink page="extensions">{t('settings.varin.extensions.driver.title')}</SettingsPageLink></SettingsDisclosure>
      <SettingsDisclosure settingsItem="harness.models.permissionJudge" title={t('settings.harness.role.permissionJudge')} summary={state(false)}><p className="typography-meta text-muted-foreground">{t('settings.harness.role.permissionJudge.description')}</p><SettingsPageLink page="harness-permissions">{t('settings.page.harness.page.permissions.title')}</SettingsPageLink></SettingsDisclosure>
    </>}</WithHarness>
  </SettingsPageLayout>;
}

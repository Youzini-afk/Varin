import React from 'react';
import { getRuntimeEndpointGeneration, getRuntimeKey } from '@varin/application-client';
import { parseHarnessWebSearchSettings, resolveHarnessModelSlot } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { SettingsScopeLabel } from '../shared/SettingsScope';
import { Btn, Disclosure, Dot, LinkRow, Loading, Note, Page, Section, useSettingsShell } from '../shared/kit';
import { Button } from '@/components/ui/button';
import { beginAgentProfilesHost, selectAgentProfile, setAgentProfilesQuery, selectDelegationModelSelection } from '../agents/agent-profiles-store';
import { DefaultsSettings } from '../varin/DefaultsSettings';
import { HarnessModelField } from './HarnessModelField';
import { useHarnessSettings } from './useHarnessSettings';
import { AssistanceModel } from './WebAssistanceSettings';
import { FastDecisionSettings, InferenceSettings } from './RetrievalSettings';
import { ImageToolsSettings } from './ImageToolsSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { DelegationModelSelectionSettings } from './DelegationModelSelectionSettings';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { useUIStore } from '@/stores/useUIStore';

function WithHarness({ children }: {children(props: HarnessSettingsPageProps): React.ReactNode}) {
  const { t } = useI18n();
  const { harness, update, status, error, retry, targetKey } = useHarnessSettings();
  return <>
    {status === 'loading' && <Loading />}
    {error && <Note kind="err" actions={<Button size="sm" variant="outline" onClick={() => void retry()}>{t('settings.harness.retry')}</Button>}>{error}</Note>}
    {harness && <React.Fragment key={targetKey}>{children({harness, update})}</React.Fragment>}
  </>;
}

/** Loaded on the feature page only if its actual selected driver declares this role. */
export function PlanningModelSettings() {
  const { t } = useI18n();
  return <div className="mt-3 border-t border-border/60 pt-3"><p className="typography-micro text-muted-foreground">{t('settings.scope.hostGlobalHint')}</p>
    <WithHarness>{props => <HarnessModelField {...props} slot="agentPlanning" />}</WithHarness></div>;
}

export function ModelRolesPage() {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const openAgent = (id: 'context' | 'delegation') => requestSettingsNavigation(() => {
    beginAgentProfilesHost(JSON.stringify([getRuntimeKey(), getRuntimeEndpointGeneration()]));
    setAgentProfilesQuery('');
    if (id === 'context') selectAgentProfile('varin:builtin:contextCompaction');
    else selectDelegationModelSelection();
    shell.setCatalogStage('detail');
    useUIStore.getState().setSettingsPage('agents');
  });
  const status = (enabled: boolean, label: string, open: () => void) => <span className="flex flex-wrap items-center gap-1.5">
    <Dot state={enabled ? 'ok' : 'off'} />{t(enabled ? 'settings.roles.on' : 'settings.roles.off')}
    <span aria-hidden="true">·</span><button type="button" className="sk-link" onClick={open}>{label}</button>
  </span>;
  return <Page title={t('settings.roles.title')} description={t('settings.roles.description')} scope={<SettingsScopeLabel kind="hostProject" />}
    actions={<Btn kind="ghost" icon="cloud" onClick={() => shell.openPage('model-connections')}>{t('settings.models.title')}</Btn>}>
    <DefaultsSettings modelsOnly />
    <WithHarness>{props => <>
      <Section title={t('settings.roles.decisions')}>
        <Disclosure label={t('settings.page.harness.section.fastDecision')} item="harness.fastDecision">
          <FastDecisionSettings {...props} embedded />
        </Disclosure>
        <HarnessModelField {...props} slot="explore" enableControl={false} />
        <AssistanceModel {...props} purpose="web-selection" slot="webSelection" item="harness.models.webSelection"
          status={status(parseHarnessWebSearchSettings(props.harness.web?.search)?.smartSelection === true, t('settings.page.harness.page.web.title'), () => shell.openPage('harness-web', { item: 'harness.web.assistance' }))} />
        <AssistanceModel {...props} purpose="web-reading" slot="reader" item="harness.models.reader"
          status={status(props.harness.web?.readingAssistance === true, t('settings.page.harness.page.web.title'), () => shell.openPage('harness-web', { item: 'harness.web.assistance' }))} />
        <DelegationModelSelectionSettings {...props} status={status(props.harness.delegationModelSelection.enabled, t('settings.page.agents.title'), () => openAgent('delegation'))} />
        <HarnessModelField {...props} slot="permissionJudge"
          status={status(props.harness.permissions?.mode === 'smart' && Boolean(resolveHarnessModelSlot('permissionJudge', props.harness.models, null)),
            t('settings.page.harness.page.permissions.title'), () => shell.openPage('harness-permissions', { item: 'harness.permissions.mode' }))} />
        <HarnessModelField {...props} slot="contextCompaction" enableControl={false} openModel={() => openAgent('context')} />
      </Section>
      <Section title={t('settings.roles.generation')}>
        <HarnessModelField {...props} slot="nextStep" enableControl={false}
          status={status(props.harness.nextStep.enabled && props.harness.models.nextStep?.enabled !== false, t('settings.page.chat.title'), () => shell.openPage('chat', { item: 'harness.next-step' }))} />
        <ImageToolsSettings {...props} embedded />
      </Section>
      <InferenceSettings {...props} kind="embedding">
        <LinkRow lead="database-2" label={t('settings.page.harness.embeddings.requests.title')} onClick={() => shell.openPage('agent-memory', { item: 'harness.embeddingRequests' })} />
      </InferenceSettings>
      <InferenceSettings {...props} kind="rerank" />
      <Section title={t('settings.page.extensions.title')}>
        <HarnessModelField {...props} slot="agentPlanning" enableControl={false}
          status={<button type="button" className="sk-link" onClick={() => shell.openPage('extensions', { item: 'extensions.routing' })}>{t('settings.varin.extensions.driver.title')}</button>} />
      </Section>
    </>}</WithHarness>
  </Page>;
}

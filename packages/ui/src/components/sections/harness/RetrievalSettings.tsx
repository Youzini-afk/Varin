import React from 'react';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfigurationModels } from './ConfigurationModels';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';
import { InferenceModelField } from './InferenceModelField';
import type { HarnessSettingsPageProps } from './harness-settings-state';

export function InferenceSettings({ harness, update, kind }: HarnessSettingsPageProps & { kind: 'embedding' | 'rerank' }) {
  const { t } = useI18n();
  const { providers, modelsFor } = useConfigurationModels();
  const binding = harness[kind];
  const [local, setLocal] = React.useState(kind === 'embedding' && binding?.protocol === 'local');
  const [remote, setRemote] = React.useState(Boolean(binding && binding.protocol !== 'local'));
  const remoteRef = React.useRef(remote);
  const [fields, setFields] = React.useState({ providerId: binding?.protocol === 'local' ? '' : binding?.providerId ?? '', modelId: binding?.protocol === 'local' ? '' : binding?.modelId ?? '', endpoint: kind === 'rerank' ? harness.rerank?.endpoint ?? '' : '' });
  const current = React.useRef(fields);
  const commit = (patch: Partial<typeof fields>) => {
    if (!remoteRef.current) return;
    const next = { ...current.current, ...patch };
    current.current = next;
    setFields(next);
    if (!next.providerId.trim() || !next.modelId.trim()) return;
    update({ [kind]: {
      ...binding,
      protocol: kind === 'embedding' ? 'openai-compatible' : 'http-rerank',
      providerId: next.providerId.trim(), modelId: next.modelId.trim(),
      ...(kind === 'rerank' ? { endpoint: next.endpoint.trim() || undefined } : {}),
    } });
  };
  const defaultLabel = t(kind === 'embedding' ? 'settings.page.harness.embeddings.off' : 'settings.harness.retrieval.off');
  return <SettingsSection title={t(`settings.page.harness.section.${kind}`)} settingsItem={`harness.${kind}`} contentClassName="space-y-5">
    <SettingsFieldRow label={t('settings.harness.retrieval.source')} description={kind === 'embedding' ? t('settings.page.harness.section.embedding.description') : undefined}>
      <Select value={local ? 'local' : remote ? 'remote' : 'default'} onValueChange={(value) => {
        setLocal(value === 'local'); remoteRef.current = value === 'remote'; setRemote(value === 'remote');
        if (value === 'local') update({ embedding: { protocol: 'local', providerId: 'local', modelId: 'installed', dimensions: undefined, maxTokens: undefined } });
        else if (value === 'default') update({ [kind]: undefined });
        else { update({ [kind]: undefined }); commit({}); }
      }}>
        <SelectTrigger size="settings" className="w-64" aria-label={t('settings.harness.retrieval.source')}><SelectValue>{local ? t('settings.page.harness.localSemantic.source') : remote ? t('settings.harness.retrieval.remote') : defaultLabel}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="default">{defaultLabel}</SelectItem>{kind === 'embedding' ? <SelectItem value="local">{t('settings.page.harness.localSemantic.source')}</SelectItem> : null}<SelectItem value="remote">{t('settings.harness.retrieval.remote')}</SelectItem></SelectContent>
      </Select>
    </SettingsFieldRow>
    {remote ? <>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.provider`)}>
        <Select value={fields.providerId || '__none'} onValueChange={(providerId) => {
          if (providerId === '__none') return;
          const next = { ...current.current, providerId, modelId: '' };
          current.current = next; setFields(next);
        }}>
          <SelectTrigger size="settings" className="w-64" aria-label={t(`settings.page.harness.${kind}.provider`)}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{providers.filter(provider => modelsFor(provider.id, kind).length).map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name || provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.model`)} controlClassName="@xl:flex-1 @xl:max-w-80">
        <InferenceModelField key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
          models={modelsFor(fields.providerId, kind)}
          label={t(`settings.page.harness.${kind}.model`)} placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'rerank-v3.5'} />
      </SettingsFieldRow>
      {kind === 'rerank' ? <SettingsFieldRow label={t('settings.page.harness.rerank.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder="/rerank" aria-label={t('settings.page.harness.rerank.endpoint')}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.rerank.endpoint.description')} />
      </SettingsFieldRow> : null}
      <p className="typography-meta text-muted-foreground">{t(!fields.providerId || !fields.modelId ? 'settings.harness.completeFields' : `settings.page.harness.${kind}.provider.description`)}</p>
    </> : null}
  </SettingsSection>;
}

function FastDecisionSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const { providers, modelsFor } = useConfigurationModels();
  const settings = harness.fastDecision;
  const binding = settings?.default;
  const purposes = settings?.purposes;
  const [remote, setRemote] = React.useState(Boolean(binding || (purposes && Object.values(purposes).some((value) => value !== 'off'))));
  const remoteRef = React.useRef(remote);
  const [fields, setFields] = React.useState({
    providerId: binding?.providerId ?? '',
    modelId: binding?.modelId ?? '',
    endpoint: binding?.endpoint ?? '',
  });
  const current = React.useRef(fields);
  const commit = (patch: Partial<typeof fields>) => {
    if (!remoteRef.current) return;
    const next = { ...current.current, ...patch };
    current.current = next;
    setFields(next);
    if (!next.providerId.trim() || !next.modelId.trim()) return;
    update({ fastDecision: { default: {
      protocol: 'typed-classifier',
      providerId: next.providerId.trim(),
      modelId: next.modelId.trim(),
      ...(next.endpoint.trim() ? { endpoint: next.endpoint.trim() } : {}),
    } } });
  };
  const purposeOverrideValue = (purpose: 'explore' | 'web' | 'scholarly' | 'memory-organization' | 'memory-recall') => {
    const override = purposes?.[purpose];
    return override === 'off' ? 'off' : override === undefined ? 'default' : 'custom';
  };
  return <SettingsSection title={t('settings.page.harness.section.fastDecision')} settingsItem="harness.fastDecision" contentClassName="space-y-5">
    <SettingsFieldRow label={t('settings.harness.retrieval.source')}>
      <Select value={remote ? 'remote' : 'default'} onValueChange={(value) => {
        remoteRef.current = value === 'remote';
        setRemote(value === 'remote');
        if (value === 'default') update({ fastDecision: { default: undefined } });
        else commit({});
      }}>
        <SelectTrigger size="settings" className="w-64" aria-label={t('settings.harness.retrieval.source')}>
          <SelectValue>{remote ? t('settings.harness.retrieval.remote') : t('settings.harness.retrieval.off')}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{t('settings.harness.retrieval.off')}</SelectItem>
          <SelectItem value="remote">{t('settings.harness.retrieval.remote')}</SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
    {remote ? <>
      <SettingsFieldRow label={t('settings.page.harness.fastDecision.provider')}>
        <Select value={fields.providerId || '__none'} onValueChange={(providerId) => {
          if (providerId === '__none') return;
          const next = { ...current.current, providerId, modelId: '' };
          current.current = next; setFields(next);
        }}>
          <SelectTrigger size="settings" className="w-64" aria-label={t('settings.page.harness.fastDecision.provider')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{providers.filter(provider => modelsFor(provider.id, 'decision').length).map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name || provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.fastDecision.model')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <InferenceModelField key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
          models={modelsFor(fields.providerId, 'decision')}
          label={t('settings.page.harness.fastDecision.model')} placeholder="jev-1.13" />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.fastDecision.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder={t('settings.page.harness.fastDecision.endpoint.description')} aria-label={t('settings.page.harness.fastDecision.endpoint')}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.fastDecision.endpoint.description')} />
      </SettingsFieldRow>
      {(['web', 'scholarly', 'memory-organization', 'memory-recall'] as const).map((purpose) => {
        const overrideValue = purposeOverrideValue(purpose);
        return <SettingsFieldRow key={purpose} label={t(`settings.page.harness.fastDecision.${purpose}`)} description={t(`settings.page.harness.fastDecision.${purpose}.description`)}>
          <Select value={overrideValue} onValueChange={(value) => {
            if (value === 'custom') return;
            update({ fastDecision: { purposes: { [purpose]: value === 'off' ? 'off' : undefined } } });
          }}>
            <SelectTrigger size="settings" className="w-64" aria-label={t(`settings.page.harness.fastDecision.${purpose}`)}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('settings.page.harness.fastDecision.purpose.default')}</SelectItem>
              <SelectItem value="off">{t('settings.harness.retrieval.off')}</SelectItem>
              {overrideValue === 'custom' ? <SelectItem value="custom" disabled>{t('settings.page.harness.fastDecision.purpose.custom')}</SelectItem> : null}
            </SelectContent>
          </Select>
        </SettingsFieldRow>;
      })}
      <p className="typography-meta text-muted-foreground">{t(!fields.providerId || !fields.modelId ? 'settings.harness.completeFields' : 'settings.page.harness.fastDecision.provider.description')}</p>
    </> : null}
  </SettingsSection>;
}

export function RetrievalSettings(props: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const { error } = useConfigurationModels();
  return <>
    {error ? <p role="alert" className="typography-meta text-destructive">{String(error)}</p> : null}
    <SettingsSection title={t('settings.page.harness.codeRetrieval.title')}
      description={t('settings.page.harness.codeRetrieval.description')} settingsItem="harness.codeRetrieval">
      <HarnessModelField {...props} slot="explore" />
    </SettingsSection>
    <InferenceSettings {...props} kind="rerank" />
    <FastDecisionSettings {...props} />
  </>;
}

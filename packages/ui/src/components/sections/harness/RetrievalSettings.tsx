import React from 'react';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { Note, Row, Section, Seg } from '../shared/kit';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfigurationModels } from './ConfigurationModels';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';
import { InferenceModelField } from './InferenceModelField';
import { LocalSemanticSettings } from './LocalSemanticSettings';
import type { HarnessSettingsPageProps } from './harness-settings-state';

type InferenceSource = 'local' | 'remote' | 'off';

export function InferenceSettings({ harness, update, kind, embedded = false, children }: React.PropsWithChildren<HarnessSettingsPageProps & {
  kind: 'embedding' | 'rerank';
  embedded?: boolean;
}>) {
  const { t } = useI18n();
  const { providers, modelsFor } = useConfigurationModels();
  const binding = harness[kind];
  const [source, setSource] = React.useState<InferenceSource>(binding?.protocol === 'local' ? 'local' : binding ? 'remote' : 'off');
  const sourceRef = React.useRef(source);
  const [fields, setFields] = React.useState({ providerId: binding?.protocol === 'local' ? '' : binding?.providerId ?? '', modelId: binding?.protocol === 'local' ? '' : binding?.modelId ?? '', endpoint: kind === 'rerank' ? harness.rerank?.endpoint ?? '' : '' });
  const current = React.useRef(fields);
  const commit = (patch: Partial<typeof fields>) => {
    if (sourceRef.current !== 'remote') return;
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
  const selectSource = (value: InferenceSource) => {
    sourceRef.current = value;
    setSource(value);
    if (value === 'local') update({ embedding: { protocol: 'local', providerId: 'local', modelId: 'installed', dimensions: undefined, maxTokens: undefined } });
    else if (value === 'off') update({ [kind]: undefined });
    else commit({});
  };
  const title = t(`settings.page.harness.section.${kind}`);
  const description = t(`settings.page.harness.section.${kind}.description`);
  const sourceLabel = t('settings.roles.inferenceSource');
  const sources: { value: InferenceSource; label: string }[] = kind === 'embedding'
    ? [{ value: 'local', label: t('settings.page.harness.localSemantic.source') }] : [];
  sources.push({ value: 'remote', label: t('settings.harness.retrieval.remote') }, { value: 'off', label: t('settings.roles.off') });
  const providerLabel = t(`settings.page.harness.${kind}.provider`);
  const modelLabel = t(`settings.page.harness.${kind}.model`);
  const endpointLabel = t('settings.page.harness.rerank.endpoint');
  const rows = <>
    <Row item={embedded ? `harness.${kind}` : undefined} label={sourceLabel} description={embedded ? description : undefined}>
      <Seg label={title} value={source} options={sources} onChange={selectSource} />
    </Row>
    {source === 'local' ? <LocalSemanticSettings /> : null}
    {source === 'remote' ? <>
      <Row label={providerLabel}>
        <Select value={fields.providerId || '__none'} onValueChange={(providerId) => {
          if (providerId === '__none') return;
          const next = { ...current.current, providerId, modelId: '' };
          current.current = next; setFields(next);
        }}>
          <SelectTrigger size="settings" className="w-64 max-w-full" aria-label={providerLabel}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{providers.filter(provider => modelsFor(provider.id, kind).length).map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name || provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </Row>
      <Row label={modelLabel}>
        <div className="w-64 max-w-full">
          <InferenceModelField key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
            models={modelsFor(fields.providerId, kind)} label={modelLabel}
            placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'rerank-v3.5'} />
        </div>
      </Row>
      {kind === 'rerank' ? <Row label={endpointLabel}>
        <div className="w-64 max-w-full"><AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder="/rerank" aria-label={endpointLabel}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.rerank.endpoint.description')} />
        </div>
      </Row> : null}
      {!fields.providerId || !fields.modelId ? <Note inPanel>{t('settings.harness.completeFields')}</Note> : null}
    </> : null}
    {children}
  </>;
  return embedded ? rows : <Section title={title} description={description} item={`harness.${kind}`}>{rows}</Section>;
}

export function FastDecisionSettings({ harness, update, embedded = false }: HarnessSettingsPageProps & { embedded?: boolean }) {
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
  return <SettingsSection title={embedded ? undefined : t('settings.page.harness.section.fastDecision')} divider={!embedded} settingsItem="harness.fastDecision" contentClassName="space-y-5">
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
    <SettingsDisclosure title={t('settings.page.harness.section.rerank')}><InferenceSettings {...props} kind="rerank" embedded /></SettingsDisclosure>
    <SettingsDisclosure title={t('settings.page.harness.section.fastDecision')}><FastDecisionSettings {...props} embedded /></SettingsDisclosure>
  </>;
}

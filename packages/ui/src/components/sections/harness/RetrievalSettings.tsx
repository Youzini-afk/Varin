import React from 'react';
import type { HarnessExploreDecisionMode, LocalSemanticStatus } from '@varin/protocol';
import { Button } from '@/components/ui/button';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { HarnessModelField } from './HarnessModelField';
import { InferenceModelField } from './InferenceModelField';
import { cancelLocalSemantic, importLocalSemantic, installLocalSemantic } from './local-semantic';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import type { LocalSemanticState } from './useLocalSemantic';

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || value === undefined || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value;
  let unit: typeof units[number] = units[0];
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024 || next === units[units.length - 1]) break;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

export function LocalSemanticSettings({ state }: { state: LocalSemanticState }) {
  const { t } = useI18n();
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const status = state.status;
  const installing = status?.status === 'installing';
  const canInstall = status?.status === 'not-installed' || status?.status === 'failed' || (status?.status === 'ready' && Boolean(status.error));
  const statusLabel = status === null
    ? (state.error ? t('settings.page.harness.localSemantic.status.unknown') : t('common.loading'))
    : status.status === 'ready'
    ? t('settings.page.harness.localSemantic.status.ready')
    : status.status === 'installing'
      ? t('settings.page.harness.localSemantic.status.installing')
      : status.status === 'failed'
        ? t('settings.page.harness.localSemantic.status.failed')
        : t('settings.page.harness.localSemantic.status.notInstalled');
  const progress = installing && status.downloadedBytes !== undefined
    ? t('settings.page.harness.localSemantic.progress', {
      downloaded: formatBytes(status.downloadedBytes), total: formatBytes(status.totalBytes),
    })
    : null;
  const stage = installing && status.stage === 'downloading'
    ? t('settings.page.harness.localSemantic.stage.downloading')
    : installing && status.stage === 'extracting'
      ? t('settings.page.harness.localSemantic.stage.extracting')
      : installing && status.stage === 'verifying'
        ? t('settings.page.harness.localSemantic.stage.verifying')
        : null;

  return <SettingsSection title={t('settings.page.harness.localSemantic.title')}
    description={t('settings.page.harness.localSemantic.description')} settingsItem="harness.localSemantic">
    <SettingsFieldRow label={t('settings.page.harness.localSemantic.status.label')}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="status" className="typography-meta text-muted-foreground">
          {statusLabel}{status?.version ? ` · ${status.version}` : ''}
        </span>
        {stage ? <span className="typography-meta text-muted-foreground">{stage}</span> : null}
        {progress ? <span className="typography-meta tabular-nums text-muted-foreground">{progress}</span> : null}
      </div>
    </SettingsFieldRow>
    {status?.error ? <p role="alert" className="typography-meta text-destructive">{status.error}</p> : null}
    {state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 typography-meta text-destructive">
      <span>{state.error}</span><Button size="sm" variant="ghost" disabled={state.busy} onClick={state.refresh}>{t('settings.page.harness.localSemantic.retry')}</Button>
    </div> : null}
    <div className="flex flex-wrap items-center gap-2">
      {canInstall ? <Button size="sm" variant="outline" disabled={state.busy} onClick={() => state.run(installLocalSemantic, true)}>
        {status?.error ? t('settings.page.harness.localSemantic.retry') : t('settings.page.harness.localSemantic.install')}
      </Button> : null}
      <Button size="sm" variant="outline" disabled={state.busy || installing} onClick={() => fileInput.current?.click()}>
        {t('settings.page.harness.localSemantic.import')}
      </Button>
      {installing ? <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => state.run(cancelLocalSemantic)}>
        {t('settings.page.harness.localSemantic.cancel')}
      </Button> : null}
      <input ref={fileInput} type="file" className="sr-only" accept=".tar.gz,.tgz,application/gzip,application/x-gzip" disabled={state.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) state.run(() => importLocalSemantic(file), true);
        }} />
    </div>
  </SettingsSection>;
}

export function InferenceSettings({ harness, update, kind, localSemanticStatus }: HarnessSettingsPageProps & { kind: 'embedding' | 'rerank'; localSemanticStatus: LocalSemanticStatus | null }) {
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
  const binding = harness[kind];
  const [remote, setRemote] = React.useState(Boolean(binding));
  const remoteRef = React.useRef(remote);
  const [fields, setFields] = React.useState({ providerId: binding?.providerId ?? '', modelId: binding?.modelId ?? '', endpoint: kind === 'rerank' ? harness.rerank?.endpoint ?? '' : '' });
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
  const defaultLabel = kind === 'embedding'
    ? t(localSemanticStatus?.installedBytes !== undefined ? 'settings.harness.retrieval.local' : 'settings.harness.retrieval.localUnavailable')
    : t('settings.harness.retrieval.off');
  return <SettingsSection title={t(`settings.page.harness.section.${kind}`)} settingsItem={`harness.${kind}`} contentClassName="space-y-5">
    <SettingsFieldRow label={t('settings.harness.retrieval.source')} description={t(`settings.page.harness.section.${kind}.description`)}>
      <Select value={remote ? 'remote' : 'default'} onValueChange={(value) => { remoteRef.current = value === 'remote'; setRemote(value === 'remote'); if (value === 'default') update({ [kind]: undefined }); else commit({}); }}>
        <SelectTrigger size="settings" className="w-64" aria-label={t('settings.harness.retrieval.source')}><SelectValue>{remote ? t('settings.harness.retrieval.remote') : defaultLabel}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="default">{defaultLabel}</SelectItem><SelectItem value="remote">{t('settings.harness.retrieval.remote')}</SelectItem></SelectContent>
      </Select>
    </SettingsFieldRow>
    {remote ? <>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.provider`)}>
        <Select value={fields.providerId || '__none'} onValueChange={(providerId) => {
          if (providerId === '__none') return;
          const next = { ...current.current, providerId, modelId: '' };
          current.current = next; setFields(next);
        }}>
          <SelectTrigger size="settings" className="w-64" aria-label={t(`settings.page.harness.${kind}.provider`)}><SelectValue>{fields.providerId || t('settings.page.harness.models.notConfigured')}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{[...providers].sort((a, b) => Number(Boolean(b.details?.capabilities?.[kind])) - Number(Boolean(a.details?.capabilities?.[kind]))).map((provider) => <SelectItem key={provider.id} value={provider.id} disabled={provider.details?.capabilities?.[kind]?.enabled === false}>{provider.name || provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.model`)} controlClassName="@xl:flex-1 @xl:max-w-80">
        <InferenceModelField key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
          models={providers.find(provider => provider.id === fields.providerId)?.details?.capabilities?.[kind]?.models ?? []}
          label={t(`settings.page.harness.${kind}.model`)} placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'rerank-v3.5'} />
      </SettingsFieldRow>
      {kind === 'rerank' ? <SettingsFieldRow label={t('settings.page.harness.rerank.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder={providers.find(provider => provider.id === fields.providerId)?.details?.capabilities?.rerank?.endpoint ?? '/rerank'} aria-label={t('settings.page.harness.rerank.endpoint')}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.rerank.endpoint.description')} />
      </SettingsFieldRow> : null}
      <p className="typography-meta text-muted-foreground">{t(!fields.providerId || !fields.modelId ? 'settings.harness.completeFields' : `settings.page.harness.${kind}.provider.description`)}</p>
    </> : null}
  </SettingsSection>;
}

function FastDecisionSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
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
      protocol: 'pi-classifier',
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
    <SettingsFieldRow label={t('settings.harness.retrieval.source')} description={t('settings.page.harness.section.fastDecision.description')}>
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
          <SelectTrigger size="settings" className="w-64" aria-label={t('settings.page.harness.fastDecision.provider')}><SelectValue>{fields.providerId || t('settings.page.harness.models.notConfigured')}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{[...providers].sort((a, b) => Number(Boolean(b.details?.capabilities?.decision)) - Number(Boolean(a.details?.capabilities?.decision))).map((provider) => <SelectItem key={provider.id} value={provider.id} disabled={provider.details?.capabilities?.decision?.enabled === false}>{provider.name || provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.fastDecision.model')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <InferenceModelField key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
          models={providers.find(provider => provider.id === fields.providerId)?.details?.capabilities?.decision?.models ?? []}
          label={t('settings.page.harness.fastDecision.model')} placeholder="jev-1.13" />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.fastDecision.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder={providers.find(provider => provider.id === fields.providerId)?.details?.capabilities?.decision?.endpoint ?? t('settings.page.harness.fastDecision.endpoint.description')} aria-label={t('settings.page.harness.fastDecision.endpoint')}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.fastDecision.endpoint.description')} />
      </SettingsFieldRow>
      {(['explore', 'web', 'scholarly', 'memory-organization', 'memory-recall'] as const).map((purpose) => {
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
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const load = usePiProviderStore((state) => state.load);
  const error = usePiProviderStore((state) => state.error);
  React.useEffect(() => { void load(cwd).catch(() => undefined); }, [cwd, load]);
  return <>
    {error ? <p role="alert" className="typography-meta text-destructive">{String(error)}</p> : null}
    <SettingsSection title={t('settings.page.harness.codeRetrieval.title')}
      description={t('settings.page.harness.codeRetrieval.description')} settingsItem="harness.codeRetrieval">
      <SettingsFieldRow label={t('settings.page.harness.codeRetrieval.decision')}>
        <Select value={props.harness.codeRetrieval.decision}
          onValueChange={(decision) => props.update({ codeRetrieval: { decision: decision as HarnessExploreDecisionMode } })}>
          <SelectTrigger size="settings" className="w-64" aria-label={t('settings.page.harness.codeRetrieval.decision')}><SelectValue /></SelectTrigger>
          <SelectContent>{(['auto', 'llm', 'fast-decision', 'rerank', 'source'] as const).map((decision) =>
            <SelectItem key={decision} value={decision}>{t(`settings.page.harness.codeRetrieval.mode.${decision}`)}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <p className="typography-meta text-muted-foreground">{t(`settings.page.harness.codeRetrieval.mode.${props.harness.codeRetrieval.decision}.description`)}</p>
      <HarnessModelField {...props} slot="explore" />
    </SettingsSection>
    <InferenceSettings {...props} kind="rerank" localSemanticStatus={null} />
    <FastDecisionSettings {...props} />
  </>;
}

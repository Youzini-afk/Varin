import React from 'react';
import { createEmbeddingRequestsHttpAPI, type EmbeddingRequestSettings } from '@varin/application-client';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { Btn, Disclosure, Loading, Note, Row, Section, Select } from '../shared/kit';
import { LocalSemanticSettings } from './LocalSemanticSettings';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { InferenceSettings } from './RetrievalSettings';

export function EmbeddingRequests({ model, localModel }: { model?: React.ReactNode; localModel?: React.ReactNode } = {}) {
  const { t } = useI18n();
  const api = React.useMemo(() => createEmbeddingRequestsHttpAPI(), []);
  const [saved, setSaved] = React.useState<EmbeddingRequestSettings | null>(null);
  const [draft, setDraft] = React.useState({ concurrentRequests: '', requestIntervalMs: '', localCpuMode: 'auto', localCpuThreads: '' });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const alive = React.useRef(false);
  const restore = (value: EmbeddingRequestSettings) => {
    setSaved(value);
    setDraft({ concurrentRequests: String(value.config.concurrentRequests), requestIntervalMs: String(value.config.requestIntervalMs), localCpuMode: value.config.localCpuMode ?? 'auto', localCpuThreads: value.config.localCpuThreads == null ? '' : String(value.config.localCpuThreads) });
    setError(value.error ?? null);
  };
  const load = React.useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try { const value = await api.read(signal); if (alive.current && !signal?.aborted) restore(value); }
    catch (failure) { if (alive.current && !signal?.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current && !signal?.aborted) setBusy(false); }
  }, [api]);
  React.useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { alive.current = false; controller.abort(); };
  }, [load]);
  const concurrentRequests = Number(draft.concurrentRequests), requestIntervalMs = Number(draft.requestIntervalMs);
  const threads = draft.localCpuThreads.trim() ? Number(draft.localCpuThreads) : null;
  const valid = (threads === null || Number.isSafeInteger(threads) && threads > 0) && draft.concurrentRequests.trim() !== '' && Number.isSafeInteger(concurrentRequests) && concurrentRequests > 0
    && draft.requestIntervalMs.trim() !== '' && Number.isSafeInteger(requestIntervalMs) && requestIntervalMs >= 0 && requestIntervalMs <= 2_147_483_647;
  const dirty = Boolean(saved && (String(saved.config.concurrentRequests) !== draft.concurrentRequests || String(saved.config.requestIntervalMs) !== draft.requestIntervalMs || draft.localCpuMode !== (saved.config.localCpuMode ?? 'auto') || draft.localCpuThreads !== (saved.config.localCpuThreads == null ? '' : String(saved.config.localCpuThreads))));
  const save = async () => {
    if (!saved || !valid || busy) return false;
    setBusy(true); setError(null);
    try {
      const value = await api.save({ concurrentRequests, requestIntervalMs, localCpuMode: draft.localCpuMode as 'auto' | 'efficient' | 'performance', localCpuThreads: threads }, saved.revision);
      if (!alive.current) return false;
      restore(value);
      return true;
    }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { if (alive.current) setBusy(false); }
  };
  const concurrency = t('settings.memoryx.concurrency');
  const interval = t('settings.memoryx.interval');
  const cpuLabel = t('settings.page.harness.embeddings.cpu.mode');
  const threadsLabel = t('settings.page.harness.embeddings.cpu.threads');
  return <Section item="harness.embeddingRequests" title={t(model ? 'settings.roles.retrieval' : 'settings.page.harness.embeddings.requests.title')}
    description={t('settings.memoryx.sharedRetrieval')}
    after={saved ? <Note icon="restart">{t(saved.restartRequired
      ? 'settings.page.harness.embeddings.requests.restartRequired' : 'settings.memoryx.restart')}</Note> : null}>
      {model}
      {localModel ? <Disclosure label={t('settings.page.harness.localSemantic.title')} defaultOpen>{localModel}</Disclosure> : null}
      {!saved && busy ? <Loading /> : null}
      {saved && <>
        <Row label={concurrency}>
          <Input type="number" min={1} step={1} className="w-[90px] text-right tabular-nums" disabled={busy} value={draft.concurrentRequests} aria-label={concurrency}
            onChange={event => setDraft(value => ({ ...value, concurrentRequests: event.target.value }))} />
        </Row>
        <Row label={interval} description={t('settings.memoryx.intervalHint')}>
          <Input type="number" min={0} step={1} className="w-[90px] text-right tabular-nums" disabled={busy} value={draft.requestIntervalMs} aria-label={interval}
            onChange={event => setDraft(value => ({ ...value, requestIntervalMs: event.target.value }))} />
          <span className="sk-small sk-muted">{t('settings.voice.page.field.millisecondsUnit')}</span>
        </Row>
      </>}
      {saved ? <Disclosure label={t('settings.memoryx.localCompute')}>
        <Row label={cpuLabel} sub>
          <Select label={cpuLabel} width="ws" value={draft.localCpuMode} disabled={busy}
            options={(['auto', 'efficient', 'performance'] as const).map(value => ({ value, label: t(`settings.page.harness.embeddings.cpu.${value}`) }))}
            onChange={localCpuMode => setDraft(current => ({ ...current, localCpuMode }))} />
        </Row>
        <Row label={threadsLabel} sub>
          <Input type="number" min={1} step={1} className="w-[90px] text-right tabular-nums" disabled={busy} value={draft.localCpuThreads}
            aria-label={threadsLabel} placeholder={t('settings.page.harness.embeddings.cpu.auto')}
            onChange={event => setDraft(value => ({ ...value, localCpuThreads: event.target.value }))} />
        </Row>
      </Disclosure> : null}
      {dirty && !valid ? <Note kind="err" inPanel>{t('settings.page.harness.embeddings.requests.invalid')}</Note> : null}
      {error && !dirty ? <Note kind="err" inPanel actions={<Btn kind="ghost" sm disabled={busy} onClick={() => void load()}>
        {t('settings.page.harness.embeddings.requests.reload')}
      </Btn>}>{error}</Note> : null}
      {dirty ? <SettingsActionBar placement="inline" dirty={dirty} saving={busy} saveDisabled={!valid} onSave={save}
        onCancel={() => { if (saved) restore(saved); }} error={error}>
        {error ? <Btn kind="ghost" sm disabled={busy} onClick={() => requestSettingsNavigation(() => void load())}>
          {t('settings.page.harness.embeddings.requests.reload')}
        </Btn> : null}
      </SettingsActionBar> : null}
  </Section>;
}

export function EmbeddingSettings(props: HarnessSettingsPageProps) {
  return <>
    <InferenceSettings {...props} kind="embedding" />
    {props.harness.embedding?.protocol === 'local' ? <LocalSemanticSettings /> : null}
    <EmbeddingRequests />
  </>;
}

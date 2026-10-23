import React from 'react';
import { createEmbeddingRequestsHttpAPI, type EmbeddingRequestSettings } from '@varin/application-client';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LocalSemanticSettings } from './LocalSemanticSettings';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { InferenceSettings } from './RetrievalSettings';

function EmbeddingRequests() {
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
    if (!saved || !valid || busy) return;
    setBusy(true); setError(null);
    try { const value = await api.save({ concurrentRequests, requestIntervalMs, localCpuMode: draft.localCpuMode as 'auto' | 'efficient' | 'performance', localCpuThreads: threads }, saved.revision); if (alive.current) restore(value); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <>
    <SettingsSection title={t('settings.page.harness.embeddings.requests.title')} description={t('settings.page.harness.embeddings.requests.description')} settingsItem="harness.embeddingRequests" contentClassName="space-y-5">
      {!saved && busy ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
      {saved ? <>
        <SettingsFieldRow label={t('settings.page.harness.embeddings.requests.concurrency')}>
          <Input type="number" min={1} step={1} className="w-40" disabled={busy} value={draft.concurrentRequests} aria-label={t('settings.page.harness.embeddings.requests.concurrency')}
            onChange={event => setDraft(value => ({ ...value, concurrentRequests: event.target.value }))} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.page.harness.embeddings.requests.interval')}>
          <Input type="number" min={0} step={1} className="w-40" disabled={busy} value={draft.requestIntervalMs} aria-label={t('settings.page.harness.embeddings.requests.interval')}
            onChange={event => setDraft(value => ({ ...value, requestIntervalMs: event.target.value }))} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.page.harness.embeddings.cpu.mode')}>
          <Select value={draft.localCpuMode} onValueChange={value => setDraft(current => ({ ...current, localCpuMode: value ?? 'auto' }))} disabled={busy}>
            <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>{(['auto', 'efficient', 'performance'] as const).map(mode => <SelectItem key={mode} value={mode}>{t(`settings.page.harness.embeddings.cpu.${mode}`)}</SelectItem>)}</SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.page.harness.embeddings.cpu.threads')} description={t('settings.page.harness.embeddings.cpu.threadsDescription')}>
          <Input type="number" min={1} step={1} className="w-40" disabled={busy} value={draft.localCpuThreads} placeholder={t('settings.page.harness.embeddings.cpu.auto')}
            onChange={event => setDraft(value => ({ ...value, localCpuThreads: event.target.value }))} />
        </SettingsFieldRow>
        {dirty && !valid ? <p role="alert" className="typography-meta text-destructive">{t('settings.page.harness.embeddings.requests.invalid')}</p> : null}
        {saved.restartRequired ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.page.harness.embeddings.requests.restartRequired')}</p> : null}
      </> : null}
      {error ? <div role="alert" className="space-y-2">
        <p className="typography-meta text-destructive">{error}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>{t('settings.page.harness.embeddings.requests.reload')}</Button>
      </div> : null}
    </SettingsSection>
    {dirty ? <SettingsActionBar dirty={dirty} saving={busy} saveDisabled={!valid} onSave={save} onCancel={() => { if (saved) restore(saved); }} error={error} /> : null}
  </>;
}

export function EmbeddingSettings(props: HarnessSettingsPageProps) {
  return <>
    <InferenceSettings {...props} kind="embedding" />
    {props.harness.embedding?.protocol === 'local' ? <LocalSemanticSettings /> : null}
    <EmbeddingRequests />
  </>;
}

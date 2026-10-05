import React from 'react';
import { IndexDirectories } from './IndexDirectories';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { InferenceSettings, LocalSemanticSettings } from './RetrievalSettings';
import { useLocalSemantic } from './useLocalSemantic';
import { readSemanticIndexStatus, removeRetainedSemanticIndex, saveSemanticIndexConfig, type SemanticIndexConfig, type SemanticIndexStatus } from './semantic-index-api';

const bytesLabel = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export function IndexSettings(props: Partial<HarnessSettingsPageProps>) {
  const { t } = useI18n();
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const loadProviders = usePiProviderStore((state) => state.load);
  const localSemantic = useLocalSemantic();
  const [status, setStatus] = React.useState<SemanticIndexStatus | null>(null);
  const [draft, setDraft] = React.useState<SemanticIndexConfig | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = React.useState<'storage' | null>(null);
  const mounted = React.useRef(false);
  const statusRequest = React.useRef<AbortController | null>(null);

  React.useEffect(() => { void loadProviders(cwd).catch(() => undefined); }, [cwd, loadProviders]);
  const refresh = React.useCallback(async () => {
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    try {
      const next = await readSemanticIndexStatus(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(next);
      setError(null);
      if (!dirty) setDraft(next.config);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (statusRequest.current === controller) statusRequest.current = null; }
  }, [dirty]);
  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; statusRequest.current?.abort(); };
  }, [refresh]);
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const edit = (patch: Partial<SemanticIndexConfig>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
  };
  const save = async () => {
    if (!draft || !status) return;
    setBusy(true);
    setError(null);
    try {
      await saveSemanticIndexConfig(draft, status.revision);
      setDirty(false);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const chooseFolder = async (_target: 'storage') => {
    if (canRequestNativeDirectoryAccess()) {
      const result = await requestDirectoryAccess(draft?.storageDirectory ?? '',
        { title: t('settings.page.harness.index.chooseFolder') });
      if (result.success && result.path) edit({ storageDirectory: result.path });
    } else setPickerTarget('storage');
  };
  const removeOldCache = async (directory: string) => {
    if (!status || !window.confirm(`${t('settings.page.harness.index.retained.confirm')}\n${directory}`)) return;
    setBusy(true);
    setError(null);
    try { await removeRetainedSemanticIndex(directory, status.revision); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const validDraft = draft && Number.isSafeInteger(draft.concurrentRequests) && draft.concurrentRequests > 0
    && Number.isSafeInteger(draft.requestIntervalMs) && draft.requestIntervalMs >= 0
    && (draft.localCpuThreads == null || (Number.isSafeInteger(draft.localCpuThreads) && draft.localCpuThreads > 0))
    && (draft.storageDirectory === null || draft.storageDirectory.trim().length > 0);

  return <>
    <IndexDirectories status={status} draft={draft} edit={edit} refresh={refresh} />
    <SettingsSection title={t('settings.page.harness.index.storage.title')}
      description={t('settings.page.harness.index.storage.description')} settingsItem="harness.semanticIndex">
      <SettingsFieldRow label={t('settings.page.harness.index.storage.mode')}>
        <Select value={draft?.storageDirectory == null ? 'default' : 'custom'}
          onValueChange={(value) => edit({ storageDirectory: value === 'default' ? null : draft?.storageDirectory ?? '' })}>
          <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t('settings.page.harness.index.storage.default')}</SelectItem>
            <SelectItem value="custom">{t('settings.page.harness.index.storage.custom')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {draft && draft.storageDirectory !== null ? <SettingsFieldRow label={t('settings.page.harness.index.storage.directory')}>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input className="min-w-64 flex-1" value={draft?.storageDirectory ?? ''}
            onChange={(event) => edit({ storageDirectory: event.target.value })}
            aria-label={t('settings.page.harness.index.storage.directory')} />
          <Button size="sm" variant="outline" onClick={() => { void chooseFolder('storage'); }}>{t('settings.page.harness.index.chooseFolder')}</Button>
        </div>
      </SettingsFieldRow> : null}
      <p className="break-all typography-meta text-muted-foreground">{t('settings.page.harness.index.activeDirectory')}: {status?.activeDirectory ?? '—'}</p>
      <p className="typography-meta text-muted-foreground">{t('settings.page.harness.index.diskUsage')}: {status ? bytesLabel(status.bytes) : '—'}</p>
      {status?.configError ? <p role="alert" className="typography-meta text-destructive">{status.configError}</p> : null}
      {status?.retained.length ? <div className="space-y-2">
        <p className="typography-ui-label">{t('settings.page.harness.index.retained.title')}</p>
        {status.retained.map((item) => <div key={item.directory} className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-all typography-meta text-muted-foreground">{item.directory} · {bytesLabel(item.bytes)}</span>
          <Button size="sm" variant="outline" disabled={item.active || busy} onClick={() => { void removeOldCache(item.directory); }}>
            {t('settings.page.harness.index.retained.remove')}
          </Button>
        </div>)}
      </div> : null}
      {status?.restartRequired ? <p role="status" className="break-all typography-meta text-[var(--status-warning)]">
        {t('settings.page.harness.index.restartRequired')} {status.configuredDirectory}
      </p> : null}
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.index.cpu.title')}
      description={t('settings.page.harness.index.cpu.description')} settingsItem="harness.semanticIndex.cpu">
      <SettingsFieldRow label={t('settings.page.harness.index.cpu.mode')}>
        <Select value={draft?.localCpuMode ?? 'auto'} onValueChange={value => edit({ localCpuMode: value as SemanticIndexConfig['localCpuMode'] })}>
          <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(['auto', 'efficient', 'performance'] as const).map(mode => <SelectItem key={mode} value={mode}>
              {t(`settings.page.harness.index.cpu.${mode}`)}
            </SelectItem>)}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.index.cpu.threads')} description={t('settings.page.harness.index.cpu.threadsDescription')}>
        <Input type="number" min={1} step={1} className="w-40" value={draft?.localCpuThreads ?? ''}
          placeholder={t('settings.page.harness.index.cpu.auto')}
          onChange={event => edit({ localCpuThreads: event.target.value === '' ? null : Number(event.target.value) })} />
      </SettingsFieldRow>
    </SettingsSection>
    <SettingsSection title={t('settings.page.harness.index.requests.title')}
      description={t('settings.page.harness.index.requests.description')} settingsItem="harness.semanticIndex.requests">
      <SettingsFieldRow label={t('settings.page.harness.index.requests.concurrency')}>
        <Input type="number" min={1} step={1} className="w-40" value={draft?.concurrentRequests ?? 1}
          onChange={(event) => edit({ concurrentRequests: Number(event.target.value) })} />
      </SettingsFieldRow>
      <SettingsFieldRow label={t('settings.page.harness.index.requests.interval')}>
        <Input type="number" min={0} step={1} className="w-40" value={draft?.requestIntervalMs ?? 0}
          onChange={(event) => edit({ requestIntervalMs: Number(event.target.value) })} />
      </SettingsFieldRow>
      <Button size="sm" disabled={!dirty || !validDraft || busy} onClick={() => { void save(); }}>{t('settings.page.harness.index.save')}</Button>
      {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    </SettingsSection>
    <LocalSemanticSettings state={localSemantic} />
    {props.harness && props.update ? <InferenceSettings harness={props.harness} update={props.update}
      kind="embedding" localSemanticStatus={localSemantic.status} /> : null}
    <DirectoryExplorerDialog open={pickerTarget !== null} onOpenChange={(open) => { if (!open) setPickerTarget(null); }} mode="select-directory"
      initialPath={draft?.storageDirectory ?? ''} title={t('settings.page.harness.index.chooseFolder')}
      description={t('settings.page.harness.index.storage.description')}
      confirmLabel={t('settings.page.harness.index.chooseFolder')}
      onSelectDirectory={(directory) => {
        edit({ storageDirectory: directory });
      }} />
  </>;
}

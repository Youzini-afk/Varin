import React from 'react';
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

export function IndexSettings(props: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const phaseLabel = (phase: string): string => {
    if (phase === 'enumerating') return t('settings.page.harness.index.phase.enumerating');
    if (phase === 'processing' || phase === 'building' || phase === 'rebuilding') return t('settings.page.harness.index.phase.processing');
    if (phase === 'ready') return t('settings.page.harness.index.phase.ready');
    if (phase === 'failed') return t('settings.page.harness.index.phase.failed');
    if (phase === 'cancelled') return t('settings.page.harness.index.phase.cancelled');
    return t('settings.page.harness.index.phase.idle');
  };
  const coverageLabel = (coverage: string): string => {
    if (coverage === 'complete') return t('settings.page.harness.index.coverage.complete');
    if (coverage === 'partial') return t('settings.page.harness.index.coverage.partial');
    return t('settings.page.harness.index.coverage.empty');
  };
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const loadProviders = usePiProviderStore((state) => state.load);
  const localSemantic = useLocalSemantic();
  const [status, setStatus] = React.useState<SemanticIndexStatus | null>(null);
  const [draft, setDraft] = React.useState<SemanticIndexConfig | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pickerTarget, setPickerTarget] = React.useState<'storage' | 'scope' | null>(null);
  const [scopePath, setScopePath] = React.useState('');
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
  const addScopePath = (directory: string) => {
    const value = directory.trim();
    if (!value) return;
    edit({ indexedDirectories: [...new Set([...(draft?.indexedDirectories ?? []), value])] });
    setScopePath('');
  };
  const chooseFolder = async (target: 'storage' | 'scope') => {
    if (canRequestNativeDirectoryAccess()) {
      const result = await requestDirectoryAccess(target === 'storage' ? draft?.storageDirectory ?? '' : scopePath,
        { title: t('settings.page.harness.index.chooseFolder') });
      if (result.success && result.path) {
        if (target === 'storage') edit({ storageDirectory: result.path });
        else addScopePath(result.path);
      }
    } else setPickerTarget(target);
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
    && (draft.storageDirectory === null || draft.storageDirectory.trim().length > 0);

  return <>
    <SettingsSection title={t('settings.page.harness.index.scope.title')}
      description={t('settings.page.harness.index.scope.description')} settingsItem="harness.semanticIndex.scope">
      <SettingsFieldRow label={t('settings.page.harness.index.scope.mode')}>
        <Select value={draft?.indexedDirectories == null ? 'all' : 'selected'}
          onValueChange={(value) => edit({ indexedDirectories: value === 'all' ? null : draft?.indexedDirectories ?? [] })}>
          <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.page.harness.index.scope.all')}</SelectItem>
            <SelectItem value="selected">{t('settings.page.harness.index.scope.selected')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {draft && draft.indexedDirectories !== null ? <div className="space-y-2">
        {draft?.indexedDirectories.map((directory) => <div key={directory} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 break-all typography-meta">{directory}</span>
          <Button size="sm" variant="ghost" onClick={() => edit({ indexedDirectories: draft.indexedDirectories?.filter((item) => item !== directory) ?? [] })}>
            {t('settings.page.harness.index.scope.remove')}
          </Button>
        </div>)}
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input className="min-w-64 flex-1" value={scopePath} onChange={(event) => setScopePath(event.target.value)}
            aria-label={t('settings.page.harness.index.scope.directory')} />
          <Button size="sm" variant="outline" disabled={!scopePath.trim()} onClick={() => addScopePath(scopePath)}>{t('settings.page.harness.index.scope.add')}</Button>
          <Button size="sm" variant="outline" onClick={() => { void chooseFolder('scope'); }}>{t('settings.page.harness.index.chooseFolder')}</Button>
        </div>
        {draft?.indexedDirectories.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.index.scope.none')}</p> : null}
      </div> : null}
    </SettingsSection>
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
    <SettingsSection title={t('settings.page.harness.index.progress.title')}
      description={t('settings.page.harness.index.progress.description')}>
      <Button size="sm" variant="outline" onClick={() => { void refresh(); }}>{t('settings.page.harness.index.refresh')}</Button>
      {status?.roots.length ? status.roots.map((root) => <div key={root.workspaceId} className="space-y-1 rounded-lg border border-border/60 p-3">
        <p className="break-all typography-ui-label">{root.root ?? root.workspaceId}</p>
        <p className="typography-meta text-muted-foreground">{root.indexingEnabled ? phaseLabel(root.progress?.phase ?? root.status.lifecycle) : t('settings.page.harness.index.scope.excluded')} · {coverageLabel(root.status.coverage)}
          {root.progress?.totalFiles ? ` · ${root.progress.processedFiles}/${root.progress.totalFiles}` : ''}
          {root.progress ? ` · ${t('settings.page.harness.index.progress.documents', { count: root.progress.publishedDocuments })}` : ''}</p>
        {root.progress?.totalFiles ? <progress className="w-full" value={root.progress.processedFiles} max={root.progress.totalFiles} /> : null}
        {root.progress?.error ? <p role="alert" className="typography-meta text-destructive">{root.progress.error}</p> : null}
      </div>) : <p className="typography-meta text-muted-foreground">{t('settings.page.harness.index.progress.empty')}</p>}
    </SettingsSection>
    <LocalSemanticSettings state={localSemantic} />
    <InferenceSettings {...props} kind="embedding" localSemanticStatus={localSemantic.status} />
    <DirectoryExplorerDialog open={pickerTarget !== null} onOpenChange={(open) => { if (!open) setPickerTarget(null); }} mode="select-directory"
      initialPath={pickerTarget === 'storage' ? draft?.storageDirectory ?? '' : scopePath} title={t('settings.page.harness.index.chooseFolder')}
      description={t(pickerTarget === 'scope'
        ? 'settings.page.harness.index.scope.description'
        : 'settings.page.harness.index.storage.description')}
      confirmLabel={t('settings.page.harness.index.chooseFolder')}
      onSelectDirectory={(directory) => {
        if (pickerTarget === 'storage') edit({ storageDirectory: directory });
        else if (pickerTarget === 'scope') addScopePath(directory);
      }} />
  </>;
}

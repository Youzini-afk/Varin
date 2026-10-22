import React from 'react';
import { SettingsSection } from '../shared/SettingsSection';
import { IndexDirectories } from './IndexDirectories';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';
import { InferenceSettings } from './RetrievalSettings';
import { readSemanticIndexStatus, removeRetainedSemanticIndex, type SemanticIndexStatus } from './semantic-index-api';

const bytesLabel = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export function IndexSettings(props: Partial<HarnessSettingsPageProps>) {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<SemanticIndexStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const request = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const next = await readSemanticIndexStatus(controller.signal);
      if (!controller.signal.aborted) { setStatus(next); setError(null); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, []);
  React.useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  const cleaning = status?.directories.entries.some(entry => entry.busy) ?? false;
  React.useEffect(() => {
    if (!cleaning) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [cleaning, refresh]);
  const removeRetained = async (directory: string) => {
    if (!status || !window.confirm(`${t('settings.page.harness.index.retained.confirm')}\n${directory}`)) return;
    setBusy(true);
    try { await removeRetainedSemanticIndex(directory, status.revision); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <>
    <SettingsSection title={t('settings.page.harness.index.storage.title')} description={t('settings.page.harness.index.storage.description')} settingsItem="harness.semanticIndex">
      <p className="typography-ui-label">{status ? bytesLabel(status.bytes) : '—'}</p>
      <p className="break-all typography-meta text-muted-foreground">{status?.activeDirectory}</p>
      {status?.retained.filter(item => !item.active).map(item => <div key={item.directory} className="flex flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 break-all typography-meta text-muted-foreground">{item.directory} · {bytesLabel(item.bytes)}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void removeRetained(item.directory)}>{t('settings.page.harness.index.retained.remove')}</Button>
      </div>)}
      {error || status?.configError ? <p role="alert" className="typography-meta text-destructive">{error ?? status?.configError}</p> : null}
    </SettingsSection>
    <IndexDirectories status={status} refresh={refresh} />
    {props.harness && props.update ? <InferenceSettings harness={props.harness} update={props.update} kind="embedding" /> : null}
  </>;
}

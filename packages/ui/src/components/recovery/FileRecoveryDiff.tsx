import React from 'react';
import type { FileRecoveryPreview, FileRecoveryRequest, FileRecoveryResult, FileRecoveryTextSlice } from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';

const Diff = React.lazy(() => import('@/components/views/PierreDiffViewer').then(module => ({ default: module.PierreDiffViewer })));
type Props = {
  path: string; point: string; sourceRunId: string; targetLabel: string;
  read(input: Omit<FileRecoveryRequest, 'conversation'>): Promise<FileRecoveryResult>;
};
export function FileRecoveryDiff({ path, point, sourceRunId, targetLabel, read }: Props) {
  const { t } = useI18n();
  const [preview, setPreview] = React.useState<FileRecoveryPreview>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const sequence = React.useRef(0);
  const loading = React.useRef(false);
  const invalidate = React.useCallback(() => { sequence.current++; }, []);
  const load = React.useCallback(async (previous?: FileRecoveryPreview) => {
    if (previous && loading.current) return;
    loading.current = true;
    const id = ++sequence.current;
    setBusy(true); setError(undefined);
    try {
      const result = await read({ action: 'preview', sourceRunId, point, path,
        ...(previous ? { currentOffset: previous.current.nextOffset, targetOffset: previous.target.nextOffset } : {}) });
      if (id !== sequence.current) return;
      if (!result.preview || result.preview.path !== path) throw new Error(t('contextPanel.recovery.files.previewUnavailable'));
      const page = result.preview;
      const append = (old: FileRecoveryTextSlice | undefined, next: FileRecoveryTextSlice): FileRecoveryTextSlice => {
        if (!old) return next;
        if (old.version !== next.version || old.kind !== next.kind) throw new Error(t('contextPanel.recovery.files.previewChanged'));
        return { ...next, ...(next.kind === 'text' ? { text: (old.text ?? '') + (next.text ?? '') } : {}) };
      };
      setPreview({ path, current: append(previous?.current, page.current), target: append(previous?.target, page.target) });
    } catch (cause) {
      if (id === sequence.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === sequence.current) { loading.current = false; setBusy(false); }
    }
  }, [path, point, read, sourceRunId, t]);
  React.useEffect(() => {
    void load();
    return invalidate;
  }, [invalidate, load]);
  const readable = preview && [preview.current.kind, preview.target.kind].every(kind => kind === 'text' || kind === 'missing');
  const more = preview && (!preview.current.eof || !preview.target.eof);
  return <div className="mb-3 overflow-hidden rounded-md border border-border/60 bg-background" aria-label={t('contextPanel.recovery.files.diffLabel', { path })}>
    <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5 typography-micro text-muted-foreground">
      <span>{t('contextPanel.recovery.files.currentContent')}</span><Icon name="arrow-right" className="size-3" /><span>{targetLabel}</span>
      <Button variant="ghost" size="icon" className="ml-auto size-5" disabled={busy}
        aria-label={t('settings.varin.recovery.actions.refresh')} onClick={() => { setPreview(undefined); void load(); }}>
        <Icon name="refresh" className="size-3" />
      </Button>
    </div>
    {readable && preview && <React.Suspense fallback={<p className="px-3 py-3 typography-meta text-muted-foreground">{t('contextPanel.recovery.files.loadingDiff')}</p>}>
      {(preview.current.text ?? '') === (preview.target.text ?? '') && !more
        ? <p className="px-3 py-4 typography-meta text-muted-foreground">{t('contextPanel.recovery.files.unchanged')}</p>
        : <Diff original={preview.current.text ?? ''} modified={preview.target.text ?? ''} fileName={path}
          language={getLanguageFromExtension(path) ?? 'text'} renderSideBySide={false} wrapLines layout="inline" enableComments={false} />}
    </React.Suspense>}
    {preview && !readable && <div className="space-y-1 px-3 py-4 typography-meta text-muted-foreground">
      <p>{t('contextPanel.recovery.files.nonText')}</p>
      <p className="typography-micro tabular-nums">{formatWorkspaceArchiveBytes(preview.current.byteLength)} → {formatWorkspaceArchiveBytes(preview.target.byteLength)}</p>
    </div>}
    {busy && <div role="status" className="flex items-center gap-2 px-3 py-2 typography-micro text-muted-foreground">
      <Icon name="loader-4" className="size-3 animate-spin" />{t('contextPanel.recovery.files.loadingDiff')}
    </div>}
    {error && <p role="alert" className="px-3 py-2 typography-micro text-[var(--status-error)]">{error}</p>}
    {more && readable && <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-3 py-2">
      <span className="typography-micro text-muted-foreground">{t('contextPanel.recovery.files.partialPreview')}</span>
      <Button size="xs" variant="ghost" disabled={busy || Boolean(error)} onClick={() => void load(preview)}>{t('contextPanel.recovery.files.loadMoreContent')}</Button>
    </div>}
  </div>;
}

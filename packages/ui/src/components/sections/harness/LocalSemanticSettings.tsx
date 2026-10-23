import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cancelLocalSemantic, importLocalSemantic, installLocalSemantic } from './local-semantic';
import { useLocalSemantic } from './useLocalSemantic';

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

export function LocalSemanticSettings() {
  const state = useLocalSemantic();
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

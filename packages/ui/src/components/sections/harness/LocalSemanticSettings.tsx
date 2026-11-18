import React from 'react';
import { Btn, Dot, Note, Row } from '../shared/kit';
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

  return <>
    <Row item="harness.localSemantic" label={t('settings.page.harness.localSemantic.title')} description={<>
      <span role="status" className="inline-flex flex-wrap items-center gap-x-2 tabular-nums">
        {installing ? <span aria-hidden className="sk-spin" /> : <Dot state={status?.status === 'ready' ? 'ok' : status?.status === 'failed' ? 'err' : 'off'} />}
        <span>{stage ?? statusLabel}{status?.version ? ` · ${status.version}` : ''}</span>
        {progress ? <span>{progress}</span> : null}
      </span>
      {canInstall ? <span className="block mt-1">{t('settings.roles.localEmbeddingTarget')}</span> : null}
    </>}>
      {installing ? <Btn sm kind="ghost" disabled={state.busy} onClick={() => state.run(cancelLocalSemantic)}>
        {t('settings.page.harness.localSemantic.cancel')}
      </Btn> : <>
        {canInstall ? <Btn sm kind="primary" icon="download" disabled={state.busy} onClick={() => state.run(installLocalSemantic, true)}>
          {status?.error ? t('settings.page.harness.localSemantic.retry') : t('settings.page.harness.localSemantic.install')}
        </Btn> : null}
        <Btn sm kind={canInstall ? 'ghost' : 'default'} disabled={state.busy} onClick={() => fileInput.current?.click()}>
          {t('settings.page.harness.localSemantic.import')}
        </Btn>
      </>}
      <input ref={fileInput} type="file" hidden accept=".tar.gz,.tgz,application/gzip,application/x-gzip" disabled={state.busy || installing}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) state.run(() => importLocalSemantic(file), true);
        }} />
    </Row>
    {status?.error ? <Note kind="err" inPanel>{status.error}</Note> : null}
    {state.error ? <Note kind="err" inPanel actions={<Btn sm kind="ghost" disabled={state.busy} onClick={state.refresh}>
      {t('assistant.reload')}
    </Btn>}>{state.error}</Note> : null}
  </>;
}

import React from 'react';
import type { PluginCenterAPI } from '@varin/application-client';
import type { VarinExtensionReleasePreview } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useExtensionCodeTrust } from './ExtensionCodeTrustDialog';
import { getVarinExtensionCatalogState, refreshVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { getRuntimeEndpointGeneration } from '@varin/application-client';

export function PluginReleasePreview({ preview, api, onClose, onInstalled, hostLabel, onInstalling }: {
  preview: VarinExtensionReleasePreview; api: PluginCenterAPI; hostLabel?: string; onClose(): void; onInstalled(): void; onInstalling?(value: boolean): void;
}) {
  const { t } = useI18n();
  const trust = useExtensionCodeTrust();
  const [replaceSource, setReplaceSource] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [owner] = React.useState(() => ({ generation: getRuntimeEndpointGeneration(), revision: preview.catalogRevision }));
  const install = async () => {
    setBusy(true); setError(undefined);
    try {
      if (!await trust.confirm({ artifacts: [{ extensionId: preview.manifest.id, version: preview.version, integrity: preview.integrity, source: preview.source }] })) return;
      const catalog = getVarinExtensionCatalogState().snapshot?.catalog;
      if (owner.generation !== getRuntimeEndpointGeneration() || catalog?.hostId !== preview.hostId || catalog.revision !== owner.revision) {
        throw new Error(t('settings.plugins.previewChanged'));
      }
      onInstalling?.(true);
      await api.install({ previewId: preview.previewId, expectedHostId: preview.hostId, expectedRevision: catalog.revision, replaceSource });
      await refreshVarinExtensionCatalog();
      onInstalled();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { onInstalling?.(false); setBusy(false); }
  };
  return <>
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('settings.plugins.previewTitle')}</DialogTitle>
          <DialogDescription>{t('settings.plugins.host', { host: hostLabel ? `${hostLabel} (${preview.hostId})` : preview.hostId })}</DialogDescription></DialogHeader>
        <div className="space-y-2 break-words typography-meta">
          <p className="font-medium">{preview.manifest.displayName ?? preview.manifest.id} · {preview.version}</p>
          <p>{preview.source.display}</p><p className="break-all typography-micro">{preview.integrity}</p>
          <p>{preview.manifest.metadata?.description}</p>
          {preview.releaseNotesUrl ? <a className="underline" href={preview.releaseNotesUrl} target="_blank" rel="noopener noreferrer">{t('settings.plugins.releaseNotes')}</a> : null}
          <p>{t('settings.plugins.capabilities')}</p>
          <ul>{Object.entries(preview.manifest.capabilities ?? {}).flatMap(([realm, values]) => values.map(value => <li key={`${realm}:${value}`}>{realm}: {value}</li>))}</ul>
          {preview.manifest.requires?.services?.length ? <div><p>{t('settings.varin.extensions.inspector.dependencies')}</p><ul>{preview.manifest.requires.services.map(service => <li key={`${service.id}:${service.version}`}>{service.id}@{service.version}{service.optional ? ` · ${t('settings.varin.extensions.inspector.optional')}` : ''}</li>)}</ul></div> : null}
          {preview.warnings.length > 0 ? <div><p>{t('settings.plugins.warnings')}</p><ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
          {preview.sourceChanged ? <div><p>{t('settings.plugins.sourceChanged')}</p><label className="flex items-center gap-2"><input type="checkbox" checked={replaceSource} onChange={e => setReplaceSource(e.target.checked)} />{t('settings.plugins.replaceSource')}</label></div> : null}
          {error ? <p role="alert" className="text-[var(--status-error)]">{error}</p> : null}
        </div>
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t('settings.common.actions.cancel')}</Button>
          <Button disabled={busy || (preview.sourceChanged && !replaceSource)} onClick={() => { void install(); }}>{t('settings.plugins.install')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>{trust.dialog}
  </>;
}

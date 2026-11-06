import React from 'react';
import type { PluginCenterAPI, PluginDiscoverySnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
export function PluginSources({ api, snapshot, onChange }: { api: PluginCenterAPI; snapshot: PluginDiscoverySnapshot | null; onChange(snapshot: PluginDiscoverySnapshot): void }) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(() => snapshot?.sources.map(source => source.url).join('\n') ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const save = async () => {
    setBusy(true); setError(undefined);
    try { onChange(await api.saveSources([...new Set(draft.split('\n').map(value => value.trim()).filter(Boolean))].map(url => { const existing = snapshot?.sources.find(source => source.url === url); return { url, enabled: existing?.enabled ?? true, ...(existing?.displayName ? { displayName: existing.displayName } : {}) }; }))); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-2 py-4"><h2 className="typography-ui-label">{t('settings.plugins.sources')}</h2>
    <label className="block typography-meta">{t('settings.plugins.sourceHint')}<textarea className="mt-2 min-h-24 w-full rounded-md border bg-background p-2" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <Button variant="outline" disabled={busy} onClick={() => { void save(); }}>{t('settings.plugins.saveSources')}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

import React from 'react';
import { consumePluginInstallIntent, subscribePluginInstallIntent, getRuntimeEndpointGeneration, type PluginDiscoverySnapshot, type PluginInstallIntent } from '@varin/application-client';
import type { VarinExtensionPackageSource } from '@varin/extension-contract';
import { useI18n } from '@/lib/i18n';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useVarinExtensionCatalog, refreshVarinExtensionCatalog, getVarinExtensionCatalogState } from '@/lib/extensions/catalog-store';
import { useSurfaceRegistrySnapshot } from '@/lib/extensions/workbench-registry';
import { getWorkbenchCompositionInspectorSnapshot, subscribeWorkbenchCompositionInspector } from '@/lib/extensions/workbench-composition-host';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsTabs } from '../shared/SettingsTabs';
import { ExtensionCard, ExtensionInstallSection, ServiceRoutingSection, WorkbenchProfileSection } from './ExtensionManagement';
import { AgentDriverRoutingSection } from './AgentDriverRoutingSection';
import { PluginDiscovery } from './PluginDiscovery';
import { installedPluginListing, routePluginInstallIntent } from './plugin-center-selection';
import { PluginSources } from './PluginSources';
import { PluginReleasePreview } from './PluginReleasePreview';
import { usePluginReleasePreparation } from './usePluginReleasePreparation';
import { usePluginUpdateChecks } from './usePluginUpdateChecks';
import { PluginUpdateStatus } from './PluginUpdateStatus';
import { readPluginCenterView, savePluginCenterView, matchesPluginQuery } from './plugin-center-state';

export const ExtensionsPage: React.FC = () => {
  const state = useVarinExtensionCatalog();
  // Unmounting the old Host scope closes confirmation and discards every late UI result.
  const hostId = state.snapshot?.catalog.hostId;
  return hostId ? <PluginCenter key={`${hostId}:${getRuntimeEndpointGeneration()}`} hostId={hostId} />
    : <SettingsPageLayout><p role="status">{state.error ?? '…'}</p></SettingsPageLayout>;
};
function PluginCenter({ hostId }: { hostId: string }) {
  const { t } = useI18n();
  const state = useVarinExtensionCatalog();
  const surface = useSurfaceRegistrySnapshot();
  const composition = React.useSyncExternalStore(subscribeWorkbenchCompositionInspector, getWorkbenchCompositionInspectorSnapshot, getWorkbenchCompositionInspectorSnapshot);
  const api = getRegisteredRuntimeAPIs()?.extensions.pluginCenter;
  const [view, setView] = React.useState(() => readPluginCenterView(hostId));
  const viewRef = React.useRef(view); viewRef.current = view;
  const [advanced, setAdvanced] = React.useState(false);
  const [directInstall, setDirectInstall] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<PluginDiscoverySnapshot | null>(null);
  const catalogRevision = state.snapshot?.catalog.revision;
  const discoveryPublication = React.useRef(0);
  const [matchedRevision, setMatchedRevision] = React.useState<number>();
  const metadataSnapshot = matchedRevision === catalogRevision ? snapshot : null;
  const [error, setError] = React.useState<string>();
  const [loading, setLoading] = React.useState(false);
  const preparation = usePluginReleasePreparation(api, hostId);
  const { busy, preview } = preparation;
  const life = React.useRef(true);
  const [owner] = React.useState(getRuntimeEndpointGeneration);
  const isCurrent = React.useCallback(() => life.current && owner === getRuntimeEndpointGeneration(), [owner]);
  const root = React.useRef<HTMLDivElement>(null);
  const restoreScroll = React.useRef(true);
  const target = useSettingsSearchTarget();
  const extensions = state.snapshot?.catalog.extensions ?? [];
  React.useEffect(() => { life.current = true; return () => { life.current = false; }; }, []);
  React.useEffect(() => { savePluginCenterView(hostId, view); }, [hostId, view]);
  React.useEffect(() => {
    const scroll = root.current?.querySelector<HTMLElement>('.overlay-scrollbar-target');
    if (!scroll) return;
    const save = () => { if (restoreScroll.current) return; viewRef.current.scroll = scroll.scrollTop; savePluginCenterView(hostId, viewRef.current); };
    scroll.addEventListener('scroll', save, { passive: true });
    return () => { save(); scroll.removeEventListener('scroll', save); };
  }, [hostId]);
  React.useEffect(() => {
    if (!restoreScroll.current || (view.tab === 'discover' && !snapshot)) return;
    const scroll = root.current?.querySelector<HTMLElement>('.overlay-scrollbar-target');
    if (scroll) { scroll.scrollTop = viewRef.current.scroll; restoreScroll.current = false; }
  }, [snapshot, view.tab]);
  React.useEffect(() => { if (target?.startsWith('extensions.')) {
    setView(current => ({ ...current, tab: 'installed' }));
    if (target.includes('workbench') || target.includes('routing')) setAdvanced(true);
  } }, [target]);
  const refresh = React.useCallback(async () => {
    if (!api) return;
    setLoading(true); setError(undefined);
    try { const next = await api.refreshDiscovery(); if (isCurrent() && next.hostId === hostId && catalogRevision === getVarinExtensionCatalogState().snapshot?.catalog.revision) { discoveryPublication.current++; setSnapshot(next); setMatchedRevision(catalogRevision); } }
    catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (isCurrent()) setLoading(false); }
  }, [api, hostId, isCurrent, catalogRevision]);
  React.useEffect(() => {
    if (!api) return;
    const publication = discoveryPublication.current;
    void api.discovery().then(next => {
      if (isCurrent() && next.hostId === hostId && publication === discoveryPublication.current
        && catalogRevision === getVarinExtensionCatalogState().snapshot?.catalog.revision) {
        setSnapshot(next); setMatchedRevision(catalogRevision);
      }
    }).catch(failure => { if (isCurrent()) setError(String(failure)); });
  }, [api, hostId, isCurrent, catalogRevision]);
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!api || loaded.current || view.tab !== 'discover') return;
    loaded.current = true; void refresh();
  }, [api, refresh, view.tab]);
  const { updates, checking, error: updateError, check } = usePluginUpdateChecks(api, catalogRevision, view.tab === 'installed', isCurrent);
  const closePreparation = preparation.close;
  const intentSequence = React.useRef(0);
  const prepareRelease = preparation.prepare;
  const prepare = React.useCallback(async (source: VarinExtensionPackageSource | string | File, extensionId?: string) => {
    if (!api) return;
    intentSequence.current++;
    const label = typeof source === 'string' ? source : source instanceof File ? source.name : `${source.kind}:${source.specifier}`;
    await prepareRelease(label, () => typeof source === 'string' ? api.previewUpdate(source)
      : source instanceof File ? api.previewArchive(source, source.name) : api.preview(source, extensionId));
  }, [api, prepareRelease]);
  const openIntent = React.useCallback(async (intent: PluginInstallIntent) => {
    if (!api) return;
    const request = ++intentSequence.current;
    setError(undefined);
    const revision = getVarinExtensionCatalogState().snapshot?.catalog.revision;
    closePreparation();
    const current = () => isCurrent() && request === intentSequence.current
      && revision === getVarinExtensionCatalogState().snapshot?.catalog.revision;
    try {
      await routePluginInstallIntent(intent, {
        resolveInstalled: (source, extensionId) => api.resolveInstalled(source, extensionId),
        isCurrent: next => current() && next.hostId === hostId,
        manage: id => setView(value => ({ ...value, tab: 'installed', query: id, group: 'all' })),
        preview: (source, id) => { void prepare(source, id); },
      });
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : String(failure)); }
  }, [api, hostId, isCurrent, closePreparation, prepare]);
  React.useEffect(() => {
    const consume = () => { const intent = consumePluginInstallIntent(); if (intent) void openIntent(intent); };
    consume(); return subscribePluginInstallIntent(consume);
  }, [openIntent]);
  const discoverySnapshot = metadataSnapshot ?? (snapshot ? { ...snapshot, entries: snapshot.entries.map(listing => ({ ...listing, installed: false })) } : null);
  const categories = [...new Set(snapshot?.entries.flatMap(item => item.entry.categories ?? []) ?? [])].sort();
  const filtered = extensions.filter(entry => {
    const listing = installedPluginListing(metadataSnapshot, entry.manifest.id);
    return matchesPluginQuery(view.query, entry.manifest.id, listing?.displayName ?? entry.manifest.displayName,
      listing?.description ?? entry.manifest.metadata?.description, listing?.author, ...(listing?.keywords ?? []));
  });
  return <div ref={root} className="h-full min-h-0">
    <SettingsPageLayout title={t('settings.page.extensions.title')} description={t('settings.plugins.host', { host: snapshot?.hostLabel ? `${snapshot.hostLabel} (${hostId})` : hostId })}
      headerEnd={<Button size="sm" variant="outline" onClick={() => setDirectInstall(value => !value)}>{t('settings.plugins.directInstall')}</Button>}>
      <SettingsTabs value={view.tab} onChange={tab => setView(current => ({ ...current, tab }))} label={t('settings.page.extensions.title')} items={[
        { value: 'discover', label: t('settings.plugins.discover') }, { value: 'installed', label: t('settings.plugins.installed') },
      ]} />
      <div className="flex flex-wrap gap-2 py-3">
        <Input className="min-w-40 flex-1" aria-label={t('settings.plugins.search')} placeholder={t('settings.plugins.search')} value={view.query} onChange={event => setView(current => ({ ...current, query: event.target.value }))} />
        {view.tab === 'discover' ? <><select className="rounded-md border bg-background px-2 typography-meta" aria-label={t('settings.plugins.allCategories')} value={view.category} onChange={event => setView(current => ({ ...current, category: event.target.value }))}>
          <option value="all">{t('settings.plugins.allCategories')}</option>{categories.map(category => <option key={category}>{category}</option>)}</select>
          <Button variant="outline" disabled={loading || !api} onClick={() => { void refresh(); }}>{t('settings.plugins.retry')}</Button></>
          : <><select className="rounded-md border bg-background px-2 typography-meta" aria-label={t('settings.plugins.installed')} value={view.group} onChange={event => setView(current => ({ ...current, group: event.target.value as typeof view.group }))}>
            {(['all', 'external', 'builtin'] as const).map(group => <option key={group} value={group}>{t(`settings.plugins.${group}`)}</option>)}</select>
            <Button variant="outline" disabled={checking || !api} onClick={() => { void check(); }}>{t('settings.plugins.checkUpdates')}</Button></>}
      </div>
      {busy ? <p role="status" className="py-2 typography-meta">{t('settings.plugins.preparing')}</p> : null}
      {error || state.error || preparation.error || updateError ? <p role="alert" className="py-2 typography-meta text-[var(--status-error)]">{error ?? state.error ?? preparation.error ?? updateError}</p> : null}
      {directInstall ? <><ExtensionInstallSection onIntent={intent => { void openIntent(intent); }} onPreview={source => { void prepare(source); }} />
        <label className="block py-3 typography-meta">{t('settings.plugins.importArchive')}<input type="file" accept=".tgz,.tar.gz" className="mt-2 block w-full" disabled={!api || busy !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepare(file); }} /></label></> : null}
      {view.tab === 'discover' ? <>
        {loading ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.plugins.loading')}</p> : null}
        {(!loading || snapshot) ? <PluginDiscovery loading={loading} snapshot={discoverySnapshot} installed={extensions} query={view.query} category={view.category} busy={busy} onPreview={(source, extensionId) => { void prepare(source, extensionId); }} onManage={id => setView(current => ({ ...current, tab: 'installed', query: id, group: 'all' }))} /> : null}
      </> : <div className="space-y-4">
        {(['external', 'builtin'] as const).filter(group => view.group === 'all' || view.group === group).map(group => {
          const entries = filtered.filter(entry => (entry.source.kind === 'builtin') === (group === 'builtin'));
          return entries.length ? <section key={group} className="space-y-2"><h2 className="typography-ui-label">{t(`settings.plugins.${group}`)}</h2>
            {entries.map(entry => <div key={entry.manifest.id} className="space-y-2"><ExtensionCard listing={installedPluginListing(metadataSnapshot, entry.manifest.id)} entry={entry} busy={state.busyExtensionId === entry.manifest.id} composition={composition} surface={surface} hostState={state.snapshot} />
              {group === 'external' && api ? <PluginUpdateStatus update={updates.find(item => item.extensionId === entry.manifest.id)} busy={checking || busy !== null} onCheck={() => { void check(entry.manifest.id); }} onPreview={() => { void prepare(entry.manifest.id); }} /> : null}
            </div>)}
          </section> : null;
        })}
        {!filtered.length ? <p className="py-8 text-center typography-meta text-muted-foreground">{t('settings.plugins.noResults')}</p> : null}
      </div>}
      <div className="py-4"><Button variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{t('settings.plugins.advanced')}</Button></div>
      {advanced ? <>
        {api ? <PluginSources key={snapshot?.sources.map(source => source.url).join('|')} api={api} snapshot={snapshot} onChange={next => { if (isCurrent() && next.hostId === hostId) setSnapshot(next); }} /> : null}
        <Button variant="outline" onClick={() => { void refreshVarinExtensionCatalog().catch(() => undefined); }}>{t('settings.varin.extensions.actions.refresh')}</Button>
        {[...(state.snapshot?.catalog.diagnostics ?? []), ...(state.snapshot?.routing.diagnostics ?? []), ...(state.snapshot?.workbench.diagnostics ?? [])].map((item, index) => <p key={index} className="break-words typography-micro">{item.code}: {item.message}</p>)}
        <AgentDriverRoutingSection /><ServiceRoutingSection /><WorkbenchProfileSection />
      </> : null}
      {preview && api ? <PluginReleasePreview key={preview.previewId} api={api} preview={preview} hostLabel={snapshot?.hostLabel} onClose={preparation.close} onInstalling={preparation.setInstalling} onInstalled={() => { void api.discovery().then(next => { if (isCurrent() && next.hostId === hostId) setSnapshot(next); }).catch(() => undefined); preparation.close(); setView(current => ({ ...current, tab: 'installed', query: preview.manifest.id, group: 'all' })); }} /> : null}
    </SettingsPageLayout>
  </div>;
}

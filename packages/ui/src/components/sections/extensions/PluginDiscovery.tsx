import React from 'react';
import type { PluginDiscoverySnapshot, PluginDiscoveryEntry } from '@varin/application-client';
import type { VarinExtensionCatalogEntry, VarinExtensionPackageSource } from '@varin/extension-contract';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { matchesPluginQuery } from './plugin-center-state';

function DiscoveryCard({ listing, installed, busy, onPreview, onManage }: { listing: PluginDiscoveryEntry; installed: boolean; busy: boolean; onPreview(source: VarinExtensionPackageSource, extensionId: string): void; onManage(id: string): void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const entry = listing.entry;
  const repository = entry.repository ?? entry.homepage;
  return <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-3 @xl:flex-row">
    <div className="flex min-w-0 flex-1 items-start gap-3">
      {entry.icon ? <img src={entry.icon} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-9 shrink-0 rounded-md object-contain" /> : <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-interactive-hover">◇</span>}
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="truncate typography-ui-label" title={entry.displayName ?? entry.id}>{entry.displayName ?? entry.id}</h2>
        {entry.description ? <><p className={`break-words typography-meta text-muted-foreground ${expanded ? '' : 'line-clamp-2'}`}>{entry.description}</p>
          <button className="typography-micro text-muted-foreground underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'settings.plugins.hideDetails' : 'settings.plugins.details')}</button></> : null}
        <p className="break-words typography-micro text-muted-foreground">{[entry.author, ...(entry.categories ?? [])].filter(Boolean).join(' · ')}</p>
        <p className="truncate typography-micro text-muted-foreground" title={listing.catalogs.join('\n')}>{listing.catalogs.join(' · ')}</p>
      </div>
    </div>
    <div className="flex shrink-0 flex-wrap items-start gap-2 @xl:flex-col @xl:items-end">
      <Button size="sm" disabled={busy} variant={installed ? 'outline' : 'default'} onClick={() => installed ? onManage(entry.id) : onPreview(entry.source, entry.id)}>{t(installed ? 'settings.plugins.manage' : busy ? 'settings.plugins.preparing' : 'settings.plugins.preview')}</Button>
      {repository && /^https?:\/\//.test(repository) ? <a className="typography-micro underline" href={repository} target="_blank" rel="noopener noreferrer">{t('settings.plugins.repository')} ↗</a> : null}
    </div>
  </article>;
}
export function PluginDiscovery({ snapshot, installed, query, category, busy, onPreview, onManage, loading = false }: {
  snapshot: PluginDiscoverySnapshot | null; installed: VarinExtensionCatalogEntry[]; query: string; category: string; busy: string | null; loading?: boolean;
  onPreview(source: VarinExtensionPackageSource, extensionId: string): void; onManage(id: string): void;
}) {
  const { t } = useI18n();
  const entries = snapshot?.entries.filter(({ entry }) => (category === 'all' || entry.categories?.includes(category))
    && matchesPluginQuery(query, entry.id, entry.displayName, entry.description, entry.author, ...(entry.keywords ?? []))) ?? [];
  return <div className="space-y-2">
    {snapshot?.sources.map(source => <div key={source.url} className="typography-micro text-muted-foreground">
      {source.error ? <p role="alert" className="text-[var(--status-warning)]">{source.displayName ?? source.url}: {source.error}</p> : null}
      {source.updatedAt ? <p>{source.displayName ?? source.url} · {t('settings.plugins.cached', { time: new Date(source.updatedAt).toLocaleString() })}</p> : null}
    </div>)}
    {entries.map(listing => <DiscoveryCard key={listing.key} listing={listing}
      installed={listing.installed === true && installed.some(item => item.manifest.id === listing.entry.id)}
      busy={busy === `${listing.entry.source.kind}:${listing.entry.source.specifier}`} onPreview={onPreview} onManage={onManage} />)}
    {entries.length === 0 && !loading ? <p className="py-8 text-center typography-meta text-muted-foreground">{t(
      snapshot?.sources.some(source => source.enabled && (source.status === 'ready' || source.status === 'stale'))
        ? snapshot.entries.length ? 'settings.plugins.noResults' : 'settings.plugins.emptyDirectory'
        : snapshot?.sources.some(source => source.enabled && source.status === 'error') ? 'settings.plugins.directoryFailed' : 'settings.plugins.noCatalog'
    )}</p> : null}
  </div>;
}

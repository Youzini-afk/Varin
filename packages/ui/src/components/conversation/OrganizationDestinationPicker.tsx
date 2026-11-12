import React from 'react';
import type { ConversationOrganizationQuery, ConversationOrganizationSnapshot } from '@varin/application-client';
import { loadOrganizationPage, organizationQueryKey, refreshConversationOrganization, useConversationOrganizationStore } from '@/stores/useConversationOrganizationStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { organizationContainerPath } from './organizationProjection';

/** Destination membership comes from requested pages, not the navigation cache's incidental coverage. */
export function OrganizationDestinationPicker({ value, onChange, snapshot, excluded, disabled }: {
  value: string; onChange(value: string): void; snapshot: ConversationOrganizationSnapshot;
  excluded: string[]; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const destinationSelect = React.useRef<HTMLSelectElement>(null);
  React.useEffect(() => { destinationSelect.current?.focus(); }, [scope]);
  const query = React.useMemo<ConversationOrganizationQuery>(() => ({ pageNodes: true, archived: 'include', ...(search.trim() ? { query: search.trim(), recursive: true } : scope ? { containerId: scope } : { rootOnly: true }) }), [scope, search]);
  const page = useConversationOrganizationStore(state => state.pages[organizationQueryKey(query)]);
  React.useEffect(() => { void loadOrganizationPage(query); }, [query]);
  const allowed = (id: string) => !organizationContainerPath(snapshot, id).some(parent => excluded.includes(parent.id));
  const members = page?.snapshot?.items ? new Set(page.snapshot.items.filter(item => item.kind === 'container').map(item => item.id)) : null;
  const choices = (page?.snapshot?.containers ?? []).filter(container => (!members || members.has(container.id)) && allowed(container.id) && (search.trim() || container.parentId === scope));
  const label = (id: string) => `${organizationContainerPath(snapshot, id).map(container => container.name ?? t('organization.untitled')).join(' / ')} · ${id}`;
  const options = [...new Set([...(value ? [value] : []), ...(scope && allowed(scope) ? [scope] : []), ...choices.map(container => container.id)])];
  return <div className="space-y-2">
    <Input type="search" aria-label={t('organization.searchTargets')} placeholder={t('organization.searchTargets')} value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} />
    <nav aria-label={t('organization.targetPath')} className="flex flex-wrap gap-1 typography-micro">
      <button type="button" disabled={disabled} onClick={() => { setScope(null); setSearch(''); }}>{t('organization.root')}</button>
      {organizationContainerPath(snapshot, scope).map(container => <button type="button" disabled={disabled} key={container.id} title={label(container.id)} onClick={() => { setScope(container.id); setSearch(''); }}> / {container.name ?? container.id}</button>)}
    </nav>
    <select ref={destinationSelect} autoFocus aria-label={t('organization.target')} className="w-full min-w-0 rounded border border-border bg-background p-1" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{t('organization.root')}</option>
      {options.map(id => <option key={id} value={id} disabled={!allowed(id)}>{label(id)}</option>)}
    </select>
    <div className="max-h-48 overflow-auto" aria-label={t('organization.browseTargets')}>
      {choices.map(container => <div key={container.id} className="flex min-w-0 items-center gap-1">
        <button type="button" disabled={disabled} className="min-w-0 flex-1 truncate text-left typography-meta" title={label(container.id)} onClick={() => onChange(container.id)}>{label(container.id)}</button>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`${t('organization.enter')}: ${label(container.id)}`} onClick={() => { setScope(container.id); setSearch(''); }}>{t('organization.enter')}</Button>
      </div>)}
    </div>
    {(!page || page.loading) && <p role="status" className="typography-meta">{t('organization.loading')}</p>}
    {page?.error && <p role="alert">{page.error} <Button type="button" variant="ghost" size="sm" onClick={() => void refreshConversationOrganization()}>{t('common.retry')}</Button></p>}
    {page?.snapshot?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={disabled || page.loading} onClick={() => void loadOrganizationPage(query, true)}>{t('organization.loadMore')}</Button>}
  </div>;
}

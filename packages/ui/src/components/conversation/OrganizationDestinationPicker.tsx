import React from 'react';
import type { ConversationOrganizationQuery, ConversationOrganizationSnapshot } from '@varin/application-client';
import { loadOrganizationPage, organizationQueryKey, refreshConversationOrganization, useConversationOrganizationStore } from '@/stores/useConversationOrganizationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { organizationContainerPath } from './organizationProjection';
import { OrganizationContainerIcon } from './OrganizationContainerIcon';

/** Entering a paged location selects it, without a second selector. */
export function OrganizationDestinationPicker({ value, onChange, snapshot, excluded, disabled }: {
  value: string; onChange(value: string): void; snapshot: ConversationOrganizationSnapshot;
  excluded: string[]; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = React.useState('');
  const projects = useProjectsStore(state => state.projects);
  const query = React.useMemo<ConversationOrganizationQuery>(() => ({ pageNodes: true, kind: 'containers', archived: 'include', ...(search.trim() ? { query: search.trim(), recursive: true } : value ? { containerId: value } : { rootOnly: true }) }), [value, search]);
  const page = useConversationOrganizationStore(state => state.pages[organizationQueryKey(query)]);
  React.useEffect(() => { void loadOrganizationPage(query); }, [query]);
  const named = (container: ConversationOrganizationSnapshot['containers'][number]) => ({ ...container, name: container.kind === 'project' ? projects.find(project => project.id === container.projectId)?.label || projects.find(project => project.id === container.projectId)?.path.split(/[\\/]/).filter(Boolean).at(-1) || t('organization.projectUnavailable') : container.name || t('organization.untitled') });
  const all = new Map(snapshot.containers.map(container => [container.id, named(container)]));
  for (const container of page?.snapshot?.containers ?? []) all.set(container.id, named(container));
  const directory = { ...snapshot, containers: [...all.values()] };
  const allowed = (id: string) => !organizationContainerPath(directory, id).some(parent => excluded.includes(parent.id));
  const membership = page?.snapshot?.items ? new Set(page.snapshot.items.filter(item => item.kind === 'container').map(item => item.id)) : null;
  const choices = (page?.snapshot?.containers ?? []).filter(container => (!membership || membership.has(container.id)) && allowed(container.id) && (search.trim() || container.parentId === (value || null))).map(named);
  const path = organizationContainerPath(directory, value || null);
  const label = (id: string) => organizationContainerPath(directory, id).map(container => container.name).join(' / ');
  const go = (id: string) => { onChange(id); setSearch(''); };
  return <div>
    <div className="relative"><Icon name="search" className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" /><Input autoFocus type="search" className="h-9 pl-8 typography-meta" aria-label={t('organization.searchTargets')} placeholder={t('organization.searchTargets')} value={search} disabled={disabled} onChange={event => setSearch(event.target.value)} /></div>
    <nav aria-label={t('organization.targetPath')} className="organization-picker-path">
      <button type="button" disabled={disabled} onClick={() => go('')}>{t('organization.all')}</button>
      {path.map(container => <React.Fragment key={container.id}><Icon name="arrow-right-s" className="size-3 opacity-60" /><button type="button" disabled={disabled} title={label(container.id)} onClick={() => go(container.id)}>{container.name}</button></React.Fragment>)}
    </nav>
    <div className="h-52 overflow-y-auto py-1" aria-label={t('organization.browseTargets')}>
      {choices.map((container, index) => {
        const duplicate = choices.filter(other => other.name === container.name && other.parentId === container.parentId).length > 1;
        return <button key={container.id} type="button" disabled={disabled} data-organization-id={container.id} className="organization-picker-row" title={label(container.id)} aria-label={`${t('organization.enter')}: ${label(container.id)}${duplicate ? ` · ${index + 1}` : ''}`} onClick={() => go(container.id)}>
          <OrganizationContainerIcon container={container} project={projects.find(project => project.id === container.projectId)} />
          <span className="min-w-0 flex-1"><span className="block truncate">{container.name}{duplicate && <span className="ml-1.5 typography-micro text-muted-foreground">{index + 1}</span>}</span>{search.trim() && <span className="block truncate typography-micro text-muted-foreground">{organizationContainerPath(directory, container.parentId).map(parent => parent.name).join(' / ') || t('organization.all')}</span>}</span>
          <Icon name="arrow-right-s" className="size-4 text-muted-foreground/60" />
        </button>;
      })}
      {(!page || page.loading) && <p role="status" className="px-3 py-3 typography-meta text-muted-foreground">{t('organization.loading')}</p>}
      {page?.error && <p role="alert" className="px-3 py-2 typography-meta text-destructive">{page.error} <Button type="button" variant="ghost" size="sm" onClick={() => void refreshConversationOrganization()}>{t('common.retry')}</Button></p>}
      {page?.snapshot && !page.loading && !page.error && !choices.length && !page.snapshot.nextCursor && <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"><Icon name={search.trim() ? 'search' : 'folder-open'} className="size-6 opacity-50" /><span className="typography-meta">{t(search.trim() ? 'organization.noTargets' : 'organization.noSubgroups')}</span></div>}
      {page?.snapshot?.nextCursor && <Button type="button" variant="ghost" size="sm" disabled={disabled || page.loading} onClick={() => void loadOrganizationPage(query, true)}>{t('organization.loadMore')}</Button>}
    </div>
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-3 typography-meta"><span className="mr-auto text-muted-foreground">{t('organization.move')}</span><Icon name="folder" className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate" title={label(value)}>{path.map(container => container.name).join(' / ') || t('organization.root')}</span></div>
  </div>;
}

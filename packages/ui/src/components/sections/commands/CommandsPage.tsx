import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { useResourceManagementTarget } from '@/components/sections/resources/useResourceManagementTarget';
import { useResourceLibraryStore } from '@/stores/useResourceLibraryStore';

/** Slash invocations are native admitted skills, not a second command registry. */
export const CommandsPage = () => {
  const { t } = useI18n();
  const { resourceTarget, targetKey } = useResourceManagementTarget();
  const pane = useResourceLibraryStore(state => state.panes.skill);
  const load = useResourceLibraryStore(state => state.loadCatalog);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => { void load('skill', resourceTarget, targetKey); }, [load, resourceTarget, targetKey]);
  const resources = pane.targetKey === targetKey ? pane.catalog?.resources ?? [] : [];
  const commands = resources.filter(resource => resource.active && resource.valid && `${resource.name} ${resource.description}`.toLowerCase().includes(query.toLowerCase()));
  return <SettingsPageLayout title={t('settings.commands.sidebar.title')} description={t('settings.commands.native.description')}
    headerEnd={<Button variant="outline" onClick={() => void load('skill', resourceTarget, targetKey, true)} disabled={pane.loadingCatalog}><Icon name="refresh" className="size-4" />{t('settings.varin.recovery.actions.refresh')}</Button>}>
    <div className="space-y-5">
      <div className="grid gap-3 @xl:grid-cols-[220px_minmax(0,1fr)]"><SettingsProjectSelector /><Input aria-label={t('settings.commands.native.search')} placeholder={t('settings.commands.native.search')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <p className="typography-meta text-muted-foreground">{t('settings.commands.native.readOnly')}</p>
      {pane.error && <p role="alert" className="typography-meta text-destructive">{pane.error}</p>}
      {pane.loadingCatalog && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-background">
        <div className="border-b border-border/60 bg-muted/20 px-4 py-3 typography-micro text-muted-foreground">{t('settings.commands.sidebar.total', { count: commands.length })}</div>
        <ul className="divide-y divide-border/60">{commands.map(resource => <li key={resource.id} className="flex items-start gap-3 px-4 py-4"><Icon name="terminal" className="mt-1 size-5 shrink-0 text-muted-foreground" /><div className="min-w-0"><strong className="typography-ui-label">/skill:{resource.name}</strong><p className="mt-1 typography-meta text-muted-foreground">{resource.description}</p><p className="mt-2 break-all font-mono typography-micro text-muted-foreground">{resource.filePath}</p></div></li>)}</ul>
        {!pane.loadingCatalog && !pane.error && !commands.length && <p className="px-4 py-8 text-center typography-meta text-muted-foreground">{t('settings.commands.native.empty')}</p>}
      </div>
    </div>
  </SettingsPageLayout>;
};

import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { useResourceManagementTarget } from '@/components/sections/resources/useResourceManagementTarget';
import { useResourceLibraryStore } from '@/stores/useResourceLibraryStore';

/** Slash invocations are native admitted skills, not a second command registry. */
export const CommandsPage = () => {
  const { resourceTarget, targetKey } = useResourceManagementTarget();
  const pane = useResourceLibraryStore(state => state.panes.skill);
  const load = useResourceLibraryStore(state => state.loadCatalog);
  const [query, setQuery] = React.useState('');
  React.useEffect(() => { void load('skill', resourceTarget, targetKey); }, [load, resourceTarget, targetKey]);
  const resources = pane.targetKey === targetKey ? pane.catalog?.resources ?? [] : [];
  const commands = resources.filter(resource => resource.active && resource.valid && `${resource.name} ${resource.description}`.toLowerCase().includes(query.toLowerCase()));
  return <SettingsPageLayout title="Commands" description="Invoke a native skill with /skill:name. A conversation uses the skills admitted into its current context snapshot. Refresh that snapshot to use library changes."
    headerEnd={<Button onClick={() => void load('skill', resourceTarget, targetKey, true)} disabled={pane.loadingCatalog}>Refresh</Button>}>
    <div className="space-y-3"><SettingsProjectSelector /><Input aria-label="Search skill commands" placeholder="Search skill commands" value={query} onChange={event => setQuery(event.target.value)} />
      {pane.error && <p role="alert">{pane.error}</p>}
      {pane.loadingCatalog && <p role="status">Loading commands…</p>}
      {commands.map(resource => <div key={resource.id} className="rounded border p-3 text-sm"><strong>/skill:{resource.name}</strong><p>{resource.description}</p><p className="break-all text-xs text-muted-foreground">{resource.filePath}</p></div>)}
      {!pane.loadingCatalog && !pane.error && !commands.length && <p>No active skill commands in this library.</p>}
    </div>
  </SettingsPageLayout>;
};

import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { agentProfileLabels } from './agent-profile-presentation';
import { AgentProfileEditor } from './AgentProfileEditor';
import { PluginAgentDetails } from './PluginAgentDetails';
import { useAgentsPageCatalog } from './useAgentsPageCatalog';
import { useAgentProfiles } from './useAgentProfiles';
import { cancelAgentProfileCreation, removeAgentProfile, saveAgentProfile } from './agent-profiles-store';

export function AgentsPage() {
  const profiles = useAgentProfiles();
  return profiles.state.runtime === 'pi' && profiles.state.view === 'plugins'
    ? <PiPluginDetails />
    : <AgentProfilesDetails key={JSON.stringify([profiles.host, profiles.state.runtime])} {...profiles} />;
}
function PiPluginDetails() {
  const { selected, state, targetKey } = useAgentsPageCatalog();
  return <PluginAgentDetails key={`${targetKey}:${state.definitionRequest ?? selected?.id}`} agent={state.definitionRequest === 'create-agent' ? null : selected} />;
}
function AgentProfilesDetails({ api, host, state, snapshot, refresh }: ReturnType<typeof useAgentProfiles>) {
  const { t } = useI18n();
  const cwd = useDirectoryStore(value => value.currentDirectory);
  const [deleting, setDeleting] = React.useState<{ id: string; name: string; revision: string } | null>(null);
  const profile = state.creating ? undefined : snapshot?.profiles.find(entry => entry.id === state.selectedId);
  return <>
    <SettingsPageLayout title={profile ? agentProfileLabels(profile, t).name : t(state.creating ? 'settings.varin.agents.definition.createAgent' : 'settings.page.agents.title')}
      description={profile ? agentProfileLabels(profile, t).description : undefined} showSaveStatus
      titleAccessory={profile ? <span className="typography-micro text-muted-foreground">{t(profile.kind === 'builtin' ? 'settings.agents.builtin' : 'settings.agents.custom')}</span> : undefined}
      headerEnd={<div className="flex gap-2"><Button type="button" variant="ghost" size="sm" disabled={state.loading || state.saving} onClick={() => { void refresh(true); }}>{t('settings.varin.agents.actions.refresh')}</Button>
        {profile?.kind === 'custom' && snapshot && <Button variant="ghost" size="icon" disabled={state.saving} aria-label={t('settings.common.actions.delete')} onClick={() => setDeleting({ id: profile.id, name: profile.effective.name, revision: snapshot.revision })}><Icon name="delete-bin" className="size-4" /></Button>}</div>}>
      {!api && <p role="alert" className="mb-4 typography-meta text-destructive">{t('settings.agents.apiUnavailable')}</p>}
      {state.error && <p role="alert" className="mb-4 typography-meta text-destructive">{state.error}</p>}
      {api && snapshot && (profile || state.creating) ? <AgentProfileEditor key={profile?.id ?? 'new'} profile={profile} snapshot={snapshot} host={host} cwd={cwd} busy={state.saving}
        onCancel={state.creating ? cancelAgentProfileCreation : undefined} onSave={input => saveAgentProfile(api, input)} />
        : <p role="status" className="typography-meta text-muted-foreground">{state.loading ? t('common.loading') : t('settings.agents.page.empty.title')}</p>}
    </SettingsPageLayout>
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open && !state.saving) setDeleting(null); }}>
      <DialogContent><DialogTitle>{t('settings.common.actions.delete')}</DialogTitle><DialogDescription>{t('settings.agents.deleteShared', { name: deleting?.name ?? '' })}</DialogDescription>
        {state.error && <p role="alert" className="typography-meta text-destructive">{state.error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={state.saving} onClick={() => setDeleting(null)}>{t('settings.common.actions.cancel')}</Button>
          <Button type="button" variant="destructive" disabled={state.saving || !api} onClick={() => { if (api && deleting) void removeAgentProfile(api, deleting.id, deleting.revision).then(saved => { if (saved) setDeleting(null); }); }}>{t('settings.common.actions.delete')}</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}

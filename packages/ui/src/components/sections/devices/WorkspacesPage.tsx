import React from 'react';
import { getRuntimeEndpointGeneration, projectFolders, projectResourceOwnerKey, subscribeRuntimeEndpointChanged, type ProjectEntry, type ThreadSourceTargets } from '@varin/application-client';
import { Btn, Dot, Empty, LinkRow, Loading, Note, Page, Section, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsScopeLabel } from '@/components/sections/shared/SettingsScope';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useServiceIdentity } from '@/lib/settings/service-identity';
import { useUIStore } from '@/stores/useUIStore';
import { requestSettingsNavigation } from '@/lib/settings/drafts';

export function WorkspacesPage() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ServiceWorkspaces key={generation} />;
}

function ServiceWorkspaces() {
  const { t } = useI18n();
  const service = useServiceIdentity();
  const shell = useSettingsShell();
  const { settings, threads } = useRuntimeAPIs();
  const [projects, setProjects] = React.useState<ProjectEntry[]>();
  const [targets, setTargets] = React.useState<ThreadSourceTargets>();
  const [errors, setErrors] = React.useState<{ projects?: string; devices?: string }>({});
  const [revision, refresh] = React.useReducer(value => value + 1, 0);

  React.useEffect(() => {
    const abort = new AbortController();
    const error = (key: 'projects' | 'devices', cause: unknown) => {
      if (!abort.signal.aborted) setErrors(previous => ({ ...previous, [key]: cause instanceof Error ? cause.message : String(cause) }));
    };
    setErrors({});
    if (settings) void settings.load().then(({ settings }) => {
      if (!abort.signal.aborted) setProjects(settings.projects ?? []);
    }, cause => error('projects', cause));
    if (threads) void threads.sources.list(null, abort.signal).then(result => {
      if (!abort.signal.aborted) setTargets(result);
    }, cause => error('devices', cause));
    return () => abort.abort();
  }, [settings, threads, revision]);

  const groups = new Map<string, { name: string; status?: string; locations: ProjectEntry[] }>();
  const local = projectResourceOwnerKey({});
  groups.set(local, { name: service?.name ?? t('settings.shell.connectedService'), locations: [] });
  for (const target of targets?.targets ?? []) {
    if (target.resourceOwner.kind === 'local') continue;
    groups.set(projectResourceOwnerKey({ source: { resourceOwner: target.resourceOwner, workspaceId: '' } }), { name: target.label, locations: [] });
  }
  for (const project of projects ?? []) {
    const key = projectResourceOwnerKey(project);
    const owner = project.source?.resourceOwner;
    if (!groups.has(key)) {
      const unavailable = targets?.unavailable.find(target => owner?.kind === 'managed_host' && target.connectionId === owner.connectionId);
      groups.set(key, { name: unavailable?.label ?? t('settings.workspaces.unavailableDevice'), status: unavailable?.message, locations: [] });
    }
    groups.get(key)!.locations.push(project);
  }
  const openProject = (id: string) => requestSettingsNavigation(() => {
    useUIStore.getState().setSettingsProjectsSelectedId(id);
    shell.setCatalogStage('detail');
    useUIStore.getState().setSettingsPage('projects');
  });
  return <Page title={t('settings.page.workspaces.title')} description={t('settings.workspaces.description')}
    scope={<SettingsScopeLabel kind="host" />} saved={false}
    actions={<Btn kind="ghost" icon="refresh" onClick={refresh}>{t('settings.common.actions.refresh')}</Btn>}>
    {errors.projects ? <Note kind="err">{errors.projects}</Note> : settings && !projects ? <Loading /> : null}
    {errors.devices ? <Note kind="warn">{errors.devices}</Note> : null}
    {[...groups].map(([id, group]) => <Section key={id} title={group.name} description={group.status}
      titleAccessory={group.status ? <Dot state="warn" /> : undefined}>
      {group.locations.map(project => <LinkRow key={project.id} lead="folder" label={project.label || project.path}
        description={<span className="break-all font-mono">{projectFolders(project).join(' · ')}</span>} onClick={() => openProject(project.id)} />)}
      {projects && !group.locations.length ? <Empty icon="folder" title={t('settings.workspaces.noProjects')} /> : null}
    </Section>)}
    <Section>
      <LinkRow lead="folders" label={t('settings.page.projects.title')} onClick={() => shell.openPage('projects')} />
      <LinkRow lead="computer" label={t('settings.page.devices.title')} onClick={() => shell.openPage('devices')} />
    </Section>
  </Page>;
}

import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { createResourceManagementHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type NativeResourceDescriptor } from '@varin/application-client';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getProjectDraftStarters, saveProjectDraftStarters } from '@/lib/project-config';
import { updateDesktopSettings } from '@/lib/persistence';
import { BUILTIN_STARTERS, DEFAULT_GLOBAL_STARTERS, getBuiltInStarter, normalizeStarterLabel, sameStarter, starterKey, type DraftStarterRef, type DraftStarterType } from '@/lib/draftStarters';
import { toast } from '@/components/ui';

type StarterGroup = 'global' | 'project';
export type ResolvedStarter = { id: string; ref: DraftStarterRef; group: StarterGroup; label: string; icon: IconName; submitText: string };
export type PinnableSection = 'built-in' | 'command' | 'skill';
export type PinnableItem = { type: DraftStarterType; name: string; label: string; icon: IconName; section: PinnableSection; scope: 'user' | 'project' };
const chipId = (group: StarterGroup, ref: DraftStarterRef) => `${group}:${starterKey(ref)}`;

export function useDraftStarters({ cwd }: { cwd?: string | null; sessionId?: string | null } = {}) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const globalRaw = useUIStore(state => state.globalDraftStarters);
  const projects = useProjectsStore(state => state.projects);
  const project = React.useMemo(() => projects.find(project => project.path === cwd), [projects, cwd]);
  const [projectRefs, setProjectRefs] = React.useState<DraftStarterRef[]>([]);
  const [skills, setSkills] = React.useState<NativeResourceDescriptor[]>([]);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setProjectRefs([]); setSkills([]);
    if (project) void getProjectDraftStarters(project).then(refs => { if (!controller.signal.aborted) setProjectRefs(refs); }).catch(error => { if (!controller.signal.aborted) toast.error(String(error)); });
    void createResourceManagementHttpAPI(host).list(project ? { projectId: project.id } : {}, controller.signal).then(catalog => {
      if (!controller.signal.aborted) setSkills(catalog.resources.filter(resource => resource.active && resource.valid));
    }).catch(() => { /* Built-in starters remain available when the optional skill directory cannot be read. */ });
    return () => controller.abort();
  }, [host, project, reload]);
  const globalRefs = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
  const resolve = (refs: readonly DraftStarterRef[], group: StarterGroup): ResolvedStarter[] => refs.flatMap(ref => {
    const builtin = ref.type === 'command' ? getBuiltInStarter(ref.name) : undefined;
    if (builtin) return [{ id: chipId(group, ref), ref, group, label: t(builtin.labelKey), icon: builtin.icon, submitText: t(builtin.labelKey) }];
    const skill = ref.type === 'skill' ? skills.find(skill => skill.name === ref.name) : undefined;
    return skill ? [{ id: chipId(group, ref), ref, group, label: normalizeStarterLabel(skill.name), icon: 'book-open' as const, submitText: `/skill:${skill.name}` }] : [];
  });
  const pinned = new Set([...globalRefs, ...projectRefs].map(starterKey));
  const pinnable: PinnableItem[] = [
    ...BUILTIN_STARTERS.map(starter => ({ type: 'command' as const, name: starter.name, label: t(starter.labelKey), icon: starter.icon, section: 'built-in' as const, scope: 'user' as const })),
    ...skills.map(skill => ({ type: 'skill' as const, name: skill.name, label: normalizeStarterLabel(skill.name), icon: 'book-open' as const, section: 'skill' as const, scope: skill.sourceInfo.scope })),
  ].filter(item => !pinned.has(starterKey(item)));
  const save = (group: StarterGroup, next: DraftStarterRef[]) => {
    if (group === 'global') {
      useUIStore.getState().setGlobalDraftStarters(next);
      void updateDesktopSettings({ draftStarters: next });
    } else if (project) {
      setProjectRefs(next);
      void saveProjectDraftStarters(project, next).catch(error => toast.error(String(error)));
    }
  };
  return {
    global: resolve(globalRefs, 'global'), project: resolve(projectRefs, 'project'), pinnable, hasProject: Boolean(project),
    ensureLoaded: () => setReload(value => value + 1),
    addStarter: (item: PinnableItem) => {
      const group = item.scope === 'project' ? 'project' : 'global';
      const refs = group === 'global' ? globalRefs : projectRefs;
      const ref = { type: item.type, name: item.name };
      if (!refs.some(current => sameStarter(current, ref))) save(group, [...refs, ref]);
    },
    removeStarter: (group: StarterGroup, ref: DraftStarterRef) => save(group, (group === 'global' ? globalRefs : projectRefs).filter(current => !sameStarter(current, ref))),
    reorder: (group: StarterGroup, fromId: string, toId: string) => {
      const refs = group === 'global' ? globalRefs : projectRefs;
      const from = refs.findIndex(ref => chipId(group, ref) === fromId), to = refs.findIndex(ref => chipId(group, ref) === toId);
      if (from >= 0 && to >= 0 && from !== to) save(group, arrayMove([...refs], from, to));
    },
  };
}

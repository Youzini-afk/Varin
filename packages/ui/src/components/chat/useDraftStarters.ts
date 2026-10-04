import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import type { RuntimeContextTarget } from '@varin/protocol';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getProjectDraftStarters, saveProjectDraftStarters } from '@/lib/project-config';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { listPiResources } from '@/lib/pi-runtime/resources';
import { getRuntimeKey } from '@varin/application-client';
import type { IconName } from '@/components/icon/icons';
import {
    BUILTIN_STARTERS,
    DEFAULT_GLOBAL_STARTERS,
    COMMAND_FALLBACK_ICON,
    SKILL_FALLBACK_ICON,
    getBuiltInStarter,
    normalizeStarterLabel,
    sameStarter,
    starterKey,
    type DraftStarterRef,
    type DraftStarterType,
} from '@/lib/draftStarters';
import {
    buildPiDraftStarterCatalog,
    type PiDraftStarterCatalogItem,
} from './piDraftStarterCatalog';

type StarterGroup = 'global' | 'project';

export type ResolvedStarter = {
    id: string;
    ref: DraftStarterRef;
    group: StarterGroup;
    label: string;
    icon: IconName;
    submitText: string;
};

export type PinnableSection = 'built-in' | 'command' | 'skill';

export type PinnableItem = {
    type: DraftStarterType;
    name: string;
    label: string;
    icon: IconName;
    section: PinnableSection;
    scope: 'user' | 'project';
};

const chipId = (group: StarterGroup, ref: DraftStarterRef): string => `${group}:${starterKey(ref)}`;

export type UseDraftStartersResult = {
    global: ResolvedStarter[];
    project: ResolvedStarter[];
    pinnable: PinnableItem[];
    hasProject: boolean;
    ensureLoaded: () => void;
    addStarter: (item: PinnableItem) => void;
    removeStarter: (group: StarterGroup, ref: DraftStarterRef) => void;
    reorder: (group: StarterGroup, fromId: string, toId: string) => void;
};

export interface UseDraftStartersOptions {
    cwd?: string | null;
    sessionId?: string | null;
}

const BUILTIN_INVOCATIONS = new Set(BUILTIN_STARTERS.map((starter) => starter.command));

export function useDraftStarters(options: UseDraftStartersOptions = {}): UseDraftStartersResult {
    const { t } = useI18n();
    const globalRaw = useUIStore((s) => s.globalDraftStarters);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const projects = useProjectsStore((s) => s.projects);
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
    const currentSessionCwd = usePiSessionStore((state) => {
        const sessionId = state.currentSessionId;
        if (!sessionId) return null;
        return state.records[sessionId]?.snapshot?.cwd
            ?? state.summaries.find((summary) => summary.id === sessionId)?.cwd
            ?? null;
    });
    const targetSessionId = options.sessionId !== undefined ? options.sessionId : currentSessionId;
    const targetCwd = options.cwd?.trim() || currentSessionCwd || currentDirectory || null;
    const runtimeTarget = React.useMemo<RuntimeContextTarget | null>(() => (
        targetSessionId ? { sessionId: targetSessionId } : targetCwd ? { cwd: targetCwd } : null
    ), [targetCwd, targetSessionId]);
    const runtimeTargetKey = JSON.stringify([
        getRuntimeKey(),
        targetSessionId ? 'session' : 'cwd',
        targetSessionId ?? targetCwd,
    ]);
    const runtimeTargetKeyRef = React.useRef(runtimeTargetKey);
    runtimeTargetKeyRef.current = runtimeTargetKey;
    const loadGenerationRef = React.useRef(0);
    const [catalogItems, setCatalogItems] = React.useState<PiDraftStarterCatalogItem[]>([]);

    const projectRef = React.useMemo(() => {
        const normalizedTarget = targetCwd?.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
        const found = normalizedTarget
            ? projects.find((project) => (
                project.path.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase() === normalizedTarget
            ))
            : projects.find((project) => project.id === activeProjectId);
        if (!found?.path) return null;
        return { id: found.id, path: found.path };
    }, [activeProjectId, projects, targetCwd]);

    const [projectStarters, setProjectStarters] = React.useState<DraftStarterRef[]>([]);

    React.useEffect(() => {
        let cancelled = false;
        if (!projectRef) {
            setProjectStarters([]);
            return;
        }
        getProjectDraftStarters(projectRef)
            .then((refs) => { if (!cancelled) setProjectStarters(refs); })
            .catch(() => { if (!cancelled) setProjectStarters([]); });
        return () => { cancelled = true; };
        // Keyed on project id to avoid reloading when the memoized ref object
        // changes identity but still points at the same project.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectRef?.id]);

    const ensureLoaded = React.useCallback(() => {
        if (!runtimeTarget) {
            setCatalogItems([]);
            return;
        }
        const generation = ++loadGenerationRef.current;
        const requestKey = runtimeTargetKey;
        const requestRuntimeKey = getRuntimeKey();
        void Promise.all([
            listPiCommands(runtimeTarget),
            listPiResources(runtimeTarget, 'skill'),
        ]).then(([commands, skills]) => {
            if (
                loadGenerationRef.current !== generation
                || runtimeTargetKeyRef.current !== requestKey
                || getRuntimeKey() !== requestRuntimeKey
            ) return;
            setCatalogItems(buildPiDraftStarterCatalog(commands, skills));
        }).catch((error) => {
            console.warn('[DraftStarters] Failed to load Pi commands and skills:', error);
            if (
                loadGenerationRef.current === generation
                && runtimeTargetKeyRef.current === requestKey
            ) setCatalogItems([]);
        });
    }, [runtimeTarget, runtimeTargetKey]);

    React.useEffect(() => {
        setCatalogItems([]);
        ensureLoaded();
    }, [ensureLoaded]);

    const catalogByRef = React.useMemo(() => {
        const result = new Map<string, PiDraftStarterCatalogItem>();
        for (const item of catalogItems) result.set(`${item.type}:${item.name}`, item);
        return result;
    }, [catalogItems]);

    const resolve = React.useCallback((ref: DraftStarterRef, group: StarterGroup): ResolvedStarter | null => {
        if (ref.type === 'command') {
            const builtin = getBuiltInStarter(ref.name);
            if (builtin) {
                return { id: chipId(group, ref), ref, group, label: t(builtin.labelKey), icon: builtin.icon, submitText: builtin.command };
            }
            const item = catalogByRef.get(`command:${ref.name}`);
            if (!item) return null;
            return { id: chipId(group, ref), ref, group, label: normalizeStarterLabel(ref.name), icon: COMMAND_FALLBACK_ICON, submitText: item.invocation };
        }
        const normalizedName = ref.name.startsWith('skill:') ? ref.name.slice('skill:'.length) : ref.name;
        const item = catalogByRef.get(`skill:${normalizedName}`);
        if (!item) return null;
        return { id: chipId(group, ref), ref, group, label: normalizeStarterLabel(normalizedName), icon: SKILL_FALLBACK_ICON, submitText: item.invocation };
    }, [catalogByRef, t]);

    const globalRefs = React.useMemo<readonly DraftStarterRef[]>(
        () => globalRaw ?? DEFAULT_GLOBAL_STARTERS,
        [globalRaw],
    );

    const global = React.useMemo(
        () => globalRefs.map((r) => resolve(r, 'global')).filter((x): x is ResolvedStarter => x !== null),
        [globalRefs, resolve],
    );
    const project = React.useMemo(
        () => projectStarters.map((r) => resolve(r, 'project')).filter((x): x is ResolvedStarter => x !== null),
        [projectStarters, resolve],
    );

    const pinnedKeys = React.useMemo(() => {
        const set = new Set<string>();
        for (const r of globalRefs) set.add(starterKey(r));
        for (const r of projectStarters) set.add(starterKey(r));
        return set;
    }, [globalRefs, projectStarters]);

    const pinnable = React.useMemo<PinnableItem[]>(() => {
        const items: PinnableItem[] = [];
        for (const b of BUILTIN_STARTERS) {
            items.push({ type: 'command', name: b.name, label: t(b.labelKey), icon: b.icon, section: 'built-in', scope: 'user' });
        }
        for (const item of catalogItems) {
            if (item.type === 'command') {
                if (getBuiltInStarter(item.name) || BUILTIN_INVOCATIONS.has(item.invocation)) continue;
                items.push({ type: 'command', name: item.name, label: normalizeStarterLabel(item.name), icon: COMMAND_FALLBACK_ICON, section: 'command', scope: item.scope });
            } else {
                items.push({ type: 'skill', name: item.name, label: normalizeStarterLabel(item.name), icon: SKILL_FALLBACK_ICON, section: 'skill', scope: item.scope });
            }
        }
        // Only offer items that are not already pinned (removed built-ins reappear here).
        return items.filter((item) => !pinnedKeys.has(`${item.type}:${item.name}`));
    }, [catalogItems, pinnedKeys, t]);

    const persistGlobal = React.useCallback((next: DraftStarterRef[]) => {
        useUIStore.getState().setGlobalDraftStarters(next);
        void updateDesktopSettings({ draftStarters: next });
    }, []);

    const persistProject = React.useCallback((next: DraftStarterRef[]) => {
        setProjectStarters(next);
        if (projectRef) void saveProjectDraftStarters(projectRef, next);
    }, [projectRef]);

    const addStarter = React.useCallback((item: PinnableItem) => {
        const ref: DraftStarterRef = { type: item.type, name: item.name };
        if (item.scope === 'project') {
            if (!projectRef || projectStarters.some((r) => sameStarter(r, ref))) return;
            persistProject([...projectStarters, ref]);
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            if (base.some((r) => sameStarter(r, ref))) return;
            persistGlobal([...base, ref]);
        }
    }, [projectRef, projectStarters, globalRaw, persistProject, persistGlobal]);

    const removeStarter = React.useCallback((group: StarterGroup, ref: DraftStarterRef) => {
        if (group === 'project') {
            persistProject(projectStarters.filter((r) => !sameStarter(r, ref)));
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            persistGlobal(base.filter((r) => !sameStarter(r, ref)));
        }
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    const reorder = React.useCallback((group: StarterGroup, fromId: string, toId: string) => {
        const base = group === 'project' ? projectStarters : (globalRaw ?? DEFAULT_GLOBAL_STARTERS);
        const from = base.findIndex((r) => chipId(group, r) === fromId);
        const to = base.findIndex((r) => chipId(group, r) === toId);
        if (from < 0 || to < 0 || from === to) return;
        const next = arrayMove([...base], from, to);
        if (group === 'project') persistProject(next); else persistGlobal(next);
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    return { global, project, pinnable, hasProject: !!projectRef, ensureLoaded, addStarter, removeStarter, reorder };
}

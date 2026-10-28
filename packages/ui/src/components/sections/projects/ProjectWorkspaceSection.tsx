import React from 'react';
import { RiArrowRightUpLine, RiLoader4Line } from '@remixicon/react';
import type { ProjectEntry } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { SettingsSection } from '../shared/SettingsSection';
import { projectWorkspaceRequest, inspectWorkspaceBackend, openWorkspaceBackendSettings, type ProjectWorkspaceStatus, type WorkspaceBackendStatus } from '@/lib/nativeWorkspace';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useI18n } from '@/lib/i18n';
export function ProjectWorkspaceSection({ project }: {
    project: ProjectEntry;
}) {
    const { t } = useI18n();
    const [status, setStatus] = React.useState<ProjectWorkspaceStatus | null>(null);
    const [backend, setBackend] = React.useState<WorkspaceBackendStatus | null>(null);
    const [checkingBackend, setCheckingBackend] = React.useState(false);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const pending = React.useRef<AbortController | null>(null);
    const refreshBackend = React.useCallback(async (signal?: AbortSignal) => {
        setCheckingBackend(true);
        try { const next = await inspectWorkspaceBackend(project.id, signal); if (!signal?.aborted) setBackend(next); }
        catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { if (!signal?.aborted) setCheckingBackend(false); }
    }, [project.id]);
    React.useEffect(() => {
        const controller = new AbortController(); setBackend(null); void refreshBackend(controller.signal);
        return () => controller.abort();
    }, [refreshBackend]);
    React.useEffect(() => {
        const controller = new AbortController();
        setStatus(null);
        setError(null);
        if (project.versionedWorkspace)
            void projectWorkspaceRequest(project.id, 'inspect', controller.signal).then(setStatus).catch(reason => { if (!controller.signal.aborted)
                setError(String(reason.message ?? reason)); });
        return () => controller.abort();
    }, [project.id, project.versionedWorkspace?.state]);
    React.useEffect(() => () => pending.current?.abort(), []);
    React.useEffect(() => {
        if (!busy && !status?.preparing)
            return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const value = await projectWorkspaceRequest(project.id, 'inspect', controller.signal);
                if (!controller.signal.aborted)
                    setStatus(value);
            }
            catch { /* The original action owns its error; progress is observational. */ }
            finally {
                if (!controller.signal.aborted)
                    timer = setTimeout(() => void refresh(), 1000);
            }
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [busy, status?.preparing, project.id]);
    const apply = async (action: 'enable' | 'disable') => {
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError(null);
        try {
            const next = await projectWorkspaceRequest(project.id, action, controller.signal);
            setStatus(next);
            const store = useProjectsStore.getState();
            const projects = store.projects.map(entry => entry.id === project.id ? { ...entry, ...(next.workspace ? { versionedWorkspace: next.workspace } : {}) } : entry);
            useProjectsStore.setState({ projects });
            if (store.activeProjectId === project.id)
                useDirectoryStore.getState().setDirectory(next.executionPath ?? project.path, { showOverlay: false });
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            pending.current = null;
            setBusy(false);
        }
    };
    const enabled = (status?.workspace ?? project.versionedWorkspace)?.state === 'ready';
    return <SettingsSection title={t('settings.projects.workspace.title')} description={t('settings.projects.workspace.description')}>
    <div className="space-y-3">
      <p className="typography-meta max-w-2xl text-muted-foreground">{t('settings.projects.workspace.explanation')}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta">
        <span className="text-muted-foreground">{t('settings.projects.workspace.backend')}</span>
        {backend && <span>{backend.backend} · {backend.platform} {backend.architecture}{backend.hostId ? ` · ${backend.hostId}` : ''}
          {' · '}{t(backend.dependenciesReady ? 'settings.projects.workspace.backendReady' : 'settings.projects.workspace.backendUnavailable')}</span>}
        <Button size="sm" variant="ghost" disabled={checkingBackend} onClick={() => void refreshBackend()}>
          {checkingBackend && <RiLoader4Line className="mr-1 size-3 animate-spin"/>}{t('settings.projects.workspace.refreshBackend')}
        </Button>
        {backend?.helpUrl && <a href={backend.helpUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t('settings.projects.workspace.backendHelp')}</a>}
        {backend?.canOpenSettings && !backend.builtInExtension?.ready && <Button size="sm" variant="ghost" onClick={() => {
            void openWorkspaceBackendSettings(project.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
        }}>{t('settings.projects.workspace.extensionSettings')}</Button>}
      </div>
      {backend && !backend.dependenciesReady && backend.detail && <p className="typography-meta break-words text-muted-foreground">{backend.detail}</p>}
      <dl className="min-w-0 space-y-2 typography-meta">
        <div className="flex flex-wrap gap-x-3"><dt className="text-muted-foreground">{t('settings.projects.workspace.original')}</dt><dd className="break-all">{project.path}</dd></div>
        {status?.executionPath && <div className="flex flex-wrap gap-x-3"><dt className="text-muted-foreground">{t('settings.projects.workspace.current')}</dt><dd className="break-all text-foreground">{status.executionPath}</dd></div>}
      </dl>
      {error && <p role="alert" className="typography-meta text-destructive break-words">{error}</p>}
      {status?.progress && <p role="status" className="typography-meta text-muted-foreground tabular-nums">
        {t(status.progress.phase === 'capture' ? 'settings.projects.workspace.capture' : status.progress.phase === 'verify' ? 'settings.projects.workspace.verify' : 'settings.projects.workspace.inventory')}
        {' · '}{status.progress.entries.toLocaleString()}{' · '}{(status.progress.bytes / 1048576).toFixed(1)} MiB
      </p>}
      {!status?.progress && (busy || status?.preparing) && <p role="status" className="typography-meta text-muted-foreground">{t('settings.projects.workspace.preparing')}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy || status?.preparing} onClick={() => void apply(enabled ? 'disable' : 'enable')}>
          {busy || status?.preparing ? <RiLoader4Line className="mr-2 h-4 w-4 animate-spin"/> : <RiArrowRightUpLine className="mr-2 h-4 w-4"/>}
          {t(busy || status?.preparing ? 'settings.projects.workspace.preparing' : enabled ? 'settings.projects.workspace.disable' : project.versionedWorkspace?.state === 'preparing' ? 'settings.projects.workspace.resume' : 'settings.projects.workspace.enable')}
        </Button>
        {busy && <Button variant="ghost" size="sm" onClick={() => pending.current?.abort()}>{t('settings.common.actions.cancel')}</Button>}
      </div>
      {status?.leases ? <p className="typography-meta text-muted-foreground">{t('settings.projects.workspace.inUse')}</p> : null}
    </div>
  </SettingsSection>;
}

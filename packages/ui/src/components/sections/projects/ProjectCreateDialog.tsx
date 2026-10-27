import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, projectPathKey, type ProjectEntry } from '@varin/application-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ProjectFoldersEditor } from './ProjectFoldersEditor';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { changeProjectTrust, readProjectTrust, type ProjectTrust } from '@/lib/projectTrust';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { useI18n } from '@/lib/i18n';

type Review = { name: string; folders: string[]; roots: ProjectTrust[]; host: number };
export function ProjectCreateDialog({ open, onOpenChange, initialPath }: {
  open: boolean; onOpenChange: (open: boolean) => void; initialPath?: string | null;
}) {
  const { t } = useI18n();
  const addProject = useProjectsStore(state => state.addProject);
  const { documents } = useRuntimeAPIs();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [name, setName] = React.useState('');
  const [folders, setFolders] = React.useState<string[]>([]);
  const [review, setReview] = React.useState<Review | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const operation = React.useRef<AbortController | null>(null);
  const created = React.useRef<ProjectEntry | null>(null);
  const owner = React.useRef({ open, host }); owner.current = { open, host };
  React.useEffect(() => {
    operation.current?.abort(); operation.current = null; created.current = null;
    setName(''); setFolders([]); setReview(null); setError(null); setBusy(false);
    return () => { operation.current?.abort(); operation.current = null; };
  }, [open, host]);
  const current = (controller: AbortController) => operation.current === controller && !controller.signal.aborted
    && owner.current.open && owner.current.host === host && host === getRuntimeEndpointGeneration();
  const run = async (action: (controller: AbortController) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(null);
    try { await action(controller); }
    catch (failure) { if (current(controller)) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (operation.current === controller) { operation.current = null; setBusy(false); } }
  };
  const finish = async (input: Pick<Review, 'name' | 'folders'>, controller: AbortController) => {
    if (!current(controller)) return;
    // A failed navigation can retry opening the accepted project without creating another entry.
    const project = created.current ?? await addProject(input.folders[0]!, { label: input.name, additionalPaths: input.folders.slice(1) });
    if (!current(controller)) return;
    if (!project) throw new Error(t('directoryExplorerDialog.toast.failedToAddProject'));
    created.current = project;
    await startThreadFromNavigation({ directory: await projectExecutionPath(project) });
    if (current(controller)) onOpenChange(false);
  };
  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !folders.length) return;
    void run(async controller => {
      const input = { name: name.trim(), folders: [...folders] };
      if (created.current) { await finish(input, controller); return; }
      const roots: ProjectTrust[] = [];
      for (const path of input.folders) {
        const workspace = await documents.resolveWorkspace({ path });
        if (!current(controller)) return;
        const snapshot = await readProjectTrust(workspace.workspaceId, controller.signal);
        if (!current(controller)) return;
        if (!roots.some(root => projectPathKey(root.path) === projectPathKey(snapshot.path))) roots.push(snapshot);
      }
      if (roots.some(root => root.decision !== true)) setReview({ ...input, roots, host });
      else await finish(input, controller);
    });
  };
  const accept = (trust: boolean) => {
    if (!review || review.host !== host) return;
    void run(async controller => {
      if (created.current) { await finish(review, controller); return; }
      for (const reviewed of review.roots) {
        if (!current(controller)) return;
        // Each grant advances the same trust document revision. Re-read before the next grant,
        // while requiring the exact canonical directory that was displayed in this review.
        const latest = await readProjectTrust(reviewed.workspaceId, controller.signal);
        if (!current(controller)) return;
        if (latest.path !== reviewed.path) throw new Error(t('projects.create.trustChanged'));
        setReview(previous => previous ? { ...previous, roots: previous.roots.map(root => root.workspaceId === latest.workspaceId ? latest : root) } : null);
        if (trust && latest.decision !== true) {
          await changeProjectTrust(latest, true, {
            confirm: async () => true, // This review's explicit Trust and create button is the confirmation.
            isCurrent: () => current(controller), signal: controller.signal,
          });
          if (!current(controller)) return;
          const confirmed = await readProjectTrust(reviewed.workspaceId, controller.signal);
          if (confirmed.path !== reviewed.path || confirmed.decision !== true) throw new Error(t('projects.create.trustChanged'));
          if (current(controller)) setReview(previous => previous ? { ...previous, roots: previous.roots.map(root => root.workspaceId === confirmed.workspaceId ? confirmed : root) } : null);
        }
      }
      await finish(review, controller);
    });
  };
  return <Dialog open={open} onOpenChange={value => { if (!operation.current) onOpenChange(value); }}>
    <DialogContent aria-busy={busy} className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t(review ? 'projects.create.trustTitle' : 'projects.create.title')}</DialogTitle>
        <DialogDescription>{t(review ? 'settings.projectTrust.description' : 'projects.folders.hint')}</DialogDescription>
      </DialogHeader>
      {review ? <div className="space-y-5">
        <p className="typography-ui-label">{review.name}</p>
        <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
          {review.roots.map(root => <li key={root.workspaceId} className="flex items-start gap-3 px-3 py-3">
            <Icon name="folder" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="break-all typography-meta">{root.path}</p>
              <p className="mt-1 typography-micro text-muted-foreground">{t(root.decision === true ? 'settings.projectTrust.trusted' : 'settings.projectTrust.untrusted')}</p>
            </div>
          </li>)}
        </ul>
        <p className="typography-meta text-muted-foreground">{t('projects.create.trustLater')}</p>
        {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { if (created.current) onOpenChange(false); else { setReview(null); setError(null); } }}>{t(created.current ? 'settings.common.actions.cancel' : 'projects.create.back')}</Button>
          {!created.current ? <Button type="button" variant="outline" disabled={busy} onClick={() => accept(false)}>{t(review.roots.some(root => root.decision === true) ? 'projects.create.keepTrust' : 'projects.create.withoutTrust')}</Button> : null}
          <Button type="button" disabled={busy} onClick={() => accept(true)}>{busy && <Icon name="loader-4" className="size-4 animate-spin" />}{t(created.current ? 'projects.create.openCreated' : 'projects.create.trustAndCreate')}</Button>
        </DialogFooter>
      </div> : <form onSubmit={create} className="space-y-5">
        <label className="block space-y-2 typography-ui-label">
          <span>{t('projects.create.name')}</span>
          <Input autoFocus aria-label={t('projects.create.name')} value={name} onChange={event => setName(event.target.value)} disabled={busy || !!created.current}
            placeholder={t('settings.projects.page.field.projectNamePlaceholder')} />
        </label>
        <div className="space-y-2">
          <p className="typography-ui-label">{t('projects.folders.title')}</p>
          <ProjectFoldersEditor folders={folders} initialPath={initialPath} disabled={busy || !!created.current} onChange={next => {
            setFolders(next);
            if (!name.trim() && next[0]) setName(next[0].replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '');
          }} />
        </div>
        {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{t('settings.common.actions.cancel')}</Button>
          {error && !created.current ? <Button type="button" variant="outline" disabled={busy || !name.trim() || !folders.length}
            onClick={() => { void run(controller => finish({ name: name.trim(), folders: [...folders] }, controller)); }}>{t('projects.create.unchangedTrust')}</Button> : null}
          <Button type="submit" disabled={busy || !name.trim() || folders.length === 0}>{busy && <Icon name="loader-4" className="size-4 animate-spin" />}{t(created.current ? 'projects.create.openCreated' : 'projects.create.action')}</Button>
        </DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>;
}
import { projectExecutionPath } from '@/lib/nativeWorkspace';

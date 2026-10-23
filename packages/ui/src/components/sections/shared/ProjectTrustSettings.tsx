import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useI18n } from '@/lib/i18n';
import { changeProjectTrust, getProjectTrustGeneration, readProjectTrust, subscribeProjectTrustChanges, type ProjectTrust } from '@/lib/projectTrust';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Review = { snapshot: ProjectTrust; decision: boolean; settle(accepted: boolean): void };

/** The displayed canonical root is also the Host's revision-checked mutation target. */
export function ProjectTrustSettings({ directory: selectedDirectory, label, showDescription = true }: {
  directory?: string | null; label?: string; showDescription?: boolean;
}) {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore(state => state.currentDirectory);
  const directory = selectedDirectory === undefined ? currentDirectory : selectedDirectory;
  const documents = useRuntimeAPIs().documents;
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trustVersion = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const [reload, setReload] = React.useState(0);
  const [snapshot, setSnapshot] = React.useState<ProjectTrust | null>(null);
  const [readError, setReadError] = React.useState('');
  const [saveError, setSaveError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [review, setReview] = React.useState<Review | null>(null);
  const pending = React.useRef<Review | null>(null);
  const saving = React.useRef(false);
  const sequence = React.useRef(0);
  const key = JSON.stringify([host, directory]);
  const owner = React.useRef(key); owner.current = key;
  const finishReview = React.useCallback((accepted: boolean) => {
    const previous = pending.current; pending.current = null; setReview(null); previous?.settle(accepted);
  }, []);

  React.useEffect(() => {
    setSaveError(''); setBusy(false); saving.current = false;
  }, [key]);
  React.useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    finishReview(false); setSnapshot(null); setReadError('');
    if (directory) void documents.resolveWorkspace({ path: directory }).then(async workspace => {
      if (controller.signal.aborted || request !== sequence.current || owner.current !== key) return;
      const value = await readProjectTrust(workspace.workspaceId, controller.signal);
      if (!controller.signal.aborted && request === sequence.current && owner.current === key) setSnapshot(value);
    }).catch(error => {
      if (!controller.signal.aborted && request === sequence.current && owner.current === key) setReadError(error instanceof Error ? error.message : String(error));
    });
    return () => { controller.abort(); sequence.current += 1; pending.current?.settle(false); pending.current = null; };
  }, [directory, documents, finishReview, host, key, reload, trustVersion]);

  const change = async (decision: boolean) => {
    if (!snapshot || saving.current) return;
    const request = sequence.current;
    saving.current = true; setBusy(true); setSaveError('');
    try {
      await changeProjectTrust(snapshot, decision, {
        isCurrent: () => owner.current === key && request === sequence.current,
        confirm: () => new Promise(resolve => {
          const next = { snapshot, decision, settle: resolve };
          pending.current = next; setReview(next);
        }),
      });
    } catch (error) {
      if (owner.current === key) setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      if (owner.current === key) { saving.current = false; setBusy(false); }
    }
  };

  if (!directory) return null;
  const error = saveError || readError;
  return <section className="space-y-2 py-3" aria-label={t('settings.projectTrust.title')}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 break-words typography-ui-label">{label ?? t('settings.projectTrust.title')}</span>
      <span className="typography-meta text-muted-foreground">{snapshot ? t(snapshot.decision === true ? 'settings.projectTrust.trusted' : 'settings.projectTrust.untrusted') : t('settings.projectTrust.checking')}</span>
      <Button size="sm" variant="outline" disabled={!snapshot || busy} onClick={() => void change(snapshot?.decision !== true)}>
        {t(snapshot?.decision === true ? 'settings.projectTrust.revoke' : 'settings.projectTrust.trust')}
      </Button>
    </div>
    <p className="break-all typography-micro text-muted-foreground">{snapshot?.path ?? directory}</p>
    {showDescription ? <p className="typography-meta text-muted-foreground">{t('settings.projectTrust.description')}</p> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error} <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSaveError(''); setReload(value => value + 1); }}>{t('assistant.reload')}</Button></p> : null}
    <Dialog open={review !== null} onOpenChange={open => { if (!open) finishReview(false); }}>
      <DialogContent><DialogHeader>
        <DialogTitle>{t(review?.decision ? 'settings.projectTrust.confirmTrust' : 'settings.projectTrust.confirmRevoke')}</DialogTitle>
        <DialogDescription>{t(review?.decision ? 'settings.projectTrust.description' : 'settings.projectTrust.revokeDescription')}</DialogDescription>
      </DialogHeader>
        <p className="break-all typography-meta">{review?.snapshot.path}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => finishReview(false)}>{t('settings.common.actions.cancel')}</Button>
          <Button onClick={() => finishReview(true)}>{t(review?.decision ? 'settings.projectTrust.trust' : 'settings.projectTrust.revoke')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

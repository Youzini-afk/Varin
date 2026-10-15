import React from 'react';
import type { DelegatedExecution, ThreadConflictResolution } from '@varin/protocol';
import type { ThreadsAPI, ThreadIdentity, ThreadIntegrationCommand, ThreadIntegrationState } from '@varin/application-client';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';

export function ThreadIntegrationPanel({ api, identity, execution }: { api: ThreadsAPI; identity: ThreadIdentity; execution: DelegatedExecution }) {
  const { t } = useI18n();
  const [opened, setOpened] = React.useState(false);
  if (!api.collaboration || execution.code_result.kind !== 'published' || execution.parent_thread_id !== identity.threadId || execution.parent_branch_id !== identity.branchId) return null;
  return <div className="space-y-2">
    <Button size="sm" variant="ghost" aria-expanded={opened} onClick={() => setOpened(value => !value)}>
      <Icon name="git-merge" className="mr-1 size-3.5" />{t('chat.integration.review')}
    </Button>
    {opened && <IntegrationReview key={`${execution.execution_id}:${execution.code_result.result.publication_id}`} api={api}
      identity={identity} executionId={execution.execution_id} publicationId={execution.code_result.result.publication_id} />}
  </div>;
}

function IntegrationReview({ api, identity, executionId, publicationId }: {
  api: ThreadsAPI; identity: ThreadIdentity; executionId: string; publicationId: string;
}) {
  const { t } = useI18n();
  const [state, setState] = React.useState<ThreadIntegrationState>();
  const [resolutions, setResolutions] = React.useState<Record<string, ThreadConflictResolution>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [retry, setRetry] = React.useState<ThreadIntegrationCommand>();
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const common = React.useCallback(() => ({ runtime: 'agent' as const, threadId: identity.threadId, branchId: identity.branchId, executionId, publicationId, key: crypto.randomUUID(),
    sourceOwner: getDocumentRegistry().surfaceOwner() }), [identity.threadId, identity.branchId, executionId, publicationId]);
  const run = React.useCallback(async (input: ThreadIntegrationCommand) => {
    setBusy(true); setError(undefined); setRetry(undefined);
    try {
      const next = await api.collaboration!.integration(input);
      if (!mounted.current) return;
      setState(next); setError(next.problem); setResolutions({});
    } catch (error) {
      if (mounted.current) { setError(error instanceof Error ? error.message : String(error)); setRetry(input); }
    } finally { if (mounted.current) setBusy(false); }
  }, [api]);
  React.useEffect(() => { void run({ ...common(), action: 'preview' }); }, [common, run]);
  const preview = state?.preview;
  const conflicts = preview?.paths.filter(path => path.decision === 'conflict') ?? [];
  const choose = (path: string, choice: ThreadConflictResolution['choice'], text?: string) => setResolutions(current => ({
    ...current, [path]: { path, choice, ...(text === undefined ? {} : { text }) },
  }));
  const apply = () => {
    if (!preview) return;
    void run({ ...common(), action: 'apply', expectedBindingFingerprint: preview.bindingFingerprint,
      resolutions: Object.values(resolutions).map(value => ({ ...value, expectedParentRevision: preview.binding[value.path].revision,
        ...(preview.binding[value.path].localEditRevision === undefined ? {} : { expectedLocalEditRevision: preview.binding[value.path].localEditRevision }) })) });
  };
  const unsettled = state?.operations.some(row => !row.executorStopped || !['complete', 'conflict', 'compensated', 'aborted', 'undone'].includes(row.state));
  return <section className="space-y-2 rounded-lg border border-border/50 p-2 typography-meta" aria-label={t('chat.integration.review')}>
    {busy && <p className="flex items-center gap-1 text-muted-foreground"><Icon name="loader-4" className="size-3 animate-spin" />{t('common.loading')}</p>}
    {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    {preview?.paths.map(path => <details key={path.path} className="rounded border border-border/40 p-2" open={path.decision === 'conflict'}>
      <summary className="cursor-pointer break-all font-medium">{path.path}{path.decision === 'conflict' ? ` · ${t('chat.integration.conflict')}` : ''}</summary>
      {path.conflictReason && <p className="mt-1 text-status-warning">{path.conflictReason}</p>}
      {path.isText && <div className="mt-2 grid gap-2">
        <div><p className="text-muted-foreground">{t('chat.integration.parent')}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">{path.parentText ?? ''}</pre></div>
        <div><p className="text-muted-foreground">{t('chat.integration.child')}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 text-xs">{path.childText ?? ''}</pre></div>
      </div>}
      {path.decision === 'conflict' && <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-1">{(['parent', 'child', 'base'] as const).map(choice => <Button key={choice} size="sm" variant={resolutions[path.path]?.choice === choice ? 'secondary' : 'ghost'}
          disabled={busy} onClick={() => choose(path.path, choice)}>{t(choice === 'parent' ? 'harness.threads.chooseParent' : choice === 'child' ? 'harness.threads.chooseChild' : 'harness.threads.chooseBase')}</Button>)}</div>
        {path.isText && <textarea aria-label={t('chat.integration.resolution')} disabled={busy} className="min-h-24 w-full rounded border border-border bg-background p-2 text-xs"
          value={resolutions[path.path]?.choice === 'text' ? resolutions[path.path].text : path.parentText ?? ''}
          onChange={event => choose(path.path, 'text', event.target.value)} />}
      </div>}
    </details>)}
    {!!preview?.unavailablePaths.length && <p className="text-status-warning">{t('harness.threads.unavailable')}: {preview.unavailablePaths.join(', ')}</p>}
    {state?.operations.map(row => <div key={row.operationId} className="flex items-center justify-between gap-2">
      <div><span>{t(!row.executorStopped ? 'chat.integration.pending' : row.state === 'complete' ? 'chat.integration.applied' : row.state === 'undone' || row.state === 'compensated' ? 'chat.integration.undone'
        : row.state === 'conflict' ? 'chat.integration.conflict' : row.state === 'aborted' ? 'chat.integration.cancelled' : 'chat.integration.pending')}</span>
      {row.failure && <p className="break-words text-destructive">{row.failure}</p>}</div>
      {(row.state === 'complete' || row.state === 'conflict') && <Button variant="ghost" size="sm" disabled={busy || !!retry || unsettled}
        onClick={() => void run({ ...common(), action: 'undo', operationId: row.operationId, sourceRunId: row.sourceRunId })}>{t('chat.integration.undo')}</Button>}
    </div>)}
    <div className="flex flex-wrap justify-end gap-1">
      {retry && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(retry)}>{t('chat.integration.retry')}</Button>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run({ ...common(), action: 'preview' })}>{t('chat.integration.refresh')}</Button>
      {preview && <Button size="sm" disabled={busy || !!retry || unsettled || !preview.valid || !preview.paths.some(path => ['conflict', 'apply-child', 'merge-clean'].includes(path.decision))
        || preview.unavailablePaths.length > 0 || conflicts.some(path => !resolutions[path.path])} onClick={apply}>{t('harness.threads.merge')}</Button>}
    </div>
  </section>;
}

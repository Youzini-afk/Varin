import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type {
  WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryOperation,
  WorkspaceCombinedRecoveryPlan,
  WorkspaceRecoveryStatus,
} from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { cn } from '@/lib/utils';
import { formatWorkspaceArchiveBytes } from '@/lib/workspaceArchive';
import { useThreadStore } from '@/stores/useThreadStore';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { useUIStore } from '@/stores/useUIStore';
import { RecoveryDialog } from '@/components/recovery/RecoveryDialog';
import { FileRecoveryTimeline } from '@/components/recovery/FileRecoveryTimeline';
import { applyCombinedRecoveryAndRead, assertCombinedRecoveryIdentity, combinedRecoveryStatus, isCombinedRecoverySettled } from '@/components/recovery/combinedRecoveryResult';
import { shouldOpenRecoveryDialog } from '@/components/recovery/recoveryPolicy';

const operationTone = (operation: WorkspaceCombinedRecoveryOperation): string => {
  if (operation.state === 'complete') {
    return 'text-[var(--status-success)]';
  }
  if (operation.state === 'compensated') return 'text-[var(--status-warning)]';
  if (operation.state === 'needs-attention') return 'text-[var(--status-error)]';
  return 'text-[var(--status-info)]';
};

export const WorkspaceRecoveryPanel: React.FC = () => {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const identity = useThreadStore(state => state.selectedIdentity);
  const sessionId = identity?.threadId;
  const branchId = identity?.branchId;
  const preference = useUIStore(state => state.recoveryPreference);
  const workspaceId = useWorkbenchWorkspaceId();
  const [status, setStatus] = React.useState<WorkspaceRecoveryStatus | null>(null);
  const [operations, setOperations] = React.useState<WorkspaceCombinedRecoveryOperation[]>([]);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const conversation = React.useMemo(() => sessionId && branchId ? { kind: 'thread' as const, threadId: sessionId, branchId } : null, [sessionId, branchId]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [undoIntent, setUndoIntent] = React.useState<{ plan: WorkspaceCombinedRecoveryPlan; attempt?: WorkspaceCombinedRecoveryApplyInput }>();
  const [undoDialogOpen, setUndoDialogOpen] = React.useState(false);
  const undoInFlight = React.useRef(false);
  const scope = JSON.stringify([host, workspaceId, sessionId, identity?.branchId]);
  const latestScope = React.useRef(scope); latestScope.current = scope;
  const dataScope = React.useRef<string | null>(null);
  const current = React.useCallback(() => latestScope.current === scope && host === getRuntimeEndpointGeneration(), [host, scope]);
  React.useEffect(() => {
    latestScope.current = scope;
    setUndoIntent(undefined); setUndoDialogOpen(false); undoInFlight.current = false;
    setStatus(null); setOperations([]); setError(null);
    return () => { if (latestScope.current === scope) latestScope.current = ''; };
  }, [scope]);

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setOperations([]);
      return;
    }
    setBusy('refresh');
    setError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      const [nextStatus, nextOperations] = await Promise.all([
        api.status(workspaceId),
        api.listCombinedOperations(workspaceId),
      ]);
      if (!current()) return;
      dataScope.current = scope;
      setStatus(requireWorkspaceRecoveryResult(nextStatus));
      setOperations(requireWorkspaceRecoveryResult(nextOperations).operations.filter(operation => operation.conversation.threadId === identity?.threadId));
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setBusy(null);
    }
  }, [current, scope, workspaceId, identity?.threadId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const acceptUndoResult = React.useCallback(async (operation: WorkspaceCombinedRecoveryOperation) => {
    if (!current()) return;
    setOperations(items => [...items.filter(item => item.id !== operation.id), operation]);
    if (operation.state !== 'complete') { setError(combinedRecoveryStatus(operation)); return; }
    setUndoIntent(undefined); setUndoDialogOpen(false);
    if (!current()) return;
    toast.success(t('contextPanel.recovery.native.undoComplete'));
    await refresh();
  }, [current, refresh, t]);

  const resumeUndo = React.useCallback(async (original: WorkspaceCombinedRecoveryOperation) => {
    if (!current() || dataScope.current !== scope || busy || undoInFlight.current || undoIntent) return;
    undoInFlight.current = true; setBusy(original.id); setError(null);
    try {
      const api = getWorkspaceRecoveryAPI();
      let operation = requireWorkspaceRecoveryResult(await api.getCombinedOperation(original.id)).operation;
      if (!current()) return;
      assertCombinedRecoveryIdentity(operation, original);
      if (operation.state !== 'planned' && !isCombinedRecoverySettled(operation)) {
        operation = await applyCombinedRecoveryAndRead(api, { operationId: operation.id, expectedRevision: operation.revision, conflictPolicy: 'abort', confirmedConflicts: [] });
        if (!current()) return;
        assertCombinedRecoveryIdentity(operation, original);
      }
      if (operation.undoOf) await acceptUndoResult(operation);
      else {
        setOperations(items => items.map(item => item.id === operation.id ? operation : item));
        await refresh();
      }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) { setBusy(null); undoInFlight.current = false; } }
  }, [acceptUndoResult, busy, current, refresh, scope, undoIntent]);

  const undo = React.useCallback(async (operation: WorkspaceCombinedRecoveryOperation) => {
    if (!current() || dataScope.current !== scope || !workspaceId || busy || undoInFlight.current || typeof window === 'undefined') return;
    if (undoIntent) { setUndoDialogOpen(true); return; }
    const interrupted = operations.find(item => item.undoOf === operation.id && !isCombinedRecoverySettled(item));
    if (interrupted) { await resumeUndo(interrupted); return; }
    if (!window.confirm(t('contextPanel.recovery.native.undoConfirm'))) return;
    undoInFlight.current = true;
    setBusy(operation.id);
    let preparedPlan: WorkspaceCombinedRecoveryPlan | undefined;
    try {
      const api = getWorkspaceRecoveryAPI();
      const prepared = requireWorkspaceRecoveryResult(await api.prepareCombinedUndo(operation.id));
      if (!current()) { if (host === getRuntimeEndpointGeneration()) void api.cancelCombinedOperation(prepared.plan.id).catch(() => undefined); return; }
      preparedPlan = prepared.plan;
      setUndoIntent({ plan: prepared.plan });
      if (shouldOpenRecoveryDialog(preference, prepared.plan)) { setUndoDialogOpen(true); return; }
      const attempt: WorkspaceCombinedRecoveryApplyInput = {
        confirmedConflicts: [],
        conflictPolicy: 'abort',
        expectedRevision: prepared.plan.revision,
        operationId: prepared.plan.id,
      };
      setUndoIntent({ plan: prepared.plan, attempt });
      const result = await applyCombinedRecoveryAndRead(api, attempt);
      if (!current()) return;
      assertCombinedRecoveryIdentity(result, prepared.plan);
      await acceptUndoResult(result);
      if (current() && result.state !== 'complete') setUndoDialogOpen(true);
    } catch (cause) {
      if (!current()) return;
      toast.error(cause instanceof Error ? cause.message : String(cause));
      setError(cause instanceof Error ? cause.message : String(cause));
      if (preparedPlan) setUndoDialogOpen(true);
    } finally {
      if (current()) { setBusy(null); undoInFlight.current = false; }
    }
  }, [acceptUndoResult, busy, current, host, operations, preference, resumeUndo, scope, t, undoIntent, workspaceId]);

  if (!identity) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon name="history" className="size-10 text-muted-foreground/50" />
        <p className="typography-ui-label text-muted-foreground">
          {t('contextPanel.recovery.native.openWorkspace')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <div className="flex items-start gap-3 border-b border-border/60 px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="typography-ui-header text-foreground">{t('contextPanel.mode.recovery')}</h2>
          <p className="mt-1 typography-meta text-muted-foreground">
            {t('contextPanel.recovery.native.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => { setRefreshKey(value => value + 1); void refresh(); }}
          disabled={busy !== null}
          aria-label={t('settings.varin.recovery.actions.refresh')}
          title={t('settings.varin.recovery.actions.refresh')}
        >
          <Icon name="refresh" className={cn('size-4', busy === 'refresh' && 'animate-spin')} />
        </Button>
      </div>

      <div className="space-y-6 px-4 py-5">
        {conversation && <FileRecoveryTimeline key={scope} conversation={conversation} refreshKey={refreshKey} onChanged={refresh} />}
        {status ? (
          <section className="rounded-xl border border-border/60 bg-muted/15 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="typography-ui-label font-medium text-foreground">{t('contextPanel.recovery.files.storageTitle')}</p>
                <p className="mt-1 typography-micro text-muted-foreground">
                  {t('contextPanel.recovery.files.storageScope')}
                </p>
                <p className="mt-1 truncate typography-micro text-muted-foreground" title={status.identity.canonicalRoot}>{status.identity.canonicalRoot}</p>
              </div>

            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">

              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.objects')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">{status.storage.objectCount}</p>
              </div>
              <div>
                <p className="typography-micro text-muted-foreground">{t('settings.varin.recovery.storage.size')}</p>
                <p className="mt-1 typography-ui-label tabular-nums">
                  {formatWorkspaceArchiveBytes(status.storage.byteLength)}
                </p>
              </div>
            </div>
            {status.failures.length > 0 ? (
              <div className="mt-3 space-y-1 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-2">
                {status.failures.map((failure) => (
                  <p key={`${failure.operationId ?? failure.code}:${failure.message}`} className="typography-micro text-[var(--status-error)]">
                    {failure.operationId ? `${failure.operationId}: ` : ''}{failure.message}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {(operations.length > 0 || undoIntent) && <section className="border-t border-border/60 pt-5">
          <h3 className="typography-ui-label font-medium text-foreground">
            {t('contextPanel.recovery.native.operations')}
          </h3>
          {undoIntent && !undoDialogOpen && <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setUndoDialogOpen(true)}>{t('contextPanel.recovery.files.checkOperation')}</Button>}
          <div className="mt-3 space-y-2">
            {operations.map((operation) => (
              <div key={operation.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate typography-ui-label font-medium text-foreground">
                      {operation.undoOf
                        ? t('contextPanel.recovery.native.undoOperation')
                        : t('contextPanel.recovery.native.combinedOperation')}
                    </p>
                    <p className={cn('mt-1 typography-micro', operationTone(operation))}>
                      {t(operation.state === 'complete' ? 'contextPanel.recovery.files.applied'
                        : operation.state === 'compensated' ? 'contextPanel.recovery.files.compensated'
                        : operation.state === 'aborted' ? 'contextPanel.recovery.files.cancelled'
                        : operation.state === 'planned' ? 'contextPanel.recovery.files.prepared'
                        : operation.state === 'needs-attention' ? 'contextPanel.recovery.files.notRestored' : 'contextPanel.recovery.files.pending')}
                    </p>
                  </div>
                  {operation.state === 'complete' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy !== null || Boolean(undoIntent)}
                      onClick={() => void undo(operation)}
                    >
                      {t('contextPanel.recovery.actions.undo')}
                    </Button>
                  ) : null}
                  {operation.state !== 'planned' && !isCombinedRecoverySettled(operation) && <Button type="button" variant="outline" size="xs"
                    disabled={busy !== null || Boolean(undoIntent)} onClick={() => void resumeUndo(operation)}>{t('contextPanel.recovery.files.checkOperation')}</Button>}
                </div>
                {operation.failure ? (
                  <p className="mt-2 typography-meta text-[var(--status-error)]">{operation.failure.message}</p>
                ) : null}
              </div>
            ))}
            {operations.length === 0 ? (
              <p className="py-2 typography-meta text-muted-foreground">
                {t('contextPanel.recovery.native.noOperations')}
              </p>
            ) : null}
          </div>
        </section>}

        {error ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {error}
          </div>
        ) : null}
      </div>
      {undoIntent && undoDialogOpen && <RecoveryDialog key={`${scope}:${undoIntent.plan.id}`} open
        plan={undoIntent.plan} initialAttempt={undoIntent.attempt} allowConversationOnly={false}
        onAttempt={attempt => setUndoIntent(value => value ? { ...value, attempt } : value)}
        onCombinedResult={acceptUndoResult} onConversationOnly={async () => {}}
        onClose={() => { setUndoDialogOpen(false); if (!undoIntent.attempt) setUndoIntent(undefined); }} />}
    </div>
  );
};

import React from 'react';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type {
  WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryOperation,
  WorkspaceCombinedRecoveryPlan,
} from '@varin/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceRecoveryAPI,
  requireWorkspaceRecoveryResult,
} from '@/lib/recovery/workspaceRecovery';
import { applyCombinedRecoveryAndRead, assertCombinedRecoveryIdentity, combinedRecoveryStatus, isCombinedRecoverySettled } from './combinedRecoveryResult';

interface PiRecoveryDialogProps {
  open: boolean;
  plan: WorkspaceCombinedRecoveryPlan;
  initialAttempt?: WorkspaceCombinedRecoveryApplyInput;
  allowConversationOnly?: boolean;
  onAttempt?(attempt: WorkspaceCombinedRecoveryApplyInput): void;
  onClose(): void;
  onCombinedResult(operation: WorkspaceCombinedRecoveryOperation): void | Promise<void>;
  onConversationOnly(): void | Promise<void>;
}

export const PiRecoveryDialog: React.FC<PiRecoveryDialogProps> = ({
  open,
  plan,
  initialAttempt,
  allowConversationOnly = true,
  onAttempt,
  onClose,
  onCombinedResult,
  onConversationOnly,
}) => {
  const { t } = useI18n();
  const [phase, setPhase] = React.useState<'ready' | 'applying' | 'failed'>('ready');
  const [failure, setFailure] = React.useState<string | null>(null);
  const attemptRef = React.useRef<WorkspaceCombinedRecoveryApplyInput | undefined>(initialAttempt);
  const [operation, setOperation] = React.useState<WorkspaceCombinedRecoveryOperation | null>(null);
  const [started, setStarted] = React.useState(Boolean(initialAttempt));
  const mounted = React.useRef(true);
  const inFlight = React.useRef(false);
  const [api] = React.useState(getWorkspaceRecoveryAPI);
  const [host] = React.useState(getRuntimeEndpointGeneration);
  const current = React.useCallback(() => mounted.current && host === getRuntimeEndpointGeneration(), [host]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && !attemptRef.current && host === getRuntimeEndpointGeneration()) void api.cancelCombinedOperation(plan.id).catch(() => undefined);
      });
    };
  }, [api, host, plan.id]);

  const runConversationOnly = React.useCallback(async () => {
    if (!current() || inFlight.current || attemptRef.current || !allowConversationOnly) return;
    inFlight.current = true;
    setPhase('applying');
    try {
      const cancelled = requireWorkspaceRecoveryResult(await api.cancelCombinedOperation(plan.id)).operation;
      assertCombinedRecoveryIdentity(cancelled, plan);
      if (cancelled.state !== 'aborted' || cancelled.conversationState !== 'unchanged' || cancelled.fileState !== 'unchanged') throw new Error(combinedRecoveryStatus(cancelled));
      if (!current()) return;
      await onConversationOnly();
      if (current()) onClose();
    } catch (error) {
      if (current()) { setFailure(error instanceof Error ? error.message : String(error)); setPhase('failed'); }
    } finally {
      inFlight.current = false;
    }
  }, [allowConversationOnly, api, current, onClose, onConversationOnly, plan]);

  const dirty = plan.conflicts.some(conflict => conflict.kind === 'dirty-buffer');
  const canRestoreFiles = !dirty && (plan.coverage === 'ready' || plan.coverage === 'partial');
  const fileLabel = (key: string) => {
    const file = plan.fileTargets?.[key];
    if (!file) return key;
    return file.target.kind === 'physical' ? `${file.path} (${file.target.canonicalRoot})` : file.path;
  };

  const runCombined = React.useCallback(async () => {
    if (!current() || inFlight.current || !canRestoreFiles) return;
    inFlight.current = true;
    setFailure(null);
    setPhase('applying');
    try {
      // Once submitted, retain the exact revision and conflict acknowledgement.
      // Observe the original operation before considering an idempotent retry.
      let result = attemptRef.current
        ? requireWorkspaceRecoveryResult(await api.getCombinedOperation(plan.id)).operation : null;
      if (!current()) return;
      if (result) assertCombinedRecoveryIdentity(result, plan);
      if (!result || !isCombinedRecoverySettled(result)) {
        attemptRef.current ??= {
          confirmedConflicts: plan.conflicts.map((conflict) => ({
            fingerprint: conflict.fingerprint,
            path: conflict.path,
          })),
          conflictPolicy: plan.conflicts.length > 0 ? 'overwrite-confirmed' : 'abort',
          expectedRevision: plan.revision,
          operationId: plan.id,
        };
        onAttempt?.(attemptRef.current);
        setStarted(true);
        result = await applyCombinedRecoveryAndRead(api, attemptRef.current);
      }
      if (!current()) return;
      assertCombinedRecoveryIdentity(result, plan);
      setOperation(result);
      await onCombinedResult(result);
      if (!current()) return;
      if (result.state !== 'complete') throw new Error(combinedRecoveryStatus(result));
      onClose();
    } catch (error) {
      if (current()) { setFailure(error instanceof Error ? error.message : String(error)); setPhase('failed'); }
    } finally {
      inFlight.current = false;
    }
  }, [api, canRestoreFiles, current, onAttempt, onClose, onCombinedResult, plan]);

  const close = React.useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent showCloseButton={phase !== 'applying'} className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>{plan.undoOf ? 'Undo conversation and file recovery' : t('chat.recoveryDialog.title')}</DialogTitle>
          <DialogDescription>{plan.undoOf
            ? 'Restore the conversation and file states captured before the original recovery. Current edits will still be checked.'
            : t('chat.recoveryDialog.description')}</DialogDescription>
        </DialogHeader>

        {plan.affectedPaths.length > 0 && <details className="max-h-48 overflow-y-auto typography-meta">
          <summary>Affected files ({plan.affectedPaths.length})</summary>
          <ul className="mt-1 list-disc pl-4">
            {plan.affectedPaths.map(path => <li key={path} className="break-all">{fileLabel(path)}</li>)}
          </ul>
        </details>}

        {plan.coverage === 'partial' ? (
          <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
            {t('chat.recoveryDialog.partialCoverage')}
            {plan.uncoveredPaths.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredPaths.map((entry) => (
                  <li key={entry.path} className="break-all">
                    {fileLabel(entry.path)}
                    {entry.source === 'shell' ? ` (${t('chat.recoveryDialog.sourceShell')})`
                      : entry.source === 'external' ? ` (${t('chat.recoveryDialog.sourceExternal')})`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.uncoveredReasons.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredReasons.map((reason) => (
                  <li key={reason} className="break-all">{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {plan.coverage === 'none' ? (
          <div className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2 typography-meta text-[var(--status-warning)]">
            {t('chat.recoveryDialog.noCoverage')}
            {plan.uncoveredPaths.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredPaths.map((entry) => (
                  <li key={entry.path} className="break-all">
                    {fileLabel(entry.path)}
                    {entry.source === 'shell' ? ` (${t('chat.recoveryDialog.sourceShell')})`
                      : entry.source === 'external' ? ` (${t('chat.recoveryDialog.sourceExternal')})`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.uncoveredReasons.length > 0 ? (
              <ul className="mt-1 list-disc pl-4">
                {plan.uncoveredReasons.map((reason) => (
                  <li key={reason} className="break-all">{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {plan.conflicts.length > 0 ? (
          <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
            <p className="typography-ui-label font-medium text-[var(--status-warning)]">
              {t('chat.recoveryDialog.reviewRequired')}
            </p>
            <ul className="mt-2 space-y-1 typography-meta text-[var(--status-warning)]">
              {plan.conflicts.map((conflict) => (
                <li key={`${conflict.kind}:${conflict.path}`} className="break-all">
                  {fileLabel(conflict.path)}: {conflict.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {dirty && <p role="alert" className="typography-meta">Save or discard the affected editor buffers first, then close this dialog and prepare recovery again. Confirming a file conflict cannot overwrite unsaved edits.</p>}
        {started && operation?.state !== 'complete' && <p role="status" className="typography-meta">This recovery has been submitted. Check its original operation before starting another recovery.</p>}

        {phase === 'applying' ? (
          <div className="flex min-h-20 items-center justify-center gap-2 text-muted-foreground" aria-busy="true">
            <Icon name="loader-4" className="size-4 animate-spin" />
            <span className="typography-ui-label">{t('chat.recoveryDialog.applying')}</span>
          </div>
        ) : (
          <div className="grid gap-2">
            {canRestoreFiles && !started ? (
              <button
                type="button"
                onClick={() => void runCombined()}
                className="rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-interactive-hover/50"
              >
                <span className="block typography-ui-label font-medium text-foreground">
                  {t('settings.varin.recovery.preference.both.label')}
                </span>
                <span className="mt-1 block typography-meta text-muted-foreground">
                  {plan.conflicts.length > 0
                    ? t('chat.recoveryDialog.reviewRequired')
                    : t('settings.varin.recovery.preference.both.description')}
                </span>
              </button>
            ) : null}
            {allowConversationOnly && <button
              type="button"
              disabled={started}
              onClick={() => void runConversationOnly()}
              className="rounded-xl border border-border px-3 py-3 text-left transition-colors hover:bg-interactive-hover/50"
            >
              <span className="block typography-ui-label font-medium text-foreground">
                {t('settings.varin.recovery.preference.conversation.label')}
              </span>
              <span className="mt-1 block typography-meta text-muted-foreground">
                {t('settings.varin.recovery.preference.conversation.description')}
              </span>
            </button>}
          </div>
        )}

        {failure ? (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 typography-meta text-[var(--status-error)]">
            {failure}
          </div>
        ) : null}

        <DialogFooter>
          {(phase === 'failed' || started) && canRestoreFiles ? (
            <Button type="button" disabled={phase === 'applying'} onClick={() => void runCombined()}>
              {started ? 'Check recovery status' : t('chat.recoveryDialog.retry')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={close} disabled={phase === 'applying'}>
            {t('sessions.sidebar.dialogs.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

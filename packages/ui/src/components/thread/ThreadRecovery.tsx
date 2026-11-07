import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { RecoveryDialog } from '../recovery/RecoveryDialog';
import { combinedRecoveryStatus, isCombinedRecoverySettled } from '../recovery/combinedRecoveryResult';
import type { useThreadRecovery } from './useThreadRecovery';

export function ThreadRecovery({ recovery, disabled }: { recovery: ReturnType<typeof useThreadRecovery>; disabled: boolean }) {
  const { t } = useI18n();
  const hasContent = recovery.notice || recovery.error || recovery.unavailable || recovery.combinedUnavailable || recovery.operation || recovery.canRetry || recovery.canUndo || recovery.savedOperations.length > 0;
  return <>
    {!hasContent && <p className="typography-meta text-muted-foreground">{t('chat.recovery.empty')}</p>}
    {hasContent && <section aria-label={t('chat.recovery.title')} className="space-y-3 typography-meta">
      {recovery.notice && <p role="status">{recovery.notice}</p>}
      {recovery.error && <p role="alert" className="text-destructive">{recovery.error}</p>}
      {recovery.combinedUnavailable && <p role="status">{recovery.combinedUnavailable}</p>}
      {recovery.unavailable && <p role="alert" className="text-destructive">{recovery.unavailable} {t('chat.recovery.unavailable')}</p>}
      {recovery.canChooseAfterFileFailure && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.chooseConversationOnly()}>{t('chat.recovery.conversationOnly')}</Button>}
      {recovery.operation && <p>{combinedRecoveryStatus(recovery.operation)}</p>}
      {recovery.canRetry && !recovery.dialogOpen && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.retry()}>{t(recovery.combined ? 'chat.recovery.check' : 'chat.recovery.retry')}</Button>}
      {recovery.combined && !recovery.dialogOpen && <Button variant="ghost" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.cancelCombined()}>{t('chat.recovery.cancel')}</Button>}
      {recovery.canUndo && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.undo()}>{t(recovery.undoIncludesFiles ? 'chat.recovery.undoCombined' : 'chat.recovery.undo')}</Button>}
      {recovery.savedOperations.length > 0 && <details open>
        <summary>{t('chat.recovery.saved')}</summary>
        {recovery.savedOperations.map(operation => <div key={operation.id} className="my-2 space-y-1 rounded border p-2">
          <p>{t(operation.undoOf ? 'chat.recovery.undo' : 'chat.recovery.title')} · {operation.updatedAt}</p>
          <p>{combinedRecoveryStatus(operation)}</p>
          {operation.state === 'planned' && <p>{t('chat.recovery.unapplied')}</p>}
          {!isCombinedRecoverySettled(operation) && <>
            <Button variant="outline" size="sm" disabled={disabled || recovery.busy || recovery.canRetry} onClick={() => void recovery.checkSaved(operation)}>{t(operation.state === 'planned' ? 'chat.recovery.checkSaved' : 'chat.recovery.resumeSaved')}</Button>
            <Button variant="ghost" size="sm" disabled={disabled || recovery.busy || recovery.canRetry} onClick={() => void recovery.cancelSaved(operation)}>{t('chat.recovery.cancelSaved')}</Button>
          </>}
          {operation.state === 'complete' && !operation.undoOf && operation.targetLeafId === recovery.head && <Button variant="outline" size="sm" disabled={disabled || recovery.blocked} onClick={() => void recovery.undoSaved(operation)}>{t('chat.recovery.undoSaved')}</Button>}
        </div>)}
      </details>}
    </section>}
    {recovery.dialogOpen && recovery.combined && <RecoveryDialog key={recovery.combined.plan.id} open
      plan={recovery.combined.plan} initialAttempt={recovery.combined.attempt} onAttempt={recovery.onAttempt}
      allowConversationOnly={recovery.canChooseConversationOnly}
      onClose={recovery.closeDialog} onCombinedResult={recovery.acceptCombined} onConversationOnly={recovery.conversationOnly} />}
  </>;
}

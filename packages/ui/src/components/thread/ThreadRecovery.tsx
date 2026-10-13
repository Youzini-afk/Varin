import React from 'react';
import { Button } from '@/components/ui/button';
import { PiRecoveryDialog } from '../pi-session/PiRecoveryDialog';
import { combinedRecoveryStatus, isCombinedRecoverySettled } from '../pi-session/combinedRecoveryResult';
import type { useThreadRecovery } from './useThreadRecovery';

export function ThreadRecovery({ recovery, disabled }: { recovery: ReturnType<typeof useThreadRecovery>; disabled: boolean }) {
  return <>
    {(recovery.notice || recovery.error || recovery.unavailable || recovery.combinedUnavailable || recovery.operation || recovery.canRetry || recovery.canUndo || recovery.savedOperations.length > 0) && <section aria-label="Thread recovery" className="mx-auto w-full max-w-3xl space-y-2 px-4 py-2 text-sm">
      {recovery.notice && <p role="status">{recovery.notice}</p>}
      {recovery.error && <p role="alert" className="text-destructive">{recovery.error}</p>}
      {recovery.combinedUnavailable && <p role="status">{recovery.combinedUnavailable}</p>}
      {recovery.unavailable && <p role="alert" className="text-destructive">{recovery.unavailable} Saved recovery and Undo are unavailable. Reopen this conversation to check again.</p>}
      {recovery.canChooseAfterFileFailure && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.chooseConversationOnly()}>Restore conversation only</Button>}
      {recovery.operation && <p>{combinedRecoveryStatus(recovery.operation)}</p>}
      {recovery.canRetry && !recovery.dialogOpen && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.retry()}>{recovery.combined ? 'Check recovery status' : 'Retry conversation recovery'}</Button>}
      {recovery.combined && !recovery.dialogOpen && <Button variant="ghost" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.cancelCombined()}>Cancel recovery</Button>}
      {recovery.canUndo && <Button variant="outline" size="sm" disabled={disabled || recovery.busy} onClick={() => void recovery.undo()}>{recovery.undoIncludesFiles ? 'Undo conversation and file recovery' : 'Undo conversation recovery'}</Button>}
      {recovery.savedOperations.length > 0 && <details className="max-h-56 overflow-y-auto" open>
        <summary>Saved conversation and file recovery</summary>
        {recovery.savedOperations.map(operation => <div key={operation.id} className="my-2 space-y-1 rounded border p-2">
          <p>{operation.undoOf ? 'Undo recovery' : 'Recovery'} · {operation.updatedAt}</p>
          <p>{combinedRecoveryStatus(operation)}</p>
          {operation.state === 'planned' && <p>This plan has not been applied. Cancel it and select a recovery point again to review current file changes.</p>}
          {!isCombinedRecoverySettled(operation) && <>
            <Button variant="outline" size="sm" disabled={disabled || recovery.busy || recovery.canRetry} onClick={() => void recovery.checkSaved(operation)}>{operation.state === 'planned' ? 'Check saved recovery' : 'Resume saved recovery'}</Button>
            <Button variant="ghost" size="sm" disabled={disabled || recovery.busy || recovery.canRetry} onClick={() => void recovery.cancelSaved(operation)}>Cancel saved recovery</Button>
          </>}
          {operation.state === 'complete' && !operation.undoOf && operation.targetLeafId === recovery.head && <Button variant="outline" size="sm" disabled={disabled || recovery.blocked} onClick={() => void recovery.undoSaved(operation)}>Undo saved conversation and file recovery</Button>}
        </div>)}
      </details>}
    </section>}
    {recovery.dialogOpen && recovery.combined && <PiRecoveryDialog key={recovery.combined.plan.id} open
      plan={recovery.combined.plan} initialAttempt={recovery.combined.attempt} onAttempt={recovery.onAttempt}
      allowConversationOnly={recovery.canChooseConversationOnly}
      onClose={recovery.closeDialog} onCombinedResult={recovery.acceptCombined} onConversationOnly={recovery.conversationOnly} />}
  </>;
}

import React from 'react';
import { getRuntimeEndpointGeneration, ThreadRequestError } from '@varin/application-client';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { ImageAttachment, NavigationReceipt } from '@varin/protocol';
import type { WorkspaceCombinedRecoveryApplyInput, WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryPlan, WorkspaceRecoveryAPI } from '@varin/extension-contract';
import { useUIStore } from '@/stores/useUIStore';
import { getWorkspaceRecoveryAPI, requireWorkspaceRecoveryResult } from '@/lib/recovery/workspaceRecovery';
import { applyCombinedRecoveryAndRead, assertCombinedRecoveryIdentity, combinedRecoveryStatus, isCombinedRecoverySettled } from '../pi-session/combinedRecoveryResult';
import { shouldOpenRecoveryDialog } from '../pi-session/piRecoveryPolicy';

type EditorContent = { editorText?: string; editorImages?: ImageAttachment[] };
type Navigation = { input: Parameters<ThreadsAPI['navigate']>[0]; editor: EditorContent };
type Combined = { api: WorkspaceRecoveryAPI; plan: WorkspaceCombinedRecoveryPlan; attempt?: WorkspaceCombinedRecoveryApplyInput };

/** Presentation of the owner-prepared recovery, never a second history/file planner. */
export function useThreadRecovery({ api, identity, host, disabled, snapshot, onRecovered }: {
  api: ThreadsAPI; identity: ThreadIdentity; host: number; disabled: boolean;
  snapshot?: ThreadSnapshot;
  onRecovered(editor: EditorContent): Promise<void>;
}) {
  const preference = useUIStore(state => state.recoveryPreference);
  const scope = React.useMemo(() => ({ api, identity, host }), [api, identity, host]);
  const latest = React.useRef(scope); latest.current = scope;
  const callback = React.useRef(onRecovered); callback.current = onRecovered;
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [navigation, setNavigation] = React.useState<Navigation>();
  const [conversationAlternative, setConversationAlternative] = React.useState<Navigation>();
  const [receipt, setReceipt] = React.useState<NavigationReceipt>();
  const [combined, setCombined] = React.useState<Combined>();
  const [operation, setOperation] = React.useState<WorkspaceCombinedRecoveryOperation>();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const ownerRecovery = snapshot?.recovery;
  const unavailable = ownerRecovery?.unavailable;
  const combinedUnavailable = ownerRecovery?.combinedUnavailable;
  const head = snapshot?.historyPage.head;
  const currentReceipt = unavailable ? null : ownerRecovery ? ownerRecovery.navigation : receipt;
  const savedOperations = unavailable ? [] : ownerRecovery?.operations.map(item => item.id === operation?.id ? operation : item).filter(item => item.id !== combined?.plan.id
    && (item.id !== operation?.id || !isCombinedRecoverySettled(item))) ?? [];
  const savedPending = savedOperations.some(item => item.state !== 'planned' && !isCombinedRecoverySettled(item));
  const undoIncludesFiles = !unavailable && !currentReceipt && operation?.state === 'complete' && !operation.undoOf && operation.targetLeafId === head;
  const current = () => latest.current === scope && host === getRuntimeEndpointGeneration();
  React.useEffect(() => {
    latest.current = scope;
    inFlight.current = false; setBusy(false); setError(undefined); setNotice(undefined);
    setNavigation(undefined); setConversationAlternative(undefined); setReceipt(undefined); setCombined(undefined); setOperation(undefined); setDialogOpen(false);
    return () => { if (latest.current === scope) latest.current = { ...scope }; };
  }, [scope]);

  const execute = async (work: () => Promise<void>) => {
    if (!current() || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await work(); }
    catch (cause) { if (current()) setError(cause instanceof ThreadRequestError && cause.status === 409
      ? 'The prepared recovery no longer matches the conversation. Review its current history and active work, then choose the recovery point again.'
      : cause instanceof Error ? cause.message : 'Recovery is unavailable. Check the original connection and retry.'); }
    finally { if (current()) { inFlight.current = false; setBusy(false); } }
  };
  const finishNavigation = async (intent: Navigation, result: NavigationReceipt) => {
    if (!current()) return;
    if (result.threadId !== identity.threadId || result.branchId !== identity.branchId || result.key !== intent.input.key) throw new Error('Recovery returned a different conversation receipt. Refresh this conversation.');
    setNavigation(undefined); setConversationAlternative(undefined); setReceipt(intent.input.undoOf ? undefined : result); setCombined(undefined); setOperation(undefined); setDialogOpen(false);
    setNotice(intent.input.undoOf ? 'Conversation recovery undone.' : 'Conversation restored. Files and independent work are unchanged.');
    await callback.current(intent.editor);
  };
  const navigate = async (intent: Navigation, retry = false) => {
    if (!current()) return;
    let result: NavigationReceipt | null = null;
    if (retry) result = await api.navigationReceipt({ ...identity, key: intent.input.key });
    if (!current()) return;
    if (!result) {
      try { result = await api.navigate(intent.input); }
      catch (failure) {
        if (!current()) return;
        try { result = await api.navigationReceipt({ ...identity, key: intent.input.key }); }
        catch { /* Keep the original intent until its outcome can be established. */ }
        if (!current()) return;
        if (!result) {
          if (failure instanceof ThreadRequestError && failure.status === 409) {
            setNavigation(undefined);
            await callback.current({});
          }
          throw failure;
        }
      }
    }
    await finishNavigation(intent, result);
  };
  const acceptCombined = async (result: WorkspaceCombinedRecoveryOperation, restoreEditor = true) => {
    if (!current()) return;
    const owner = result.conversation;
    if (owner.kind !== 'thread' || owner.threadId !== identity.threadId || owner.branchId !== identity.branchId) throw new Error('Recovery returned a different conversation. Refresh this conversation.');
    setOperation(result);
    if (result.state === 'complete') {
      setCombined(undefined); setNavigation(undefined); setConversationAlternative(undefined); setReceipt(undefined); setDialogOpen(false);
      setNotice(result.undoOf ? 'Conversation and file recovery undone.' : 'Conversation and journalled files restored.');
      await callback.current(restoreEditor ? result : {});
    } else setError(combinedRecoveryStatus(result));
  };
  const applyCombined = async (intent: Combined, retry = false) => {
    if (!current()) return;
    let result = retry ? requireWorkspaceRecoveryResult(await intent.api.getCombinedOperation(intent.plan.id)).operation : null;
    if (!current()) return;
    if (result) assertCombinedRecoveryIdentity(result, intent.plan);
    if (!result || !isCombinedRecoverySettled(result)) {
      const attempt = intent.attempt ?? { operationId: intent.plan.id, expectedRevision: intent.plan.revision, conflictPolicy: 'abort' as const, confirmedConflicts: [] };
      setCombined({ ...intent, attempt });
      result = await applyCombinedRecoveryAndRead(intent.api, attempt);
    }
    assertCombinedRecoveryIdentity(result, intent.plan);
    await acceptCombined(result);
  };
  const recover = (entryId: string) => execute(async () => {
    if (navigation || combined) return;
    setConversationAlternative(undefined);
    const selection = await api.prepareNavigation({ ...identity, entryId });
    if (!current()) return;
    const intent: Navigation = { input: { ...identity, key: crypto.randomUUID(), expectedHeadId: selection.expectedHeadId, targetHeadId: selection.targetHeadId }, editor: selection };
    if (preference === 'conversation') { setNavigation(intent); await navigate(intent); return; }
    let planned = false;
    try {
      const source = await api.recoverySource({ ...identity, entryId });
      if (!current()) return;
      if (!source || source.mode === 'fixed_branch') { setNavigation(intent); await navigate(intent); return; }
      if (source.resourceOwner.kind === 'managed_host') throw new Error('File recovery for this managed Host is not available yet. You can restore the conversation only; the remote files will stay unchanged.');
      const recovery = getWorkspaceRecoveryAPI();
      const { plan } = requireWorkspaceRecoveryResult(await recovery.prepareCombinedRecovery({
        workspaceId: source.workspaceId, conversation: { kind: 'thread', threadId: identity.threadId, branchId: identity.branchId }, entryId,
      }));
      if (!current()) { if (host === getRuntimeEndpointGeneration()) void recovery.cancelCombinedOperation(plan.id).catch(() => undefined); return; }
      planned = true;
      const prepared = { api: recovery, plan };
      setNavigation(intent); setCombined(prepared); setOperation(undefined);
      if (shouldOpenRecoveryDialog(preference, plan)) { setDialogOpen(true); return; }
      await applyCombined(prepared);
    } catch (failure) {
      // Preparing files never changes history. Keep an explicit conversation-only
      // choice when the file service could not prepare a plan.
      if (current() && !planned) setConversationAlternative(intent);
      throw failure;
    }
  });
  const prepareUndo = async (original: WorkspaceCombinedRecoveryOperation) => {
      const recovery = getWorkspaceRecoveryAPI();
      const { plan } = requireWorkspaceRecoveryResult(await recovery.prepareCombinedUndo(original.id));
      if (!current()) { if (host === getRuntimeEndpointGeneration()) void recovery.cancelCombinedOperation(plan.id).catch(() => undefined); return; }
      const prepared = { api: recovery, plan };
      setCombined(prepared);
      if (shouldOpenRecoveryDialog(preference, plan)) { setDialogOpen(true); return; }
      await applyCombined(prepared);
  };
  const undo = () => execute(async () => {
    if (unavailable || navigation || combined) return;
    if (undoIncludesFiles && operation) await prepareUndo(operation);
    else if (currentReceipt) {
      const intent: Navigation = { input: { ...identity, key: crypto.randomUUID(), expectedHeadId: currentReceipt.headId, targetHeadId: currentReceipt.previousHeadId, undoOf: currentReceipt.key }, editor: {} };
      setNavigation(intent); await navigate(intent);
    }
  });
  const retry = () => execute(async () => {
    if (combined) {
      if (!combined.attempt) { setDialogOpen(true); return; }
      await applyCombined(combined, true);
    } else if (navigation) await navigate(navigation, true);
  });
  const closeDialog = () => {
    setDialogOpen(false);
    if (!combined?.attempt) { setCombined(undefined); setNavigation(undefined); }
  };
  const cancelCombined = () => execute(async () => {
    if (!combined) return;
    const result = requireWorkspaceRecoveryResult(await combined.api.cancelCombinedOperation(combined.plan.id)).operation;
    if (!current()) return;
    assertCombinedRecoveryIdentity(result, combined.plan);
    await acceptCombined(result, false);
    if (!current()) return;
    setDialogOpen(false);
    if (result.state === 'aborted' || result.state === 'compensated') {
      setCombined(undefined); setNavigation(undefined); setError(undefined); setNotice('Recovery cancelled.');
      await callback.current({});
    }
  });
  const undoSaved = (original: WorkspaceCombinedRecoveryOperation) => execute(async () => {
    if (!unavailable && !navigation && !combined) await prepareUndo(original);
  });
  const checkSaved = (original: WorkspaceCombinedRecoveryOperation) => execute(async () => {
    if (navigation || combined) return;
    const recovery = getWorkspaceRecoveryAPI();
    let result = requireWorkspaceRecoveryResult(await recovery.getCombinedOperation(original.id)).operation;
    if (!current()) return;
    assertCombinedRecoveryIdentity(result, original);
    if (result.state !== 'planned' && !isCombinedRecoverySettled(result)) {
      // The owner resumes already accepted durable phases. This grants no new
      // conflict overwrite; an inert plan still needs its explicit review.
      result = await applyCombinedRecoveryAndRead(recovery, {
        operationId: result.id, expectedRevision: result.revision, conflictPolicy: 'abort', confirmedConflicts: [],
      });
      if (!current()) return;
      assertCombinedRecoveryIdentity(result, original);
    }
    // Opening history never replays a request or replaces the user's current draft.
    await acceptCombined(result, false);
  });
  const cancelSaved = (original: WorkspaceCombinedRecoveryOperation) => execute(async () => {
    if (navigation || combined) return;
    const result = requireWorkspaceRecoveryResult(await getWorkspaceRecoveryAPI().cancelCombinedOperation(original.id)).operation;
    if (!current()) return;
    assertCombinedRecoveryIdentity(result, original);
    await acceptCombined(result, false);
    if (!current()) return;
    if (result.state === 'aborted' || result.state === 'compensated') { setError(undefined); setNotice('Recovery cancelled.'); }
    await callback.current({});
  });
  return {
    busy, blocked: busy || savedPending || Boolean(navigation || combined), error, unavailable, combinedUnavailable, notice, operation, combined, dialogOpen, savedOperations, head, undoIncludesFiles,
    recover, retry, undo, closeDialog, acceptCombined, cancelCombined,
    undoSaved, checkSaved, cancelSaved,
    canChooseAfterFileFailure: Boolean(conversationAlternative) && !navigation && !combined && !savedPending,
    chooseConversationOnly: () => execute(async () => {
      if (!conversationAlternative || navigation || combined || savedPending) return;
      setNavigation(conversationAlternative); setConversationAlternative(undefined); await navigate(conversationAlternative);
    }),
    canUndo: !navigation && !combined && !savedPending && Boolean(currentReceipt && currentReceipt.headId === head || undoIncludesFiles),
    canRetry: !busy && Boolean(navigation || combined),
    canChooseConversationOnly: Boolean(navigation),
    onAttempt: (attempt: WorkspaceCombinedRecoveryApplyInput) => { if (current()) setCombined(value => value ? { ...value, attempt } : value); },
    conversationOnly: async () => {
      if (!current() || !navigation || combined?.attempt) return;
      // The modal cancels the unused file plan before reaching this action.
      await execute(async () => {
        setCombined(undefined); setDialogOpen(false);
        await navigate(navigation);
      });
    },
  };
}

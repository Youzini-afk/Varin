import { ThreadRequestError, type ThreadIdentity, type ThreadRememberInput, type ThreadRememberReceipt } from '@varin/application-client';
export interface ComposerRecipient { identity: ThreadIdentity; name: string; avatar?: string | null }
/** Disposable composer projection only. Original owners keep all save/send receipts. */
export interface ComposerWorkflowState {
  assist?: { cancelRequested?: boolean; pending?: import('@varin/application-client').ThreadDispatchInput; rejected?: boolean; receipt?: import('@varin/application-client').ThreadDispatchReceipt; result?: string; failure?: string };
  handoff?: { rejected?: boolean; pending?: Parameters<NonNullable<import('@varin/application-client').ThreadsAPI['collaboration']>['dispatch']>[0]; receipt?: Awaited<ReturnType<NonNullable<import('@varin/application-client').ThreadsAPI['collaboration']>['dispatch']>> };
  recipient?: ComposerRecipient;
  remember?: { pending?: ThreadRememberInput; rejected?: boolean; receipt?: ThreadRememberReceipt };
}

export const directedComposerKey = (draftKey: string, target: ThreadIdentity) => `${draftKey}:directed:${JSON.stringify([target.threadId, target.branchId])}`;

/** Owner validation/CAS details are actionable; preserve them for these explicit workflows. */
export const composerWorkflowFailure = (cause: unknown): string => cause instanceof ThreadRequestError
  ? cause.detail || cause.message : cause instanceof Error ? cause.message : String(cause);

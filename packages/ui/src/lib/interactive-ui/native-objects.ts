import { nativeObjectLabel as t } from './native-object-labels';
import type { ThreadSnapshot, ThreadPlanState } from '@varin/application-client';
import type { ThreadSummary } from '@varin/protocol';
import { parseWebSourceCitation } from '@varin/protocol';
import { parsePdfMaterialCitationUrl } from '@/lib/materials/pdfMaterialCitation';
import { childTaskRows } from '@/components/conversation/childTaskRows';
import { summarizePlan } from '@/lib/planSummary';

export type NativeObject =
  | { kind: 'thread'; title: string; threadId: string; branchId: string; avatar?: string | null; state?: string }
  | { kind: 'file'; title: string; callId: string; path: string }
  | { kind: 'material'; title: string; ref: string }
  | { kind: 'section'; title: string; section: 'plan' | 'recovery' | 'context'; state?: string }
  | { kind: 'unavailable'; title: string };
export interface NativeObjectFacts {
  snapshot?: ThreadSnapshot;
  threads: readonly ThreadSummary[];
  plan?: ThreadPlanState;
  planError?: string;
  usage?: { totalTokens: number; contextLimit: number } | null;
}
const unavailable = (title: string): NativeObject => ({ kind: 'unavailable', title });
/** References select original owner identities. No filesystem URL or arbitrary navigation fallback. */
export function resolveNativeObject(ref: string, facts: NativeObjectFacts): NativeObject {
  if (parsePdfMaterialCitationUrl(ref) || parseWebSourceCitation(ref)) return { kind: 'material', title: ref, ref };
  const snapshot = facts.snapshot;
  const child = childTaskRows(snapshot?.children ?? [], snapshot?.childExecutions ?? [], snapshot?.childActivity)
    .find(row => row.child.child_thread_id === ref || row.child.operation_id === ref);
  if (child) return { kind: 'thread', title: child.child.name || child.child.input.name || child.task,
    threadId: child.child.child_thread_id, branchId: child.child.child_branch_id, avatar: child.child.avatar, state: child.state };
  const thread = snapshot?.thread.thread_id === ref ? snapshot.thread : facts.threads.find(value => value.thread_id === ref && value.deleted_at_ms === null);
  if (thread) {
    const branchId = snapshot?.identity.threadId === ref ? snapshot.identity.branchId : thread.main_branch_id;
    const run = snapshot?.identity.threadId === ref ? snapshot.activeRun ?? thread.branches.find(branch => branch.branch_id === branchId)?.latest_run : thread.branches.find(branch => branch.branch_id === branchId)?.latest_run;
    return { kind: 'thread', title: thread.title || thread.thread_id, threadId: thread.thread_id, branchId, avatar: thread.avatar, state: run?.state };
  }
  if (ref.startsWith('file:')) {
    const match = /^file:([^/]+)\/(.+)$/.exec(ref);
    if (!match) return unavailable(t('ui.native.invalidFile'));
    try { const callId = decodeURIComponent(match[1]!), path = decodeURIComponent(match[2]!);
      if (!callId || !path || [...path].some(character => character.charCodeAt(0) < 32)) return unavailable(t('ui.native.invalidFile'));
      return { kind: 'file', title: path, callId, path };
    } catch { return unavailable(t('ui.native.invalidFile')); }
  }
  if (ref.startsWith('plan:')) {
    if (facts.planError) return unavailable(facts.planError);
    if (!facts.plan) return unavailable(t('ui.native.loadingPlan'));
    if (facts.plan.plan?.ref !== ref) return unavailable(t('ui.native.oldPlan'));
    const summary = summarizePlan(facts.plan.plan.content);
    return { kind: 'section', section: 'plan', title: summary.items.find(item => item.status === 'in_progress')?.text ?? facts.plan.plan.content.split('\n').find(Boolean) ?? 'Plan', state: `${summary.done}/${summary.total}` };
  }
  if (ref.startsWith('recovery:')) {
    if (snapshot?.recovery?.unavailable) return unavailable(snapshot.recovery.unavailable);
    const operation = snapshot?.recovery?.operations.find(value => value.id === ref.slice('recovery:'.length));
    return operation ? { kind: 'section', section: 'recovery', title: t('ui.native.recovery', { id: operation.id }), state: operation.state } : unavailable(t('ui.native.recoveryUnavailable'));
  }
  if (ref.startsWith('usage:')) {
    const expected = snapshot && `usage:${encodeURIComponent(snapshot.identity.threadId)}/${encodeURIComponent(snapshot.identity.branchId)}`;
    if (ref !== expected) return unavailable(t('ui.native.usageWrongBranch'));
    return facts.usage ? { kind: 'section', section: 'context', title: t('ui.native.tokens', { used: facts.usage.totalTokens.toLocaleString(), limit: facts.usage.contextLimit.toLocaleString() }) } : unavailable(t('ui.native.usageUnavailable'));
  }
  return unavailable(t('ui.native.unavailable', { ref }));
}

import { companionChildEvidence } from './childTeam';
import type { DesktopCompanionScene, ThreadSnapshot } from '@varin/application-client';
import { projectCompanionIntent, unresolvedPermissionId, type ObservationHealth } from './presentation';
import { operationPresentation } from './toolPresentation';

export type SceneFact = Pick<DesktopCompanionScene, 'kind' | 'phase' | 'outcome' | 'count' | 'status'>;
const none: SceneFact = { kind: null, phase: 'withdraw', outcome: null, count: null };
const kinds: Record<string, DesktopCompanionScene['kind']> = { T01: 'reading', T02: 'editing', T04: 'searching', T06: 'organize', T07: 'verify', T08: 'dispatch', W02: 'permission', W03: 'question' };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const permission = (operation: ThreadSnapshot['operations'][number]) => object(object(operation.result?.kind === 'control' ? operation.result.value : null)?.permission);

/** A bounded visual edge latch, not an operation owner. Initial snapshots never replay receipts. */
export class CompanionSceneFacts {
  private pendingPermissions = new Map<string, string>();
  private pendingQuestions = new Set<string>();
  private shownPermission: { operationId: string; permissionId: string } | null = null;
  private shownQuestion: string | null = null;
  private active: SceneFact = none;
  private shown: SceneFact = none;
  reset(): SceneFact {
    this.pendingPermissions.clear(); this.pendingQuestions.clear(); this.shownPermission = null; this.shownQuestion = null; this.active = this.shown = none;
    return this.shown;
  }
  observe(snapshot: ThreadSnapshot, health: ObservationHealth): SceneFact {
    const intent = projectCompanionIntent(snapshot, health);
    if (health !== 'current' || intent.state?.startsWith('E')) return this.reset();
    const pending = snapshot.operations.filter(op => op.phase !== 'terminal' && (!snapshot.activeRun || op.run_id === snapshot.activeRun.id));
    const children = snapshot.children !== undefined && snapshot.childExecutions !== undefined
      ? companionChildEvidence(snapshot).filter(child => !['completed','failed','cancelled','preparation_failed'].includes(child.state)).length
      : Object.values(snapshot.childActivity ?? {}).filter(child => child.state !== 'preparation_failed').length;
    let kind = intent.state ? kinds[intent.state] ?? null : null;
    if (!kind && !intent.state) {
      // Mixed real tool categories: retain one readable primary, never infer from prose.
      kind = pending.map(operationPresentation).map(item => item && kinds[item.state]).find(Boolean) || (children ? 'dispatch' : null);
    }
    const current: SceneFact = { kind, phase: 'active', outcome: null, count: children ? Math.min(children, 99) : null };
    let receipt: SceneFact | null = null;
    for (const operation of snapshot.operations) {
      const p = permission(operation);
      if (this.pendingPermissions.has(operation.id) && this.shownPermission?.operationId === operation.id
        && typeof p?.id === 'string' && this.shownPermission.permissionId === p.id && this.pendingPermissions.get(operation.id) === p.id) {
        const decision = p?.decision;
        if (decision === 'allow_once' || decision === 'allow_always' || decision === 'deny') receipt = { kind: 'permission', phase: 'resolve', outcome: decision === 'deny' ? 'denied' : 'allowed', count: null };
      }
      if (this.shownQuestion === operation.id && this.pendingQuestions.has(operation.id) && operation.phase === 'terminal' && operation.outcome === 'succeeded'
        && operation.result?.kind === 'control' && object(operation.result.value)?.answer_ref != null)
        receipt = { kind: 'question', phase: 'resolve', outcome: 'answered', count: null };
    }
    this.pendingPermissions = new Map(pending.flatMap(op => { const id = unresolvedPermissionId(op); return id !== null ? [[op.id, id] as const] : []; }));
    this.pendingQuestions = new Set(pending.filter(op => op.executor === 'ask_user').map(op => op.id));
    const uniquePermission = this.pendingPermissions.size === 1 ? [...this.pendingPermissions][0] : undefined;
    this.shownPermission = kind === 'permission' && uniquePermission ? { operationId: uniquePermission[0], permissionId: uniquePermission[1] } : null;
    this.shownQuestion = kind === 'question' && this.pendingQuestions.size === 1 ? [...this.pendingQuestions][0]! : null;
    // A current newer scene wins. A receipt can resolve only the scene that was actually shown.
    if (kind) this.shown = current;
    else if (receipt && this.active.kind === receipt.kind) this.shown = receipt;
    else if (this.active.kind) this.shown = { ...this.active, phase: 'withdraw', outcome: null };
    this.active = kind ? current : none;
    return this.shown;
  }
}

const statuses: Record<string, DesktopCompanionScene['status']> = { W01: 'queued', W04: 'external', W05: 'retry', E01: 'failure', E02: 'cancelling', E04: 'disconnected', E05: 'synchronizing', E06: 'uncertain' };
/** Current facts own the one status slot. It never overlays an unresolved question/permission. */
export function sceneForIntent(fact: SceneFact, state: string | null): SceneFact {
  const status = state ? statuses[state] : undefined;
  if (status) return { kind: 'status', status, phase: 'active', outcome: null, count: null };
  if (state === 'C05') return { kind: 'editing', phase: 'active', outcome: null, count: null };
  return fact;
}
export function reviewSceneFact(state: string): SceneFact {
  return sceneForIntent({ kind: kinds[state] ?? null, phase: 'active', outcome: null, count: state === 'T08' ? 2 : null }, state);
}

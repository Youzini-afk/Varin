import { withPlanSelection } from './plan-resolution.js';
/** Trusted identity projection; the existing KnowledgeStore remains the sole writer. */
import type { PlanMutationResult, PlanView } from '@varin/protocol';
import type { ThreadIdentity } from '@varin/application-client';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
export class PlanConflict extends Error {
  readonly code = 'plan-conflict';
  constructor() { super('Plan changed'); }
}
export class PlanScopeUnavailable extends Error {
  constructor(readonly code: 'plan-not-ready' | 'plan-unsupported') { super('Plan scope is unavailable'); }
}
export class PlanService {
  constructor(private readonly runtime: AgentRuntimeClient, private readonly store: () => Promise<KnowledgeStore>) {}
  async supports(identity: ThreadIdentity): Promise<boolean> {
    try { await this.requireScope(identity); return true; }
    catch (error) { if (error instanceof PlanScopeUnavailable) return false; throw error; }
  }
  private async requireScope(identity: ThreadIdentity): Promise<void> {
    const context = await this.runtime.context(identity.branchId);
    const basis = context?.personalization;
    if (!basis) throw new PlanScopeUnavailable('plan-not-ready');
    if (basis.sessionId !== identity.threadId) throw new Error('Context belongs to another Thread');
    if (basis.mode !== 'agent' || basis.threadRole !== 'main' || await this.runtime.childForThread(identity.threadId)) {
      throw new PlanScopeUnavailable('plan-unsupported');
    }
  }
  private async view(identity: ThreadIdentity, headId?: string | null): Promise<PlanView> {
    await this.requireScope(identity);
    const view = await this.runtime.planView(identity.branchId, headId);
    if (view.threadId !== identity.threadId) throw new Error('Plan belongs to another Thread');
    return view;
  }
  async read(identity: ThreadIdentity, signal?: AbortSignal) {
    const view = await this.view(identity);
    const store = await this.store();
    const plan = await withPlanSelection(store, this.runtime, view, selection => store.readPlan(view, selection), signal);
    return { identity, headId: view.headId, plan };
  }
  async update(input: ThreadIdentity & { key: string; expectedHeadId: string | null; expectedRef: string | null; content: string }, signal?: AbortSignal): Promise<PlanMutationResult> {
    const view = await this.view(input, input.expectedHeadId);
    const mutation = { view, origin: { kind: 'user' as const, key: input.key }, expectedRef: input.expectedRef, content: input.content };
    const store = await this.store();
    // A lost response may be retried after the conversation or plan advanced.
    const replay = await store.readPlanMutation(mutation);
    if (replay) {
      if (replay.receipt.status === 'conflict') throw new PlanConflict();
      return replay;
    }
    const current = await this.view(input);
    if (current.headId !== input.expectedHeadId) throw new PlanConflict();
    const result = await withPlanSelection(store, this.runtime, view, selection => store.mutatePlan({ ...mutation, selection }), signal);
    if (result.receipt.status === 'conflict') throw new PlanConflict();
    return result;
  }
  async capture(identity: ThreadIdentity, headId: string | null, targetBranchId: string, signal?: AbortSignal) {
    const source = await this.view(identity, headId);
    const store = await this.store();
    return withPlanSelection(store, this.runtime, source, selection => store.capturePlanFork({ source, targetBranchId, selection }), signal);
  }
}

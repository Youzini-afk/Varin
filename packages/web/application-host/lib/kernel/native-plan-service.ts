import { withNativePlanSelection } from './native-plan-resolution.js';
/** Trusted native identity projection; the existing KnowledgeStore remains the sole writer. */
import type { NativePlanMutationResult, NativePlanView } from '@varin/protocol';
import type { NativeThreadIdentity } from '@varin/application-client';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
export class NativePlanConflict extends Error {
  readonly code = 'native-plan-conflict';
  constructor() { super('Native plan changed'); }
}
export class NativePlanScopeUnavailable extends Error {
  constructor(readonly code: 'native-plan-not-ready' | 'native-plan-unsupported') { super('Native plan scope is unavailable'); }
}
export class NativePlanService {
  constructor(private readonly runtime: NativeRuntimeClient, private readonly store: () => Promise<KnowledgeStore>) {}
  async supports(identity: NativeThreadIdentity): Promise<boolean> {
    try { await this.requireScope(identity); return true; }
    catch (error) { if (error instanceof NativePlanScopeUnavailable) return false; throw error; }
  }
  private async requireScope(identity: NativeThreadIdentity): Promise<void> {
    const context = await this.runtime.context(identity.branchId);
    const basis = context?.personalization;
    if (!basis) throw new NativePlanScopeUnavailable('native-plan-not-ready');
    if (basis.sessionId !== identity.threadId) throw new Error('Native context belongs to another Thread');
    if (basis.mode !== 'agent' || basis.threadRole !== 'main' || await this.runtime.childForThread(identity.threadId)) {
      throw new NativePlanScopeUnavailable('native-plan-unsupported');
    }
  }
  private async view(identity: NativeThreadIdentity, headId?: string | null): Promise<NativePlanView> {
    await this.requireScope(identity);
    const view = await this.runtime.planView(identity.branchId, headId);
    if (view.threadId !== identity.threadId) throw new Error('Native plan belongs to another Thread');
    return view;
  }
  async read(identity: NativeThreadIdentity, signal?: AbortSignal) {
    const view = await this.view(identity);
    const store = await this.store();
    const plan = await withNativePlanSelection(store, this.runtime, view, selection => store.readNativePlan(view, selection), signal);
    return { identity, headId: view.headId, plan };
  }
  async update(input: NativeThreadIdentity & { key: string; expectedHeadId: string | null; expectedRef: string | null; content: string }, signal?: AbortSignal): Promise<NativePlanMutationResult> {
    const view = await this.view(input, input.expectedHeadId);
    const mutation = { view, origin: { kind: 'user' as const, key: input.key }, expectedRef: input.expectedRef, content: input.content };
    const store = await this.store();
    // A lost response may be retried after the conversation or plan advanced.
    const replay = await store.readNativePlanMutation(mutation);
    if (replay) {
      if (replay.receipt.status === 'conflict') throw new NativePlanConflict();
      return replay;
    }
    const current = await this.view(input);
    if (current.headId !== input.expectedHeadId) throw new NativePlanConflict();
    const result = await withNativePlanSelection(store, this.runtime, view, selection => store.mutateNativePlan({ ...mutation, selection }), signal);
    if (result.receipt.status === 'conflict') throw new NativePlanConflict();
    return result;
  }
  async capture(identity: NativeThreadIdentity, headId: string | null, targetBranchId: string, signal?: AbortSignal) {
    const source = await this.view(identity, headId);
    const store = await this.store();
    return withNativePlanSelection(store, this.runtime, source, selection => store.captureNativePlanFork({ source, targetBranchId, selection }), signal);
  }
}

import { randomUUID } from 'node:crypto';
import { HostToolAdmissionError } from './tool-admission.js';
import type { KernelClient } from './kernel-client.js';
import type { Operation } from './protocol.generated.js';
import type { HostToolCall } from './protocol.generated.js';
import type { PermissionRule } from '@varin/protocol';

export interface PermissionTarget { name: string; arguments: Record<string, unknown> }
export interface PersistentPermissionScope { tool: string; scope: 'tool'; available: boolean }
export interface PermissionPersistence {
  prepare(runId: string, target: PermissionTarget): Promise<PersistentPermissionScope>;
  save(runId: string, target: PermissionTarget, signal: AbortSignal): Promise<PermissionRule>;
}

export interface PermissionScope {
  ownerReference: string;
  ownerGeneration: number;
  toolSchemaVersion: string;
  policyGeneration: string;
  reason: string;
  persistent?: PersistentPermissionScope;
}
interface Pending {
  permissionId: string;
  decide: (decision: 'allow_once' | 'deny') => void;
  call: HostToolCall;
  target?: PermissionTarget;
  persistent?: PersistentPermissionScope;
  signal: AbortSignal;
  persistedRule?: PermissionRule;
  flight?: Promise<Operation>;
  choice?: 'allow_once' | 'allow_always' | 'deny';
}
/** Only a live rendezvous, not a policy/grants store. Rust owns the Operation and decision.
 * A closed owner, cancelled call or restart drops this rendezvous and never implies consent.
 */
export class PermissionService {
  private readonly pending = new Map<string, Pending>();
  private persistence?: PermissionPersistence;
  constructor(private readonly kernel: KernelClient) {}
  setPersistence(persistence: PermissionPersistence) { this.persistence = persistence; }

  async authorize(call: HostToolCall, scope: PermissionScope, signal: AbortSignal, target?: PermissionTarget): Promise<void> {
    if (signal.aborted || this.pending.has(call.operationId)) throw new HostToolAdmissionError('permission_not_available');
    const permissionId = randomUUID();
    const exactCall = structuredClone(call);
    const exactScope = structuredClone(scope);
    const exactTarget = target && structuredClone(target);
    if (this.persistence && exactTarget) {
      try { exactScope.persistent = await this.persistence.prepare(call.runId, exactTarget); }
      catch { exactScope.persistent = { tool: exactTarget.name, scope: 'tool', available: false }; }
    }
    signal.throwIfAborted();
    let fail!: (error: Error) => void;
    const decision = new Promise<'allow_once' | 'deny'>((resolve, reject) => {
      fail = reject;
      this.pending.set(call.operationId, { permissionId, decide: resolve, call: exactCall, target: exactTarget, persistent: exactScope.persistent, signal });
    });
    // A cancellation during the open transaction must not become an unhandled rejection.
    void decision.catch(() => undefined);
    const abort = () => fail(new HostToolAdmissionError('permission_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = this.kernel.subscribeExit(() => fail(new HostToolAdmissionError('permission_owner_closed')));
    try {
      if (signal.aborted) throw new HostToolAdmissionError('permission_cancelled');
      await this.kernel.agentRuntimeRequest('runtime.permission.open', { operationId: call.operationId, permissionId, call: exactCall, scope: exactScope }, signal);
      if (await decision !== 'allow_once' || signal.aborted) throw new HostToolAdmissionError('permission_denied');
      await this.kernel.agentRuntimeRequest('runtime.permission.consume', { operationId: call.operationId, permissionId, call: exactCall, scope: exactScope }, signal);
      if (signal.aborted) throw new HostToolAdmissionError('permission_cancelled');
    } finally {
      if (this.pending.get(call.operationId)?.permissionId === permissionId) this.pending.delete(call.operationId);
      signal.removeEventListener('abort', abort);
      unsubscribe();
    }
  }

  /** Called only after the authenticated thread route has checked thread/branch ownership. */
  async decide(operationId: string, permissionId: string, decision: 'allow_once' | 'allow_always' | 'deny'): Promise<Operation> {
    const pending = this.pending.get(operationId);
    if (!pending || pending.permissionId !== permissionId) {
      const original = await this.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId });
      const record = original.result?.kind === 'control' ? (original.result.value as { permission?: { id?: string; decision?: string; persisted_rule?: unknown } })?.permission : undefined;
      if (record?.id === permissionId && record.decision === (decision === 'allow_always' ? 'allow_once' : decision)
        && (decision !== 'allow_always' || record.persisted_rule)) return original;
      throw new HostToolAdmissionError('permission_expired');
    }
    if (pending.flight) {
      if (pending.choice !== decision) throw new HostToolAdmissionError('permission_decision_in_progress');
      return pending.flight;
    }
    pending.choice = decision;
    const decide = async () => {
      if (decision === 'allow_always') {
        if (!this.persistence || !pending.target || !pending.persistent?.available) throw new HostToolAdmissionError('permission_persistence_unavailable');
        if (!pending.persistedRule) {
          const original = await this.kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId }, pending.signal);
          const permission = original.result?.kind === 'control' ? (original.result.value as { permission?: { id?: string; decision?: string | null } })?.permission : undefined;
          if (original.phase !== 'waiting' || original.cancel_requested || permission?.id !== permissionId || permission.decision !== null)
            throw new HostToolAdmissionError('permission_expired');
          pending.persistedRule = await this.persistence.save(pending.call.runId, pending.target, pending.signal);
        }
      }
      if (this.pending.get(operationId) !== pending || pending.signal.aborted) {
        throw new HostToolAdmissionError(pending.persistedRule ? 'permission_persisted_request_expired' : 'permission_expired');
      }
      const once = decision === 'allow_always' ? 'allow_once' : decision;
      const operation = await this.kernel.agentRuntimeRequest<Operation, 'runtime.permission.decide'>('runtime.permission.decide', {
        operationId, permissionId, decision: once, ...(pending.persistedRule ? { persistedRule: pending.persistedRule } : {}),
      });
      if (this.pending.get(operationId) === pending) pending.decide(once);
      return operation;
    };
    pending.flight = decide();
    try { return await pending.flight; }
    catch (error) {
      if (pending.persistedRule && !(error instanceof HostToolAdmissionError && error.code === 'permission_persisted_request_expired'))
        throw new HostToolAdmissionError('permission_persisted_decision_unconfirmed');
      throw error;
    } finally { pending.flight = undefined; pending.choice = undefined; }
  }
}
const services = new WeakMap<KernelClient, PermissionService>();
export function permissionService(kernel: KernelClient): PermissionService {
  let service = services.get(kernel);
  if (!service) { service = new PermissionService(kernel); services.set(kernel, service); }
  return service;
}

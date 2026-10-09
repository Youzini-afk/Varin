import { randomUUID } from 'node:crypto';
import type { KernelClient } from './kernel-client.js';
import type { NativeOperation } from './protocol.generated.js';
import type { NativeMcpCall } from './native-mcp-bridge.js';

export interface NativePermissionScope {
  ownerReference: string;
  ownerGeneration: number;
  toolSchemaVersion: string;
  policyGeneration: string;
  reason: string;
}
interface Pending {
  permissionId: string;
  decide: (decision: 'allow_once' | 'deny') => void;
}
/** Only a live rendezvous, not a policy/grants store. Rust owns the Operation and decision.
 * A closed owner, cancelled call or restart drops this rendezvous and never implies consent.
 */
export class NativePermissionService {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly kernel: KernelClient) {}

  async authorize(call: NativeMcpCall, scope: NativePermissionScope, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.pending.has(call.operationId)) throw new Error('native_permission_not_available');
    const permissionId = randomUUID();
    const exactCall = structuredClone(call);
    const exactScope = structuredClone(scope);
    let fail!: (error: Error) => void;
    const decision = new Promise<'allow_once' | 'deny'>((resolve, reject) => {
      fail = reject;
      this.pending.set(call.operationId, { permissionId, decide: resolve });
    });
    // A cancellation during the open transaction must not become an unhandled rejection.
    void decision.catch(() => undefined);
    const abort = () => fail(new Error('native_permission_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const unsubscribe = this.kernel.subscribeExit(() => fail(new Error('native_permission_owner_closed')));
    try {
      if (signal.aborted) throw new Error('native_permission_cancelled');
      await this.kernel.nativeRuntimeRequest('runtime.permission.open', { operationId: call.operationId, permissionId, call: exactCall, scope: exactScope }, signal);
      if (await decision !== 'allow_once' || signal.aborted) throw new Error('native_permission_denied');
      await this.kernel.nativeRuntimeRequest('runtime.permission.consume', { operationId: call.operationId, permissionId, call: exactCall, scope: exactScope }, signal);
      if (signal.aborted) throw new Error('native_permission_cancelled');
    } finally {
      if (this.pending.get(call.operationId)?.permissionId === permissionId) this.pending.delete(call.operationId);
      signal.removeEventListener('abort', abort);
      unsubscribe();
    }
  }

  /** Called only after the authenticated native-thread route has checked thread/branch ownership. */
  async decide(operationId: string, permissionId: string, decision: 'allow_once' | 'deny'): Promise<NativeOperation> {
    const pending = this.pending.get(operationId);
    if (!pending || pending.permissionId !== permissionId) throw new Error('native_permission_expired');
    const operation = await this.kernel.nativeRuntimeRequest<NativeOperation, 'runtime.permission.decide'>('runtime.permission.decide', { operationId, permissionId, decision });
    if (this.pending.get(operationId) === pending) pending.decide(decision);
    return operation;
  }
}
const services = new WeakMap<KernelClient, NativePermissionService>();
export function nativePermissionService(kernel: KernelClient): NativePermissionService {
  let service = services.get(kernel);
  if (!service) { service = new NativePermissionService(kernel); services.set(kernel, service); }
  return service;
}

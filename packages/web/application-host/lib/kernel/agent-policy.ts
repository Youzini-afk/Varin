/** A selected policy is pinned for one Run. Its immutable configuration and installed artifact
 * participate in durable checkpoint identity; this is not a second policy state/config store.
 * Graph receipts and scoped result-chunk decisions use this same lease, cancellation and epoch
 * fence. The Host never resolves hashes or grants a general content-store capability. */
import { waitWithSignal } from '../cancellation.js';
import { createHash } from 'node:crypto';
import { HostServiceBindingError, type ApplicationExtensionRuntime } from '@varin/extension-host';
import { parseVarinAgentPolicyIdentity, parseVarinAgentPolicyInput, parseVarinAgentPolicyDecision,
  VARIN_AGENT_POLICY_SERVICE_ID, VARIN_AGENT_POLICY_VERSION, type JsonValue, type VarinAgentPolicyDecision,
  type VarinAgentPolicyInput, type VarinAgentPolicyIdentity } from '@varin/extension-contract';
export interface AgentPolicyBinding { reference: string; identity: VarinAgentPolicyIdentity }
export interface AgentPolicyLease {
  binding: AgentPolicyBinding;
  requestedModelRoles?: readonly 'agentPlanning'[];
  decide(input: VarinAgentPolicyInput, signal: AbortSignal): Promise<VarinAgentPolicyDecision>;
  release(): void;
}
export type AgentPolicyPreparer = (scope: { sessionId: string; projectId?: string }, signal?: AbortSignal) => Promise<AgentPolicyLease | undefined>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createAgentPolicy(runtime: ApplicationExtensionRuntime): AgentPolicyPreparer {
  return async (scope, signal) => {
    signal?.throwIfAborted();
    let selected;
    try { selected = await waitWithSignal(runtime.prepareService({ serviceId: VARIN_AGENT_POLICY_SERVICE_ID,
      version: VARIN_AGENT_POLICY_VERSION, method: 'describe', args: [], routing: scope }), signal); }
    catch (error) { if (error instanceof HostServiceBindingError && error.code === 'missing') return undefined; throw error; }
    const pin = selected.pin();
    try {
      const provider = runtime.services.getSnapshot().providers.find(provider => provider.providerId === selected.providerId && provider.status === 'active');
      const artifact = provider && runtime.supervisor.getActiveArtifactIdentity(provider);
      if (!provider || !artifact) throw new Error('Policy executing artifact identity is unavailable');
      const description = await waitWithSignal(pin.invoke('describe', [], signal), signal);
      signal?.throwIfAborted();
      if (!record(description) || Object.keys(description).some(key => !['identity', 'configuration', 'capabilities'].includes(key)) || !('configuration' in description)) throw new Error('Invalid policy description');
      if (description.capabilities !== undefined && (!Array.isArray(description.capabilities)
        || description.capabilities.some(role => role !== 'agentPlanning') || new Set(description.capabilities).size !== description.capabilities.length)) throw new Error('Invalid policy capabilities');
      const requestedModelRoles = (description.capabilities ?? []) as 'agentPlanning'[];
      const identity = parseVarinAgentPolicyIdentity(description.identity);
      const current = await waitWithSignal(runtime.prepareService({ serviceId: VARIN_AGENT_POLICY_SERVICE_ID,
        version: VARIN_AGENT_POLICY_VERSION, method: 'describe', args: [], routing: scope }), signal);
      if (current.providerId !== selected.providerId || runtime.supervisor.getActiveArtifactIdentity(provider) !== artifact) throw new Error('Policy selection changed during preparation');
      pin.assertAvailable();
      const version = createHash('sha256').update(JSON.stringify({ artifact,
        configuration: description.configuration, version: identity.version, ...(requestedModelRoles.length ? { capabilities: requestedModelRoles } : {}) })).digest('hex');
      return { requestedModelRoles, binding: { reference: selected.providerId, identity: { name: `${selected.providerKey}:${identity.name}`, version } },
        decide: async (input, signal) => parseVarinAgentPolicyDecision(await pin.invoke('decide', [input as unknown as JsonValue], signal)),
        release: () => pin.release() };
    } catch (error) { pin.release(); throw error; }
  };
}
export interface PrivatePolicyResponse {
  v: 1; kind: 'agent-policy-response'; id: string; kernelEpoch: string;
  ok: boolean; decision?: VarinAgentPolicyDecision; error?: { code: string };
}
interface Owner { lease: AgentPolicyLease; epoch: string; active: Map<string, AbortController> }
export class AgentPolicyBridge {
  readonly #owners = new Map<string, Owner>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivatePolicyResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  register(runId: string, lease: AgentPolicyLease): AgentPolicyBinding {
    const epoch = this.currentEpoch();
    if (!epoch || !runId || this.#owners.has(runId)) throw new Error('policy_owner_registration_invalid');
    this.#owners.set(runId, { lease, epoch, active: new Map() });
    return structuredClone(lease.binding);
  }
  binding(runId: string): AgentPolicyBinding | undefined {
    const owner = this.#owners.get(runId);
    return owner?.epoch === this.currentEpoch() ? structuredClone(owner.lease.binding) : undefined;
  }
  unregister(runId: string): void {
    const owner = this.#owners.get(runId);
    if (!owner) return;
    this.#owners.delete(runId);
    for (const abort of owner.active.values()) abort.abort();
    owner.lease.release();
  }
  close(): void {
    for (const runId of this.#owners.keys()) this.unregister(runId);
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['agent-policy-request', 'agent-policy-cancel', 'agent-policy-release'].includes(String(value.kind))) return false;
    if (value.kind === 'agent-policy-release') {
      if (value.v === 1 && value.kernelEpoch === this.currentEpoch() && typeof value.runId === 'string') this.unregister(value.runId);
      return true;
    }
    if (value.v !== 1 || typeof value.id !== 'string' || !value.id || value.kernelEpoch !== this.currentEpoch() || typeof value.runId !== 'string') return true;
    const owner = this.#owners.get(value.runId);
    if (value.kind === 'agent-policy-cancel') { owner?.active.get(value.id)?.abort(); return true; }
    const id = value.id; const kernelEpoch = String(value.kernelEpoch); const runId = value.runId;
    const respond = (response: Omit<PrivatePolicyResponse, 'v' | 'kind' | 'id' | 'kernelEpoch'>) => {
      if (this.currentEpoch() !== kernelEpoch) return;
      void this.send({ v: 1, kind: 'agent-policy-response', id, kernelEpoch, ...response }).catch(() => { if (this.currentEpoch() === kernelEpoch) this.transportFailed(); });
    };
    if (!owner || owner.epoch !== kernelEpoch || !record(value.binding)
      || value.binding.reference !== owner.lease.binding.reference
      || JSON.stringify(value.binding.identity) !== JSON.stringify(owner.lease.binding.identity)) {
      respond({ ok: false, error: { code: 'policy_owner_unavailable' } }); return true;
    }
    if (owner.active.has(id)) return true;
    let input: VarinAgentPolicyInput;
    try { input = parseVarinAgentPolicyInput(value.input); if (input.view.run_id !== runId) throw new Error('policy_run_mismatch'); }
    catch { respond({ ok: false, error: { code: 'policy_input_invalid' } }); return true; }
    const abort = new AbortController(); owner.active.set(id, abort);
    // Do not await extension work on the kernel reader. Cancellation frees the waiter even when a
    // broker callback never returns; a late result has no authority to create a checkpoint.
    const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('policy_cancelled')), { once: true }));
    void Promise.race([owner.lease.decide(input, abort.signal), cancelled]).then(decision => {
      if (!abort.signal.aborted && this.#owners.get(runId) === owner) respond({ ok: true, decision });
    }, () => { if (!abort.signal.aborted && this.#owners.get(runId) === owner) respond({ ok: false, error: { code: 'policy_decision_failed' } }); })
      .finally(() => owner.active.delete(id));
    return true;
  }
}

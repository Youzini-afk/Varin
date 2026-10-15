/** Exact installed policy leases. Catalog owns activation and checkpoints; this owner only keeps
 * live service pins. Retired callbacks drain through HostServicePin, never through an abort claim. */
import { waitWithSignal } from '../cancellation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HostServiceBindingError, HostCompositionPreparationRequiredError, type ApplicationExtensionRuntime, type HostServiceBinding } from '@varin/extension-host';
import {
  parseVarinAgentPolicyDescription, parseVarinAgentPolicyInput, parseVarinAgentPolicyDecision,
  parseVarinAgentPolicyTransitionInput, parseVarinAgentPolicyTransition, resolveVarinExtensionServiceRouting,
  VARIN_AGENT_POLICY_SERVICE_ID, VARIN_AGENT_POLICY_VERSION, type JsonValue, type VarinAgentPolicyDecision,
  type VarinAgentPolicyInput, type VarinAgentPolicyTransitionInput, type VarinAgentPolicyTransition,
} from '@varin/extension-contract';
import type { AgentPolicyArtifactBinding, AgentPolicyBinding } from './protocol.generated.js';
export type { AgentPolicyArtifactBinding, AgentPolicyBinding } from './protocol.generated.js';
export interface AgentPolicyLease {
  /** Prepared identity has no activation generation until Catalog allocates one. */
  binding: Omit<AgentPolicyBinding, 'generation'>;
  revocationSignal: AbortSignal;
  decide(input: VarinAgentPolicyInput, signal: AbortSignal): Promise<VarinAgentPolicyDecision>;
  transitionState(input: VarinAgentPolicyTransitionInput, signal: AbortSignal): Promise<VarinAgentPolicyTransition>;
  release(): void;
}
export interface AgentPolicyScope { threadId: string; projectId?: string; requiredBinding?: AgentPolicyArtifactBinding }
export interface AgentPolicyPreparer {
  (scope: AgentPolicyScope, signal?: AbortSignal): Promise<AgentPolicyLease | undefined>;
  observe(scope: Omit<AgentPolicyScope, 'requiredBinding'>, changed: () => void, signal: AbortSignal): () => void;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const generationValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

async function retainAgentPolicy(
  runtime: ApplicationExtensionRuntime,
  selected: HostServiceBinding,
  required: AgentPolicyArtifactBinding | undefined,
  assertSelection: () => Promise<void>,
  signal?: AbortSignal,
): Promise<AgentPolicyLease> {
  const pin = (() => { try { return selected.pin(); } catch (error) { selected.release(); throw error; } })();
  try {
    const provider = runtime.services.getSnapshot().providers.find(candidate => candidate.providerId === selected.providerId);
    const artifact = provider && runtime.supervisor.getRetainedArtifactIdentity(provider);
    if (!provider || !artifact || !selected.composition) throw new Error('Policy executing composition identity is unavailable');
    const description = parseVarinAgentPolicyDescription(await waitWithSignal(pin.invoke('describe', [], signal), signal));
    signal?.throwIfAborted();
    await assertSelection();
    if (runtime.supervisor.getRetainedArtifactIdentity(provider) !== artifact) throw new Error('Policy artifact changed during preparation');
    const configurationIdentity = hash(description.configuration);
    const durable: AgentPolicyArtifactBinding = {
      providerKey: selected.providerKey, extensionId: provider.extensionId, extensionVersion: provider.extensionVersion,
      serviceId: VARIN_AGENT_POLICY_SERVICE_ID, serviceVersion: VARIN_AGENT_POLICY_VERSION, artifactIntegrity: artifact,
      composition: selected.composition, configurationIdentity, declaredIdentity: description.identity, modelRoles: description.modelRoles, stateTransition: description.stateTransition,
      identity: { name: `${selected.providerKey}:${description.identity.name}`, version: hash({ artifact, composition: selected.composition.root, configurationIdentity,
        identity: description.identity, modelRoles: description.modelRoles, stateTransition: description.stateTransition, serviceVersion: VARIN_AGENT_POLICY_VERSION }) },
    };
    if (required && !isDeepStrictEqual(durable, required)) throw new Error('policy_exact_binding_unavailable');
    pin.assertAvailable();
    return { binding: { reference: selected.providerId, artifact: durable }, revocationSignal: pin.revocationSignal,
      decide: async (input, signal) => parseVarinAgentPolicyDecision(await pin.invoke('decide', [input as unknown as JsonValue], AbortSignal.any([signal, pin.revocationSignal]))),
      transitionState: async (input, signal) => {
        signal.throwIfAborted(); pin.assertAvailable();
        if (durable.stateTransition === 'unsupported') return { kind: 'incompatible', reason: 'Policy does not implement state compatibility' };
        return parseVarinAgentPolicyTransition(await pin.invoke('transitionState', [input as unknown as JsonValue], AbortSignal.any([signal, pin.revocationSignal])));
      },
      release: () => { pin!.release(); selected.release(); } };
  } catch (error) { pin?.release(); selected.release(); throw error; }
}

export function createAgentPolicy(runtime: ApplicationExtensionRuntime): AgentPolicyPreparer {
  const explicitRoute = (routing: Awaited<ReturnType<typeof runtime.routing.read>>, scope: AgentPolicyScope, version: number) => {
    const resolution = resolveVarinExtensionServiceRouting({ candidates: [], document: routing.document,
      serviceId: VARIN_AGENT_POLICY_SERVICE_ID, version, context: scope });
    return resolution.matchedRule !== undefined || resolution.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'));
  };
  const prepare = async (scope: AgentPolicyScope, signal?: AbortSignal): Promise<AgentPolicyLease | undefined> => {
    signal?.throwIfAborted();
    const required = scope.requiredBinding;
    const request = { serviceId: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION,
      method: 'describe', args: [], routing: { threadId: scope.threadId, ...(scope.projectId ? { projectId: scope.projectId } : {}) } };
    if (required) {
      if (required.serviceId !== VARIN_AGENT_POLICY_SERVICE_ID || required.serviceVersion !== VARIN_AGENT_POLICY_VERSION) throw new Error('policy_exact_binding_unavailable');
      const retained = runtime.services.getSnapshot().providers.filter(provider => provider.providerKey === required.providerKey
        && provider.extensionId === required.extensionId && provider.extensionVersion === required.extensionVersion
        && runtime.supervisor.getRetainedArtifactIdentity(provider) === required.artifactIntegrity
        && runtime.supervisor.getRetainedComposition(provider)?.root === required.composition.root);
      for (const provider of retained) {
        signal?.throwIfAborted();
        try {
          const selected = runtime.services.bindPinned(required.serviceId, required.serviceVersion, provider.providerId);
          return await retainAgentPolicy(runtime, selected, required, async () => {}, signal);
        } catch { signal?.throwIfAborted(); }
      }
      try {
        const selected = await runtime.prepareService(request, { ...(signal ? { signal } : {}), frozenComposition: required.composition });
        return await retainAgentPolicy(runtime, selected, required, async () => {}, signal);
      } catch (error) { signal?.throwIfAborted(); throw new Error('policy_exact_binding_unavailable', { cause: error }); }
    }
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Cannot prepare a Host service from stale selection state');
    if (!explicitRoute(routing, scope, VARIN_AGENT_POLICY_VERSION)) {
      const versions = new Set(routing.document.rules.filter(rule => rule.serviceId === VARIN_AGENT_POLICY_SERVICE_ID
        && rule.version !== VARIN_AGENT_POLICY_VERSION).map(rule => rule.version));
      for (const version of versions) if (explicitRoute(routing, scope, version)) {
        throw new HostServiceBindingError('selected_unavailable', `Selected agent policy service version ${version} is unsupported; version ${VARIN_AGENT_POLICY_VERSION} is required`);
      }
      const current = await waitWithSignal(runtime.routing.read(), signal);
      if (!current.authoritative || current.document.revision !== routing.document.revision) throw new Error('Policy routing changed during preparation');
      return undefined;
    }
    const selected = await runtime.prepareService(request, { ...(signal ? { signal } : {}), expectedRoutingRevision: routing.document.revision });
    return retainAgentPolicy(runtime, selected, undefined, async () => {
      const current = await runtime.resolveServiceCompositions(request, { ...(signal ? { signal } : {}), expectedRoutingRevision: routing.document.revision });
      if (current.services.length !== 1 || current.services[0]!.providerKey !== selected.providerKey
        || current.services[0]!.composition.root !== selected.composition?.root) throw new Error('Policy selection changed during preparation');
    }, signal);
  };
  const observe: AgentPolicyPreparer['observe'] = (scope, changed, signal) => {
    let closed = false, reading = false, dirty = false, previous: string | undefined;
    const refresh = async () => {
      if (closed) return; dirty = true; if (reading) return; reading = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const routing = await runtime.routing.read();
          if (closed) return;
          let token: string;
          if (!routing.authoritative) token = 'stale';
          else if (!explicitRoute(routing, scope, VARIN_AGENT_POLICY_VERSION)) token = canonical({ default: true,
            unsupported: routing.document.rules.filter(rule => rule.serviceId === VARIN_AGENT_POLICY_SERVICE_ID
              && rule.version !== VARIN_AGENT_POLICY_VERSION && explicitRoute(routing, scope, rule.version)) });
          else {
            try {
              const resolved = await runtime.resolveServiceCompositions({ serviceId: VARIN_AGENT_POLICY_SERVICE_ID,
                version: VARIN_AGENT_POLICY_VERSION, method: 'describe', args: [], routing: scope }, { signal });
              token = canonical(resolved.services.map(service => [service.providerKey, service.composition.root]));
            } catch (error) {
              token = error instanceof HostCompositionPreparationRequiredError ? `needs_preparation:${error.extensionId}`
                : `unavailable:${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (!closed && token !== previous) { previous = token; changed(); }
        }
      } finally { reading = false; }
    };
    const unsubscribe = runtime.subscribe(() => { void refresh().catch(() => undefined); });
    const close = () => { if (!closed) { closed = true; unsubscribe(); signal.removeEventListener('abort', close); } };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close(); else void refresh().catch(() => undefined);
    return close;
  };
  return Object.assign(prepare, { observe });
}

export type PrivatePolicyResponse = {
  v: 1; kind: 'agent-policy-response'; id: string; kernelEpoch: string; generation: number;
  ok: boolean; decision?: VarinAgentPolicyDecision; error?: { code: string };
} | {
  v: 1; kind: 'agent-policy-transition-response'; id: string; kernelEpoch: string; generation: number;
  ok: boolean; transition?: VarinAgentPolicyTransition; error?: { code: string };
};
interface Owner { runId: string; binding: AgentPolicyBinding; lease: AgentPolicyLease; epoch: string; active: Map<string, { abort: AbortController; revoke(): void }>; unwatch(): void }
const ownerKey = (runId: string, generation: number) => JSON.stringify([runId, generation]);
export class AgentPolicyBridge {
  readonly #owners = new Map<string, Owner>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivatePolicyResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  register(runId: string, generation: number, lease: AgentPolicyLease): AgentPolicyBinding {
    const epoch = this.currentEpoch(), key = ownerKey(runId, generation);
    if (!epoch || !runId || !generationValid(generation) || this.#owners.has(key) || lease.revocationSignal.aborted) throw new Error('policy_owner_registration_invalid');
    const binding = { ...structuredClone(lease.binding), generation };
    const revoke = () => {
      const owner = this.#owners.get(key);
      if (!owner || owner.lease !== lease) return;
      for (const call of owner.active.values()) call.revoke();
      this.unregister(runId, generation);
    };
    this.#owners.set(key, { runId, binding, lease, epoch, active: new Map(),
      unwatch: () => lease.revocationSignal.removeEventListener('abort', revoke) });
    lease.revocationSignal.addEventListener('abort', revoke, { once: true });
    return structuredClone(binding);
  }
  binding(runId: string, generation: number): AgentPolicyBinding | undefined {
    const owner = this.#owners.get(ownerKey(runId, generation));
    return owner?.epoch === this.currentEpoch() ? structuredClone(owner.binding) : undefined;
  }
  unregister(runId: string, generation: number): void {
    const key = ownerKey(runId, generation), owner = this.#owners.get(key);
    if (!owner) return;
    this.#owners.delete(key);
    owner.unwatch();
    for (const call of owner.active.values()) call.abort.abort();
    owner.lease.release();
  }
  releaseRun(runId: string): void {
    for (const owner of this.#owners.values()) if (owner.runId === runId) this.unregister(runId, owner.binding.generation);
  }
  close(): void { for (const owner of this.#owners.values()) this.unregister(owner.runId, owner.binding.generation); }
  consume(value: unknown): boolean {
    if (!record(value) || !['agent-policy-request', 'agent-policy-transition-request', 'agent-policy-cancel', 'agent-policy-release'].includes(String(value.kind))) return false;
    if (value.v !== 1 || value.kernelEpoch !== this.currentEpoch() || typeof value.runId !== 'string' || !generationValid(value.generation)) return true;
    if (value.kind === 'agent-policy-release') { this.unregister(value.runId, value.generation); return true; }
    if (typeof value.id !== 'string' || !value.id) return true;
    const key = ownerKey(value.runId, value.generation), owner = this.#owners.get(key);
    if (value.kind === 'agent-policy-cancel') { owner?.active.get(value.id)?.abort.abort(); return true; }
    const id = value.id, kernelEpoch = String(value.kernelEpoch), runId = value.runId, generation = value.generation;
    const transition = value.kind === 'agent-policy-transition-request';
    const respond = (result: { ok: boolean; decision?: VarinAgentPolicyDecision; transition?: VarinAgentPolicyTransition; error?: { code: string } }) => {
      if (this.currentEpoch() !== kernelEpoch) return;
      const response = { v: 1 as const, kind: transition ? 'agent-policy-transition-response' as const : 'agent-policy-response' as const, id, kernelEpoch, generation, ...result };
      void this.send(response).catch(() => { if (this.currentEpoch() === kernelEpoch) this.transportFailed(); });
    };
    if (!owner || owner.epoch !== kernelEpoch || !isDeepStrictEqual(value.binding, owner.binding)) {
      respond({ ok: false, error: { code: 'policy_owner_unavailable' } }); return true;
    }
    if (owner.active.has(id)) return true;
    let input: VarinAgentPolicyInput | VarinAgentPolicyTransitionInput;
    try {
      input = transition ? parseVarinAgentPolicyTransitionInput(value.input) : parseVarinAgentPolicyInput(value.input);
      if (input.view.run_id !== runId) throw new Error('policy_run_mismatch');
    } catch { respond({ ok: false, error: { code: 'policy_input_invalid' } }); return true; }
    const abort = new AbortController(); owner.active.set(id, { abort, revoke: () => respond({ ok: false, error: { code: 'policy_owner_revoked' } }) });
    const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('policy_cancelled')), { once: true }));
    const work = Promise.resolve().then<VarinAgentPolicyDecision | VarinAgentPolicyTransition>(() => {
      abort.signal.throwIfAborted();
      return transition ? owner.lease.transitionState(input as VarinAgentPolicyTransitionInput, abort.signal) : owner.lease.decide(input, abort.signal);
    });
    void Promise.race([work, cancelled]).then(result => {
      if (!abort.signal.aborted && this.#owners.get(key) === owner) respond(transition
        ? { ok: true, transition: result as VarinAgentPolicyTransition } : { ok: true, decision: result as VarinAgentPolicyDecision });
    }, () => { if (!abort.signal.aborted && this.#owners.get(key) === owner) respond({ ok: false, error: { code: transition ? 'policy_transition_failed' : 'policy_decision_failed' } }); })
      .finally(() => owner.active.delete(id));
    return true;
  }
}

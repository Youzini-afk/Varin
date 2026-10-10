/** Exact installed policy leases. Catalog owns activation and checkpoints; this owner only keeps
 * live service pins. Retired callbacks drain through HostServicePin, never through an abort claim. */
import { waitWithSignal } from '../cancellation.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HostServiceBindingError, type ApplicationExtensionRuntime, type HostServiceBinding } from '@varin/extension-host';
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
export interface AgentPolicyScope { sessionId: string; projectId?: string; requiredBinding?: AgentPolicyArtifactBinding }
export interface AgentPolicyPreparer {
  (scope: AgentPolicyScope, signal?: AbortSignal): Promise<AgentPolicyLease | undefined>;
  observe(scope: Omit<AgentPolicyScope, 'requiredBinding'>, changed: () => void, signal: AbortSignal): () => void;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const generationValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function createAgentPolicy(runtime: ApplicationExtensionRuntime): AgentPolicyPreparer {
  const prepare = async (scope: AgentPolicyScope, signal?: AbortSignal): Promise<AgentPolicyLease | undefined> => {
    signal?.throwIfAborted();
    const required = scope.requiredBinding;
    let selected: HostServiceBinding;
    let assertSelection = async (): Promise<void> => {};
    if (required) {
      // Recovery identifies the original installed package directly. A different current route
      // can neither replace it nor grant permission to load an arbitrary archived artifact.
      const snapshot = await waitWithSignal(runtime.state(), signal);
      if (!snapshot.catalog.authoritative) throw new Error('Policy catalog is unavailable');
      const installed = snapshot.catalog.extensions.find(entry => entry.manifest.id === required.extensionId);
      if (!installed || !installed.desired.enabled || installed.manifest.version !== required.extensionVersion
        || installed.integrity !== required.artifactIntegrity || required.serviceId !== VARIN_AGENT_POLICY_SERVICE_ID
        || required.serviceVersion !== VARIN_AGENT_POLICY_VERSION
        || !installed.manifest.provides?.services?.some(service => service.id === required.serviceId && service.version === required.serviceVersion)) {
        throw new Error('policy_exact_binding_unavailable');
      }
      await waitWithSignal(runtime.supervisor.activateExtension(required.extensionId), signal);
      const provider = runtime.services.getSnapshot().providers.find(candidate => candidate.status === 'active'
        && candidate.providerKey === required.providerKey && candidate.extensionId === required.extensionId
        && candidate.extensionVersion === required.extensionVersion);
      if (!provider || runtime.supervisor.getActiveArtifactIdentity(provider) !== required.artifactIntegrity) throw new Error('policy_exact_binding_unavailable');
      selected = runtime.services.bind(required.serviceId, required.serviceVersion, provider.providerId);
    } else {
      const routing = await waitWithSignal(runtime.routing.read(), signal);
      if (!routing.authoritative) throw new Error('Cannot prepare a Host service from stale selection state');
      const readSelections = () => Object.fromEntries(Object.entries(runtime.services.getSnapshot().selections)
        .filter(([key]) => key.startsWith(`${VARIN_AGENT_POLICY_SERVICE_ID}@`)).sort(([a], [b]) => a.localeCompare(b)));
      const selections = readSelections();
      const assertSelectionsUnchanged = () => {
        if (!isDeepStrictEqual(readSelections(), selections)) throw new Error('Policy selection changed during preparation');
      };
      const explicitRoute = (version: number) => {
        const resolution = resolveVarinExtensionServiceRouting({ candidates: [], document: routing.document,
          serviceId: VARIN_AGENT_POLICY_SERVICE_ID, version, context: scope });
        return resolution.matchedRule !== undefined || resolution.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'));
      };
      if (!selections[`${VARIN_AGENT_POLICY_SERVICE_ID}@${VARIN_AGENT_POLICY_VERSION}`] && !explicitRoute(VARIN_AGENT_POLICY_VERSION)) {
        const versions = new Set(routing.document.rules.filter(rule => rule.serviceId === VARIN_AGENT_POLICY_SERVICE_ID
          && rule.version !== VARIN_AGENT_POLICY_VERSION).map(rule => rule.version));
        for (const key of Object.keys(selections)) versions.add(Number(key.slice(`${VARIN_AGENT_POLICY_SERVICE_ID}@`.length)));
        for (const version of versions) if (version !== VARIN_AGENT_POLICY_VERSION
          && (selections[`${VARIN_AGENT_POLICY_SERVICE_ID}@${version}`] || explicitRoute(version))) {
          throw new HostServiceBindingError('selected_unavailable', `Selected agent policy service version ${version} is unsupported; version ${VARIN_AGENT_POLICY_VERSION} is required`);
        }
      }
      const request = { serviceId: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, method: 'describe', args: [], routing: scope };
      try { selected = await waitWithSignal(runtime.prepareService(request, { expectedRoutingRevision: routing.document.revision }), signal); }
      catch (error) {
        if (error instanceof HostServiceBindingError && error.code === 'missing') { assertSelectionsUnchanged(); return undefined; }
        throw error;
      }
      assertSelection = async () => {
        assertSelectionsUnchanged();
        const current = await waitWithSignal(runtime.prepareService(request, { expectedRoutingRevision: routing.document.revision }), signal);
        if (current.providerId !== selected.providerId) throw new Error('Policy selection changed during preparation');
        assertSelectionsUnchanged();
      };
    }
    const pin = selected.pin();
    try {
      const provider = runtime.services.getSnapshot().providers.find(candidate => candidate.providerId === selected.providerId && candidate.status === 'active');
      const artifact = provider && runtime.supervisor.getActiveArtifactIdentity(provider);
      if (!provider || !artifact) throw new Error('Policy executing artifact identity is unavailable');
      const description = parseVarinAgentPolicyDescription(await waitWithSignal(pin.invoke('describe', [], signal), signal));
      signal?.throwIfAborted();
      await assertSelection();
      if (runtime.supervisor.getActiveArtifactIdentity(provider) !== artifact) throw new Error('Policy artifact changed during preparation');
      const configurationIdentity = hash(description.configuration);
      const durable: AgentPolicyArtifactBinding = {
        providerKey: selected.providerKey, extensionId: provider.extensionId, extensionVersion: provider.extensionVersion,
        serviceId: VARIN_AGENT_POLICY_SERVICE_ID, serviceVersion: VARIN_AGENT_POLICY_VERSION, artifactIntegrity: artifact,
        configurationIdentity, declaredIdentity: description.identity, modelRoles: description.modelRoles, stateTransition: description.stateTransition,
        identity: { name: `${selected.providerKey}:${description.identity.name}`, version: hash({ artifact, configurationIdentity,
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
        release: () => pin.release() };
    } catch (error) { pin.release(); throw error; }
  };
  const observe: AgentPolicyPreparer['observe'] = (scope, changed, signal) => {
    let closed = false, reading = false, dirty = false, previous: string | undefined;
    const refresh = async () => {
      if (closed) return;
      dirty = true;
      if (reading) return;
      reading = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const state = await runtime.state();
          if (closed) return;
          const versions = new Set([VARIN_AGENT_POLICY_VERSION as number,
            ...state.routing.document.rules.filter(rule => rule.serviceId === VARIN_AGENT_POLICY_SERVICE_ID).map(rule => rule.version),
            ...Object.keys(state.services.selections).filter(key => key.startsWith(`${VARIN_AGENT_POLICY_SERVICE_ID}@`)).map(key => Number(key.slice(`${VARIN_AGENT_POLICY_SERVICE_ID}@`.length))),
          ]);
          const selections = [...versions].sort((a, b) => a - b).flatMap(version => {
            const candidates = state.catalog.extensions.filter(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
              && entry.manifest.provides?.services?.some(service => service.id === VARIN_AGENT_POLICY_SERVICE_ID && service.version === version))
              .map(entry => ({ providerId: entry.manifest.id, providerKey: `${entry.manifest.id}:host:${VARIN_AGENT_POLICY_SERVICE_ID}@${version}` }));
            const resolution = resolveVarinExtensionServiceRouting({ candidates, document: state.routing.document,
              serviceId: VARIN_AGENT_POLICY_SERVICE_ID, version, context: scope });
            const selected = state.services.selections[`${VARIN_AGENT_POLICY_SERVICE_ID}@${version}`];
            if (version !== VARIN_AGENT_POLICY_VERSION && !selected && !resolution.matchedRule
              && !resolution.diagnostics.some(item => item.code.startsWith('service_selection_'))) return [];
            const provider = state.services.providers.find(item => item.status === 'active'
              && (selected ? item.providerId === selected : item.providerKey === resolution.providerKey));
            const entry = state.catalog.extensions.find(item => item.manifest.id === (provider?.extensionId ?? resolution.providerId));
            return [{ version, selected: selected ?? null, resolution, provider: provider?.providerId ?? null,
              package: entry ? { id: entry.manifest.id, version: entry.manifest.version, artifact: entry.integrity, enabled: entry.desired.enabled } : null }];
          });
          const token = canonical({ authoritative: [state.catalog.authoritative, state.routing.authoritative], selections });
          if (token !== previous) { previous = token; changed(); }
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

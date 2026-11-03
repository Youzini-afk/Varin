/** Selection and live leases for independently scheduled Run drivers. Catalog retains
 * the durable choice; this bridge owns only the actual original Host callback. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalServiceComposition, parseVarinAgentDriverDescription,
  parseVarinAgentDriverRunInput, parseVarinAgentDriverRunOutcome, resolveVarinAgentDriverRouting,
  VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_AGENT_DRIVER_VERSION,
  type JsonValue, type VarinExtensionServiceRoutingContext,
} from '@varin/extension-contract';
import { HostServiceBindingError, type ApplicationExtensionRuntime, type HostInvocationScope,
  type HostServiceBinding, type HostServiceOwnerIdentity } from '@varin/extension-host';
import { waitWithSignal } from '../cancellation.js';
import type { DriverArtifact, DriverBinding, DriverRunInput, DriverRunOutcome } from './protocol.generated.js';
import { withRunDriverInvocation } from './run-driver-invocation.js';

export interface AgentDriverLease {
  binding: DriverBinding;
  owner: Readonly<HostServiceOwnerIdentity>;
  revocationSignal: AbortSignal;
  run(input: DriverRunInput, signal: AbortSignal, invocation: HostInvocationScope): Promise<DriverRunOutcome>;
  release(): void;
}
export interface AgentDriverScope extends VarinExtensionServiceRoutingContext {
  threadId: string;
  requiredBinding?: DriverArtifact;
}
export type AgentDriverPreparer = (scope: AgentDriverScope, signal?: AbortSignal) => Promise<AgentDriverLease | undefined>;
const hash = (value: unknown): string => createHash('sha256').update(canonicalServiceComposition(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

async function retainDriver(runtime: ApplicationExtensionRuntime, selected: HostServiceBinding,
  releaseRoot: () => void, required: DriverArtifact | undefined, assertSelection: () => Promise<void>, signal?: AbortSignal): Promise<AgentDriverLease> {
  let pin;
  try {
    pin = selected.pin();
    const provider = runtime.services.getSnapshot().providers.find(value => value.providerId === selected.providerId);
    const artifactIntegrity = provider && runtime.supervisor.getRetainedArtifactIdentity(provider);
    if (!provider || !artifactIntegrity || !selected.composition) throw new Error('Run driver composition identity is unavailable');
    const description = parseVarinAgentDriverDescription(await waitWithSignal(pin.invoke('describe', [], signal), signal));
    signal?.throwIfAborted();
    await assertSelection();
    if (runtime.supervisor.getRetainedArtifactIdentity(provider) !== artifactIntegrity) throw new Error('Run driver artifact changed during preparation');
    const configurationIdentity = hash(description.configuration);
    const artifact: DriverArtifact = {
      providerKey: selected.providerKey, extensionId: provider.extensionId, extensionVersion: provider.extensionVersion,
      serviceId: VARIN_AGENT_DRIVER_SERVICE_ID, serviceVersion: VARIN_AGENT_DRIVER_VERSION,
      artifactIntegrity, composition: selected.composition, configurationIdentity,
      identity: { name: `${selected.providerKey}:${description.identity.name}`, version: hash({ artifactIntegrity,
        composition: selected.composition.root, configurationIdentity, description: { ...description, configuration: undefined } }) },
      modelRoles: description.modelRoles, recovery: description.recovery, checkpointSchema: description.checkpointSchema,
    };
    if (required && !isDeepStrictEqual(artifact, required)) throw new Error('run_driver_exact_binding_unavailable');
    pin.assertAvailable();
    const originalPin = pin;
    let released = false;
    return {
      binding: { reference: selected.providerId, artifact },
      owner: Object.freeze({ extensionId: provider.extensionId, extensionVersion: provider.extensionVersion,
        entrypointId: provider.entrypointId, instanceKey: provider.instanceKey, generation: provider.generation }),
      revocationSignal: pin.revocationSignal,
      run: async (input, callSignal, invocation) => parseVarinAgentDriverRunOutcome(await originalPin.invoke(
        'run', [input as unknown as JsonValue], AbortSignal.any([callSignal, originalPin.revocationSignal]), invocation)),
      release: () => { if (released) return; released = true; originalPin.release(); selected.release(); releaseRoot(); },
    };
  } catch (error) { pin?.release(); selected.release(); releaseRoot(); throw error; }
}

export function createAgentDriver(runtime: ApplicationExtensionRuntime): AgentDriverPreparer {
  return async (scope, signal) => {
    signal?.throwIfAborted();
    const { requiredBinding: required, ...routingContext } = scope;
    if (required) {
      if (required.serviceId !== VARIN_AGENT_DRIVER_SERVICE_ID || required.serviceVersion !== VARIN_AGENT_DRIVER_VERSION) {
        throw new Error('run_driver_service_version_unsupported');
      }
      const retained = runtime.services.getSnapshot().providers.find(provider => provider.providerKey === required.providerKey
        && provider.extensionId === required.extensionId && provider.extensionVersion === required.extensionVersion
        && runtime.supervisor.getRetainedArtifactIdentity(provider) === required.artifactIntegrity
        && runtime.supervisor.getRetainedComposition(provider)?.root === required.composition.root);
      if (retained) {
        const binding = runtime.services.bindPinned(required.serviceId, required.serviceVersion, retained.providerId);
        return retainDriver(runtime, binding, () => {}, required, async () => {}, signal);
      }
      // Restart reconstructs only the original still-reviewed graph. Cache presence does not
      // authorize old code, and current routing is not a substitute for a saved selection.
      const root = await runtime.supervisor.prepareExtension(required.extensionId, routingContext, signal, required.composition);
      let binding: HostServiceBinding;
      try { binding = root.bind(required.serviceId, required.serviceVersion); }
      catch (error) { root.release(); throw error; }
      return retainDriver(runtime, binding, () => root.release(), required, async () => {}, signal);
    }
    const readSelection = async () => {
      const [catalog, routing] = await Promise.all([runtime.catalog.snapshot(), runtime.routing.read()]);
      if (!catalog.authoritative || !routing.authoritative) throw new Error('Cannot select a Run driver from stale extension state');
      const candidates = catalog.extensions.flatMap(entry => entry.desired.enabled && entry.manifest.entrypoints?.host
        && entry.manifest.provides?.services?.some(service => service.id === VARIN_AGENT_DRIVER_SERVICE_ID && service.version === VARIN_AGENT_DRIVER_VERSION)
        ? [{ providerId: entry.manifest.id, providerKey: `${entry.manifest.id}:host:${VARIN_AGENT_DRIVER_SERVICE_ID}@${VARIN_AGENT_DRIVER_VERSION}` }] : []);
      return { routingRevision: routing.document.revision, selection: resolveVarinAgentDriverRouting({
        candidates, context: routingContext, document: routing.document,
      }) };
    };
    const initial = await readSelection();
    if (initial.selection.kind === 'unavailable') throw new HostServiceBindingError('selected_unavailable',
      initial.selection.routing.diagnostics.map(item => item.message).join('; ') || 'The selected Run driver is unavailable');
    const selected = initial.selection;
    const assertSelection = async () => {
      signal?.throwIfAborted();
      const current = await readSelection();
      if (current.routingRevision !== initial.routingRevision || current.selection.kind !== selected.kind
        || selected.kind === 'extension' && (current.selection.kind !== 'extension' || current.selection.providerKey !== selected.providerKey)) {
        throw new Error('Run driver selection changed during preparation');
      }
    };
    if (selected.kind === 'builtin') { await assertSelection(); return undefined; }
    // Prepare this actual root, not generic routing that could fall back while it is unavailable.
    const root = await runtime.supervisor.prepareExtension(selected.providerId, routingContext, signal);
    let binding: HostServiceBinding;
    try { binding = root.bind(VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_AGENT_DRIVER_VERSION); }
    catch (error) { root.release(); throw error; }
    return retainDriver(runtime, binding, () => root.release(), undefined, assertSelection, signal);
  };
}

export interface PrivateDriverResponse {
  v: 1;
  kind: 'agent-driver-response';
  kernelEpoch: string;
  id: string;
  instanceId: string;
  ok: boolean;
  outcome?: DriverRunOutcome;
  error?: { code: string; message: string };
}
export interface PrivateDriverClosing {
  v: 1;
  kind: 'agent-driver-closing';
  kernelEpoch: string;
  id: string;
  instanceId: string;
  runId: string;
  generation: number;
}
export type PrivateDriverFrame = PrivateDriverResponse | PrivateDriverClosing;
interface DriverCall { abort: AbortController; instanceId: string }
interface DriverOwner { runId: string; epoch: string; lease: AgentDriverLease; active: Map<string, DriverCall>; retired: boolean; unwatch(): void }

export class AgentDriverBridge {
  readonly #owners = new Map<string, DriverOwner>();
  // A new kernel epoch does not make an old trusted Host callback disappear.
  readonly #draining = new Map<string, Set<DriverOwner>>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (frame: PrivateDriverFrame) => Promise<void>,
    private readonly cancelRun: (runId: string) => Promise<unknown>,
    private readonly transportFailed: () => void) {}

  register(runId: string, lease: AgentDriverLease): DriverBinding {
    const epoch = this.currentEpoch();
    if (this.#draining.get(runId)?.size) throw new Error('run_driver_original_callback_not_stopped');
    if (!epoch || !runId || this.#owners.has(runId) || lease.revocationSignal.aborted) throw new Error('run_driver_registration_unavailable');
    const revoke = () => {
      // Revoke admission promptly using the existing native Run stop owner, but retain the
      // original callback and credentials until their actual work has settled.
      if (this.#owners.get(runId) !== owner) return;
      void this.cancelRun(runId).catch(() => { if (this.currentEpoch() === epoch) this.transportFailed(); });
      this.retire(owner);
    };
    const owner: DriverOwner = { runId, epoch, lease, active: new Map(), retired: false,
      unwatch: () => lease.revocationSignal.removeEventListener('abort', revoke) };
    this.#owners.set(runId, owner);
    lease.revocationSignal.addEventListener('abort', revoke, { once: true });
    if (lease.revocationSignal.aborted) revoke();
    return structuredClone(lease.binding);
  }
  binding(runId: string): DriverBinding | undefined {
    const owner = this.#owners.get(runId);
    return owner && owner.epoch === this.currentEpoch() && !owner.retired ? structuredClone(owner.lease.binding) : undefined;
  }
  private retire(owner: DriverOwner): void {
    if (owner.retired) return;
    owner.retired = true;
    if (this.#owners.get(owner.runId) === owner) this.#owners.delete(owner.runId);
    owner.unwatch();
    for (const call of owner.active.values()) call.abort.abort(new Error('Original Run driver owner was retired'));
    if (owner.active.size) {
      const draining = this.#draining.get(owner.runId) ?? new Set<DriverOwner>();
      draining.add(owner); this.#draining.set(owner.runId, draining);
    } else owner.lease.release();
  }
  release(runId: string): void { const owner = this.#owners.get(runId); if (owner) this.retire(owner); }
  close(): void { for (const owner of this.#owners.values()) this.retire(owner); }

  consume(value: unknown): boolean {
    if (!record(value) || !['agent-driver-run', 'agent-driver-cancel', 'agent-driver-release'].includes(String(value.kind))) return false;
    if (value.v !== 1 || value.kernelEpoch !== this.currentEpoch() || typeof value.runId !== 'string') return true;
    const owner = this.#owners.get(value.runId);
    if (value.kind === 'agent-driver-release') { this.release(value.runId); return true; }
    if (typeof value.id !== 'string' || !value.id || typeof value.instanceId !== 'string' || !value.instanceId) return true;
    if (value.kind === 'agent-driver-cancel') {
      const active = owner?.active.get(value.id);
      if (active?.instanceId === value.instanceId) active.abort.abort(new Error('Run cancellation requested'));
      return true;
    }
    const id = value.id, instanceId = value.instanceId, kernelEpoch = String(value.kernelEpoch), runId = value.runId;
    const respond = (result: Pick<PrivateDriverResponse, 'ok' | 'outcome' | 'error'>) => {
      if (this.currentEpoch() !== kernelEpoch) return;
      void this.send({ v: 1, kind: 'agent-driver-response', kernelEpoch, id, instanceId, ...result })
        .catch(() => { if (this.currentEpoch() === kernelEpoch) this.transportFailed(); });
    };
    if (!owner || owner.epoch !== kernelEpoch || owner.retired || value.reference !== owner.lease.binding.reference) {
      respond({ ok: false, error: { code: 'run_driver_owner_unavailable', message: 'The original Run driver owner is unavailable' } }); return true;
    }
    if (owner.active.has(id)) return true;
    let input: DriverRunInput;
    try {
      input = parseVarinAgentDriverRunInput(value.input);
      if (input.runId !== runId || input.epoch !== value.generation) throw new Error('Run driver identity mismatch');
    } catch { respond({ ok: false, error: { code: 'run_driver_input_invalid', message: 'Run driver input does not match its original Run' } }); return true; }
    const abort = new AbortController();
    owner.active.set(id, { abort, instanceId });
    const work = withRunDriverInvocation({ authority: { runId, kernelEpoch, instanceId }, owner: owner.lease.owner,
      signal: abort.signal, currentEpoch: this.currentEpoch,
      closing: async () => {
        if (this.currentEpoch() !== kernelEpoch) return;
        // This is callback completion intent, not the final response. Native closes new
        // admission and wakes observer waits; accepted models/tools still truly drain.
        try { await this.send({ v: 1, kind: 'agent-driver-closing', kernelEpoch, id, instanceId, runId, generation: input.epoch }); }
        catch (error) { if (this.currentEpoch() === kernelEpoch) this.transportFailed(); throw error; }
      } }, invocation => owner.lease.run(input, abort.signal, invocation));
    void work.then(outcome => respond(abort.signal.aborted
      ? { ok: false, error: { code: 'run_driver_cancelled', message: 'The original Run driver callback ended after cancellation' } }
      : { ok: true, outcome }), () => respond({ ok: false,
      error: { code: abort.signal.aborted ? 'run_driver_cancelled' : 'run_driver_failed', message: 'The original Run driver callback ended unsuccessfully' } }))
      .finally(() => {
        owner.active.delete(id);
        if (owner.retired && !owner.active.size) {
          owner.lease.release();
          const draining = this.#draining.get(runId); draining?.delete(owner);
          if (!draining?.size) this.#draining.delete(runId);
        }
      });
    return true;
  }
}

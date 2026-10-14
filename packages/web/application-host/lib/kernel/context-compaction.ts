import { createHash } from 'node:crypto';
import { HostServiceBindingError, type ApplicationExtensionRuntime, type HostServicePin } from '@varin/extension-host';
import {
  VARIN_CONTEXT_COMPACTION_SERVICE_ID, VARIN_CONTEXT_COMPACTION_VERSION, resolveVarinExtensionServiceRouting,
  parseVarinContextCompactionDescription, parseVarinContextCompactionInput, parseVarinContextCompactionPlan,
  canonicalServiceComposition, type JsonValue, type VarinContextCompactionInput,
} from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import type { ContextCompactionCandidate } from './protocol.generated.js';

export interface ContextCompactionScope { threadId: string; projectId?: string; workspaceId?: string }
export interface ContextCompactionLease {
  /** Detached immutable candidate; admission, replay and publication belong to ContextJob. */
  candidate: ContextCompactionCandidate;
  signal: AbortSignal;
  assertAvailable(): void;
  release(): void;
}
export interface ContextCompactionOwner {
  selected(scope: ContextCompactionScope, signal: AbortSignal): Promise<boolean>;
  /** Hold the returned lease through native ContextJob.create; release on either outcome. */
  prepare(scope: ContextCompactionScope, input: VarinContextCompactionInput, signal: AbortSignal): Promise<ContextCompactionLease | undefined>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalServiceComposition(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Short-lived preparation pin, not a plugin-owned task ledger. No accepted work calls back here. */
export function createContextCompaction(runtime: ApplicationExtensionRuntime): ContextCompactionOwner {
  const routingScope = (scope: ContextCompactionScope) => ({ userId: 'default', ...scope });
  const selection = async (scope: ContextCompactionScope, signal: AbortSignal) => {
    signal.throwIfAborted();
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Context compaction routing is unavailable');
    const versions = new Set([VARIN_CONTEXT_COMPACTION_VERSION as number,
      ...routing.document.rules.filter(rule => rule.serviceId === VARIN_CONTEXT_COMPACTION_SERVICE_ID).map(rule => rule.version),
    ]);
    let selected = false;
    for (const version of versions) {
      const resolved = resolveVarinExtensionServiceRouting({ candidates: [], document: routing.document,
        serviceId: VARIN_CONTEXT_COMPACTION_SERVICE_ID, version, context: routingScope(scope) });
      const explicit = resolved.matchedRule !== undefined || resolved.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'));
      if (explicit && version !== VARIN_CONTEXT_COMPACTION_VERSION) throw new HostServiceBindingError('selected_unavailable', `Context compaction service version ${version} is unsupported`);
      if (explicit) selected = true;
    }
    return { routing, selected };
  };
  return {
    selected: async (scope, signal) => (await selection(scope, signal)).selected,
    async prepare(scope, rawInput, signal) {
      const current = await selection(scope, signal);
      // Re-read original routing for this actual attempt. Installing a provider never opts in.
      if (!current.selected) return undefined;
      const input = freeze(parseVarinContextCompactionInput(rawInput));
      const binding = await runtime.prepareService({ serviceId: VARIN_CONTEXT_COMPACTION_SERVICE_ID,
        version: VARIN_CONTEXT_COMPACTION_VERSION, method: 'describe', args: [], routing: routingScope(scope) },
      { expectedRoutingRevision: current.routing.document.revision, signal });
      let pin: HostServicePin | undefined;
      try {
        signal.throwIfAborted();
        pin = binding.pin();
        const heldPin = pin;
        const callSignal = AbortSignal.any([signal, heldPin.revocationSignal]);
        const assertAvailable = () => { callSignal.throwIfAborted(); heldPin.assertAvailable(); };
        assertAvailable();
        const provider = runtime.services.getSnapshot().providers.find(provider => provider.providerId === binding.providerId);
        const artifact = provider && runtime.supervisor.getRetainedArtifactIdentity(provider);
        if (!provider || !artifact || !binding.composition) throw new Error('Context compaction executing composition identity is unavailable');
        const description = parseVarinContextCompactionDescription(await waitWithSignal(heldPin.invoke('describe', [], callSignal), callSignal));
        assertAvailable();
        const plan = parseVarinContextCompactionPlan(await waitWithSignal(heldPin.invoke('prepare',
          [input as unknown as JsonValue], callSignal), callSignal), input);
        assertAvailable();
        const candidate: ContextCompactionCandidate = freeze(structuredClone({
          producer: { kind: 'extension', providerKey: binding.providerKey, providerId: binding.providerId,
            extensionId: provider.extensionId, extensionVersion: provider.extensionVersion,
            serviceId: VARIN_CONTEXT_COMPACTION_SERVICE_ID, serviceVersion: VARIN_CONTEXT_COMPACTION_VERSION,
            artifactIntegrity: artifact, composition: binding.composition,
            configurationIdentity: hash(description.configuration), declaredIdentity: description.identity }, plan,
        }));
        return { candidate, signal: callSignal, assertAvailable, release: () => { heldPin.release(); binding.release(); } };
      } catch (error) { pin?.release(); binding.release(); throw error; }
    },
  };
}

import { createHash } from 'node:crypto';
import { HostServiceBindingError, type ApplicationExtensionRuntime } from '@varin/extension-host';
import {
  VARIN_CONTEXT_BUDGET_SERVICE_ID, VARIN_CONTEXT_BUDGET_VERSION, resolveVarinExtensionServiceRouting,
  parseVarinContextBudgetDescription, parseVarinContextBudgetInput, parseVarinContextBudgetDecision,
  type JsonValue, type VarinContextBudgetInput, type VarinContextBudgetDecision, type VarinContextBudgetDescription,
} from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import type { ContextBudgetStrategy } from './protocol.generated.js';
export interface ContextBudgetScope { sessionId: string; projectId?: string; workspaceId?: string }
export interface ContextBudgetOwner {
  selected(scope: ContextBudgetScope, signal: AbortSignal): Promise<boolean>;
  decide(scope: ContextBudgetScope, input: VarinContextBudgetInput, signal: AbortSignal): Promise<{
    decision: VarinContextBudgetDecision; strategy: ContextBudgetStrategy;
  } | undefined>;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Selection and immutable description facts only; each decision owns its actual service lease. */
export function createContextBudget(runtime: ApplicationExtensionRuntime): ContextBudgetOwner {
  const selections = new Map<string, { routingRevision: number; selected: boolean }>();
  const declarations = new Map<string, { identity: string; prepared: { description: VarinContextBudgetDescription; strategy: ContextBudgetStrategy } }>();
  const routingScope = (scope: ContextBudgetScope) => ({ userId: 'default', ...scope });
  const selection = async (scope: ContextBudgetScope, signal: AbortSignal) => {
    signal.throwIfAborted();
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Context budget routing is unavailable');
    const key = canonical(scope);
    const cached = selections.get(key);
    if (cached?.routingRevision === routing.document.revision) {
      return { key, routing, selected: cached.selected };
    }
    const versions = new Set([VARIN_CONTEXT_BUDGET_VERSION as number,
      ...routing.document.rules.filter(rule => rule.serviceId === VARIN_CONTEXT_BUDGET_SERVICE_ID).map(rule => rule.version),
    ]);
    let selected = false;
    for (const version of versions) {
      const resolved = resolveVarinExtensionServiceRouting({ candidates: [], document: routing.document,
        serviceId: VARIN_CONTEXT_BUDGET_SERVICE_ID, version, context: routingScope(scope) });
      const explicit = resolved.matchedRule !== undefined || resolved.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'));
      if (explicit && version !== VARIN_CONTEXT_BUDGET_VERSION) throw new HostServiceBindingError('selected_unavailable', `Context budget service version ${version} is unsupported`);
      if (explicit) selected = true;
    }
    selections.set(key, { routingRevision: routing.document.revision, selected });
    return { key, routing, selected };
  };
  return {
    selected: async (scope, signal) => (await selection(scope, signal)).selected,
    async decide(scope, input, signal) {
      const current = await selection(scope, signal);
      // Selection may have changed since the short prepare query. Only this actual decision
      // captures a provider generation; merely installing a provider never selects it.
      if (!current.selected) return undefined;
      const binding = await runtime.prepareService({ serviceId: VARIN_CONTEXT_BUDGET_SERVICE_ID,
        version: VARIN_CONTEXT_BUDGET_VERSION, method: 'describe', args: [], routing: routingScope(scope) },
      { expectedRoutingRevision: current.routing.document.revision, signal });
      try {
        signal.throwIfAborted();
        const pin = binding.pin();
        try {
          const callSignal = AbortSignal.any([signal, pin.revocationSignal]);
          // The SDK freezes configuration per activation, which may read current extension
          // storage. Only the same real generation can reuse its description; an unchanged
          // artifact/dependency graph alone does not prove the next activation's configuration.
          // Cache bytes only, never a reference that keeps an unused worker alive.
          if (!binding.composition) throw new Error('Context budget composition identity is unavailable');
          const identity = JSON.stringify([binding.providerKey, binding.composition.root, binding.providerId]);
          const cached = declarations.get(current.key);
          let prepared = cached?.identity === identity ? cached.prepared : undefined;
          if (!prepared) {
            const provider = runtime.services.getSnapshot().providers.find(provider => provider.providerId === binding.providerId);
            const artifact = provider && runtime.supervisor.getRetainedArtifactIdentity(provider);
            if (!provider || !artifact) throw new Error('Context budget artifact identity is unavailable');
            const description = parseVarinContextBudgetDescription(await waitWithSignal(pin.invoke('describe', [], callSignal), callSignal));
            callSignal.throwIfAborted(); pin.assertAvailable();
            prepared = { description, strategy: { kind: 'extension', providerKey: binding.providerKey, extensionId: provider.extensionId,
              extensionVersion: provider.extensionVersion, artifactIntegrity: artifact, serviceVersion: VARIN_CONTEXT_BUDGET_VERSION,
              configurationIdentity: hash(description.configuration), name: description.identity.name, version: description.identity.version } };
          }
          // Once pinned, ordinary replacement cannot invalidate this original call. Revocation can.
          const decision = parseVarinContextBudgetDecision(await waitWithSignal(pin.invoke('decide',
            [parseVarinContextBudgetInput(input) as unknown as JsonValue], callSignal), callSignal));
          callSignal.throwIfAborted(); pin.assertAvailable();
          declarations.set(current.key, { identity, prepared });
          return { decision, strategy: structuredClone(prepared.strategy) };
        } finally { pin.release(); }
      } finally { binding.release(); }
    },
  };
}

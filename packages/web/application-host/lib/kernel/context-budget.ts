import { createHash } from 'node:crypto';
import { HostServiceBindingError, type ApplicationExtensionRuntime, type HostServiceBinding } from '@varin/extension-host';
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
/** Preparation facts are cached using the original lifecycle revision. No callback/state ledger. */
export function createContextBudget(runtime: ApplicationExtensionRuntime): ContextBudgetOwner {
  const selections = new Map<string, { routingRevision: number; hostRevision: number; selected: boolean }>();
  const bindings = new Map<string, { routingRevision: number; hostRevision: number; binding: HostServiceBinding; prepared: {description:VarinContextBudgetDescription;strategy:ContextBudgetStrategy} }>();
  const routingScope = (scope: ContextBudgetScope) => ({ userId: 'default', ...scope });
  const selection = async (scope: ContextBudgetScope, signal: AbortSignal) => {
    signal.throwIfAborted();
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Context budget routing is unavailable');
    const key = canonical(scope); const revision = runtime.preparationRevision;
    const cached = selections.get(key);
    if (revision !== undefined && cached?.routingRevision === routing.document.revision && cached.hostRevision === revision) {
      return { key, routing, revision, selected: cached.selected };
    }
    const snapshot = runtime.services.getSnapshot();
    const versions = new Set([VARIN_CONTEXT_BUDGET_VERSION as number,
      ...routing.document.rules.filter(rule => rule.serviceId === VARIN_CONTEXT_BUDGET_SERVICE_ID).map(rule => rule.version),
      ...Object.keys(snapshot.selections).filter(key => key.startsWith(`${VARIN_CONTEXT_BUDGET_SERVICE_ID}@`)).map(key => Number(key.slice(`${VARIN_CONTEXT_BUDGET_SERVICE_ID}@`.length))),
    ]);
    let selected = false;
    for (const version of versions) {
      const resolved = resolveVarinExtensionServiceRouting({ candidates: [], document: routing.document,
        serviceId: VARIN_CONTEXT_BUDGET_SERVICE_ID, version, context: routingScope(scope) });
      const explicit = snapshot.selections[`${VARIN_CONTEXT_BUDGET_SERVICE_ID}@${version}`] !== undefined
        || resolved.matchedRule !== undefined || resolved.diagnostics.some(diagnostic => diagnostic.code.startsWith('service_selection_'));
      if (explicit && version !== VARIN_CONTEXT_BUDGET_VERSION) throw new HostServiceBindingError('selected_unavailable', `Context budget service version ${version} is unsupported`);
      if (explicit) selected = true;
    }
    if (revision !== undefined) selections.set(key, { routingRevision: routing.document.revision, hostRevision: revision, selected });
    return { key, routing, revision, selected };
  };
  return {
    selected: async (scope, signal) => (await selection(scope, signal)).selected,
    async decide(scope, input, signal) {
      const current = await selection(scope, signal);
      // Selection may have changed since the short prepare query. Only this actual decision
      // captures a provider generation; merely installing a provider never selects it.
      if (!current.selected) return undefined;
      const cached = bindings.get(current.key);
      let binding: HostServiceBinding;
      if (current.revision !== undefined && cached?.routingRevision === current.routing.document.revision && cached.hostRevision === current.revision) {
        binding = cached.binding;
      } else {
        binding = await waitWithSignal(runtime.prepareService({ serviceId: VARIN_CONTEXT_BUDGET_SERVICE_ID,
          version: VARIN_CONTEXT_BUDGET_VERSION, method: 'describe', args: [], routing: routingScope(scope) },
        { expectedRoutingRevision: current.routing.document.revision }), signal);
      }
      const pin = binding.pin();
      const bindingRevision = runtime.preparationRevision;
      const callSignal = AbortSignal.any([signal, pin.revocationSignal]);
      try {
        let prepared = cached?.binding.providerId===binding.providerId ? cached.prepared : undefined;
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
        const revision = runtime.preparationRevision;
        if (revision !== undefined && revision === bindingRevision) bindings.set(current.key,
          { routingRevision: current.routing.document.revision, hostRevision: revision, binding, prepared });
        return { decision, strategy: structuredClone(prepared.strategy) };
      } finally { pin.release(); }
    },
  };
}

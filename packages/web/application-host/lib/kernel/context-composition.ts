import { createHash } from 'node:crypto';
import { ApplicationExtensionRuntime, HostCompositionPreparationRequiredError, HostServiceBindingError } from '@varin/extension-host';
import { VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinContextFragments, VARIN_CONTEXT_FRAGMENTS_SERVICE_ID, VARIN_CONTEXT_FRAGMENTS_VERSION,
  VARIN_CONTEXT_FRAGMENTS_METHOD, type VarinHostServiceComposition } from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import type { ContextComposition, ContextTransform } from './protocol.generated.js';

export interface ContextCompositionPreparer {
  (scope: { threadId: string; projectId?: string; workspaceId?: string; configurationDirectory?: string }, signal?: AbortSignal): Promise<ContextComposition | undefined>;
}
interface Declaration {
  providerKey: string;
  composition: VarinHostServiceComposition;
  transform: ContextTransform;
}
/** Only selected immutable declarations cross this boundary. This is preparation, never a
 * callback on conversation history, a retrieval operation or permission to perform effects.
 * The cache retains data and its composition proof, never a worker or service lease.
 */
export function createContextComposition(runtime: ApplicationExtensionRuntime): ContextCompositionPreparer {
  const prepared = new Map<string, { value: ContextComposition; scopeKey: string; declarations: readonly Declaration[] }>();
  return async (scope, signal) => {
    signal?.throwIfAborted();
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Context contribution routing is unavailable');
    const scopeKey = JSON.stringify([scope.threadId, scope.projectId ?? null, scope.workspaceId ?? null, scope.configurationDirectory ?? null]);
    const cached = prepared.get(scope.threadId);
    const request = { serviceId: VARIN_CONTEXT_FRAGMENTS_SERVICE_ID,
      version: VARIN_CONTEXT_FRAGMENTS_VERSION, method: VARIN_CONTEXT_FRAGMENTS_METHOD, args: [],
      routing: { userId: 'default', threadId: scope.threadId, ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.configurationDirectory ? { configurationDirectory: scope.configurationDirectory } : {}) } };
    const options = { expectedRoutingRevision: routing.document.revision, ...(signal ? { signal } : {}),
      defaultProviderKey: `${VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID}:host:${VARIN_CONTEXT_FRAGMENTS_SERVICE_ID}@${VARIN_CONTEXT_FRAGMENTS_VERSION}` };
    if (cached?.scopeKey === scopeKey) {
      // Resolve the same authoritative declaration graph without borrowing an active generation.
      // A changed/cold built-in may first need materialization through ordinary preparation.
      let resolved;
      try { resolved = await runtime.resolveServiceCompositions(request, { ...options, collection: true }); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof HostServiceBindingError && error.code === 'missing') {
          prepared.delete(scope.threadId);
          return undefined;
        }
        if (!(error instanceof HostCompositionPreparationRequiredError)) throw error;
      }
      if (resolved && resolved.services.length === cached.declarations.length
        && resolved.services.every((service, index) => service.providerKey === cached.declarations[index]!.providerKey
          && service.composition.root === cached.declarations[index]!.composition.root)) {
        signal?.throwIfAborted();
        return structuredClone(cached.value);
      }
    }
    let collection;
    try { collection = await runtime.prepareServiceCollection(request, options); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof HostServiceBindingError && error.code === 'missing') {
        prepared.delete(scope.threadId);
        return undefined;
      }
      throw error;
    }
    try {
      signal?.throwIfAborted();
      const declarations = await Promise.all(collection.bindings.map(async (binding): Promise<Declaration> => {
        const composition = binding.composition;
        if (!composition) throw new Error('Context contribution composition identity is unavailable');
        const previous = cached?.declarations.find(declaration => declaration.providerKey === binding.providerKey
          && declaration.composition.root === composition.root);
        binding.assertAvailable();
        if (previous) return previous;
        const pin = binding.pin();
        try {
          const callSignal = signal ? AbortSignal.any([signal, pin.revocationSignal]) : pin.revocationSignal;
          // The registry retains the real callback even when caller cancellation ends this wait.
          const fragments = parseVarinContextFragments(await waitWithSignal(pin.invoke(VARIN_CONTEXT_FRAGMENTS_METHOD, [], callSignal), callSignal));
          pin.assertAvailable();
          return { providerKey: binding.providerKey, composition, transform: { providerId: binding.providerId,
            contentVersion: createHash('sha256').update(JSON.stringify({ provider: binding.providerKey, fragments })).digest('hex'),
            sections: fragments.sections } };
        } finally { pin.release(); }
      }));
      const current = await runtime.resolveServiceCompositions(request, { ...options, collection: true });
      if (current.services.length !== declarations.length || current.services.some((service, index) =>
        service.providerKey !== declarations[index]!.providerKey || service.composition.root !== declarations[index]!.composition.root)) {
        throw new Error('Context contribution selection changed during preparation');
      }
      for (const binding of collection.bindings) binding.assertAvailable();
      signal?.throwIfAborted();
      const transforms = declarations.map(declaration => declaration.transform);
      const previous = cached?.value;
      const value: ContextComposition = previous && transforms.length === previous.transforms.length
        && transforms.every((transform, index) => transform === previous.transforms[index]) ? previous
        : { scopeId: scope.threadId, selectionRevision: routing.document.revision, transforms };
      prepared.set(scope.threadId, { value, scopeKey, declarations });
      return structuredClone(value);
    } finally { for (const binding of collection.bindings) binding.release(); }
  };
}

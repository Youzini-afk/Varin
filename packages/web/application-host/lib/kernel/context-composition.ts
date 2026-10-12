import { createHash } from 'node:crypto';
import { ApplicationExtensionRuntime, HostServiceBindingError, type HostServiceBinding } from '@varin/extension-host';
import { VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinContextFragments, VARIN_CONTEXT_FRAGMENTS_SERVICE_ID, VARIN_CONTEXT_FRAGMENTS_VERSION,
  VARIN_CONTEXT_FRAGMENTS_METHOD } from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import type { ContextComposition, ContextTransform } from './protocol.generated.js';

export interface ContextCompositionPreparer {
  (scope: { sessionId: string; projectId?: string; workspaceId?: string }, signal?: AbortSignal): Promise<ContextComposition | undefined>;
}
/** Only selected immutable declarations cross this boundary. This is preparation, never a
 * callback on conversation history, a retrieval operation or permission to perform effects.
 */
export function createContextComposition(runtime: ApplicationExtensionRuntime): ContextCompositionPreparer {
  const prepared = new Map<string, { value: ContextComposition; scopeKey: string; routingRevision: number;
    hostRevision: number | undefined; bindings: readonly HostServiceBinding[] }>();
  return async (scope, signal) => {
    signal?.throwIfAborted();
    const routing = await waitWithSignal(runtime.routing.read(), signal);
    if (!routing.authoritative) throw new Error('Context contribution routing is unavailable');
    const scopeKey = JSON.stringify([scope.sessionId, scope.projectId ?? null, scope.workspaceId ?? null]);
    const cached = prepared.get(scope.sessionId);
    const assertBindings = (bindings: readonly HostServiceBinding[]) => {
      for (const binding of bindings) runtime.services.bind(VARIN_CONTEXT_FRAGMENTS_SERVICE_ID, VARIN_CONTEXT_FRAGMENTS_VERSION, binding.providerId);
    };
    if (cached && cached.scopeKey === scopeKey && cached.routingRevision === routing.document.revision
      && cached.hostRevision !== undefined && cached.hostRevision === runtime.preparationRevision) {
      assertBindings(cached.bindings);
      signal?.throwIfAborted();
      return structuredClone(cached.value);
    }
    let collection;
    try {
      collection = await waitWithSignal(runtime.prepareServiceCollection({ serviceId: VARIN_CONTEXT_FRAGMENTS_SERVICE_ID,
        version: VARIN_CONTEXT_FRAGMENTS_VERSION, method: VARIN_CONTEXT_FRAGMENTS_METHOD, args: [],
        routing: { userId: 'default', sessionId: scope.sessionId, ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) },
      }, { expectedRoutingRevision: routing.document.revision,
        defaultProviderKey: `${VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID}:host:${VARIN_CONTEXT_FRAGMENTS_SERVICE_ID}@${VARIN_CONTEXT_FRAGMENTS_VERSION}` }), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof HostServiceBindingError && error.code === 'missing') {
        prepared.delete(scope.sessionId);
        return undefined;
      }
      throw error;
    }
    signal?.throwIfAborted();
    const previous = cached?.value;
    const transforms = await Promise.all(collection.bindings.map(async (binding): Promise<ContextTransform> => {
      const pin = binding.pin();
      try {
        const cached = previous?.transforms.find(transform => transform.providerId === binding.providerId);
        if (cached) { pin.assertAvailable(); return cached; }
        const callSignal = signal ? AbortSignal.any([signal, pin.revocationSignal]) : pin.revocationSignal;
        // Cancellation ends this wait. The service registry retains the actual invocation until
        // its handler settles; releasing our pin does not claim the worker callback has drained.
        const fragments = parseVarinContextFragments(await waitWithSignal(pin.invoke(VARIN_CONTEXT_FRAGMENTS_METHOD, [], callSignal), callSignal));
        pin.assertAvailable();
        return { providerId: binding.providerId,
          contentVersion: createHash('sha256').update(JSON.stringify({ provider: binding.providerKey, fragments })).digest('hex'),
          sections: fragments.sections };
      } finally { pin.release(); }
    }));
    signal?.throwIfAborted();
    const currentRouting = await waitWithSignal(runtime.routing.read(), signal);
    if (!currentRouting.authoritative || currentRouting.document.revision !== routing.document.revision) {
      throw new Error('Context contribution selection changed during preparation');
    }
    // Exact-index checks reject retirement/revocation without scanning all registered services.
    assertBindings(collection.bindings);
    signal?.throwIfAborted();
    const value: ContextComposition = previous && transforms.length === previous.transforms.length
      && transforms.every((transform, index) => transform === previous.transforms[index]) ? previous
      : { scopeId: scope.sessionId, selectionRevision: routing.document.revision, transforms };
    prepared.set(scope.sessionId, { value, scopeKey, routingRevision: routing.document.revision,
      hostRevision: runtime.preparationRevision, bindings: collection.bindings });
    return structuredClone(value);
  };
}

import { createHash } from 'node:crypto';
import { ApplicationExtensionRuntime, HostServiceBindingError } from '@varin/extension-host';
import { VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinContextFragments, VARIN_CONTEXT_FRAGMENTS_SERVICE_ID, VARIN_CONTEXT_FRAGMENTS_VERSION,
  VARIN_CONTEXT_FRAGMENTS_METHOD } from '@varin/extension-contract';
import type { NativeContextComposition } from './protocol.generated.js';

export interface NativeContextCompositionPreparer {
  (scope: { sessionId: string; projectId?: string }): Promise<NativeContextComposition | undefined>;
}
/** Selected worker preparation only. No history, prompt, credentials or file contents are sent.
 * The service returns declarative sections; the actual pure Transform runs natively against the
 * prepared request context. Its prepared output and exact selection become checkpoint provenance.
 */
export function createNativeContextComposition(runtime: ApplicationExtensionRuntime): NativeContextCompositionPreparer {
  const prepared = new Map<string, { providerId: string; value: NativeContextComposition }>();
  return async scope => {
    const routing = await runtime.routing.read();
    if (!routing.authoritative) throw new Error('Context contribution routing is unavailable');
    let binding;
    try {
      binding = await runtime.prepareService({ serviceId: VARIN_CONTEXT_FRAGMENTS_SERVICE_ID,
        version: VARIN_CONTEXT_FRAGMENTS_VERSION, method: VARIN_CONTEXT_FRAGMENTS_METHOD, args: [],
        routing: { sessionId: scope.sessionId, ...(scope.projectId ? { projectId: scope.projectId } : {}) },
      }, { defaultProviderKey: `${VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION_ID}:host:${VARIN_CONTEXT_FRAGMENTS_SERVICE_ID}@${VARIN_CONTEXT_FRAGMENTS_VERSION}` });
    } catch (error) {
      if (error instanceof HostServiceBindingError && error.code === 'missing') {
        prepared.delete(scope.sessionId);
        return undefined;
      }
      throw error; // An explicitly selected but unavailable implementation is never an empty success.
    }
    const assertCurrent = async () => {
      const currentRouting = await runtime.routing.read();
      if (!currentRouting.authoritative || currentRouting.document.revision !== routing.document.revision
        || !runtime.services.getSnapshot().providers.some(provider => provider.providerId === binding.providerId && provider.status === 'active')) {
        throw new Error('Context contribution selection changed during preparation');
      }
    };
    const previous = prepared.get(scope.sessionId);
    if (previous && previous.providerId === binding.providerId) {
      await assertCurrent();
      // This declarative contract has no input/configuration arguments. An unrelated routing
      // revision does not change an already-selected immutable implementation or its provenance.
      return structuredClone(previous.value);
    }
    const fragments = parseVarinContextFragments(await binding.invoke(VARIN_CONTEXT_FRAGMENTS_METHOD, []));
    await assertCurrent();
    const value: NativeContextComposition = {
      providerId: binding.providerId, scopeId: scope.sessionId, selectionRevision: routing.document.revision,
      contentVersion: createHash('sha256').update(JSON.stringify({ provider: binding.providerKey, fragments })).digest('hex'),
      sections: fragments.sections,
    };
    prepared.set(scope.sessionId, { providerId: binding.providerId, value });
    return structuredClone(value);
  };
}

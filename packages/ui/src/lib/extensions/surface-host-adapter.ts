import type { ExtensionsAPI } from '@varin/application-client';
import type { SurfaceExtensionHost } from '@varin/extension-loader';

type SurfaceHostAPI = Pick<ExtensionsAPI, keyof SurfaceExtensionHost>;

export const createSurfaceExtensionHost = (current: () => SurfaceHostAPI): SurfaceExtensionHost => ({
  activateExtension: async extensionId => current().activateExtension(extensionId),
  catalog: async () => current().catalog(),
  discardPreparedCandidate: async (extensionId, integrity) => current().discardPreparedCandidate(extensionId, integrity),
  hostState: async () => current().hostState(),
  invokeService: async (request, signal) => current().invokeService(request, signal),
  watchServiceLease: async (request, onEvent, signal) => current().watchServiceLease(request, onEvent, signal),
  prepareCandidate: async (extensionId, integrity, signal) => current().prepareCandidate(extensionId, integrity, signal),
  requestCandidateApplication: async request => current().requestCandidateApplication(request),
  readAsset: async request => current().readAsset(request),
  readManagedEntrypoint: async request => current().readManagedEntrypoint(request),
  reportActualState: async (extensionId, state) => current().reportActualState(extensionId, state),
  selectCandidate: async (request, signal) => current().selectCandidate(request, signal),
  waitForHostState: async (request, signal) => current().waitForHostState(request, signal),
});

/** Runtime API facades can resolve the current endpoint at call time. Never reuse one across epochs. */
export const captureSurfaceExtensionHost = (
  current: () => SurfaceHostAPI, currentGeneration: () => number, api = current(),
): SurfaceExtensionHost => {
  const generation = currentGeneration();
  return createSurfaceExtensionHost(() => {
    if (generation !== currentGeneration() || api !== current()) {
      throw new Error('Application Host changed during candidate application; the original operation was not retargeted.');
    }
    return api;
  });
};

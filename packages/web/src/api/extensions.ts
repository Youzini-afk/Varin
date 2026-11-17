import {
  parseVarinRuntimeContractResult,
  parseVarinSurfaceServiceLeaseEvent,
  parseVarinExtensionCatalogAvailability,
  parseVarinExtensionAssetPayload,
  parseVarinExtensionCatalogSnapshot,
  parseVarinExtensionCandidatePreparationResult,
  parseVarinExtensionHostStateSnapshot,
  parseVarinExtensionLocalSourceReloadResult,
  parseVarinExtensionManagedEntrypointPayload,
  parseVarinExtensionServiceRoutingSnapshot,
  parseVarinWorkbenchProfileSnapshot,
  type VarinExtensionActualState,
  type VarinExtensionAssetRequest,
  type VarinExtensionCandidateCapabilityReviewRequest,
  type VarinExtensionCapabilityReviewRequest,
  type VarinExtensionCandidateSelectionRequest,
  type VarinExtensionCandidatePublicationRequest,
  type VarinExtensionCatalogAvailability,
  type VarinExtensionManagedEntrypointRequest,
  type VarinExtensionPackageInstallRequest,
  type VarinExtensionHostStateWaitRequest,
  type VarinExtensionLocalSourceReloadRequest,
} from '@varin/extension-contract';
import type { ExtensionsAPI } from '@varin/application-client';
import { createPluginCenterHttpAPI } from '@varin/application-client';
import { buildLocalRuntimeAuthHeaders } from '@varin/application-client';
import { fetchWithoutRuntimeRouting, getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, runtimeFetch } from '@varin/application-client';
import { isCapacitorApp } from '@varin/ui/lib/platform';

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '');

const applicationHostOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = typeof window.__VARIN_LOCAL_ORIGIN__ === 'string'
    ? normalizeOrigin(window.__VARIN_LOCAL_ORIGIN__)
    : '';
  return injected || normalizeOrigin(window.location.origin);
};

const errorResult = (message: string, retryable: boolean): VarinExtensionCatalogAvailability => ({
  supported: true,
  status: 'error',
  error: { code: 'application_host_unavailable', message, retryable },
});

const fetchApplicationHost = async (path: string, init: RequestInit): Promise<Response> => {
  // Capacitor serves UI assets locally; its extension owner is the connected Host.
  if (isCapacitorApp()) {
    if (!getRuntimeApiBaseUrl()) throw new Error('Connect to a Varin Host to use extensions');
    const endpoint = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(path, { ...init, credentials: 'include' });
    if (endpoint !== getRuntimeEndpointGeneration()) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('Application Host changed during the extension request');
    }
    return response;
  }
  const origin = applicationHostOrigin();
  const target = origin ? new URL(path, `${origin}/`) : new URL(path, window.location.href);
  const headers = await buildLocalRuntimeAuthHeaders(origin, init.headers);
  return fetchWithoutRuntimeRouting(target, { ...init, credentials: 'include', headers });
};

const applicationHostRequest = (
  path: string,
  body: unknown,
  signal?: AbortSignal,
  method = 'POST',
  accept = 'application/json',
): Promise<Response> => fetchApplicationHost(path, {
  body: JSON.stringify(body),
  headers: { Accept: accept, 'Content-Type': 'application/json' },
  method,
  signal,
});

const applicationHostRead = (path: string): Promise<Response> => (
  fetchApplicationHost(path, { headers: { Accept: 'application/json' } })
);

const readJsonOrThrow = async (response: Response): Promise<unknown> => {
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return payload;
  const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
  const detail = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  const message = detail || `Varin extension host request failed (${response.status})`;
  throw new Error(message);
};

const readHostState = async (request: Promise<Response>) => {
  const endpoint = isCapacitorApp() ? getRuntimeEndpointGeneration() : undefined;
  const payload = await readJsonOrThrow(await request);
  // A response may have arrived before the switch while its body was still being read.
  if (endpoint !== undefined && endpoint !== getRuntimeEndpointGeneration()) {
    throw new Error('Application Host changed during the extension request');
  }
  return parseVarinExtensionHostStateSnapshot(payload);
};

export const createWebExtensionsAPI = (): ExtensionsAPI => ({
  pluginCenter: createPluginCenterHttpAPI(fetchApplicationHost),
  queryContracts: async (request, context, signal) => parseVarinRuntimeContractResult(
    await readJsonOrThrow(await applicationHostRequest(
      '/api/varin/extensions/v1/contracts/query', { request, ...(context ? { context } : {}) }, signal,
    )),
  ),
  activateExtension: async (extensionId) => {
    const response = await applicationHostRequest(`/api/varin/extensions/v1/extensions/${encodeURIComponent(extensionId)}/activate`, {});
    if (!response.ok) await readJsonOrThrow(response);
  },
  applyWorkbenchProfile: async (request) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/workbench/profiles/apply', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin workbench profile apply response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  catalog: async () => {
    try {
      const response = await applicationHostRead('/api/varin/extensions/v1/catalog');
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        try {
          const parsed = parseVarinExtensionCatalogAvailability(payload);
          if (parsed.supported === true && parsed.status === 'error') return parsed;
        } catch {
          // The HTTP status below remains the authoritative failure when the error body is malformed.
        }
        return errorResult(`Extension catalog request failed (${response.status})`, response.status >= 500);
      }
      return parseVarinExtensionCatalogAvailability(payload);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), true);
    }
  },
  discardPreparedCandidate: async (extensionId, candidateIntegrity) => {
    const response = await applicationHostRequest('/api/varin/extensions/v1/candidates/discard-prepared', { candidateIntegrity, extensionId });
    if (!response.ok) await readJsonOrThrow(response);
  },
  discardCandidate: async (request) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/discard', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension discard response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  hostState: () => readHostState(applicationHostRead('/api/varin/extensions/v1/host-state')),
  install: async (request: VarinExtensionPackageInstallRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/install', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension install response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  invokeService: async (request, signal) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/services/invoke', request, signal));
    if (!payload || typeof payload !== 'object' || !('result' in payload)) throw new Error('Varin Host service response is malformed');
    return JSON.parse(JSON.stringify((payload as { result: unknown }).result));
  },
  watchServiceLease: async (request, onEvent, signal) => {
    const response = await applicationHostRequest('/api/varin/extensions/v1/services/lease', request, signal, 'POST', 'text/event-stream');
    if (!response.ok) await readJsonOrThrow(response);
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Varin Surface service lease response is not an event stream');
    }
    const reader = response.body.getReader();
    const abortReader = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener('abort', abortReader, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    let data: string[] = [];
    const acceptLine = (line: string): void => {
      if (!line) {
        if (data.length) onEvent(parseVarinSurfaceServiceLeaseEvent(JSON.parse(data.join('\n'))));
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    };
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          acceptLine(buffer.slice(0, end).replace(/\r$/, ''));
          buffer = buffer.slice(end + 1);
        }
        if (done) {
          if (buffer || data.length) throw new Error('Varin Surface service lease stream ended with an incomplete event');
          return;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abortReader);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
  prepareCandidate: async (extensionId, candidateIntegrity, signal) => {
    const response = await applicationHostRequest('/api/varin/extensions/v1/candidates/prepare', { candidateIntegrity, extensionId }, signal);
    return parseVarinExtensionCandidatePreparationResult(await readJsonOrThrow(response));
  },
  requestRestartHandoff: async request => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/restart-handoff', request));
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  recoverRestartHandoff: async request => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/recover-restart-handoff', request));
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  requestCandidateApplication: async (request: VarinExtensionCandidateSelectionRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/request-application', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension candidate application response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  readAsset: async (request: VarinExtensionAssetRequest) => (
    parseVarinExtensionAssetPayload(await readJsonOrThrow(
      await applicationHostRequest('/api/varin/extensions/v1/assets/read', request),
    ))
  ),
  readManagedEntrypoint: async (request: VarinExtensionManagedEntrypointRequest) => (
    parseVarinExtensionManagedEntrypointPayload(await readJsonOrThrow(
      await applicationHostRequest('/api/varin/extensions/v1/entrypoints/read', request),
    ))
  ),
  reloadLocalSource: async (request: VarinExtensionLocalSourceReloadRequest) => (
    parseVarinExtensionLocalSourceReloadResult(await readJsonOrThrow(await applicationHostRequest(
      `/api/varin/extensions/v1/extensions/${encodeURIComponent(request.extensionId)}/reload-local-source`,
      request,
    )))
  ),
  reportActualState: async (extensionId: string, state: VarinExtensionActualState) => {
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/actual', { extensionId, state }))
      .catch((error) => {
        // A successful actual-state report intentionally has no response body.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      });
  },
  reviewCapabilities: async (request: VarinExtensionCapabilityReviewRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/review-capabilities', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension capability review response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  reviewCandidateCapabilities: async (request: VarinExtensionCandidateCapabilityReviewRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/review-capabilities', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension capability review response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  selectCandidate: async (request: VarinExtensionCandidatePublicationRequest, signal) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/candidates/select', request, signal));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension candidate response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  setEnabled: async (extensionId, enabled, expectedRevision) => {
    const payload = await readJsonOrThrow(await applicationHostRequest(
      `/api/varin/extensions/v1/extensions/${encodeURIComponent(extensionId)}/enabled`,
      { enabled, expectedRevision },
      undefined,
      'PATCH',
    ));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension enabled response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  upsertServiceRoutingRule: async (request) => parseVarinExtensionServiceRoutingSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/services/routing', request, undefined, 'PUT')),
  ),
  removeServiceRoutingRule: async (request) => parseVarinExtensionServiceRoutingSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/services/routing/remove', request)),
  ),
  removeExtension: async (request) => {
    const payload = await readJsonOrThrow(await applicationHostRequest(
      `/api/varin/extensions/v1/extensions/${encodeURIComponent(request.extensionId)}`,
      request,
      undefined,
      'DELETE',
    ));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Varin extension remove response is malformed');
    return parseVarinExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  updateWorkbenchLayout: async (request) => parseVarinWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/workbench/layout', request, undefined, 'PATCH')),
  ),
  selectWorkbenchProfile: async (request) => parseVarinWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/workbench/profile/select', request, undefined, 'PATCH')),
  ),
  upsertWorkbenchProfile: async (request) => parseVarinWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/workbench/profiles', request, undefined, 'PUT')),
  ),
  removeWorkbenchProfile: async (request) => parseVarinWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/varin/extensions/v1/workbench/profiles/remove', request)),
  ),
  waitForHostState: (request: VarinExtensionHostStateWaitRequest, signal?: AbortSignal) => (
    readHostState(applicationHostRequest('/api/varin/extensions/v1/host-state/wait', request, signal))
  ),
});

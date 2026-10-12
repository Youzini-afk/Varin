import { SurfaceExtensionLoader } from '@varin/extension-loader';
import {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
} from '@varin/extension-contract';
import type { RuntimeContextTarget } from '@varin/protocol';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getPiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { varinSurfaceRuntime } from './surface-runtime';
import { startBuiltinVarinExtensions } from './builtin-surface-manager';
import { surfaceCapabilityRegistry } from './surface-capabilities';
import { createMonacoExtensionExternalService } from '@/lib/monaco/extension-service';

const runtimeExtensions = () => {
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Varin application-host extension API is unavailable');
  return extensions;
};

let activeProjectTrusted = false;

export const setVarinExtensionProjectTrust = (trusted: boolean): void => {
  if (activeProjectTrusted === trusted) return;
  activeProjectTrusted = trusted;
  void surfaceExtensionLoader.reconcile();
};

export const surfaceExtensionLoader = new SurfaceExtensionLoader({
  accessContext: () => ({
    access: varinSurfaceRuntime.surface === 'desktop'
      || (typeof window !== 'undefined' && typeof window.__VARIN_LOCAL_ORIGIN__ === 'string')
      ? 'local'
      : 'remote',
    projectTrusted: activeProjectTrusted,
  }),
  host: {
    activateExtension: (extensionId) => runtimeExtensions().activateExtension(extensionId),
    catalog: () => runtimeExtensions().catalog(),
    discardPreparedCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().discardPreparedCandidate(extensionId, candidateIntegrity),
    hostState: () => runtimeExtensions().hostState(),
    invokeService: (request) => runtimeExtensions().invokeService(request),
    prepareCandidate: (extensionId, candidateIntegrity, signal) => runtimeExtensions().prepareCandidate(extensionId, candidateIntegrity, signal),
    requestCandidateApplication: (request) => runtimeExtensions().requestCandidateApplication(request),
    readAsset: (request) => runtimeExtensions().readAsset(request),
    readManagedEntrypoint: (request) => runtimeExtensions().readManagedEntrypoint(request),
    reportActualState: (extensionId, state) => runtimeExtensions().reportActualState(extensionId, state),
    selectCandidate: (request, signal) => runtimeExtensions().selectCandidate(request, signal),
    waitForHostState: (request, signal) => runtimeExtensions().waitForHostState(request, signal),
  },
  capabilities: surfaceCapabilityRegistry,
  externalServiceFactories: varinSurfaceRuntime.surface === 'desktop' || varinSurfaceRuntime.surface === 'web'
    ? [{
        create: createMonacoExtensionExternalService,
        descriptor: {
          id: VARIN_EDITOR_MONACO_SERVICE_ID,
          version: VARIN_EDITOR_MONACO_SERVICE_VERSION,
        },
        providerId: 'varin.builtin.text',
      }]
    : [],
  surface: varinSurfaceRuntime.surface,
  surfaceRuntime: varinSurfaceRuntime,
});

let trustOwnerKey = '';
let trustGeneration = 0;

const trustTarget = (): RuntimeContextTarget | null => {
  const state = usePiSessionStore.getState();
  if (state.currentSessionId) return { sessionId: state.currentSessionId };
  if (state.catalogCwd) return { cwd: state.catalogCwd };
  return null;
};

const refreshProjectTrustOwner = (): void => {
  const target = trustTarget();
  const runtimeKey = getRuntimeKey();
  const nextOwnerKey = JSON.stringify([runtimeKey, target]);
  if (nextOwnerKey === trustOwnerKey) return;
  trustOwnerKey = nextOwnerKey;
  const generation = ++trustGeneration;
  setVarinExtensionProjectTrust(false);
  if (!target) return;
  void surfaceExtensionLoader.triggerActivation('workspace-match').catch((error) => {
    console.error('[Varin Extensions] Workspace Surface activation failed:', error);
  });
  void getPiSettings(target).then((settings) => {
    if (generation !== trustGeneration || nextOwnerKey !== trustOwnerKey || runtimeKey !== getRuntimeKey()) return;
    setVarinExtensionProjectTrust(settings.projectTrusted);
  }).catch(() => {
    // A failed read is not evidence of either trusted or untrusted state. The new owner stays untrusted
    // until a complete authoritative catalog is observed.
  });
};

usePiSessionStore.subscribe((state, previous) => {
  if (state.currentSessionId !== previous.currentSessionId || state.catalogCwd !== previous.catalogCwd) {
    refreshProjectTrustOwner();
  }
});
subscribeRuntimeEndpointChanged(refreshProjectTrustOwner);
refreshProjectTrustOwner();

let initialReconcile: Promise<void> | null = null;

export const startSurfaceExtensions = (): Promise<void> => {
  initialReconcile ??= Promise.all([
    surfaceExtensionLoader.start(),
    startBuiltinVarinExtensions(),
  ]).then(() => undefined).catch((error) => {
    initialReconcile = null;
    throw error;
  });
  return initialReconcile;
};

export const refreshSurfaceExtensions = (): Promise<void> => (
  surfaceExtensionLoader.reconcile()
);

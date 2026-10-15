import { SurfaceExtensionLoader } from '@varin/extension-loader';
import {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
} from '@varin/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { readProjectTrust, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { getRuntimeKey, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { getResolvedWorkbenchWorkspaceId, subscribeWorkbenchWorkspace } from './workbench-workspace';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { varinSurfaceRuntime } from './surface-runtime';
import { surfaceServiceRoutingContext } from './surface-routing-context';
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
  reconcileSurfaceContext();
};

export const surfaceExtensionLoader = new SurfaceExtensionLoader({
  accessContext: (state) => {
    const directory = useDirectoryStore.getState().currentDirectory;
    const workspaceId = directory ? getResolvedWorkbenchWorkspaceId(directory) : undefined;
    const identity = useThreadStore.getState().selectedIdentity;
    return {
      access: varinSurfaceRuntime.surface === 'desktop'
        || (typeof window !== 'undefined' && typeof window.__VARIN_LOCAL_ORIGIN__ === 'string') ? 'local' : 'remote',
      projectTrusted: activeProjectTrusted,
      routing: surfaceServiceRoutingContext({
        surface: varinSurfaceRuntime.surface, runtimeId: getRuntimeKey(),
        ...(state ? { snapshot: state } : {}), ...(identity ? { threadId: identity.threadId, branchId: identity.branchId } : {}),
        ...(directory ? { configurationDirectory: directory } : {}),
        ...(workspaceId ? { documentWorkspaceId: workspaceId } : {}),
      }),
    };
  },
  host: {
    activateExtension: (extensionId) => runtimeExtensions().activateExtension(extensionId),
    catalog: () => runtimeExtensions().catalog(),
    discardPreparedCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().discardPreparedCandidate(extensionId, candidateIntegrity),
    hostState: () => runtimeExtensions().hostState(),
    invokeService: (request, signal) => runtimeExtensions().invokeService(request, signal),
    watchServiceLease: (request, onEvent, signal) => runtimeExtensions().watchServiceLease(request, onEvent, signal),
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
        providerKey: `varin.builtin.text:surface:${VARIN_EDITOR_MONACO_SERVICE_ID}@${VARIN_EDITOR_MONACO_SERVICE_VERSION}`,
      }]
    : [],
  surface: varinSurfaceRuntime.surface,
  surfaceRuntime: varinSurfaceRuntime,
});

function reconcileSurfaceContext(): void {
  if (!getRegisteredRuntimeAPIs()?.extensions) return;
  void surfaceExtensionLoader.reconcile().catch((error) => {
    console.error('[Varin Extensions] Surface context reconciliation failed:', error);
  });
}

let trustOwnerKey = '';
let trustGeneration = 0;

const refreshProjectTrustOwner = (force = false): void => {
  const directory = useDirectoryStore.getState().currentDirectory;
  const workspaceId = directory ? getResolvedWorkbenchWorkspaceId(directory) : undefined;
  const endpoint = getRuntimeEndpointGeneration();
  const runtimeKey = getRuntimeKey();
  const nextOwnerKey = JSON.stringify([endpoint, runtimeKey, workspaceId]);
  if (!force && nextOwnerKey === trustOwnerKey) return;
  trustOwnerKey = nextOwnerKey;
  const generation = ++trustGeneration;
  setVarinExtensionProjectTrust(false);
  reconcileSurfaceContext();
  if (!workspaceId) return;
  void surfaceExtensionLoader.triggerActivation('workspace-match').catch((error) => {
    console.error('[Varin Extensions] Workspace Surface activation failed:', error);
  });
  void readProjectTrust(workspaceId).then((trust) => {
    if (generation !== trustGeneration || nextOwnerKey !== trustOwnerKey || runtimeKey !== getRuntimeKey()) return;
    setVarinExtensionProjectTrust(trust.decision === true);
  }).catch(() => {
    // A failed read is not evidence of either trusted or untrusted state. The new owner stays untrusted
    // until a complete authoritative catalog is observed.
  });
};

useThreadStore.subscribe((state, previous) => {
  if (state.selectedIdentity !== previous.selectedIdentity) reconcileSurfaceContext();
});
useDirectoryStore.subscribe((state, previous) => {
  if (state.currentDirectory !== previous.currentDirectory) refreshProjectTrustOwner();
});
subscribeWorkbenchWorkspace(() => refreshProjectTrustOwner());
subscribeProjectTrustChanges(() => refreshProjectTrustOwner(true));
subscribeRuntimeEndpointChanged(() => refreshProjectTrustOwner());
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

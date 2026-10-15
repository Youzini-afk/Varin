import type {
  VarinExtensionActualState,
  VarinExtensionCatalogEntry,
} from '@varin/extension-contract';
import type { SurfaceOwnerIdentity } from '@varin/extension-surface';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import {
  BUILTIN_SURFACE_EXTENSION_DEFINITIONS,
  activateBuiltinSurfaceExtension,
} from './builtin-surface-extensions';
import {
  getVarinExtensionCatalogState,
  startVarinExtensionCatalog,
  subscribeVarinExtensionCatalog,
} from './catalog-store';
import { varinSurfaceRuntime } from './surface-runtime';

interface ControllerState {
  active: boolean;
  generation: number;
  hostId: string | null;
  lastDesiredRevision: number;
  lastEnabled: boolean | null;
  owner: SurfaceOwnerIdentity | null;
}

const realmId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `builtin-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const controllers = new Map<string, ControllerState>();
let startPromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let reconcileQueue: Promise<void> = Promise.resolve();

const controllerFor = (extensionId: string): ControllerState => {
  const current = controllers.get(extensionId);
  if (current) return current;
  const created: ControllerState = {
    active: false,
    generation: 0,
    hostId: null,
    lastDesiredRevision: 0,
    lastEnabled: null,
    owner: null,
  };
  controllers.set(extensionId, created);
  return created;
};

const extensionsApi = () => (
  getRegisteredRuntimeAPIs()?.extensions
);

const reportActual = async (entry: VarinExtensionCatalogEntry): Promise<void> => {
  const hostId = getVarinExtensionCatalogState().snapshot?.catalog.hostId;
  const actual = varinSurfaceRuntime.getSnapshot().actual.find((state) => (
    state.extensionId === entry.manifest.id
    && state.realmId === realmId
    && state.entrypointId === 'main'
    && state.hostId === hostId
  ));
  if (!actual) return;
  const state: VarinExtensionActualState = {
    desiredRevision: actual.desiredRevision,
    diagnostics: actual.diagnostics,
    entrypointId: actual.entrypointId,
    generation: actual.generation,
    hostId: actual.hostId,
    realmId: actual.realmId,
    realmKind: actual.realmKind,
    status: actual.status,
    updatedAt: actual.updatedAt,
  };
  await extensionsApi()?.reportActualState(entry.manifest.id, state).catch(() => undefined);
};

const reconcileEntry = async (entry: VarinExtensionCatalogEntry): Promise<void> => {
  const definition = BUILTIN_SURFACE_EXTENSION_DEFINITIONS.find((candidate) => (
    candidate.manifest.id === entry.manifest.id
  ));
  if (!definition) return;
  const controller = controllerFor(entry.manifest.id);
  const hostId = getVarinExtensionCatalogState().snapshot?.catalog.hostId;
  if (!hostId) return;
  if (
    controller.hostId === hostId
    && controller.lastDesiredRevision === entry.desired.revision
    && controller.lastEnabled === entry.desired.enabled
  ) return;

  if (controller.owner && controller.hostId !== hostId) {
    controller.generation += 1;
    await varinSurfaceRuntime.deactivate({
      ...controller.owner,
      desiredRevision: controller.owner.desiredRevision + 1,
      generation: controller.generation,
    });
    controller.active = false;
    controller.owner = null;
  }

  controller.generation += 1;
  const owner: SurfaceOwnerIdentity = {
    desiredRevision: entry.desired.revision,
    entrypointId: 'main',
    extensionId: entry.manifest.id,
    extensionVersion: entry.manifest.version,
    generation: controller.generation,
    hostId,
    realmId,
  };
  controller.hostId = hostId;
  controller.lastDesiredRevision = entry.desired.revision;
  controller.lastEnabled = entry.desired.enabled;
  controller.owner = owner;
  try {
    if (entry.desired.enabled) {
      await varinSurfaceRuntime.activate(
        { owner },
        activateBuiltinSurfaceExtension(definition, varinSurfaceRuntime.surface),
      );
      controller.active = true;
    } else {
      await varinSurfaceRuntime.deactivate(owner);
      controller.active = false;
    }
  } finally {
    await reportActual(entry);
  }
};

const reconcile = (): Promise<void> => {
  const operation = async () => {
    const snapshot = getVarinExtensionCatalogState().snapshot?.catalog;
    if (!snapshot?.authoritative) return;
    for (const definition of BUILTIN_SURFACE_EXTENSION_DEFINITIONS) {
      const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === definition.manifest.id);
      if (entry) await reconcileEntry(entry);
    }
  };
  const result = reconcileQueue.then(operation, operation);
  reconcileQueue = result.catch(() => undefined);
  return result;
};

export const startBuiltinVarinExtensions = (): Promise<void> => {
  if (startPromise) return startPromise;
  if (!extensionsApi()) return Promise.resolve();
  unsubscribe ??= subscribeVarinExtensionCatalog(() => {
    void reconcile().catch((error) => {
      console.error('[Varin Extensions] Failed to reconcile a built-in integration:', error);
    });
  });
  startPromise = startVarinExtensionCatalog()
    .then(() => reconcile())
    .catch((error) => {
      startPromise = null;
      throw error;
    });
  return startPromise;
};

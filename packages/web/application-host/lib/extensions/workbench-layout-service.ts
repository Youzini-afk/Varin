import {
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_CORE_SERVICE_VERSION,
  VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
} from '@varin/extension-contract';
import type { JsonObject, JsonValue, VarinExtensionStorageAddress } from '@varin/extension-contract';
import type { HostServiceHandler, HostServiceOwnerIdentity, HostServiceProvision } from '@varin/extension-host';

const OWNER = {
  entrypointId: 'workbench-layout',
  instanceKey: 'application-workbench-layout',
  extensionId: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  generation: 1,
};

interface WorkbenchLayoutStorage {
  read(address: VarinExtensionStorageAddress): Promise<unknown>;
  update(
    address: VarinExtensionStorageAddress,
    expectedRevision: number,
    schemaVersion: number,
    document: JsonObject,
  ): Promise<unknown>;
}

interface WorkbenchLayoutRuntime {
  catalog: {
    snapshot(): Promise<{ extensions: Array<{ manifest: { id: string; version: string } }> }>;
  };
  services: {
    drainOwner(owner: HostServiceOwnerIdentity): Promise<void>;
    removeOwner(owner: HostServiceOwnerIdentity): void;
    replaceOwner(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[]): Promise<void>;
  };
  storage: WorkbenchLayoutStorage;
}

const object = (value: unknown, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
};

const jsonValue = (value: unknown, label = 'value'): JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]),
    );
  }
  throw new TypeError(`${label} must be JSON-safe`);
};

const addressFor = (input: JsonObject): VarinExtensionStorageAddress => {
  const profileId = text(input.profileId, 'profileId');
  const workspaceId = input.workspaceId === undefined || input.workspaceId === null
    ? null
    : text(input.workspaceId, 'workspaceId');
  return {
    extensionId: OWNER.extensionId,
    key: JSON.stringify({ profileId, workspaceId }),
    scope: workspaceId ? 'workspace' : 'profile',
  };
};

export const createWorkbenchLayoutServiceHandler = (
  storage: WorkbenchLayoutStorage,
): ((method: string, args: JsonValue[]) => Promise<JsonValue>) => async (method, args) => {
  const input = object(args[0], 'workbench layout request');
  const address = addressFor(input);
  if (method === 'read') return jsonValue(await storage.read(address));
  if (method === 'write') {
    if (typeof input.expectedRevision !== 'number' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative integer');
    }
    const document = object(input.document, 'document');
    return jsonValue(await storage.update(address, input.expectedRevision, 1, document));
  }
  throw new Error(`Unsupported workbench layout service method: ${method}`);
};

export const registerBuiltinWorkbenchLayoutService = async (
  extensionRuntime: WorkbenchLayoutRuntime,
): Promise<() => Promise<void>> => {
  const catalog = await extensionRuntime.catalog.snapshot();
  const entry = catalog.extensions.find((candidate) => candidate.manifest.id === OWNER.extensionId);
  if (!entry) throw new Error('Built-in IDE Workbench extension is not installed');
  const owner = { ...OWNER, extensionVersion: entry.manifest.version };
  const handler: HostServiceHandler = createWorkbenchLayoutServiceHandler(extensionRuntime.storage);
  await extensionRuntime.services.replaceOwner(owner, [{
    descriptor: {
      id: VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
      multiple: true,
      version: VARIN_CORE_SERVICE_VERSION,
    },
    handler,
  }]);
  return async () => {
    await extensionRuntime.services.drainOwner(owner);
    extensionRuntime.services.removeOwner(owner);
  };
};

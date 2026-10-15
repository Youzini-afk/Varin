import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceOwnerIdentity,
} from "@varin/extension-surface";
import type {
  JsonObject,
  JsonValue,
  VarinEditorDocumentApplyEditsResult,
  VarinEditorDocumentController,
  VarinEditorDocumentEdit,
  VarinEditorDocumentSnapshot,
  VarinEditorDocumentUpdateResult,
  VarinExtensionAssetPayload,
  VarinExtensionServiceProvision,
  VarinExtensionStaticContribution,
  VarinExtensionStorageOpenRequest,
  VarinExtensionStorageSnapshot,
  VarinHostServiceDependencyBinding,
} from "@varin/extension-contract";
import {
  defaultVarinWorkbenchProfileDocument,
  inspectVarinWorkbenchShell,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
  resolveVarinWorkbenchProfile,
  createHostServiceDependencyClients,
} from "@varin/extension-contract";
import type {
  VarinBrokeredHostContext,
  VarinBrokeredHostExtension,
  VarinHostServiceHandler,
  VarinIsolatedSurfaceExtension,
  VarinEditorMountProps,
  VarinSurfaceMountImplementation,
} from "./index.js";
import { isAbsolute, relative, resolve } from "node:path";
import {
  VARIN_WORKSPACE_DOCUMENTS_CAPABILITY,
  VARIN_WORKSPACE_LANGUAGE_CAPABILITY,
  VARIN_WORKSPACE_DEBUG_CAPABILITY,
  VARIN_WORKSPACE_TEST_CAPABILITY,
  VARIN_WORKSPACE_TASKS_CAPABILITY,
  createWorkspaceDocumentsClient,
  defineSurfaceMount,
} from "./index.js";

export interface SurfaceConformanceResult {
  activeContributionIds: string[];
  activeServiceIds: string[];
  finalRevision: number;
}

export const runSurfaceExtensionConformance = async (options: {
  activation: SurfaceActivation;
  owner: SurfaceOwnerIdentity;
  runtime: SurfaceExtensionRuntime;
}): Promise<SurfaceConformanceResult> => {
  await options.runtime.activate({ owner: options.owner }, options.activation);
  const active = options.runtime.getSnapshot();
  const activeContributionIds = active.contributions
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  const activeServiceIds = active.services
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  await options.runtime.deactivate({
    ...options.owner,
    desiredRevision: options.owner.desiredRevision + 1,
    generation: options.owner.generation + 1,
  });
  const inactive = options.runtime.getSnapshot();
  if (inactive.contributions.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked contributions after deactivation");
  }
  if (inactive.services.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked services after deactivation");
  }
  return { activeContributionIds, activeServiceIds, finalRevision: inactive.revision };
};

export interface HostConformanceResult {
  finalStorage: VarinExtensionStorageSnapshot;
  finalStorages: VarinExtensionStorageSnapshot[];
  providedServiceIds: string[];
  registeredDisposers: number;
}

export interface IsolatedConformanceResult {
  contributionIds: string[];
  registeredDisposers: number;
}

export interface VarinIsolatedConformanceService {
  descriptor: VarinExtensionServiceProvision;
  implementation: Record<string, (...args: JsonValue[]) => JsonValue | Promise<JsonValue>>;
  providerId?: string;
}

const asRecord = (value: JsonValue | undefined): JsonObject | null => (
  value && typeof value === "object" && !Array.isArray(value) ? value : null
);

const createConformanceCapabilities = () => {
  const files = new Map<string, { content: string; revision: string }>();
  const providers = new Map<string, JsonObject>();
  const call = async (capability: string, method: string, params: JsonValue): Promise<JsonValue> => {
    if (capability === VARIN_WORKSPACE_DOCUMENTS_CAPABILITY) {
      const record = asRecord(params) ?? {};
      const resource = asRecord(record.resource) ?? record;
      const key = `${String(resource.workspaceId ?? "")}\0${String(resource.resourceId ?? "")}`;
      if (method === "read") {
        const file = files.get(key);
        if (!file) return { status: "missing", resource };
        return {
          status: "ready",
          resource,
          revision: file.revision,
          content: file.content,
          encoding: "utf-8",
          bom: false,
          byteLength: file.content.length,
        };
      }
      if (method === "write") {
        const current = files.get(key);
        if (record.expectedRevision !== undefined && record.expectedRevision !== null && current?.revision !== record.expectedRevision) {
          return {
            status: "conflict",
            current: current
              ? { status: "ready", resource, revision: current.revision, encoding: "utf-8", bom: false, byteLength: current.content.length }
              : { status: "missing", resource },
          };
        }
        const revision = `c${files.size + 1}`;
        const content = typeof record.content === "string" ? record.content : "";
        files.set(key, { content, revision });
        return { status: "written", revision, byteLength: content.length };
      }
    }
    if (capability === VARIN_WORKSPACE_LANGUAGE_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerProvider") {
        const providerId = String(record.providerId ?? "");
        providers.set(providerId, record);
        return { status: "registered", providerId };
      }
      if (method === "unregisterProvider") {
        const providerId = String(record.providerId ?? "");
        providers.delete(providerId);
        return { status: "unregistered", providerId };
      }
      if (method === "getStatus") return { status: providers.size > 0 ? "ready" : "absent" };
      if (method === "disposeWorkspace") {
        providers.clear();
        return { status: "disposed" };
      }
    }
    if (capability === VARIN_WORKSPACE_TASKS_CAPABILITY) {
      if (method === "list") return { status: "empty", configurations: [] };
      if (method === "run") return { status: "running" };
      if (method === "disposeWorkspace") return { status: "disposed" };
    }
    if (capability === VARIN_WORKSPACE_DEBUG_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerAdapter") return { status: "registered", adapterId: String(record.adapterId ?? "") };
      if (method === "unregisterAdapter") return { status: "unregistered", adapterId: String(record.adapterId ?? "") };
      if (method === "getStatus") return { status: "absent" };
    }
    if (capability === VARIN_WORKSPACE_TEST_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerProvider") return { status: "registered", providerId: String(record.providerId ?? "") };
      if (method === "unregisterProvider") return { status: "unregistered", providerId: String(record.providerId ?? "") };
      if (method === "discover") return { status: "empty", tests: [] };
    }
    throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
  };
  return { call, files, providers };
};

export const runIsolatedExtensionConformance = async (options: {
  activation: VarinIsolatedSurfaceExtension["activate"];
  grantedCapabilities?: readonly string[];
  services?: readonly VarinIsolatedConformanceService[];
}): Promise<IsolatedConformanceResult> => {
  const controller = new AbortController();
  const contributions = new Map<string, VarinExtensionStaticContribution>();
  const contextValues = new Map<string, string | number | boolean>();
  const disposers: Array<() => void | Promise<void>> = [];
  const grantedCapabilities = new Set(options.grantedCapabilities ?? []);
  const services = [...(options.services ?? [])];
  const capabilities = createConformanceCapabilities();
  const emptyIntegrity = `sha256-${"0".repeat(64)}`;
  const returned = await options.activation({
    assets: {
      read: async (path): Promise<VarinExtensionAssetPayload> => ({
        artifactIntegrity: emptyIntegrity,
        bytesBase64: "",
        contentType: "application/octet-stream",
        integrity: emptyIntegrity,
        path,
      }),
    },
    capabilities: {
      call: async (capability, method, params) => {
        if (!grantedCapabilities.has(capability)) {
          throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
        }
        return capabilities.call(capability, method, params);
      },
      has: (capability) => grantedCapabilities.has(capability),
    },
    context: {
      delete: async (key) => contextValues.delete(key),
      set: async (key, value) => {
        contextValues.set(key, value);
        return true;
      },
    },
    contribute: (descriptor) => {
      if (contributions.has(descriptor.id)) throw new Error(`Isolated contribution provided more than once: ${descriptor.id}`);
      contributions.set(descriptor.id, descriptor);
    },
    effect: (disposer) => { disposers.push(disposer); },
    services: {
      call: async (id, version, method, args, providerId) => {
        const service = services.find((candidate) => (
          candidate.descriptor.id === id
          && candidate.descriptor.version === version
          && (!providerId || candidate.providerId === providerId)
        ));
        const handler = service?.implementation[method];
        if (typeof handler !== "function") {
          throw new Error(`Conformance dependency is not provided: ${id}@${version}.${method}`);
        }
        return handler(...args);
      },
      has: async (id, version, providerId) => services.some((candidate) => (
        candidate.descriptor.id === id
        && candidate.descriptor.version === version
        && (!providerId || candidate.providerId === providerId)
      )),
      use: (id, version, providerId) => new Proxy({}, {
        get: (_target, property) => property === "then" || typeof property !== "string"
          ? undefined
          : (...args: JsonValue[]) => {
              const service = services.find((candidate) => (
                candidate.descriptor.id === id
                && candidate.descriptor.version === version
                && (!providerId || candidate.providerId === providerId)
              ));
              const handler = service?.implementation[property];
              if (typeof handler !== "function") {
                throw new Error(`Conformance dependency is not provided: ${id}@${version}.${property}`);
              }
              return handler(...args);
            },
      }) as never,
    },
    signal: controller.signal,
  });
  if (typeof returned === "function") disposers.push(returned);
  const contributionIds = [...contributions.keys()].sort();
  const registeredDisposers = disposers.length;
  controller.abort("Isolated extension conformance deactivation");
  const cleanupErrors: string[] = [];
  while (disposers.length > 0) {
    try { await disposers.pop()?.(); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  contributions.clear();
  if (cleanupErrors.length > 0) throw new Error(`Isolated extension cleanup failed: ${cleanupErrors.join("; ")}`);
  return { contributionIds, registeredDisposers };
};

export const runHostExtensionConformance = async (options: {
  activation: VarinBrokeredHostExtension["activate"];
  extensionId: string;
  initialData?: JsonObject;
  packageRoot?: string;
  storageSchemaVersion?: number;
  dependencies: readonly VarinHostServiceDependencyBinding[];
  invokeDependency?: (request: import('@varin/extension-contract').VarinExtensionServiceInvocationRequest) => Promise<JsonValue>;
}): Promise<HostConformanceResult> => {
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  const services = new Map<string, VarinHostServiceHandler>();
  const storageKey = (request: Pick<VarinExtensionStorageOpenRequest, "key" | "scope">): string => (
    `${request.scope}\0${request.key}`
  );
  const createStorage = (request: VarinExtensionStorageOpenRequest): VarinExtensionStorageSnapshot => ({
    address: { extensionId: options.extensionId, key: request.key, scope: request.scope },
    authoritative: true,
    diagnostics: [],
    document: {
      data: structuredClone(options.initialData ?? {}),
      revision: 0,
      schemaVersion: request.schemaVersion ?? options.storageSchemaVersion ?? 1,
      updatedAt: new Date(0).toISOString(),
    },
    exists: options.initialData !== undefined,
    storageState: options.initialData === undefined ? "missing" : "ready",
  });
  const storages = new Map<string, VarinExtensionStorageSnapshot>();
  storages.set(storageKey({ key: "state", scope: "application" }), createStorage({
    key: "state",
    schemaVersion: options.storageSchemaVersion ?? 1,
    scope: "application",
  }));
  const storageClient = (request: VarinExtensionStorageOpenRequest) => {
    const key = storageKey(request);
    if (!storages.has(key)) storages.set(key, createStorage(request));
    return {
      get snapshot() { return structuredClone(storages.get(key) as VarinExtensionStorageSnapshot); },
      refresh: async () => structuredClone(storages.get(key) as VarinExtensionStorageSnapshot),
      update: async (data: JsonObject, expectedRevision?: number) => {
        const current = storages.get(key) as VarinExtensionStorageSnapshot;
        const revision = expectedRevision ?? current.document.revision;
        if (revision !== current.document.revision) {
          throw new Error(`Conformance storage revision conflict: expected ${revision}, current ${current.document.revision}`);
        }
        const next: VarinExtensionStorageSnapshot = {
          ...current,
          document: {
            ...current.document,
            data: structuredClone(data),
            revision: current.document.revision + 1,
            schemaVersion: request.schemaVersion ?? current.document.schemaVersion,
            updatedAt: new Date().toISOString(),
          },
          exists: true,
          storageState: "ready",
        };
        storages.set(key, next);
        return structuredClone(next);
      },
    };
  };
  const defaultStorage = storageClient({
    key: "state",
    schemaVersion: options.storageSchemaVersion ?? 1,
    scope: "application",
  });
  const capabilities = createConformanceCapabilities();
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  const context: VarinBrokeredHostContext = {
    assets: {
      path: (logicalPath) => {
        if (!logicalPath || logicalPath.includes("\\") || logicalPath.includes("\0") || isAbsolute(logicalPath)) {
          throw new Error("Host asset path must be a non-empty package-relative path");
        }
        const target = resolve(packageRoot, ...logicalPath.split("/"));
        const fromRoot = relative(packageRoot, target);
        if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
          throw new Error(`Host asset path escapes the extension package: ${logicalPath}`);
        }
        return target;
      },
    },
    capabilities: {
      call: (capability, method, params) => capabilities.call(capability, method, params),
    },
    effect: (disposer) => { disposers.push(disposer); },
    services: {
      ...createHostServiceDependencyClients(options.dependencies, request => {
        if (!options.invokeDependency) throw new Error(`Conformance dependency is not provided: ${request.serviceId}@${request.version}.${request.method}`);
        return options.invokeDependency(request);
      }),
      provide: (descriptor: VarinExtensionServiceProvision, handler: VarinHostServiceHandler) => {
        const key = `${descriptor.id}@${descriptor.version}`;
        if (services.has(key)) throw new Error(`Host service provided more than once: ${key}`);
        services.set(key, handler);
      },
    },
    signal: controller.signal,
    storage: {
      get snapshot() { return defaultStorage.snapshot; },
      open: async (request) => storageClient(request),
      refresh: () => defaultStorage.refresh(),
      update: (data, expectedRevision) => defaultStorage.update(data, expectedRevision),
    },
  };
  const returned = await options.activation(context);
  if (typeof returned === "function") disposers.push(returned);
  const providedServiceIds = [...services.keys()].sort();
  const registeredDisposers = disposers.length;
  controller.abort("Host extension conformance deactivation");
  const cleanupErrors: string[] = [];
  while (disposers.length > 0) {
    try { await disposers.pop()?.(); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  services.clear();
  if (cleanupErrors.length > 0) throw new Error(`Host extension cleanup failed: ${cleanupErrors.join("; ")}`);
  return {
    finalStorage: defaultStorage.snapshot,
    finalStorages: [...storages.values()].map((snapshot) => structuredClone(snapshot)),
    providedServiceIds,
    registeredDisposers,
  };
};

export interface SurfaceMountConformanceResult {
  aborted: boolean;
  disposed: boolean;
  mounted: boolean;
}

export const runSurfaceMountConformance = async (): Promise<SurfaceMountConformanceResult> => {
  const controller = new AbortController();
  const container = { textContent: "" } as HTMLElement;
  let disposed = false;
  const implementation = defineSurfaceMount(async (element, context) => {
    await Promise.resolve();
    if (context.signal.aborted) return;
    element.textContent = "ready";
    return () => {
      disposed = true;
      element.textContent = "";
    };
  });
  const cleanup = await implementation.mount(container, {
    contributionId: "dev.example.mount.shell",
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.mount",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "72694a4f-093a-4f79-8763-3ca9f06b7078",
      realmId: "mount-conformance",
    },
    props: {},
    reportError: (error) => { throw error; },
    signal: controller.signal,
  });
  const mounted = container.textContent === "ready";
  controller.abort("runtime-switch");
  if (typeof cleanup === "function") await cleanup();
  return { aborted: controller.signal.aborted, disposed, mounted };
};

export interface VarinEditorDocumentControllerFixture {
  readonly controller: VarinEditorDocumentController;
  readonly subscriberCount: number;
  setStatus(status: VarinEditorDocumentSnapshot["status"]): void;
}

export const createVarinEditorDocumentControllerFixture = (
  initialContent = "alpha",
): VarinEditorDocumentControllerFixture => {
  const listeners = new Set<() => void>();
  let snapshot: VarinEditorDocumentSnapshot = {
    baseRevision: "fixture-0",
    content: initialContent,
    dirty: false,
    documentVersion: 0,
    saving: false,
    status: "ready",
  };
  const publish = (): void => {
    for (const listener of listeners) listener();
  };
  const mutationUnavailable = (): Extract<
    VarinEditorDocumentUpdateResult,
    { status: "conflict" | "unsupported" }
  > | null => {
    if (snapshot.status === "conflict") return { snapshot: structuredClone(snapshot), status: "conflict" };
    if (snapshot.status !== "ready") return { snapshot: structuredClone(snapshot), status: "unsupported" };
    return null;
  };
  const controller: VarinEditorDocumentController = {
    applyEdits: async (edits, expectedDocumentVersion): Promise<VarinEditorDocumentApplyEditsResult> => {
      if (expectedDocumentVersion !== snapshot.documentVersion) {
        return { snapshot: structuredClone(snapshot), status: "stale" };
      }
      const unavailable = mutationUnavailable();
      if (unavailable) return unavailable;
      const indexed = edits.map((edit, index) => ({ ...edit, index }));
      if (indexed.some((edit) => (
        !Number.isSafeInteger(edit.from)
        || !Number.isSafeInteger(edit.to)
        || edit.from < 0
        || edit.to < edit.from
        || edit.to > snapshot.content.length
      ))) return { snapshot: structuredClone(snapshot), status: "invalid-range" };
      const ascending = [...indexed].sort((left, right) => (
        left.from - right.from || left.to - right.to || left.index - right.index
      ));
      for (let index = 1; index < ascending.length; index += 1) {
        const previous = ascending[index - 1] as VarinEditorDocumentEdit;
        const next = ascending[index] as VarinEditorDocumentEdit;
        if (previous.to > next.from) {
          return { snapshot: structuredClone(snapshot), status: "overlapping-ranges" };
        }
      }
      let content = snapshot.content;
      for (const edit of [...indexed].sort((left, right) => (
        right.from - left.from || right.to - left.to || right.index - left.index
      ))) content = `${content.slice(0, edit.from)}${edit.insert}${content.slice(edit.to)}`;
      if (indexed.length > 0) {
        snapshot = {
          ...snapshot,
          content,
          dirty: true,
          documentVersion: snapshot.documentVersion + 1,
        };
        publish();
      }
      return { snapshot: structuredClone(snapshot), status: "applied" };
    },
    getSnapshot: () => structuredClone(snapshot),
    replaceContent: async (content, expectedDocumentVersion) => {
      if (expectedDocumentVersion !== snapshot.documentVersion) {
        return { snapshot: structuredClone(snapshot), status: "stale" };
      }
      const unavailable = mutationUnavailable();
      if (unavailable) return unavailable;
      if (content !== snapshot.content) {
        snapshot = {
          ...snapshot,
          content,
          dirty: true,
          documentVersion: snapshot.documentVersion + 1,
        };
        publish();
      }
      return { snapshot: structuredClone(snapshot), status: "updated" };
    },
    save: async (expectedDocumentVersion) => {
      if (expectedDocumentVersion !== snapshot.documentVersion) {
        return { snapshot: structuredClone(snapshot), status: "stale" };
      }
      const unavailable = mutationUnavailable();
      if (unavailable) return unavailable;
      snapshot = {
        ...snapshot,
        baseRevision: `fixture-${snapshot.documentVersion}`,
        dirty: false,
      };
      publish();
      return { snapshot: structuredClone(snapshot), status: "updated" };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    controller,
    get subscriberCount() { return listeners.size; },
    setStatus: (status) => {
      snapshot = { ...snapshot, status };
      publish();
    },
  };
};

export interface EditorExtensionConformanceResult {
  aborted: boolean;
  appliedStatus: VarinEditorDocumentApplyEditsResult["status"];
  conflictStatus: VarinEditorDocumentApplyEditsResult["status"];
  disposed: boolean;
  invalidStatus: VarinEditorDocumentApplyEditsResult["status"];
  overlappingStatus: VarinEditorDocumentApplyEditsResult["status"];
  staleStatus: VarinEditorDocumentApplyEditsResult["status"];
  subscriptionsReleased: boolean;
  unsupportedStatus: VarinEditorDocumentApplyEditsResult["status"];
}

export const runEditorExtensionConformance = async (options: {
  implementation: VarinSurfaceMountImplementation<VarinEditorMountProps>;
}): Promise<EditorExtensionConformanceResult> => {
  const fixture = createVarinEditorDocumentControllerFixture();
  const controller = new AbortController();
  const container = { textContent: "" } as HTMLElement;
  const cleanup = await options.implementation.mount(container, {
    contributionId: "dev.example.editor.editor",
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.editor",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "72694a4f-093a-4f79-8763-3ca9f06b7078",
      realmId: "editor-conformance",
    },
    props: {
      document: fixture.controller,
      providerId: "dev.example.editor.editor",
      resource: { resourceId: "notes.md", workspaceId: "workspace-fixture" },
      viewId: "view-fixture",
    },
    reportError: (error) => { throw error; },
    signal: controller.signal,
  });
  const applied = await fixture.controller.applyEdits([{ from: 0, insert: "beta", to: 5 }], 0);
  const stale = await fixture.controller.applyEdits([{ from: 0, insert: "x", to: 0 }], 0);
  const version = fixture.controller.getSnapshot().documentVersion;
  const invalid = await fixture.controller.applyEdits([{ from: -1, insert: "x", to: 0 }], version);
  const overlapping = await fixture.controller.applyEdits([
    { from: 0, insert: "x", to: 2 },
    { from: 1, insert: "y", to: 3 },
  ], version);
  fixture.setStatus("conflict");
  const conflict = await fixture.controller.applyEdits([], version);
  fixture.setStatus("binary");
  const unsupported = await fixture.controller.applyEdits([], version);
  controller.abort("Editor extension conformance deactivation");
  let disposed = false;
  if (typeof cleanup === "function") {
    await cleanup();
    disposed = true;
  }
  return {
    aborted: controller.signal.aborted,
    appliedStatus: applied.status,
    conflictStatus: conflict.status,
    disposed,
    invalidStatus: invalid.status,
    overlappingStatus: overlapping.status,
    staleStatus: stale.status,
    subscriptionsReleased: fixture.subscriberCount === 0,
    unsupportedStatus: unsupported.status,
  };
};

export interface WorkbenchProfileConformanceResult {
  afterSwitch: string;
  beforeSwitch: string;
  desiredEnabledUnchanged: boolean;
  failedCandidateKeepsPrevious: boolean;
}

export const runWorkbenchProfileConformance = (): WorkbenchProfileConformanceResult => {
  const document = defaultVarinWorkbenchProfileDocument();
  document.profiles.push({ id: "studio", label: "Studio" });
  document.layouts.push({
    profileId: "studio",
    references: [],
    replacementSelections: { [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.studio.shell" },
    scope: "distribution",
    scopeId: "studio",
    surface: "web",
  });
  const extensions = [{
    actual: [],
    capabilityGrants: [],
    desired: { enabled: true, revision: 1, updatedAt: "2026-08-20T00:00:00.000Z" },
    installedAt: "2026-08-20T00:00:00.000Z",
    manifest: {
      engines: { varin: "*" },
      id: "dev.example.studio",
      schemaVersion: 1 as const,
      version: "1.0.0",
      contributions: [{
        contractVersion: 1,
        data: {
          contract: VARIN_WORKBENCH_SHELL_DATA_CONTRACT,
          seams: {
            web: { replacementTargets: [], slots: [] },
          },
        },
        id: "dev.example.studio.shell",
        kind: "shell" as const,
        replacement: { target: VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell },
        supports: ["web" as const],
      }],
    },
    resolvedVersion: "1.0.0",
    selectedVersion: "1.0.0",
    source: { display: "Studio", kind: "local" as const },
    updatedAt: "2026-08-20T00:00:00.000Z",
  }];
  const before = resolveVarinWorkbenchProfile(document, extensions, { surface: "web", userId: "default" });
  document.profileSelections.users.default = "studio";
  const after = resolveVarinWorkbenchProfile(document, extensions, { surface: "web", userId: "default" });
  const failed = inspectVarinWorkbenchShell(
    after.layout.replacementSelections,
    [{ ...extensions[0]!, desired: { ...extensions[0]!.desired, enabled: false } }],
    "web",
  );
  return {
    beforeSwitch: before.profileId,
    afterSwitch: after.profileId,
    desiredEnabledUnchanged: extensions[0]?.desired.enabled === true,
    failedCandidateKeepsPrevious: failed.status === "disabled",
  };
};

export const runIsolatedDocumentConflictConformance = async (): Promise<{ status: string }> => {
  let status = "missing";
  await runIsolatedExtensionConformance({
    grantedCapabilities: [VARIN_WORKSPACE_DOCUMENTS_CAPABILITY],
    activation: async (context) => {
      const documents = createWorkspaceDocumentsClient(context.capabilities);
      const resource = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" };
      await documents.write({ resource, content: "one", encoding: "utf-8", bom: false, expectedRevision: null, operationId: "op-1" });
      const conflict = await documents.write({
        resource,
        content: "two",
        encoding: "utf-8",
        bom: false,
        expectedRevision: "stale",
        operationId: "op-2",
      }) as { status?: string };
      status = conflict.status ?? "missing";
    },
  });
  return { status };
};

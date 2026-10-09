import type {
  SurfaceActivationContext,
  SurfaceOwnerIdentity,
} from "@varin/extension-surface";
import type {
  JsonObject,
  JsonValue,
  VarinContextValue,
  VarinEditorDocumentController,
  VarinEditorMonacoClearDecorationsRequestV1,
  VarinEditorMonacoExecuteActionRequestV1,
  VarinEditorMonacoOperationResultV1,
  VarinEditorMonacoRevealRequestV1,
  VarinEditorMonacoServiceV1,
  VarinEditorMonacoSetDecorationsRequestV1,
  VarinEditorMonacoSetSelectionRequestV1,
  VarinEditorMonacoStateResultV1,
  VarinEditorMonacoViewRequestV1,
  VarinEditorMonacoViewResultV1,
  VarinEditorMonacoWaitForStateRequestV1,
  VarinExtensionAssetPayload,
  VarinExtensionContributionKind,
  VarinExtensionServiceProvision,
  VarinExtensionServiceRoutingContext,
  VarinExtensionStaticContribution,
  VarinExtensionStorageOpenRequest,
  VarinExtensionStorageSnapshot,
  VarinTransitionSceneAnimatedPhase,
  VarinTransitionSceneFrameV1,
} from "@varin/extension-contract";
import {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
} from "@varin/extension-contract";

export interface VarinSurfaceAsset {
  bytes: Uint8Array;
  contentType: string;
  integrity: string;
  path: string;
}

export interface VarinSurfaceAssets {
  read(path: string): Promise<VarinSurfaceAsset>;
  url(path: string): Promise<string>;
}

export interface VarinSurfaceStyles {
  use(path: string): Promise<void>;
}

export interface VarinManagedSurfaceContext extends SurfaceActivationContext {
  readonly assets: VarinSurfaceAssets;
  readonly styles: VarinSurfaceStyles;
}

export type VarinSurfaceMountDisposer = () => void | Promise<void>;

/**
 * Per-mount state supplied by a Varin Surface host. The signal belongs to this
 * mounted view, so it is aborted for prop changes as well as owner teardown.
 */
export interface VarinSurfaceMountContext<TProps extends object = Record<string, unknown>> {
  readonly contributionId: string;
  readonly owner: Readonly<SurfaceOwnerIdentity>;
  readonly props: Readonly<TProps>;
  reportError(error: unknown): void;
  readonly signal: AbortSignal;
}

export interface VarinEditorMountProps {
  document: VarinEditorDocumentController;
  providerId: string;
  resource: { resourceId: string; workspaceId: string };
  viewId: string;
}

/**
 * Stable per-transition external store. Varin owns the handoff transaction; a scene owns only its
 * rendering and may complete the current animated phase before its declared duration elapses.
 */
export interface VarinTransitionSceneControllerV1 {
  complete(transitionId: number, phase: VarinTransitionSceneAnimatedPhase): void;
  getSnapshot(): VarinTransitionSceneFrameV1;
  subscribe(listener: () => void): () => void;
}

export interface VarinTransitionSceneMountProps {
  transition: VarinTransitionSceneControllerV1;
}

export interface VarinIsolatedTransitionSceneFrameMessage {
  contributionId: string;
  frame: VarinTransitionSceneFrameV1;
  type: "motion.transition.frame";
}

export interface VarinIsolatedEditorMountMessage {
  contributionId: string;
  props: {
    providerId: string;
    resource: { resourceId: string; workspaceId: string };
    viewId: string;
  };
  type: "workbench.mount";
}

/** Framework-neutral runtime implementation for a DOM-backed contribution. */
export interface VarinSurfaceMountImplementation<TProps extends object = Record<string, unknown>> {
  mount(
    container: HTMLElement,
    context: VarinSurfaceMountContext<TProps>,
  ): void | VarinSurfaceMountDisposer | Promise<void | VarinSurfaceMountDisposer>;
}

export type VarinSurfaceMount<TProps extends object = Record<string, unknown>> =
  VarinSurfaceMountImplementation<TProps>["mount"];

export const defineSurfaceMount = <TProps extends object = Record<string, unknown>>(
  implementation: VarinSurfaceMount<TProps> | VarinSurfaceMountImplementation<TProps>,
): VarinSurfaceMountImplementation<TProps> => typeof implementation === "function"
  ? { mount: implementation }
  : implementation;

export type VarinManagedSurfaceActivation = (
  context: VarinManagedSurfaceContext,
) => void | Promise<void>;

export interface VarinManagedSurfaceExtension {
  activate: VarinManagedSurfaceActivation;
}

export type VarinManagedSurfaceModule = {
  activate?: VarinManagedSurfaceActivation;
  default?: VarinManagedSurfaceActivation | VarinManagedSurfaceExtension;
};

export const defineSurfaceExtension = (
  extension: VarinManagedSurfaceActivation | VarinManagedSurfaceExtension,
): VarinManagedSurfaceExtension => (
  typeof extension === "function" ? { activate: extension } : extension
);

export const resolveSurfaceExtensionModule = (
  module: VarinManagedSurfaceModule,
): VarinManagedSurfaceExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    return { activate: candidate.activate.bind(candidate) };
  }
  throw new Error("Managed Varin Surface module must export activate or a default extension definition");
};

export interface VarinIsolatedCapabilityClient {
  call(capability: string, method: string, params: JsonValue): Promise<JsonValue>;
  has(capability: string): boolean;
}

export interface VarinIsolatedServiceClient {
  call(
    id: string,
    version: number,
    method: string,
    args: JsonValue[],
    providerId?: string,
  ): Promise<JsonValue>;
  has(id: string, version: number, providerId?: string): Promise<boolean>;
  use<TImplementation = unknown>(id: string, version: number, providerId?: string): TImplementation;
}

export interface VarinIsolatedSurfaceContext {
  readonly assets: {
    read(path: string): Promise<VarinExtensionAssetPayload>;
  };
  readonly capabilities: VarinIsolatedCapabilityClient;
  readonly context: {
    delete(key: string): Promise<boolean>;
    set(key: string, value: VarinContextValue): Promise<boolean>;
  };
  contribute(descriptor: VarinExtensionStaticContribution, options?: { viewId?: string }): void;
  effect(disposer: () => void | Promise<void>): void;
  readonly services: VarinIsolatedServiceClient;
  readonly signal: AbortSignal;
}

export interface VarinEditorMonacoClientV1 {
  clearDecorations(request: VarinEditorMonacoClearDecorationsRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  executeAction(request: VarinEditorMonacoExecuteActionRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  focus(request?: VarinEditorMonacoViewRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  getActiveView(): Promise<VarinEditorMonacoViewResultV1>;
  getState(): Promise<VarinEditorMonacoStateResultV1>;
  getView(request?: VarinEditorMonacoViewRequestV1): Promise<VarinEditorMonacoViewResultV1>;
  reveal(request: VarinEditorMonacoRevealRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  setDecorations(request: VarinEditorMonacoSetDecorationsRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  setSelection(request: VarinEditorMonacoSetSelectionRequestV1): Promise<VarinEditorMonacoOperationResultV1>;
  waitForState(request: VarinEditorMonacoWaitForStateRequestV1): Promise<VarinEditorMonacoStateResultV1>;
}

type VarinEditorMonacoServiceContext =
  | Pick<VarinManagedSurfaceContext, "useService">
  | Pick<VarinIsolatedSurfaceContext, "services">;

const monacoServiceAbsent = (): VarinEditorMonacoOperationResultV1 => ({
  reason: "provider-inactive",
  status: "absent",
});

/**
 * Resolve the owner-bound optional Monaco service injected by the Surface runtime. The extension does
 * not provide an owner identity; managed and isolated callers receive the same serialized subset.
 */
export const createVarinEditorMonacoClient = (
  context: VarinEditorMonacoServiceContext,
): VarinEditorMonacoClientV1 => {
  const invoke = async <TResult extends VarinEditorMonacoOperationResultV1 | VarinEditorMonacoStateResultV1>(
    method: keyof VarinEditorMonacoServiceV1,
    args: JsonValue[],
  ): Promise<TResult> => {
    if ("useService" in context) {
      const service = context.useService<VarinEditorMonacoServiceV1>(
        VARIN_EDITOR_MONACO_SERVICE_ID,
        VARIN_EDITOR_MONACO_SERVICE_VERSION,
      );
      if (!service) return monacoServiceAbsent() as TResult;
      const handler = service[method] as (...values: unknown[]) => unknown;
      if (typeof handler !== "function") {
        return { reason: "operation-unavailable", status: "unsupported" } as TResult;
      }
      return await Promise.resolve(handler(...args)) as TResult;
    }
    const available = await context.services.has(
      VARIN_EDITOR_MONACO_SERVICE_ID,
      VARIN_EDITOR_MONACO_SERVICE_VERSION,
    );
    if (!available) return monacoServiceAbsent() as TResult;
    return await context.services.call(
      VARIN_EDITOR_MONACO_SERVICE_ID,
      VARIN_EDITOR_MONACO_SERVICE_VERSION,
      method,
      args,
    ) as TResult;
  };
  const requestArgs = (request: object | undefined): JsonValue[] => request === undefined
    ? []
    : [request as unknown as JsonValue];
  return {
    clearDecorations: (request) => invoke("clearDecorations", requestArgs(request)),
    executeAction: (request) => invoke("executeAction", requestArgs(request)),
    focus: (request) => invoke("focus", requestArgs(request)),
    getActiveView: () => invoke<VarinEditorMonacoViewResultV1>("getActiveView", []),
    getState: () => invoke<VarinEditorMonacoStateResultV1>("getState", []),
    getView: (request) => invoke<VarinEditorMonacoViewResultV1>("getView", requestArgs(request)),
    reveal: (request) => invoke("reveal", requestArgs(request)),
    setDecorations: (request) => invoke("setDecorations", requestArgs(request)),
    setSelection: (request) => invoke("setSelection", requestArgs(request)),
    waitForState: (request) => invoke<VarinEditorMonacoStateResultV1>("waitForState", requestArgs(request)),
  };
};

export type VarinIsolatedSurfaceActivation = (
  context: VarinIsolatedSurfaceContext,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export interface VarinIsolatedSurfaceExtension {
  activate: VarinIsolatedSurfaceActivation;
}

export type VarinIsolatedSurfaceModule = {
  activate?: VarinIsolatedSurfaceActivation;
  default?: VarinIsolatedSurfaceActivation | VarinIsolatedSurfaceExtension;
};

export const defineIsolatedExtension = (
  extension: VarinIsolatedSurfaceActivation | VarinIsolatedSurfaceExtension,
): VarinIsolatedSurfaceExtension => typeof extension === "function" ? { activate: extension } : extension;

export const resolveIsolatedExtensionModule = (
  module: VarinIsolatedSurfaceModule,
): VarinIsolatedSurfaceExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    return { activate: candidate.activate.bind(candidate) };
  }
  throw new Error("Isolated Varin Surface module must export activate or a default extension definition");
};

export interface VarinHostCapabilityClient {
  call(capability: string, method: string, params: JsonValue): Promise<JsonValue>;
}

export interface VarinHostServiceClient {
  call(method: string, ...args: JsonValue[]): Promise<JsonValue>;
}

export interface VarinHostServiceUseOptions {
  providerId?: string;
  routing?: VarinExtensionServiceRoutingContext;
}

export interface VarinHostServiceInvocationContext {
  /** Cooperative cancellation; an aborted signal does not prove an external effect was undone. */
  readonly signal: AbortSignal;
  readonly callId: string;
}

export type VarinHostServiceHandler = Record<string, (
  args: JsonValue[], call: VarinHostServiceInvocationContext,
) => JsonValue | Promise<JsonValue>>;

export interface VarinHostStorageDocumentClient {
  readonly snapshot: VarinExtensionStorageSnapshot;
  refresh(): Promise<VarinExtensionStorageSnapshot>;
  update(data: JsonObject, expectedRevision?: number): Promise<VarinExtensionStorageSnapshot>;
}

export interface VarinHostStorageClient extends VarinHostStorageDocumentClient {
  open(request: VarinExtensionStorageOpenRequest): Promise<VarinHostStorageDocumentClient>;
}

export interface VarinHostAssets {
  /** Resolve a forward-slash package-relative file to its immutable local path. */
  path(logicalPath: string): string;
}

export interface VarinBrokeredHostContext {
  readonly assets: VarinHostAssets;
  readonly capabilities: VarinHostCapabilityClient;
  effect(disposer: () => void | Promise<void>): void;
  readonly services: {
    provide(descriptor: VarinExtensionServiceProvision, handler: VarinHostServiceHandler): void;
    use(id: string, version: number, provider?: string | VarinHostServiceUseOptions): VarinHostServiceClient;
  };
  readonly signal: AbortSignal;
  readonly storage: VarinHostStorageClient;
}

export interface VarinExtensionMigrationInput {
  data: JsonObject;
  fromSchemaVersion: number;
  toSchemaVersion: number;
}

export interface VarinBrokeredHostExtension {
  activate(context: VarinBrokeredHostContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  migrate?(input: VarinExtensionMigrationInput): JsonObject | Promise<JsonObject>;
}

export type VarinBrokeredHostModule = {
  activate?: VarinBrokeredHostExtension["activate"];
  default?: VarinBrokeredHostExtension | VarinBrokeredHostExtension["activate"];
  migrate?: VarinBrokeredHostExtension["migrate"];
};

export const defineHostExtension = (
  extension: VarinBrokeredHostExtension | VarinBrokeredHostExtension["activate"],
): VarinBrokeredHostExtension => typeof extension === "function" ? { activate: extension } : extension;

export const resolveHostExtensionModule = (
  module: VarinBrokeredHostModule,
): VarinBrokeredHostExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate, ...(module.migrate ? { migrate: module.migrate } : {}) };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    const migrate = candidate.migrate?.bind(candidate) ?? module.migrate;
    return {
      activate: candidate.activate.bind(candidate),
      ...(migrate ? { migrate } : {}),
    };
  }
  throw new Error("Brokered Varin Host module must export activate or a default extension definition");
};

export const VARIN_WORKSPACE_DOCUMENTS_CAPABILITY = "workspace.documents";
export const VARIN_WORKSPACE_SEARCH_CAPABILITY = "workspace.search";
export const VARIN_WORKSPACE_LANGUAGE_CAPABILITY = "workspace.language";
export const VARIN_WORKSPACE_TASKS_CAPABILITY = "workspace.tasks";
export const VARIN_WORKSPACE_DEBUG_CAPABILITY = "workspace.debug";
export const VARIN_WORKSPACE_TEST_CAPABILITY = "workspace.test";
export const VARIN_WORKSPACE_RECOVERY_PRIMITIVES_CAPABILITY = "workspace.recovery-primitives";

export {
  VARIN_EDITOR_MONACO_SERVICE_ID,
  VARIN_EDITOR_MONACO_SERVICE_VERSION,
  VARIN_TRANSITION_SCENE_CONTRACT_VERSION,
  VARIN_TRANSITION_SCENE_DATA_CONTRACT,
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  VARIN_WORKBENCH_CONTEXT_KEYS,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_IDE_PROFILE_ID,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_WORKBENCH_SLOTS,
} from "@varin/extension-contract";

export type {
  VarinContextExpressionV1,
  VarinContextValue,
  VarinEditorDocumentApplyEditsResult,
  VarinEditorDocumentController,
  VarinEditorDocumentEdit,
  VarinEditorDocumentSnapshot,
  VarinEditorDocumentUpdateResult,
  VarinEditorMonacoAbsentReasonV1,
  VarinEditorMonacoClearDecorationsRequestV1,
  VarinEditorMonacoDecorationV1,
  VarinEditorMonacoExecuteActionRequestV1,
  VarinEditorMonacoFailureResultV1,
  VarinEditorMonacoOperationResultV1,
  VarinEditorMonacoPositionV1,
  VarinEditorMonacoRangeV1,
  VarinEditorMonacoRevealRequestV1,
  VarinEditorMonacoSelectionV1,
  VarinEditorMonacoServiceV1,
  VarinEditorMonacoSetDecorationsRequestV1,
  VarinEditorMonacoSetSelectionRequestV1,
  VarinEditorMonacoStateResultV1,
  VarinEditorMonacoStateSnapshotV1,
  VarinEditorMonacoStaleReasonV1,
  VarinEditorMonacoUnsupportedReasonV1,
  VarinEditorMonacoViewRequestV1,
  VarinEditorMonacoViewResultV1,
  VarinEditorMonacoViewSnapshotV1,
  VarinEditorMonacoWaitForStateRequestV1,
  VarinTransitionSceneAnimatedPhase,
  VarinTransitionSceneContributionDataV1,
  VarinTransitionSceneDirection,
  VarinTransitionSceneDurationSet,
  VarinTransitionSceneFrameV1,
  VarinTransitionSceneId,
  VarinTransitionScenePhase,
  VarinTransitionScenePhaseDurations,
  VarinTransitionSceneTempo,
} from "@varin/extension-contract";

export const defineViewMount = defineSurfaceMount;

// ---------------------------------------------------------------------------
// Shell composition host API
//
// A managed Shell can mount child contributions (replacements and slots) via
// the composition host. This is the public, framework-neutral API for
// external Shells that need to compose sub-regions without importing
// @varin/ui private modules.
// ---------------------------------------------------------------------------

export interface VarinWorkbenchChildMount {
  dispose(reason?: unknown): Promise<void>;
}

export interface VarinWorkbenchCompositionHost {
  mountReplacement(options: {
    container: HTMLElement;
    target: string;
    props?: JsonObject;
  }): Promise<VarinWorkbenchChildMount>;

  mountSlot(options: {
    container: HTMLElement;
    slot: string;
    kind?: VarinExtensionContributionKind;
    props?: JsonObject;
  }): Promise<VarinWorkbenchChildMount>;
}

export interface VarinShellMountContext<TProps extends object = Record<string, unknown>>
  extends VarinSurfaceMountContext<TProps> {
  readonly workbench: VarinWorkbenchCompositionHost;
}

export interface VarinShellMountImplementation<TProps extends object = Record<string, unknown>> {
  mount(
    container: HTMLElement,
    context: VarinShellMountContext<TProps>,
  ): void | VarinSurfaceMountDisposer | Promise<void | VarinSurfaceMountDisposer>;
}

export type VarinShellMount<TProps extends object = Record<string, unknown>> =
  VarinShellMountImplementation<TProps>["mount"];

export const defineShellMount = <TProps extends object = Record<string, unknown>>(
  implementation: VarinShellMount<TProps> | VarinShellMountImplementation<TProps>,
): VarinShellMountImplementation<TProps> => typeof implementation === "function"
  ? { mount: implementation }
  : implementation;
export const defineTransitionSceneMount = (
  implementation:
    | VarinSurfaceMount<VarinTransitionSceneMountProps>
    | VarinSurfaceMountImplementation<VarinTransitionSceneMountProps>,
): VarinSurfaceMountImplementation<VarinTransitionSceneMountProps> => defineSurfaceMount(implementation);
export const defineEditorMount = (
  implementation:
    | VarinSurfaceMount<VarinEditorMountProps>
    | VarinSurfaceMountImplementation<VarinEditorMountProps>,
): VarinSurfaceMountImplementation<VarinEditorMountProps> => defineSurfaceMount(implementation);

export const callWorkspaceDocuments = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_DOCUMENTS_CAPABILITY, method, params);

export const callWorkspaceSearch = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_SEARCH_CAPABILITY, method, params);

export const callWorkspaceLanguage = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_LANGUAGE_CAPABILITY, method, params);

export const callWorkspaceRecoveryPrimitives = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_RECOVERY_PRIMITIVES_CAPABILITY, method, params);

export interface VarinWorkspaceDocumentsClient {
  delete(request: JsonObject): Promise<JsonValue>;
  move(request: JsonObject): Promise<JsonValue>;
  read(resource: JsonObject): Promise<JsonValue>;
  resolveWorkspace(input: JsonObject): Promise<JsonValue>;
  write(request: JsonObject): Promise<JsonValue>;
}

export const createWorkspaceDocumentsClient = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
): VarinWorkspaceDocumentsClient => ({
  resolveWorkspace: (input) => callWorkspaceDocuments(capabilities, "resolveWorkspace", input),
  read: (resource) => callWorkspaceDocuments(capabilities, "read", resource),
  write: (request) => callWorkspaceDocuments(capabilities, "write", request),
  move: (request) => callWorkspaceDocuments(capabilities, "move", request),
  delete: (request) => callWorkspaceDocuments(capabilities, "delete", request),
});

export type VarinLanguageProviderDescriptor = {
  args?: readonly string[];
  command: string;
  initializationOptions?: JsonObject;
  languageIds: readonly string[];
  providerId: string;
  source?: string;
  workspaceId?: string;
};

export type VarinHostDescriptorFactory<TDescriptor> = (
  context: VarinBrokeredHostContext,
) => TDescriptor | Promise<TDescriptor>;

export interface VarinWorkspaceLanguageClient {
  disposeWorkspace(workspaceId: string): Promise<JsonValue>;
  getStatus(workspaceId: string, languageId?: string): Promise<JsonValue>;
  registerProvider(descriptor: VarinLanguageProviderDescriptor): Promise<JsonValue>;
  unregisterProvider(providerId: string): Promise<JsonValue>;
}

const languageProviderParams = (descriptor: VarinLanguageProviderDescriptor): JsonObject => {
  const params: JsonObject = {
    command: descriptor.command,
    languageIds: [...descriptor.languageIds],
    providerId: descriptor.providerId,
  };
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.initializationOptions) params.initializationOptions = structuredClone(descriptor.initializationOptions);
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

export const createWorkspaceLanguageClient = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
): VarinWorkspaceLanguageClient => ({
  registerProvider: (descriptor) => callWorkspaceLanguage(capabilities, "registerProvider", languageProviderParams(descriptor)),
  unregisterProvider: (providerId) => callWorkspaceLanguage(capabilities, "unregisterProvider", { providerId }),
  getStatus: (workspaceId, languageId) => callWorkspaceLanguage(capabilities, "getStatus", {
    workspaceId,
    ...(languageId ? { languageId } : {}),
  }),
  disposeWorkspace: (workspaceId) => callWorkspaceLanguage(capabilities, "disposeWorkspace", { workspaceId }),
});

export const defineLanguageProvider = (
  input: VarinLanguageProviderDescriptor | VarinHostDescriptorFactory<VarinLanguageProviderDescriptor>,
): VarinBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceLanguageClient(context.capabilities);
  await client.registerProvider({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterProvider(descriptor.providerId); });
});

export const callWorkspaceDebug = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_DEBUG_CAPABILITY, method, params);

export const callWorkspaceTest = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_TEST_CAPABILITY, method, params);

export const callWorkspaceTasks = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(VARIN_WORKSPACE_TASKS_CAPABILITY, method, params);

export type VarinDebugAdapterDescriptor = {
  adapterId: string;
  args?: readonly string[];
  command: string;
  languageIds?: readonly string[];
  source?: string;
  workspaceId?: string;
};

export type VarinTestProviderDescriptor = {
  args?: readonly string[];
  command?: string;
  kind?: string;
  providerId: string;
  source?: string;
  workspaceId?: string;
};

const debugAdapterParams = (descriptor: VarinDebugAdapterDescriptor): JsonObject => {
  const params: JsonObject = {
    adapterId: descriptor.adapterId,
    command: descriptor.command,
  };
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.languageIds) params.languageIds = [...descriptor.languageIds];
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

const testProviderParams = (descriptor: VarinTestProviderDescriptor): JsonObject => {
  const params: JsonObject = { providerId: descriptor.providerId };
  if (descriptor.command) params.command = descriptor.command;
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.kind) params.kind = descriptor.kind;
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

export interface VarinWorkspaceDebugClient {
  getStatus(workspaceId: string): Promise<JsonValue>;
  registerAdapter(descriptor: VarinDebugAdapterDescriptor): Promise<JsonValue>;
  unregisterAdapter(adapterId: string): Promise<JsonValue>;
}

export interface VarinWorkspaceTestClient {
  discover(workspaceId: string): Promise<JsonValue>;
  registerProvider(descriptor: VarinTestProviderDescriptor): Promise<JsonValue>;
  unregisterProvider(providerId: string): Promise<JsonValue>;
}

export const createWorkspaceDebugClient = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
): VarinWorkspaceDebugClient => ({
  registerAdapter: (descriptor) => callWorkspaceDebug(capabilities, "registerAdapter", debugAdapterParams(descriptor)),
  unregisterAdapter: (adapterId) => callWorkspaceDebug(capabilities, "unregisterAdapter", { adapterId }),
  getStatus: (workspaceId) => callWorkspaceDebug(capabilities, "getStatus", { workspaceId }),
});

export const createWorkspaceTestClient = (
  capabilities: VarinIsolatedCapabilityClient | VarinHostCapabilityClient,
): VarinWorkspaceTestClient => ({
  registerProvider: (descriptor) => callWorkspaceTest(capabilities, "registerProvider", testProviderParams(descriptor)),
  unregisterProvider: (providerId) => callWorkspaceTest(capabilities, "unregisterProvider", { providerId }),
  discover: (workspaceId) => callWorkspaceTest(capabilities, "discover", { workspaceId }),
});

export const defineDebugAdapter = (
  input: VarinDebugAdapterDescriptor | VarinHostDescriptorFactory<VarinDebugAdapterDescriptor>,
): VarinBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceDebugClient(context.capabilities);
  await client.registerAdapter({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterAdapter(descriptor.adapterId); });
});

export const defineTestProvider = (
  input: VarinTestProviderDescriptor | VarinHostDescriptorFactory<VarinTestProviderDescriptor>,
): VarinBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceTestClient(context.capabilities);
  await client.registerProvider({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterProvider(descriptor.providerId); });
});

export * from "./context-fragments.js";

export * from "./agent-policy.js";

export * from "./run-activity.js";

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type FileEntry,
  getAgentDir,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  createErrorResponse,
  createEvent,
  type ExtensionUiResponse,
  type HostCapabilities,
  type HostEvent,
  type HostEventData,
  type HostMethod,
  type ImageAttachment,
  type JsonValue,
  type ModelSelection,
  type PermissionPolicy,
  normalizeFrozenHarnessPermissions,
  parsePiSessionFeatureMutation,
  parseProviderConfigInput,
  PiSessionFeatureValidationError,
  VARIN_PROTOCOL_VERSION,
  type ProviderConfigDeleteScope,
  type ProviderConfigInput,
  type ProviderInferenceCapability,
  ProviderConfigValidationError,
  type ProviderAuthResponse,
  ProtocolDecodeError,
  type RequestEnvelope,
  type RecoveryMode,
  type PiResourceKind,
  type PiResourceScope,
  type PiConfigTextAuthorityId,
  type PiConfigWatchTarget,
  type PiPackageScope,
  type RuntimeDescriptor,
  type RuntimeSourceKind,
  type RuntimeWorkerRole,
  THINKING_LEVELS,
  parseHarnessAgentModelSettings,
  type ThinkingLevel,
  type WireEnvelope,
  parseAgentInputContext,
  parseQueuedMessageUpdate,
  type AgentInputContext,
  type HarnessEmbedItem,
  type HarnessEmbedParams,
  type HarnessRerankDocument,
  type HarnessRerankParams,
  FAST_DECISION_PURPOSES,
  type HarnessFastDecisionPurpose,
  type FastDecisionInstructions,
  type FastDecisionMaterial,
  type FastDecisionQuestion,
  type HarnessFastDecisionParams,
  type HarnessMemoryOrganizeParams,
  type HarnessError,
  isWorkFocusId,
  isWorkFocusSource,
  type WorkFocusSelection,
} from "@varin/protocol";
import { CompactionWorkerRuntime } from "./compaction-worker.js";
import { HostError, toProtocolError } from "./errors.js";
import { PackageAuthorityHost } from "./package-authority-host.js";
import { expectRecord, readBoolean, readJson, readString } from "./params.js";
import { resolvePiSdkSpecifier } from "./pi-sdk-packages.js";
import { SessionHost } from "./session-host.js";
import type { HostTransport } from "./transport.js";

export const VARIN_HOST_VERSION = "0.1.0";

const readAgentInputContext = (params: Record<string, unknown>): AgentInputContext => {
  if (params.inputContext === undefined) return { source: "disk" };
  const context = parseAgentInputContext(params.inputContext);
  if (!context) throw new HostError("invalid_params", "inputContext is malformed");
  return context;
};

const optionalWorkFocusSelection = (
  params: Record<string, unknown>,
): WorkFocusSelection | undefined => {
  if (params.workFocus === undefined) return undefined;
  const value = expectRecord(params.workFocus, "workFocus");
  if (!isWorkFocusId(value.id) || !isWorkFocusSource(value.source)) {
    throw new HostError("invalid_params", "workFocus must contain a valid id and source");
  }
  return { id: value.id, source: value.source };
};

const readWorkFocusSelection = (params: Record<string, unknown>): WorkFocusSelection => {
  const value = expectRecord(params.selection, "selection");
  if (!isWorkFocusId(value.id) || !isWorkFocusSource(value.source)) {
    throw new HostError("invalid_params", "selection must contain a valid work focus id and source");
  }
  return { id: value.id, source: value.source };
};

const optionalWorkFocusRole = (
  params: Record<string, unknown>,
): import("@varin/protocol").WorkFocusExecutionRole | undefined => {
  const value = params.workFocusRole;
  if (value === undefined) return undefined;
  if (value !== "principal" && value !== "branch") {
    throw new HostError("invalid_params", "workFocusRole must be principal or branch");
  }
  return value;
};

const optionalPositiveInteger = (params: Record<string, unknown>, key: string): number | undefined => {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new HostError("invalid_params", `${key} must be a positive integer`);
  }
  return Number(value);
};


const HOST_CAPABILITIES: HostCapabilities = {
  agentProviders: true,
  extensionUi: true,
  fleet: true,
  models: true,
  packages: true,
  providerConfiguration: true,
  recovery: true,
  resources: true,
  sessionFeatures: true,
  sessions: true,
  settings: true,
};

const OUT_OF_BAND_METHODS = new Set([
  // Synchronous read-only cuts must not queue behind a prompt that is waiting
  // in preflight; otherwise the UI health check waits on the very same stall.
  "session.snapshot",
  "session.reconcile",
  "agent.abort",
  "agent.queue.clear",
  "agent.queue.update",
  "config.unwatch",
  "extension.ui.respond",
  "harness.respond",
  "harness.rejectUnbound",
  "harness.inference.cancel",
  "provider.auth.cancel",
  "provider.auth.respond",
  "project.trust.respond",
  "workspace.mutation.respond",
]);

const COMMON_ROLE_METHODS = new Set<HostMethod>(["host.handshake", "host.shutdown"]);
const CATALOG_ROLE_METHODS = new Set<HostMethod>([
  ...COMMON_ROLE_METHODS,
  "session.entries.read",
  "session.list",
  "session.rename",
  "session.resolve",
]);
const PACKAGE_ROLE_METHODS = new Set<HostMethod>([
  ...COMMON_ROLE_METHODS,
  "package.bootstrap",
  "package.install",
  "package.list",
  "package.remove",
  "package.setEnabled",
  "package.update",
]);
/** Internal compaction workers run one task and may receive query responses. */
const COMPACTION_ROLE_METHODS = new Set<HostMethod>([
  ...COMMON_ROLE_METHODS,
  "compaction.run",
  "harness.respond",
]);
const CONTEXT_FORBIDDEN_METHODS = new Set<HostMethod>([
  "package.bootstrap",
  "session.entries.read",
  "session.list",
  "session.resolve",
]);

interface PiSessionFileModule {
  loadEntriesFromFile(filePath: string): FileEntry[];
}

const sessionFileModules = new Map<string, Promise<PiSessionFileModule>>();

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function isResolvableSessionHeader(
  value: unknown,
): value is { cwd: string; id: string; type: "session" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "session"
    && typeof record.id === "string"
    && record.id.trim().length > 0
    && typeof record.cwd === "string"
    && record.cwd.trim().length > 0
  );
}

async function loadSessionEntries(
  sessionFile: string,
  packageRoot: string | undefined,
): Promise<FileEntry[]> {
  const sdkEntry = packageRoot === undefined
    ? import.meta.resolve("@earendil-works/pi-coding-agent")
    : resolvePiSdkSpecifier(packageRoot, "@earendil-works/pi-coding-agent");
  const sessionManagerUrl = new URL("./core/session-manager.js", sdkEntry).href;
  let modulePromise = sessionFileModules.get(sessionManagerUrl);
  if (!modulePromise) {
    modulePromise = import(sessionManagerUrl).then((loaded: unknown) => {
      const module = loaded as Partial<PiSessionFileModule>;
      if (typeof module.loadEntriesFromFile !== "function") {
        throw new Error("The selected Pi SDK does not expose loadEntriesFromFile");
      }
      return module as PiSessionFileModule;
    });
    sessionFileModules.set(sessionManagerUrl, modulePromise);
  }
  return (await modulePromise).loadEntriesFromFile(sessionFile);
}

export interface HostControllerOptions {
  agentDir?: string;
  inferenceFetch?: typeof fetch;
  packageRoot?: string;
  projectTrustOverride?: boolean;
  runtimeSource?: RuntimeSourceKind;
  transport: HostTransport;
  workerRole?: RuntimeWorkerRole;
}

function readImages(record: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = record.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HostError("invalid_params", "images must be an array");
  return value.map((entry, index) => {
    const image = expectRecord(entry, `images[${index}]`);
    return {
      data: readString(image, "data"),
      mimeType: readString(image, "mimeType"),
    };
  });
}

function readRecoveryMode(record: Record<string, unknown>): RecoveryMode {
  const mode = readString(record, "mode");
  if (mode !== "conversation" && mode !== "files" && mode !== "both") {
    throw new HostError("invalid_params", "mode must be conversation, files, or both");
  }
  return mode;
}

function readSessionFeatureMutation(value: unknown) {
  try {
    return parsePiSessionFeatureMutation(value);
  } catch (error) {
    if (error instanceof PiSessionFeatureValidationError) {
      throw new HostError("invalid_params", error.message);
    }
    throw error;
  }
}

function readResourceKind(record: Record<string, unknown>): PiResourceKind {
  const kind = readString(record, "kind");
  if (kind !== "prompt" && kind !== "skill") {
    throw new HostError("invalid_params", "kind must be prompt or skill");
  }
  return kind;
}

function readResourceScope(record: Record<string, unknown>): PiResourceScope {
  const scope = readString(record, "scope");
  if (scope !== "user" && scope !== "project") {
    throw new HostError("invalid_params", "scope must be user or project");
  }
  return scope;
}

function readPackageScope(record: Record<string, unknown>): PiPackageScope {
  const scope = readString(record, "scope");
  if (scope !== "global" && scope !== "project") {
    throw new HostError("invalid_params", "scope must be global or project");
  }
  return scope;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return readString(record, key, { optional: true });
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  if (record[key] === null) return null;
  return readString(record, key);
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HostError("invalid_params", `${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringList(record: Record<string, unknown>, key: string): string[] | undefined {
  return record[key] === undefined ? undefined : readStringList(record, key);
}

function optionalModelSelection(record: Record<string, unknown>): ModelSelection | undefined {
  if (record.model === undefined) return undefined;
  const model = expectRecord(record.model, "model");
  return {
    providerId: readString(model, "providerId"),
    modelId: readString(model, "modelId"),
  };
}

function optionalPermissionPolicy(record: Record<string, unknown>): PermissionPolicy | undefined {
  if (record.permissions === undefined) return undefined;
  return normalizeFrozenHarnessPermissions(record.permissions);
}

function readEmbedParams(params: Record<string, unknown>): HarnessEmbedParams {
  const purpose = readString(params, "purpose");
  if (purpose !== "document" && purpose !== "query") {
    throw new HostError("invalid_params", "purpose must be document or query");
  }
  if (readString(params, "protocol") !== "openai-compatible") {
    throw new HostError("invalid_params", "embedding protocol must be openai-compatible");
  }
  const itemsValue = params.items;
  if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
    throw new HostError("invalid_params", "items must be a non-empty array");
  }
  const items: HarnessEmbedItem[] = itemsValue.map((entry, index) => {
    const item = expectRecord(entry, `items[${index}]`);
    return { id: readString(item, "id"), text: readString(item, "text", { allowEmpty: true }) };
  });
  const dimensions = params.dimensions === undefined ? undefined : Number(params.dimensions);
  const maxTokens = params.maxTokens === undefined ? undefined : Number(params.maxTokens);
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions <= 0)) {
    throw new HostError("invalid_params", "dimensions must be a positive integer");
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    throw new HostError("invalid_params", "maxTokens must be a positive integer");
  }
  return {
    purpose,
    configurationId: readString(params, "configurationId"),
    providerId: readString(params, "providerId"),
    modelId: readString(params, "modelId"),
    protocol: "openai-compatible",
    items,
    batchId: readString(params, "batchId"),
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function readRerankParams(params: Record<string, unknown>): HarnessRerankParams {
  if (readString(params, "protocol") !== "http-rerank") {
    throw new HostError("invalid_params", "rerank protocol must be http-rerank");
  }
  const documentsValue = params.documents;
  if (!Array.isArray(documentsValue) || documentsValue.length === 0) {
    throw new HostError("invalid_params", "documents must be a non-empty array");
  }
  const documents: HarnessRerankDocument[] = documentsValue.map((entry, index) => {
    const item = expectRecord(entry, `documents[${index}]`);
    const revision = optionalString(item, "revision");
    return {
      id: readString(item, "id"),
      text: readString(item, "text", { allowEmpty: true }),
      ...(revision === undefined ? {} : { revision }),
    };
  });
  const endpoint = optionalString(params, "endpoint");
  const maxDocumentTokens = params.maxDocumentTokens === undefined
    ? undefined
    : Number(params.maxDocumentTokens);
  if (maxDocumentTokens !== undefined && (!Number.isInteger(maxDocumentTokens) || maxDocumentTokens <= 0)) {
    throw new HostError("invalid_params", "maxDocumentTokens must be a positive integer");
  }
  return {
    configurationId: readString(params, "configurationId"),
    providerId: readString(params, "providerId"),
    modelId: readString(params, "modelId"),
    protocol: "http-rerank",
    query: readString(params, "query", { allowEmpty: true }),
    documents,
    batchId: readString(params, "batchId"),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(maxDocumentTokens === undefined ? {} : { maxDocumentTokens }),
  };
}

function readFastDecisionInstructions(value: unknown, path: string): FastDecisionInstructions {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return value as FastDecisionInstructions;
  }
  throw new HostError("invalid_params", `${path}.instructions must be a string, object, or array`);
}

function readFastDecisionParams(params: Record<string, unknown>): HarnessFastDecisionParams {
  if (readString(params, "protocol") !== "pi-classifier") {
    throw new HostError("invalid_params", "fast decision protocol must be pi-classifier");
  }
  const purpose = readString(params, "purpose");
  if (!FAST_DECISION_PURPOSES.includes(purpose as HarnessFastDecisionPurpose)) {
    throw new HostError("invalid_params", "purpose is not a registered fast-decision purpose");
  }
  const materialsValue = params.materials;
  if (!Array.isArray(materialsValue)) {
    throw new HostError("invalid_params", "materials must be an array");
  }
  const materials: FastDecisionMaterial[] = materialsValue.map((entry, index) => {
    const item = expectRecord(entry, `materials[${index}]`);
    const label = optionalString(item, "label");
    const revision = optionalString(item, "revision");
    return {
      id: readString(item, "id"),
      text: readString(item, "text", { allowEmpty: true }),
      ...(label === undefined ? {} : { label }),
      ...(revision === undefined ? {} : { revision }),
    };
  });
  const questionsValue = params.questions;
  if (!Array.isArray(questionsValue) || questionsValue.length === 0) {
    throw new HostError("invalid_params", "questions must be a non-empty array");
  }
  const seen = new Set<string>();
  const questions: FastDecisionQuestion[] = questionsValue.map((entry, index) => {
    const item = expectRecord(entry, `questions[${index}]`);
    const id = readString(item, "id");
    if (seen.has(id)) throw new HostError("invalid_params", `duplicate question id ${id}`);
    seen.add(id);
    const kind = readString(item, "kind");
    if (kind === "judge") {
      const criteria = item.criteria === undefined ? undefined : expectRecord(item.criteria, `questions[${index}].criteria`);
      const yes = criteria ? optionalString(criteria, "yes") : undefined;
      const no = criteria ? optionalString(criteria, "no") : undefined;
      return {
        id,
        kind: "judge",
        instructions: readFastDecisionInstructions(item.instructions, `questions[${index}]`),
        ...(criteria ? { criteria: { ...(yes ? { yes } : {}), ...(no ? { no } : {}) } } : {}),
      };
    }
    if (kind === "choose") {
      if (!Array.isArray(item.options) || item.options.length === 0) {
        throw new HostError("invalid_params", `questions[${index}].options must be a non-empty array`);
      }
      const options = item.options.map((entry, optionIndex) => {
        const option = expectRecord(entry, `questions[${index}].options[${optionIndex}]`);
        const detail = optionalString(option, "detail");
        return { id: readString(option, "id"), ...(detail === undefined ? {} : { detail }) };
      });
      const allowNone = item.allowNone === undefined ? undefined : item.allowNone === true;
      return {
        id,
        kind: "choose",
        instructions: readFastDecisionInstructions(item.instructions, `questions[${index}]`),
        options,
        ...(allowNone === undefined ? {} : { allowNone }),
      };
    }
    if (kind === "score") {
      if (!Array.isArray(item.levels) || item.levels.length === 0) {
        throw new HostError("invalid_params", `questions[${index}].levels must be a non-empty array`);
      }
      const levels = item.levels.map((level, levelIndex) => {
        if (typeof level !== "string" || !level) {
          throw new HostError("invalid_params", `questions[${index}].levels[${levelIndex}] must be a non-empty string`);
        }
        return level;
      });
      return {
        id,
        kind: "score",
        instructions: readFastDecisionInstructions(item.instructions, `questions[${index}]`),
        levels,
      };
    }
    throw new HostError("invalid_params", `questions[${index}].kind must be judge, choose, or score`);
  });
  const endpoint = optionalString(params, "endpoint");
  return {
    configurationId: readString(params, "configurationId"),
    providerId: readString(params, "providerId"),
    modelId: readString(params, "modelId"),
    protocol: "pi-classifier",
    purpose: purpose as HarnessFastDecisionPurpose,
    goal: readString(params, "goal", { allowEmpty: true }),
    materials,
    questions,
    batchId: readString(params, "batchId"),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

function readMemoryOrganizeParams(params: Record<string, unknown>): HarnessMemoryOrganizeParams {
  return {
    batchId: readString(params, "batchId"),
    providerId: readString(params, "providerId"),
    modelId: readString(params, "modelId"),
    system: readString(params, "system"),
    prompt: readString(params, "prompt"),
  };
}

function readProviderConfig(value: unknown): ProviderConfigInput {
  try {
    return parseProviderConfigInput(value);
  } catch (error) {
    if (error instanceof ProviderConfigValidationError) {
      throw new HostError("invalid_params", error.message);
    }
    throw error;
  }
}

function readProviderInferenceCapability(value: unknown): ProviderInferenceCapability | undefined {
  if (value === undefined || value === "embedding" || value === "rerank" || value === "decision") return value;
  throw new HostError("invalid_params", "capability must be embedding, rerank, or decision");
}

function readProviderConfigScope(value: string): "user" | "project" | "custom" {
  if (value !== "user" && value !== "project" && value !== "custom") {
    throw new HostError("invalid_params", "scope must be user, project, or custom");
  }
  return value;
}

function readProviderDeleteScope(value: string): ProviderConfigDeleteScope {
  if (
    value !== "user" &&
    value !== "project" &&
    value !== "custom" &&
    value !== "auth" &&
    value !== "all"
  ) {
    throw new HostError("invalid_params", "scope must be user, project, custom, auth, or all");
  }
  return value;
}

function readConfigTextAuthority(
  record: Record<string, unknown>,
): PiConfigTextAuthorityId {
  const authority = readString(record, "authority");
  if (
    authority !== "aft-user"
    && authority !== "hermes-memory-user"
    && authority !== "pi-lens-global"
    && authority !== "pi-lens-project"
  ) {
    throw new HostError("invalid_params", "Unknown configuration text authority");
  }
  return authority;
}

function readConfigWatchTarget(value: unknown): PiConfigWatchTarget {
  const target = expectRecord(value, "target");
  const kind = readString(target, "kind");
  if (kind === "document") {
    const scope = readString(target, "scope");
    if (scope !== "global" && scope !== "project") {
      throw new HostError("invalid_params", "Unknown configuration scope");
    }
    return { kind, path: readString(target, "path"), scope };
  }
  if (kind === "text") {
    const root = readString(target, "root");
    const format = readString(target, "format");
    if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
      throw new HostError("invalid_params", "Unknown configuration root");
    }
    if (format !== "json" && format !== "jsonc") {
      throw new HostError("invalid_params", "Unknown configuration format");
    }
    return { format, kind, path: readString(target, "path"), root };
  }
  if (kind === "text-authority") {
    return { authority: readConfigTextAuthority(target), kind };
  }
  if (kind === "settings") {
    const scope = readString(target, "scope");
    if (scope !== "global" && scope !== "project") {
      throw new HostError("invalid_params", "Unknown settings scope");
    }
    return { kind, scope };
  }
  throw new HostError("invalid_params", "Unknown configuration watch target");
}

export class HostController {
  readonly #agentDir: string;
  readonly #packageRoot: string | undefined;
  readonly #packageAuthority: PackageAuthorityHost | undefined;
  readonly #runtimeSource: RuntimeSourceKind;
  readonly #sessionHost: SessionHost;
  readonly #transport: HostTransport;
  readonly #workerRole: RuntimeWorkerRole;
  #compactionWorker: CompactionWorkerRuntime | undefined;
  #disposed = false;
  #requestQueue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #started = false;

  constructor(options: HostControllerOptions) {
    this.#agentDir = resolve(options.agentDir ?? getAgentDir());
    this.#packageRoot = options.packageRoot ? resolve(options.packageRoot) : undefined;
    this.#runtimeSource = options.runtimeSource ?? (this.#packageRoot ? "custom" : "bundled");
    this.#transport = options.transport;
    this.#workerRole = options.workerRole ?? "session";
    this.#packageAuthority = this.#workerRole === "package"
      ? new PackageAuthorityHost({
          agentDir: this.#agentDir,
          cwd: process.cwd(),
          emitProgress: (data) => this.emit("package.progress", data),
          ...(options.projectTrustOverride === undefined
            ? {}
            : { projectTrustOverride: options.projectTrustOverride }),
        })
      : undefined;
    this.#sessionHost = new SessionHost({
      agentDir: this.#agentDir,
      emit: (event, data) => this.emit(event, data),
      ...(options.inferenceFetch ? { inferenceFetch: options.inferenceFetch } : {}),
      ...(options.projectTrustOverride === undefined
        ? {}
        : { projectTrustOverride: options.projectTrustOverride }),
    });
  }

  get runtimeDescriptor(): RuntimeDescriptor {
    return {
      agentDir: this.#agentDir,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      ...(this.#packageRoot === undefined ? {} : { packageRoot: this.#packageRoot }),
      piVersion: VERSION,
      source: this.#runtimeSource,
    };
  }

  start(): void {
    if (this.#started) throw new Error("Host controller is already started");
    if (this.#disposed) throw new Error("Host controller is disposed");
    this.#started = true;
    this.#transport.start(
      (envelope) => {
        if (
          envelope.kind === "request"
          && this.#methodAllowed(envelope.method)
          && (envelope.method === "provider.login" || envelope.method === "provider.models.discover")
          && envelope.params
          && typeof envelope.params === "object"
          && !Array.isArray(envelope.params)
        ) {
          const params = envelope.params as Record<string, unknown>;
          if (
            typeof params.interactionId === "string"
            && params.interactionId.length > 0
            && typeof params.providerId === "string"
            && params.providerId.length > 0
            && (envelope.method === "provider.models.discover"
              || params.type === "api_key"
              || params.type === "oauth")
          ) {
            try {
              this.#sessionHost.reserveProviderInteraction(
                params.interactionId,
                params.providerId,
              );
            } catch (error) {
              this.#transport.send(createErrorResponse(envelope.id, toProtocolError(error)));
              return;
            }
          }
        }
        if (
          envelope.kind === "request"
          && (
            envelope.method === "harness.embed"
            || envelope.method === "harness.rerank"
            || envelope.method === "harness.fastDecision"
            || envelope.method === "harness.memoryOrganize"
          )
          && envelope.params
          && typeof envelope.params === "object"
          && !Array.isArray(envelope.params)
          && typeof (envelope.params as unknown as Record<string, unknown>).batchId === "string"
        ) {
          try {
            this.#sessionHost.reserveInference(
              envelope.id,
              (envelope.params as unknown as Record<string, unknown>).batchId as string,
            );
          } catch {
            // The queued dispatcher remains authoritative for readiness and params.
          }
        }
        if (envelope.kind === "request" && (OUT_OF_BAND_METHODS.has(envelope.method)
          || (this.#workerRole === "compaction" && envelope.method === "host.shutdown"))) {
          void this.#handleEnvelope(envelope).catch((error) => this.#handleFatalError(error));
          return;
        }
        this.#requestQueue = this.#requestQueue
          .then(() => {
            // Admit embeddings after earlier configuration/lifecycle work, but
            // do not serialize independent network waits. Batch reservations
            // and cancellation are still owned by the inference runtime.
            if (envelope.kind === "request" && envelope.method === "harness.embed") {
              void this.#handleEnvelope(envelope).catch((error) => this.#handleFatalError(error));
              return;
            }
            return this.#handleEnvelope(envelope);
          })
          .catch((error) => this.#handleFatalError(error));
      },
      () => {
        void this.#dispose(false).catch((error) => {
          process.stderr.write(
            `Varin host disposal failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
      (error) => {
        this.emit(
          "host.error",
          error instanceof ProtocolDecodeError
            ? { code: error.code, message: error.message }
            : toProtocolError(error),
        );
        void this.#dispose(true).catch((disposeError) => {
          process.stderr.write(
            `Varin host disposal failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}\n`,
          );
        });
      },
    );
    this.emit("host.ready", { runtime: this.runtimeDescriptor });
  }

  emit<E extends HostEvent>(event: E, data: HostEventData<E>): void {
    if (this.#disposed) return;
    this.#transport.send(createEvent(this.#sequence++, event, data));
  }

  async dispose(): Promise<void> {
    await this.#dispose(true);
  }

  async #handleEnvelope(envelope: WireEnvelope): Promise<void> {
    if (this.#disposed) return;
    if (envelope.kind !== "request") {
      this.emit("host.error", {
        code: "unexpected_envelope",
        message: `Client sent an unexpected ${envelope.kind} envelope`,
      });
      return;
    }
    if (!this.#methodAllowed(envelope.method)) {
      this.#transport.send(createErrorResponse(envelope.id, {
        code: "worker_role_violation",
        message: `Pi ${this.#workerRole} worker cannot handle ${envelope.method}`,
      }));
      this.#sessionHost.releaseInferenceReservation(envelope.id);
      return;
    }
    let shutdownAfterResponse = false;
    try {
      const result = await this.#dispatch(envelope);
      this.#transport.send({
        id: envelope.id,
        kind: "response",
        ok: true,
        result,
        v: VARIN_PROTOCOL_VERSION,
      } as WireEnvelope);
      shutdownAfterResponse = envelope.method === "host.shutdown";
    } catch (error) {
      this.#transport.send(createErrorResponse(envelope.id, toProtocolError(error)));
    } finally {
      this.#sessionHost.releaseInferenceReservation(envelope.id);
      if (
        envelope.method === "provider.login"
        || envelope.method === "provider.models.discover"
      ) {
        const params = envelope.params;
        if (
          typeof params === "object"
          && params !== null
          && !Array.isArray(params)
          && typeof (params as Record<string, unknown>).interactionId === "string"
        ) {
          this.#sessionHost.releaseProviderInteraction(
            (params as Record<string, unknown>).interactionId as string,
          );
        }
      }
    }
    if (shutdownAfterResponse) await this.dispose();
  }

  #methodAllowed(method: HostMethod): boolean {
    if (this.#workerRole === "catalog") return CATALOG_ROLE_METHODS.has(method);
    if (this.#workerRole === "package") return PACKAGE_ROLE_METHODS.has(method);
    if (this.#workerRole === "compaction") return COMPACTION_ROLE_METHODS.has(method);
    if (method === "catalog.context.open") return this.#workerRole === "workspace";
    return !CONTEXT_FORBIDDEN_METHODS.has(method);
  }

  async #handleFatalError(error: unknown): Promise<void> {
    if (this.#disposed) return;
    try {
      this.emit("host.error", toProtocolError(error));
    } catch {
      // The transport itself failed; disposal below is the only safe recovery.
    }
    try {
      await this.#dispose(true);
    } catch (disposeError) {
      process.stderr.write(
        `Varin host disposal failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}\n`,
      );
    }
  }

  async #dispatch(request: RequestEnvelope): Promise<unknown> {
    const params = expectRecord(request.params);
    const methodName: string = request.method;
    switch (request.method) {
      case "host.handshake": {
        const versions = params.protocolVersions;
        const clientCapabilities = params.capabilities === undefined
          ? undefined
          : expectRecord(params.capabilities, "capabilities");
        if (
          !Array.isArray(versions) ||
          versions.some((version) => !Number.isSafeInteger(version))
        ) {
          throw new HostError("invalid_params", "protocolVersions must be an array of integers");
        }
        readString(params, "clientName");
        readString(params, "clientVersion");
        readString(params, "mode");
        if (!versions.includes(VARIN_PROTOCOL_VERSION)) {
          throw new HostError(
            "unsupported_version",
            `Client does not support Varin protocol v${VARIN_PROTOCOL_VERSION}`,
          );
        }
        this.#sessionHost.setWorkspaceMutationJournalEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "workspaceMutationJournal", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessThreadRuntimeEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessThreads", { optional: true }) === true,
        );
        this.#sessionHost.setSessionInstructionsAvailable(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "sessionInstructions", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessExperimentsEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessExperiments", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessSettingsEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessSettings", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessFollowUpsEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessFollowUps", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessScheduledTasksEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessScheduledTasks", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessLspNavigationEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessLspNavigation", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessDocumentReadEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessDocumentRead", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessDocumentPathOverlayEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessDocumentPathOverlay", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessMaterialsEnabled(
          clientCapabilities !== undefined
          && readBoolean(clientCapabilities, "harnessMaterials", { optional: true }) === true,
        );
        this.#sessionHost.setHarnessWebCapabilities({
          read: clientCapabilities !== undefined
            && readBoolean(clientCapabilities, "harnessWebRead", { optional: true }) === true,
          search: clientCapabilities !== undefined
            && readBoolean(clientCapabilities, "harnessWebSearch", { optional: true }) === true,
        });
        return {
          capabilities: HOST_CAPABILITIES,
          hostVersion: VARIN_HOST_VERSION,
          protocolVersion: VARIN_PROTOCOL_VERSION,
          runtime: this.runtimeDescriptor,
        };
      }
      case "host.shutdown":
        readBoolean(params, "force", { optional: true });
        return { accepted: true };
      case "catalog.context.open":
        return this.#sessionHost.openCatalogContext(readString(params, "cwd"));
      case "session.create":
        return this.#sessionHost.create(
          readString(params, "cwd"),
          optionalString(params, "name"),
          optionalString(params, "parentSession"),
          optionalStringList(params, "tools"),
          optionalModelSelection(params),
          optionalPermissionPolicy(params),
          optionalWorkFocusSelection(params),
          optionalPositiveInteger(params, "workFocusGeneration"),
          optionalWorkFocusRole(params),
          params.modelSettings === undefined ? undefined : params.modelSettings === null ? null : parseHarnessAgentModelSettings(params.modelSettings),
        );
      case "session.open": {
        const cwd = optionalString(params, "cwd");
        const sessionFile = optionalString(params, "sessionFile");
        const sessionId = optionalString(params, "sessionId");
        const tools = optionalStringList(params, "tools");
        const model = optionalModelSelection(params);
        const permissions = optionalPermissionPolicy(params);
        const workFocus = optionalWorkFocusSelection(params);
        const workFocusGeneration = optionalPositiveInteger(params, "workFocusGeneration");
        const workFocusRole = optionalWorkFocusRole(params);
        return this.#sessionHost.open({
          ...(params.modelSettings === undefined ? {} : {
            modelSettings: params.modelSettings === null ? null : parseHarnessAgentModelSettings(params.modelSettings),
          }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionFile === undefined ? {} : { sessionFile }),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(tools === undefined ? {} : { tools }),
          ...(model === undefined ? {} : { model }),
          ...(permissions === undefined ? {} : { permissions }),
          ...(workFocus === undefined ? {} : { workFocus }),
          ...(workFocusGeneration === undefined ? {} : { workFocusGeneration }),
          ...(workFocusRole === undefined ? {} : { workFocusRole }),
        });
      }
      case "session.workFocus.apply": {
        const generation = optionalPositiveInteger(params, "generation");
        if (generation === undefined) {
          throw new HostError("invalid_params", "generation is required");
        }
        return {
          applied: this.#sessionHost.applyWorkFocus(
            readString(params, "sessionId"),
            readWorkFocusSelection(params),
            generation,
          ),
        };
      }
      case "session.instructions.apply":
        return {
          applied: this.#sessionHost.applySessionInstructions(
            readString(params, "sessionId"),
            readNullableString(params, "instructions"),
          ),
        };
      case "session.workFocus.publish":
        return {
          published: this.#sessionHost.publishWorkFocus(readString(params, "sessionId")),
        };
      case "session.resolve": {
        const sessionFile = resolve(readString(params, "sessionFile"));
        try {
          const fileInfo = await stat(sessionFile);
          if (!fileInfo.isFile()) {
            throw new HostError(
              "invalid_session_file",
              `Pi session path is not a regular file: ${sessionFile}`,
            );
          }
        } catch (error) {
          if (error instanceof HostError) throw error;
          if (isMissingFileError(error)) {
            throw new HostError("session_not_found", `Pi session file does not exist: ${sessionFile}`);
          }
          throw new HostError("session_read_failed", `Unable to inspect Pi session file: ${sessionFile}`, {
            cause: error,
          });
        }
        let entries: FileEntry[];
        try {
          entries = await loadSessionEntries(sessionFile, this.#packageRoot);
        } catch (error) {
          if (isMissingFileError(error)) {
            throw new HostError("session_not_found", `Pi session file does not exist: ${sessionFile}`);
          }
          throw new HostError("session_read_failed", `Unable to read Pi session file: ${sessionFile}`, {
            cause: error,
          });
        }
        const header = entries[0] as unknown;
        if (!isResolvableSessionHeader(header)) {
          throw new HostError(
            "invalid_session_file",
            `Pi session file has no valid header with a non-empty id and cwd: ${sessionFile}`,
          );
        }
        return {
          cwd: resolve(header.cwd),
          sessionFile,
          sessionId: header.id,
        };
      }
      case "session.close":
        return { closed: await this.#sessionHost.close(readString(params, "sessionId")) };
      case "session.list":
        return this.#sessionHost.list(optionalString(params, "cwd"));
      case "session.snapshot":
        this.#sessionHost.assertSession(readString(params, "sessionId"));
        // The watermark is this worker's next event sequence at read time:
        // emitted events with seq below it are already reflected in the
        // snapshot, letting clients reconcile a subscribe/snapshot race
        // without reapplying covered events.
        return { ...this.#sessionHost.snapshot(), eventWatermark: this.#sequence };
      case "session.reconcile": {
        const sessionId = readString(params, "sessionId");
        this.#sessionHost.assertSession(sessionId);
        const scopes = readStringList(params, "scopes");
        if (scopes.some((scope) => scope !== "branch" && scope !== "all")) {
          throw new HostError("invalid_params", "scopes must contain only 'branch' or 'all'");
        }
        // These reads are synchronous on the owning Pi worker. No event can
        // interleave this cut; any reentrant event uses seq >= the watermark.
        const eventWatermark = this.#sequence;
        const snapshot = { ...this.#sessionHost.snapshot(), eventWatermark };
        const entries: Partial<Record<"branch" | "all", ReturnType<SessionHost["entries"]>>> = {};
        for (const scope of new Set(scopes as Array<"branch" | "all">)) {
          entries[scope] = this.#sessionHost.entries(sessionId, scope);
        }
        return { entries, snapshot, stats: this.#sessionHost.stats(sessionId) };
      }
      case "session.input.capture":
        return this.#sessionHost.captureInput(readString(params, "sessionId"));
      case "session.entries":
        {
          const scope = optionalString(params, "scope") ?? "branch";
          if (scope !== "branch" && scope !== "all") {
            throw new HostError("invalid_params", "scope must be 'branch' or 'all'");
          }
          return this.#sessionHost.entries(readString(params, "sessionId"), scope);
        }
      case "session.entries.read":
        {
          const scope = optionalString(params, "scope") ?? "branch";
          if (scope !== "branch" && scope !== "all") {
            throw new HostError("invalid_params", "scope must be 'branch' or 'all'");
          }
          return this.#sessionHost.readEntries(
            readString(params, "sessionId"),
            readString(params, "sessionFile"),
            optionalString(params, "cwd"),
            scope,
          );
        }
      case "session.features.get":
        return this.#sessionHost.features(readString(params, "sessionId"));
      case "session.features.mutate":
        return this.#sessionHost.mutateFeatures(
          readString(params, "sessionId"),
          readSessionFeatureMutation(params.mutation),
        );
      case "session.entry":
        return this.#sessionHost.entry(
          readString(params, "sessionId"),
          readString(params, "entryId"),
        );
      case "session.header":
        return this.#sessionHost.header(readString(params, "sessionId"));
      case "session.tree":
        return this.#sessionHost.tree(readString(params, "sessionId"));
      case "session.stats":
        return this.#sessionHost.stats(readString(params, "sessionId"));
      case "session.summary":
        return this.#sessionHost.summary(readString(params, "sessionId"));
      case "session.rename":
        return this.#sessionHost.rename(
          readString(params, "sessionId"),
          readString(params, "name", { allowEmpty: true }),
          optionalString(params, "sessionFile"),
        );
      case "session.fork": {
        const position = optionalString(params, "position") ?? "before";
        if (position !== "before" && position !== "at") {
          throw new HostError("invalid_params", "position must be 'before' or 'at'");
        }
        return this.#sessionHost.fork(
          readString(params, "sessionId"),
          readString(params, "entryId"),
          position,
        );
      }
      case "session.navigate":
        return this.#sessionHost.navigate(
          readString(params, "sessionId"),
          readString(params, "targetId"),
          readBoolean(params, "summarize", { defaultValue: false }),
        );
      case "session.recovery.navigation.prepare":
        return this.#sessionHost.prepareRecoveryNavigation(
          readString(params, "sessionId"),
          readString(params, "targetId"),
        );
      case "session.recovery.navigation.commit":
        return this.#sessionHost.commitRecoveryNavigation(
          readString(params, "sessionId"),
          readString(params, "targetId"),
          readNullableString(params, "preparedTargetLeafId"),
          readNullableString(params, "expectedLeafId"),
          readString(params, "operationId"),
        );
      case "session.recovery.navigation.commitLeaf":
        return this.#sessionHost.commitRecoveryNavigationLeaf(
          readString(params, "sessionId"),
          readNullableString(params, "preparedTargetLeafId"),
          readNullableString(params, "expectedLeafId"),
          readString(params, "operationId"),
        );
      case "session.recovery.navigation.prepareLeaf":
        return this.#sessionHost.prepareRecoveryNavigationLeaf(
          readString(params, "sessionId"),
          readNullableString(params, "targetLeafId"),
        );
      case "agent.prompt":
        return this.#sessionHost.prompt(
          readString(params, "sessionId"),
          readString(params, "text", { allowEmpty: true }),
          readImages(params),
          optionalString(params, "instructions"),
          readAgentInputContext(params),
        );
      case "agent.compact":
        return this.#sessionHost.prepareCompaction(
          readString(params, "sessionId"),
          optionalString(params, "customInstructions"),
        );
      case "agent.compact.apply":
        return this.#sessionHost.applyCompaction(
          readString(params, "sessionId"),
          readString(params, "taskId"),
        );
      case "agent.steer":
        return {
          accepted: await this.#sessionHost.steer(
            readString(params, "sessionId"),
            readString(params, "text", { allowEmpty: true }),
            readImages(params),
            optionalString(params, "instructions"),
            readAgentInputContext(params),
          ),
        };
      case "agent.threadRequest":
        return this.#sessionHost.requestThreadMessage(
          readString(params, "sessionId"),
          readString(params, "messageId"),
          readString(params, "text", { allowEmpty: true }),
        );
      case "agent.notify":
        return this.#sessionHost.notify(
          readString(params, "sessionId"),
          readString(params, "messageId"),
          readString(params, "text", { allowEmpty: true }),
        );
      case "agent.followUp":
        return {
          accepted: await this.#sessionHost.followUp(
            readString(params, "sessionId"),
            readString(params, "text", { allowEmpty: true }),
            readImages(params),
            optionalString(params, "instructions"),
            readAgentInputContext(params),
          ),
        };
      case "agent.abort":
        return { aborted: await this.#sessionHost.abort(
          readString(params, "sessionId"),
          optionalString(params, "expectedRunId"),
        ) };
      case "agent.queue.clear":
        return this.#sessionHost.clearQueue(readString(params, "sessionId"));
      case "agent.queue.update": {
        const update = parseQueuedMessageUpdate(params);
        if (!update) throw new HostError("invalid_params", "Queue update is malformed");
        return this.#sessionHost.updateQueue(update);
      }
      case "agentProvider.list":
        return this.#sessionHost.listAgentProviders();
      case "agentProvider.action":
        return this.#sessionHost.runAgentProviderAction(
          readString(params, "providerId"),
          readString(params, "action"),
          optionalString(params, "agentId"),
          readJson(params, "input"),
        );
      case "command.list":
        return this.#sessionHost.listCommands(readString(params, "sessionId"));
      case "command.execute":
        return this.#sessionHost.executeCommand(
          readString(params, "sessionId"),
          readString(params, "command"),
        );
      case "fleet.status":
        return this.#sessionHost.fleetStatus(readString(params, "sessionId"));
      case "fleet.action": {
        for (const key of Object.keys(params)) {
          if (
            key !== "action"
            && key !== "entryKey"
            && key !== "input"
            && key !== "providerId"
            && key !== "sessionId"
          ) {
            throw new HostError("invalid_params", `Unknown fleet.action field ${key}`);
          }
        }
        return this.#sessionHost.fleetAction(
          readString(params, "sessionId"),
          readString(params, "providerId"),
          readString(params, "action"),
          optionalString(params, "entryKey"),
          readJson(params, "input"),
        );
      }
      case "model.list":
        return this.#sessionHost.listModels();
      case "mcp.config.snapshot":
        return this.#sessionHost.mcpConfigSnapshot();
      case "model.select":
        return this.#sessionHost.selectModel(
          readString(params, "sessionId"),
          readString(params, "provider"),
          readString(params, "modelId"),
        );
      case "model.resetDefault":
        return this.#sessionHost.resetModelToNewSessionDefault(readString(params, "sessionId"));
      case "thinking.select": {
        const level = readString(params, "level");
        if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
          throw new HostError(
            "invalid_params",
            `level must be one of: ${THINKING_LEVELS.join(", ")}`,
          );
        }
        return this.#sessionHost.selectThinkingLevel(
          readString(params, "sessionId"),
          level as ThinkingLevel,
        );
      }
      case "provider.list":
        return this.#sessionHost.listProviders();
      case "provider.config.get":
        return this.#sessionHost.getProviderConfiguration(readString(params, "providerId"));
      case "provider.config.upsert":
        return this.#sessionHost.upsertProviderConfiguration(
          readProviderConfigScope(readString(params, "scope")),
          readProviderConfig(params.config),
        );
      case "provider.config.delete":
        return this.#sessionHost.deleteProviderConfiguration(
          readString(params, "providerId"),
          readProviderDeleteScope(readString(params, "scope")),
        );
      case "provider.models.discover":
        return this.#sessionHost.discoverProviderModels(
          readString(params, "interactionId"),
          readString(params, "providerId"),
          params.config === undefined ? undefined : readProviderConfig(params.config),
          readBoolean(params, "requestCredential", { optional: true }) ?? false,
          readProviderInferenceCapability(params.capability),
        );
      case "provider.auth.respond": {
        const cancelled = readBoolean(params, "cancelled", { optional: true });
        if (params.value !== undefined && typeof params.value !== "string") {
          throw new HostError("invalid_params", "value must be a string");
        }
        const response: ProviderAuthResponse = {
          requestId: readString(params, "requestId"),
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(params.value === undefined ? {} : { value: params.value }),
        };
        return { accepted: this.#sessionHost.auth.respond(response) };
      }
      case "provider.auth.cancel":
        return {
          cancelled: this.#sessionHost.cancelProviderInteraction(
            readString(params, "interactionId"),
          ),
        };
      case "provider.login": {
        const type = readString(params, "type");
        if (type !== "api_key" && type !== "oauth") {
          throw new HostError("invalid_params", "type must be 'api_key' or 'oauth'");
        }
        return {
          authenticated: await this.#sessionHost.loginProvider(
            readString(params, "interactionId"),
            readString(params, "providerId"),
            type,
          ),
        };
      }
      case "provider.logout":
        await this.#sessionHost.logoutProvider(readString(params, "providerId"));
        return { authenticated: false };
      case "resource.list":
        return this.#sessionHost.listResources(readResourceKind(params));
      case "resource.get":
        return this.#sessionHost.getResource(
          readResourceKind(params),
          readString(params, "id"),
        );
      case "resource.create":
        return this.#sessionHost.createResource(
          readResourceKind(params),
          readResourceScope(params),
          readString(params, "name"),
          readString(params, "content", { allowEmpty: true }),
        );
      case "resource.update":
        return this.#sessionHost.updateResource(
          readResourceKind(params),
          readString(params, "id"),
          readString(params, "content", { allowEmpty: true }),
          readString(params, "expectedRevision"),
        );
      case "resource.delete":
        return this.#sessionHost.deleteResource(
          readResourceKind(params),
          readString(params, "id"),
          readString(params, "expectedRevision"),
        );
      case "resource.copy":
        return this.#sessionHost.copyResource(
          readResourceKind(params),
          readString(params, "id"),
          readResourceScope(params),
          optionalString(params, "name"),
        );
      case "recovery.status":
        return this.#sessionHost.recoveryStatus(readString(params, "sessionId"));
      case "recovery.navigate":
        return this.#sessionHost.navigateRecovery(
          readString(params, "sessionId"),
          readString(params, "targetId"),
          readRecoveryMode(params),
          readBoolean(params, "summarize", { optional: true }),
        );
      case "recovery.undo":
        return this.#sessionHost.undoRecovery(
          readString(params, "sessionId"),
          readRecoveryMode(params),
        );
      case "recovery.redo":
        return this.#sessionHost.redoRecovery(
          readString(params, "sessionId"),
          readRecoveryMode(params),
        );
      case "recovery.checkpoint.create":
        return this.#sessionHost.createRecoveryCheckpoint(
          readString(params, "sessionId"),
          readString(params, "name"),
        );
      case "recovery.repair": {
        const action = readString(params, "action");
        if (
          action !== "recover" &&
          action !== "recover-typo" &&
          action !== "recover-destructive"
        ) {
          throw new HostError("invalid_params", "Unknown recovery repair action");
        }
        return this.#sessionHost.repairRecovery(readString(params, "sessionId"), action);
      }
      case "config.document.get": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown configuration scope");
        }
        return this.#sessionHost.getConfigDocument(scope, readString(params, "path"));
      }
      case "config.document.update": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown configuration scope");
        }
        return this.#sessionHost.updateConfigDocument(
          scope,
          readString(params, "path"),
          readJson(params, "set") ?? null,
          readStringList(params, "remove"),
          readString(params, "expectedRevision"),
        );
      }
      case "config.text.get": {
        const root = readString(params, "root");
        const format = readString(params, "format");
        if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
          throw new HostError("invalid_params", "Unknown configuration root");
        }
        if (format !== "json" && format !== "jsonc") {
          throw new HostError("invalid_params", "Unknown configuration format");
        }
        return this.#sessionHost.getConfigTextDocument(
          root,
          format,
          readString(params, "path"),
        );
      }
      case "config.text.authority.get":
        return this.#sessionHost.getConfigTextAuthority(readConfigTextAuthority(params));
      case "config.text.authority.update":
        return this.#sessionHost.updateConfigTextAuthority(
          readConfigTextAuthority(params),
          readString(params, "content", { allowEmpty: true }),
          readString(params, "expectedRevision"),
        );
      case "config.text.update": {
        const root = readString(params, "root");
        const format = readString(params, "format");
        if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
          throw new HostError("invalid_params", "Unknown configuration root");
        }
        if (format !== "json" && format !== "jsonc") {
          throw new HostError("invalid_params", "Unknown configuration format");
        }
        return this.#sessionHost.updateConfigTextDocument(
          root,
          format,
          readString(params, "path"),
          readString(params, "content", { allowEmpty: true }),
          readString(params, "expectedRevision"),
        );
      }
      case "config.watch":
        return this.#sessionHost.watchConfig(readConfigWatchTarget(params.target));
      case "config.unwatch":
        return { unwatched: this.#sessionHost.unwatchConfig(readString(params, "watchId")) };
      case "harness.embed":
        return this.#sessionHost.embed(readEmbedParams(params), request.id);
      case "harness.rerank":
        return this.#sessionHost.rerank(readRerankParams(params), request.id);
      case "harness.fastDecision":
        return this.#sessionHost.fastDecision(readFastDecisionParams(params), request.id);
      case "harness.memoryOrganize":
        return this.#sessionHost.memoryOrganize(readMemoryOrganizeParams(params), request.id);
      case "harness.inference.describe":
        return this.#sessionHost.describeInference();
      case "harness.inference.cancel":
        return { cancelled: this.#sessionHost.cancelInference(readString(params, "batchId")) };
      case "settings.get":
        return this.#sessionHost.getSettings();
      case "settings.update": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown settings scope");
        }
        return this.#sessionHost.updateSettings(
          scope,
          readJson(params, "set") ?? null,
          readStringList(params, "remove"),
          readString(params, "expectedRevision"),
        );
      }
      case "package.list":
        return this.#packageAuthority
          ? this.#packageAuthority.refreshPackages()
          : this.#sessionHost.refreshPackages();
      case "package.bootstrap":
        return this.#packageAuthority
          ? this.#packageAuthority.bootstrapPackages(readStringList(params, "sources"))
          : this.#sessionHost.bootstrapPackages(readStringList(params, "sources"));
      case "package.install": {
        const scope = readPackageScope(params);
        if (this.#packageAuthority) {
          return this.#packageAuthority.installPackage(readString(params, "source"), scope);
        }
        return this.#sessionHost.installPackage(readString(params, "source"), scope);
      }
      case "package.remove": {
        const scope = readPackageScope(params);
        return {
          removed: await (this.#packageAuthority
            ? this.#packageAuthority.removePackage(readString(params, "source"), scope)
            : this.#sessionHost.removePackage(readString(params, "source"), scope)),
        };
      }
      case "package.setEnabled": {
        const scope = readPackageScope(params);
        if (this.#packageAuthority) {
          return this.#packageAuthority.setPackageEnabled(
            readString(params, "source"),
            scope,
            readBoolean(params, "enabled"),
          );
        }
        return this.#sessionHost.setPackageEnabled(
          readString(params, "source"),
          scope,
          readBoolean(params, "enabled"),
        );
      }
      case "package.update":
        return this.#packageAuthority
          ? this.#packageAuthority.updatePackages(optionalString(params, "source"))
          : this.#sessionHost.updatePackages(optionalString(params, "source"));
      case "extension.ui.respond": {
        const cancelled = readBoolean(params, "cancelled", { optional: true });
        const response: ExtensionUiResponse = {
          requestId: readString(params, "requestId"),
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(params.value === undefined ? {} : { value: params.value as JsonValue }),
        };
        return { accepted: this.#sessionHost.ui.respond(response) };
      }
      case "project.trust.respond":
        return {
          accepted: this.#sessionHost.trust.respond({
            remember: readBoolean(params, "remember"),
            requestId: readString(params, "requestId"),
            trusted: readBoolean(params, "trusted"),
          }),
        };
      case "workspace.mutation.respond":
        return {
          accepted: this.#sessionHost.respondWorkspaceMutation(
            readString(params, "sessionId"),
            readString(params, "requestId"),
            readBoolean(params, "accepted"),
          ),
        };
      case "harness.respond": {
        const harnessOutcome = params as {
          ok: boolean; result?: unknown;
          error?: { code: string; message: string; retryable?: boolean };
        };
        if (this.#workerRole === "compaction") {
          return {
            accepted: this.#compactionWorker?.respondHarness(
              readString(params, "sessionId"),
              readString(params, "requestId"),
              harnessOutcome.ok
                ? { ok: true, result: harnessOutcome.result }
                : { ok: false, error: (harnessOutcome.error ?? { code: "failed", message: "unknown error" }) as HarnessError },
            ) ?? false,
          };
        }
        return {
          accepted: this.#sessionHost.respondHarness(
            readString(params, "sessionId"),
            readString(params, "requestId"),
            params as { ok: boolean; result?: unknown; error?: { code: string; message: string; retryable?: boolean } },
          ),
        };
      }
      case "harness.rejectUnbound":
        return { accepted: this.#sessionHost.rejectUnboundHarness(readString(params, "requestId")) };
      case "compaction.run":
        if (this.#workerRole !== "compaction") {
          throw new HostError("worker_role_violation", "compaction.run requires a compaction worker");
        }
        this.#compactionWorker ??= new CompactionWorkerRuntime({
          agentDir: this.#agentDir,
          emit: (event, data) => this.emit(event, data),
        });
        return this.#compactionWorker.run(request.params);
      default:
        throw new HostError("method_not_found", `Unknown host method: ${methodName}`);
    }
  }

  async #dispose(closeTransport: boolean): Promise<void> {
    if (this.#disposed) return;
    this.#compactionWorker?.abort();
    this.#disposed = true;
    await this.#sessionHost.dispose();
    if (closeTransport) this.#transport.close();
  }
}

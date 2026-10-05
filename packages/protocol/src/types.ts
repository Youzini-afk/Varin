import type { PiAssistantMessage } from "./session.js";
import type { PiSessionFeatureState } from "./session-features.js";
import type { SessionWorkFocusSnapshot } from "./work-focus.js";

// Varin is pre-release and all product surfaces ship in lockstep. Breaking
// development changes replace this single contract instead of accumulating
// compatibility versions that no released client needs.
export const VARIN_PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof VARIN_PROTOCOL_VERSION;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HostMode = "desktop" | "headless" | "mobile" | "test" | "web";

export type RuntimeSourceKind =
  | "bundled"
  | "system"
  | "standalone"
  | "custom"
  | "development"
  | "source";

export type PiRuntimeInstallationSource =
  | "bundled"
  | "system"
  | "standalone"
  | "custom"
  | "development";

export type PiRuntimeInstallationState = "ready" | "missing" | "upgrade-required" | "failed";

export interface PiRuntimeInstallation {
  id: string;
  source: PiRuntimeInstallationSource;
  version?: string;
  commandPath?: string;
  nodePath?: string;
  packageRoot?: string;
  state: PiRuntimeInstallationState;
  issue?: string;
}

export type PiRuntimeManagerStatus =
  | "discovering"
  | "missing"
  | "installing"
  | "probing"
  | "ready"
  | "upgrade-required"
  | "upgrading"
  | "failed";

export const PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE = "host-entry-unavailable" as const;

export const PI_RUNTIME_ISSUE_CODES = [
  PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE,
] as const;

export type PiRuntimeIssueCode = (typeof PI_RUNTIME_ISSUE_CODES)[number];

export type PiRuntimeInstallAction = "none" | "install" | "upgrade" | "keep-newer";

export type PiRuntimeInstallManager = "npm" | "bun" | "pnpm" | "standalone";

export interface PiRuntimeInstallPlan {
  action: PiRuntimeInstallAction;
  targetVersion: string;
  manager?: PiRuntimeInstallManager;
  executable?: string;
  args?: string[];
  location?: string;
  currentVersion?: string;
  reason: string;
}

export interface PiRuntimeSnapshot {
  revision: number;
  status: PiRuntimeManagerStatus;
  installations: PiRuntimeInstallation[];
  selectedId?: string;
  active?: PiRuntimeInstallation;
  operationId?: string;
  issue?: string;
  issueCode?: PiRuntimeIssueCode;
  installPlan?: PiRuntimeInstallPlan;
}

export const RUNTIME_SOURCE_KINDS = [
  "bundled",
  "system",
  "standalone",
  "custom",
  "development",
  "source",
] as const satisfies readonly RuntimeSourceKind[];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface HostCapabilities {
  agentProviders: boolean;
  extensionUi: boolean;
  models: boolean;
  packages: boolean;
  providerConfiguration: boolean;
  recovery: boolean;
  resources: boolean;
  sessionFeatures: boolean;
  sessions: boolean;
  settings: boolean;
}

export interface RuntimeDescriptor {
  agentDir: string;
  nodePath: string;
  nodeVersion: string;
  packageRoot?: string;
  piVersion: string;
  source: RuntimeSourceKind;
}

export type SessionWorkspaceBinding =
  | { kind: "unbound" }
  | { authorityId?: string; id: string; kind: "workspace" };

/**
 * Immutable source selected for one user input. Surface contexts contain only
 * an opaque Host reference; document text remains on the authenticated
 * Documents channel and never enters runtime request payloads.
 */
export type AgentInputContext =
  | { source: "disk" }
  | {
      source: "surface";
      roots: Array<{ workspaceId: string; dirtyPaths: string[] }>;
      snapshot:
        | { status: "ready"; ref: string }
        | { status: "unavailable"; reason: "surface-unavailable" };
    };

/** Parse untrusted wire input into a content-free AgentInputContext clone. */
export function parseAgentInputContext(value: unknown): AgentInputContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.source === "disk") return { source: "disk" };
  if (input.source !== "surface"
    || !Array.isArray(input.roots)
    || !input.snapshot || typeof input.snapshot !== "object" || Array.isArray(input.snapshot)) return null;
  const roots: Array<{ workspaceId: string; dirtyPaths: string[] }> = [];
  for (const root of input.roots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const entry = root as Record<string, unknown>;
    if (typeof entry.workspaceId !== "string" || !entry.workspaceId
      || !Array.isArray(entry.dirtyPaths) || entry.dirtyPaths.length === 0
      || entry.dirtyPaths.some((path) => typeof path !== "string")
      || new Set(entry.dirtyPaths).size !== entry.dirtyPaths.length
      || roots.some((candidate) => candidate.workspaceId === entry.workspaceId)) return null;
    roots.push({ workspaceId: entry.workspaceId, dirtyPaths: [...entry.dirtyPaths] as string[] });
  }
  const snapshot = input.snapshot as Record<string, unknown>;
  if (snapshot.status === "ready" && typeof snapshot.ref === "string" && snapshot.ref) {
    if (roots.length === 0) return null;
    return {
      source: "surface",
      roots,
      snapshot: { status: "ready", ref: snapshot.ref },
    };
  }
  if (snapshot.status === "unavailable" && snapshot.reason === "surface-unavailable") {
    return {
      source: "surface",
      roots,
      snapshot: { status: "unavailable", reason: "surface-unavailable" },
    };
  }
  return null;
}

export interface SessionSummary {
  allMessagesText: string;
  archivedAt?: string;
  createdAt: string;
  cwd: string;
  firstMessage: string;
  id: string;
  messageCount: number;
  name?: string;
  parentId?: string;
  parentSessionPath?: string;
  persisted: boolean;
  sessionFile: string;
  updatedAt: string;
  workspace?: SessionWorkspaceBinding;
  workspacePersistence?: "pending";
  /** Present for Varin-managed sessions after broker metadata projection. */
  workFocus?: SessionWorkFocusSnapshot;
}

export interface SessionHeader {
  cwd: string;
  id: string;
  parentSession?: string;
  timestamp: string;
  version?: number;
}

export interface ModelDescriptor {
  api: string;
  available: boolean;
  baseUrl: string;
  contextWindow: number;
  cost: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    tiers?: Array<{
      cacheRead: number;
      cacheWrite: number;
      input: number;
      inputTokensAbove: number;
      output: number;
    }>;
  };
  id: string;
  input: Array<"text" | "image">;
  maxTokens: number;
  name: string;
  provider: string;
  supportedThinkingLevels: ThinkingLevel[];
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export type ProviderAuthType = "api_key" | "oauth";

export interface PackageDescriptor {
  enabled: boolean;
  installed: boolean;
  name: string;
  resolvedPath?: string;
  scope: PiPackageScope;
  source: string;
  structured: boolean;
  version?: string;
}

export type PiPackageScope = "global" | "project";

export type PiResourceKind = "skill";

export type PiResourceScope = "user" | "project";

export interface PiResourceSourceInfo {
  baseDir?: string;
  origin: "package" | "top-level";
  path: string;
  scope: PiResourceScope | "temporary";
  source: string;
}

export type PiCommandSource = "extension" | "skill";

export interface PiCommandDescriptor {
  argumentHint?: string;
  description?: string;
  name: string;
  source: PiCommandSource;
  sourceInfo: PiResourceSourceInfo;
}

export interface PiResourceCollision {
  loserPath: string;
  loserSource?: string;
  name: string;
  resourceType: "extension" | "prompt" | "skill" | "theme";
  winnerPath: string;
  winnerSource?: string;
}

export interface PiResourceDiagnostic {
  collision?: PiResourceCollision;
  message: string;
  path?: string;
  type: "collision" | "error" | "warning";
}

export interface PiResourceDescriptor {
  active: boolean;
  argumentHint?: string;
  baseDir?: string;
  description: string;
  disableModelInvocation?: boolean;
  filePath: string;
  id: string;
  kind: PiResourceKind;
  name: string;
  sourceInfo: PiResourceSourceInfo;
  valid: boolean;
  writable: boolean;
}

export interface PiResourceCatalogSnapshot {
  diagnostics: PiResourceDiagnostic[];
  projectTrusted: boolean;
  resources: PiResourceDescriptor[];
}

export interface PiResourceDocumentSnapshot {
  content: string;
  descriptor: PiResourceDescriptor;
  projectTrusted: boolean;
  revision: string;
}

export type PiAgentKind =
  | "delegatable"
  | "internal"
  | "primary"
  | "profile"
  | "service"
  | "workflow";

export type PiAgentStatus =
  | "available"
  | "disabled"
  | "error"
  | "unavailable"
  | "unconfigured";

export type PiAgentSourceScope = "builtin" | "package" | "project" | "runtime" | "user";

export interface PiAgentSource {
  packageName?: string;
  path?: string;
  scope: PiAgentSourceScope;
}

export interface PiAgentActionDescriptor {
  destructive?: boolean;
  id: string;
  label: string;
  requiresScope?: boolean;
}

export interface PiAgentConfigurationTarget {
  pluginId: string;
  section?: string;
}

export interface PiAgentInvocationDescriptor {
  command: string;
  kind: "slash-command";
  taskSeparator: "space" | "double-dash";
}

/** Provider-owned definition used to seed that agent's edit/update flow. */
export interface PiAgentDefinitionDescriptor {
  config: { [key: string]: JsonValue };
  revision?: string;
}

export interface PiAgentDescriptor {
  workFocus?: import("./work-focus.js").WorkFocusId[];
  actions: PiAgentActionDescriptor[];
  aliases?: string[];
  configuration?: PiAgentConfigurationTarget;
  definition?: PiAgentDefinitionDescriptor;
  description: string;
  fallbackModels?: string[];
  id: string;
  invocation?: PiAgentInvocationDescriptor;
  kind: PiAgentKind;
  model?: string;
  name: string;
  providerId: string;
  source: PiAgentSource;
  status: PiAgentStatus;
  thinking?: string;
}

export interface PiAgentProviderDescriptor {
  actions: PiAgentActionDescriptor[];
  available: boolean;
  configuration?: PiAgentConfigurationTarget;
  description: string;
  id: string;
  label: string;
  source?: string;
}

export interface PiAgentDiagnostic {
  message: string;
  path?: string;
  providerId: string;
  severity: "error" | "warning";
}

export interface PiAgentCatalogSnapshot {
  agents: PiAgentDescriptor[];
  diagnostics: PiAgentDiagnostic[];
  projectTrusted: boolean;
  providers: PiAgentProviderDescriptor[];
}

export interface PiAgentProviderActionResult {
  agentId?: string;
  data?: JsonValue;
  message: string;
  providerId: string;
  success: boolean;
}

export type RecoveryMode = "conversation" | "files" | "both";

export type RecoveryPreference = "conversation" | "both" | "ask";

export type RecoveryAction =
  | "navigate"
  | "undo"
  | "redo"
  | "checkpoint"
  | "repair"
  | "repair-typo"
  | "repair-destructive";

export type RecoveryRepairAction = "recover" | "recover-typo" | "recover-destructive";

export interface RecoveryProviderDescriptor {
  actions: RecoveryAction[];
  active: boolean;
  bridgeVersion?: number;
  id: string;
  modes: RecoveryMode[];
  name: string;
  source?: string;
}

export interface RecoveryStatus {
  actions: RecoveryAction[];
  available: boolean;
  issues: string[];
  modes: RecoveryMode[];
  providers: RecoveryProviderDescriptor[];
}

export interface RecoveryOperationResult {
  action: RecoveryAction;
  editorImages?: ImageAttachment[];
  editorText?: string;
  handledBy: string;
  mode?: RecoveryMode;
  outcome: "applied" | "cancelled" | "unknown";
  snapshot: SessionSnapshot;
}

export interface HostHandshakeParams {
  capabilities?: {
    /** The application Host can execute and observe durable child threads. */
    harnessThreads?: boolean;
    /** The application Host answers durable session instruction lookups. */
    sessionInstructions?: boolean;
    /** The application Host registered the experiment/resource/source services (7C/7D). */
    harnessExperiments?: boolean;
    /** The application Host registered the shared settings catalog service (D-306). */
    harnessSettings?: boolean;
    /** The application Host can serve LSP navigation tools. */
    harnessLspNavigation?: boolean;
    /** The application Host can resolve native Pi reads against editor drafts. */
    harnessDocumentRead?: boolean;
    /** The application Host can resolve native Pi find/ls paths against editor drafts. */
    harnessDocumentPathOverlay?: boolean;
    /** Host-owned operation-directory and query-scope services. */
    /** The application Host permits session-local reader models over its guarded web.fetch service. */
    harnessWebRead?: boolean;
    /** The application Host provides web search, including its keyless default. */
    harnessWebSearch?: boolean;
    /** The application Host owns durable follow-up registrations that resume the calling thread/session (D-307). */
    harnessFollowUps?: boolean;
    /** The application Host exposes the project scheduled-task authority to agents (D-307). */
    harnessScheduledTasks?: boolean;
    /** The application Host registered the material collection service (D-315 L3). */
    harnessMaterials?: boolean;
    workspaceMutationJournal?: boolean;
  };
  clientName: string;
  clientVersion: string;
  mode: HostMode;
  protocolVersions: number[];
}

export interface HostHandshakeResult {
  capabilities: HostCapabilities;
  hostVersion: string;
  protocolVersion: ProtocolVersion;
  runtime: RuntimeDescriptor;
}

export interface UserQuestion {
  id: string;
  type: "select" | "confirm" | "input" | "editor";
  question: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  allowOther?: boolean;
  placeholder?: string;
  prefill?: string;
}

export interface UserQuestionAnswer {
  id: string;
  type: UserQuestion["type"];
  value: string | boolean;
}

export interface UserQuestionRequest {
  id: string;
  sessionId: string;
  questions: UserQuestion[];
  createdAt: number;
  popupUntil: number;
  waitingUntil?: number;
}

export type ExtensionUiMethod =
  | "question"
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "custom"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "setEditorText"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel";

export interface ExtensionUiRequest {
  id?: string;
  method: ExtensionUiMethod;
  options?: JsonValue;
  payload: JsonValue;
  sessionId: string;
}

export interface ExtensionUiResponse {
  cancelled?: boolean;
  requestId: string;
  value?: JsonValue;
}

export interface QueuedUserMessage {
  id: string;
  revision: number;
  mode: "steer" | "followUp";
  text: string;
  imageCount: number;
}

export interface SessionRuntimeState {
  activeTools: string[];
  busy: boolean;
  followUp: string[];
  followUpMode: "all" | "one-at-a-time";
  isCompacting: boolean;
  isStreaming: boolean;
  pendingMessageCount: number;
  queuedMessages: QueuedUserMessage[];
  retryAttempt: number;
  steering: string[];
  steeringMode: "all" | "one-at-a-time";
}

export type HarnessContextFailurePhase = "prepare" | "commit";

export interface HarnessContextRuntimeFailure {
  at: number;
  message: string;
  phase: HarnessContextFailurePhase;
}

export interface HarnessContextRuntimeState {
  /** User-owned background preparation switch after legacy mapping. */
  backgroundPreparation: boolean;
  /** Live candidate state for the current compaction cycle. */
  candidate: "none" | "preparing" | "ready";
  candidateTaskId?: string;
  applicationRequested?: boolean;
  lastFailure?: HarnessContextRuntimeFailure;
}

export interface HarnessRuntimeState {
  context: HarnessContextRuntimeState;
}

export interface SessionSnapshot extends SessionRuntimeState {
  questions?: UserQuestionRequest[];
  /** Effective Pi permission policy, used when freezing delegated work. */
  permissions?: import("./permission-gate.js").PermissionPolicy;
  cwd: string;
  /**
   * Per-worker event sequence observed when this snapshot was read. Events from
   * the session worker with seq below the watermark are already reflected in
   * this state; events at or above it are not. Absent on older hosts.
   */
  eventWatermark?: number;
  /** Broker worker that owns eventWatermark; sequence numbers are worker-local. */
  eventWorkerId?: string;
  features: PiSessionFeatureState;
  /** Present for harness-capable runtimes; absent on older/non-harness hosts. */
  harness?: HarnessRuntimeState;
  leafId: string | null;
  /** Authoritative in-flight assistant message while the session is streaming. */
  liveAssistant?: PiAssistantMessage;
  /** Host-assigned identity of the active or most recently settled agent run. */
  runId?: string;
  model?: ModelDescriptor;
  /** Native virtual selection remains in model; this is the latest physical response target. */
  routedModel?: { model: ModelDescriptor; thinkingLevel?: ThinkingLevel };
  cacheWarming?: {
    state: "inactive" | "scheduled" | "refreshing";
    reason?: string;
    nextWarmAt?: number;
    decision?: { phase: "streaming" | "idle"; warmCost: number; missCost: number;
      continuationProbability: number; expectedSavings: number; economicsAvailable: boolean; action: "warm" | "stop" };
    extensionOverride?: boolean;
  };
  name?: string;
  /** Tool call identifiers still executing on the session worker. */
  pendingToolCallIds?: string[];
  sessionFile?: string;
  sessionId: string;
  thinkingLevel: ThinkingLevel;
  workspace?: SessionWorkspaceBinding;
  workspacePersistence?: "pending";
  /** Applied and selected Agent work focus; independent of the active Workbench shell. */
  workFocus?: SessionWorkFocusSnapshot;
}

export interface SessionModelUsage {
  provider: string | null;
  model: string | null;
  tokens: SessionStats['tokens'];
}

export interface SessionStats {
  /** Billed usage across the complete native session journal, including inactive branches. */
  usageByModel?: SessionModelUsage[];
  contextUsage?: JsonValue;
  cost: number;
  sessionFile?: string;
  sessionId: string;
  tokens: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    total: number;
  };
  totalMessages: number;
  toolCalls: number;
  toolResults: number;
  assistantMessages: number;
  userMessages: number;
  toolErrors?: number;
  toolRetries?: number;
  outputBytes?: number;
  observationCalls?: number;
  cacheHitRatio?: number | null;
}

export interface ProjectTrustRequest {
  cwd: string;
  id: string;
  reason: "project-resources";
}

export type PiConfigScope = "global" | "project";

export type PiConfigTextFormat = "json" | "jsonc";
export type PiConfigTextRoot = "agent" | "home" | "project" | "user-config";
export type PiConfigTextAuthorityId =
  | "aft-user"
  | "hermes-memory-user"
  | "pi-lens-global"
  | "pi-lens-project";

export interface ExtensionStateSnapshot {
  channel: string;
  sessionId: string;
  value: JsonValue | null;
}

export interface PiConfigTextDocumentSnapshot {
  content: string;
  exists: boolean;
  format: PiConfigTextFormat;
  path: string;
  projectTrusted: boolean;
  revision: string;
  root: PiConfigTextRoot;
}

export interface PiConfigTextAuthoritySnapshot {
  authority: PiConfigTextAuthorityId;
  content: string;
  exists: boolean;
  format: PiConfigTextFormat;
  path: string;
  projectTrusted: boolean;
  revision: string;
}

export interface PiConfigDocumentSnapshot {
  document: { [key: string]: JsonValue };
  exists: boolean;
  path: string;
  projectTrusted: boolean;
  revision: string;
  scope: PiConfigScope;
}

export type PiConfigWatchTarget =
  | {
      kind: "document";
      path: string;
      scope: PiConfigScope;
    }
  | {
      format: PiConfigTextFormat;
      kind: "text";
      path: string;
      root: PiConfigTextRoot;
    }
  | {
      authority: PiConfigTextAuthorityId;
      kind: "text-authority";
    }
  | {
      kind: "settings";
      scope: PiConfigScope;
    };

export interface PiConfigWatchSubscription {
  target: PiConfigWatchTarget;
  watchId: string;
}

export type PiConfigWatchChangeReason = "change" | "error" | "rename";

export interface PiSettingsSnapshot {
  global: { [key: string]: JsonValue };
  globalRevision: string;
  project: { [key: string]: JsonValue };
  projectRevision: string;
  projectTrusted: boolean;
}

export interface ProtocolErrorData {
  code: string;
  details?: JsonValue;
  message: string;
  retryable?: boolean;
}

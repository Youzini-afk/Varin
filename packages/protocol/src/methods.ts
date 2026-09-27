import type {
  ExtensionUiResponse,
  HostHandshakeParams,
  HostHandshakeResult,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  PiCommandDescriptor,
  PiPackageScope,
  PiAgentCatalogSnapshot,
  PiAgentProviderActionResult,
  PiConfigDocumentSnapshot,
  PiConfigScope,
  PiConfigTextAuthorityId,
  PiConfigTextAuthoritySnapshot,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  PiConfigWatchSubscription,
  PiConfigWatchTarget,
  PiFleetActionResult,
  PiFleetSnapshot,
  PiResourceCatalogSnapshot,
  PiResourceDocumentSnapshot,
  PiResourceKind,
  PiResourceScope,
  PiSettingsSnapshot,
  ProviderAuthType,
  RecoveryMode,
  RecoveryOperationResult,
  RecoveryRepairAction,
  RecoveryStatus,
  SessionHeader,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  SessionWorkspaceBinding,
  ThinkingLevel,
  AgentInputContext,
} from "./types.js";
import type { PackageBootstrapResult } from "./foundational-pi-packages.js";
import type { PiMcpConfigSnapshot } from "./mcp.js";
import type { ProviderAuthResponse, ProviderDescriptor } from "./auth.js";
import type {
  ProviderConfigDeleteScope,
  ProviderConfigDetails,
  ProviderConfigInput,
  ProviderConfigScope,
  ProviderModelDiscoveryResult,
} from "./provider.js";
import type { PiSessionEntry, SessionEntriesResult, SessionReconcileResult, SessionTreeResult } from "./session.js";
import type { PiSessionFeatureMutation, PiSessionFeatureState } from "./session-features.js";
import type { HarnessRespondParams } from "./harness.js";
import type {
  HarnessEmbedParams,
  HarnessEmbedResult,
  HarnessInferenceBindingSnapshot,
  HarnessRerankParams,
  HarnessRerankResult,
} from "./harness-inference.js";
import type {
  HarnessFastDecisionParams,
  HarnessFastDecisionResult,
} from "./harness-fast-decision.js";
import type { ModelSelection } from "./harness-settings.js";
import type { PermissionPolicy } from "./permission-gate.js";
import type { WorkFocusSelection } from "./work-focus.js";


export interface HostMethodMap {
  "agentProvider.action": {
    params: { action: string; agentId?: string; input?: JsonValue; providerId: string };
    result: PiAgentProviderActionResult;
  };
  "agentProvider.list": {
    params: Record<string, never>;
    result: PiAgentCatalogSnapshot;
  };
  "config.document.get": {
    params: { path: string; scope: PiConfigScope };
    result: PiConfigDocumentSnapshot;
  };
  "config.document.update": {
    params: {
      expectedRevision: string;
      path: string;
      remove: string[];
      scope: PiConfigScope;
      set: { [key: string]: JsonValue };
    };
    result: PiConfigDocumentSnapshot;
  };
  "config.text.get": {
    params: { format: PiConfigTextFormat; path: string; root: PiConfigTextRoot };
    result: PiConfigTextDocumentSnapshot;
  };
  "config.text.update": {
    params: {
      content: string;
      expectedRevision: string;
      format: PiConfigTextFormat;
      path: string;
      root: PiConfigTextRoot;
    };
    result: PiConfigTextDocumentSnapshot;
  };
  "config.text.authority.get": {
    params: { authority: PiConfigTextAuthorityId };
    result: PiConfigTextAuthoritySnapshot;
  };
  "config.text.authority.update": {
    params: {
      authority: PiConfigTextAuthorityId;
      content: string;
      expectedRevision: string;
    };
    result: PiConfigTextAuthoritySnapshot;
  };
  "config.watch": {
    params: { target: PiConfigWatchTarget };
    result: PiConfigWatchSubscription;
  };
  "config.unwatch": {
    params: { watchId: string };
    result: { unwatched: boolean };
  };
  "catalog.context.open": {
    params: { cwd: string };
    result: SessionSnapshot;
  };
  "agent.abort": {
    params: { sessionId: string; expectedRunId?: string };
    result: { aborted: boolean };
  };
  /** Run an explicit Pi context compaction through the owning session. */
  "agent.compact": {
    params: { customInstructions?: string; sessionId: string };
    result: import("./session.js").PiCompactionResult;
  };
  /** Host-only passive delivery; deliberately absent from the surface method catalog. */
  "agent.notify": {
    params: { sessionId: string; messageId: string; text: string };
    result: { accepted: boolean; alreadyDelivered: boolean };
  };
  /** Host-only idempotent execution request; receipt lives in the native Pi session. */
  "agent.threadRequest": {
    params: { sessionId: string; messageId: string; text: string };
    result: { accepted: boolean; alreadyDelivered: boolean };
  };
  "agent.followUp": {
    params: { images?: ImageAttachment[]; inputContext?: AgentInputContext; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.prompt": {
    params: { images?: ImageAttachment[]; inputContext?: AgentInputContext; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  /** Broker-only safe-boundary profile application; absent from the surface method catalog. */
  "session.workFocus.apply": {
    params: { generation: number; sessionId: string; selection: WorkFocusSelection };
    result: { applied: boolean };
  };
  /** Broker-only publication after the durable selection commit succeeds. */
  "session.workFocus.publish": {
    params: { sessionId: string };
    result: { published: boolean };
  };
  "agent.queue.clear": {
    params: { sessionId: string };
    result: { cleared: boolean; followUp: string[]; steering: string[] };
  };
  "agent.steer": {
    params: { images?: ImageAttachment[]; inputContext?: AgentInputContext; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "command.execute": {
    params: { command: string; sessionId: string };
    result: JsonValue;
  };
  "command.list": {
    params: { sessionId: string };
    result: PiCommandDescriptor[];
  };
  "extension.ui.respond": {
    params: ExtensionUiResponse;
    result: { accepted: boolean };
  };
  "fleet.action": {
    params: {
      action: string;
      entryKey?: string;
      input?: JsonValue;
      providerId: string;
      sessionId: string;
    };
    result: PiFleetActionResult;
  };
  "fleet.status": {
    params: { sessionId: string };
    result: PiFleetSnapshot;
  };
  "host.handshake": {
    params: HostHandshakeParams;
    result: HostHandshakeResult;
  };
  "host.shutdown": {
    params: { force?: boolean };
    result: { accepted: boolean };
  };
  "model.list": {
    params: Record<string, never>;
    result: ModelDescriptor[];
  };
  "model.select": {
    params: { modelId: string; provider: string; sessionId: string };
    result: SessionSnapshot;
  };
  "mcp.config.snapshot": {
    params: Record<string, never>;
    result: PiMcpConfigSnapshot;
  };
  "thinking.select": {
    params: { level: ThinkingLevel; sessionId: string };
    result: SessionSnapshot;
  };
  "workspace.mutation.respond": {
    params: { accepted: boolean; requestId: string; sessionId: string };
    result: { accepted: boolean };
  };
  "harness.respond": {
    params: HarnessRespondParams;
    result: { accepted: boolean };
  };
  /** Broker-only negative acknowledgement for a request emitted before worker identity is pinned. */
  "harness.rejectUnbound": {
    params: { requestId: string };
    result: { accepted: boolean };
  };
  /** Broker → dedicated compaction worker: run the frozen internal task (D-314). */
  "compaction.run": {
    params: import("./harness-compaction.js").CompactionTaskSpec;
    result: import("./harness-compaction.js").CompactionRunResult;
  };
  "project.trust.respond": {
    params: { remember: boolean; requestId: string; trusted: boolean };
    result: { accepted: boolean };
  };
  "provider.list": {
    params: Record<string, never>;
    result: ProviderDescriptor[];
  };
  "provider.config.delete": {
    params: { providerId: string; scope: ProviderConfigDeleteScope };
    result: ProviderConfigDetails;
  };
  "provider.config.get": {
    params: { providerId: string };
    result: ProviderConfigDetails;
  };
  "provider.config.upsert": {
    params: { config: ProviderConfigInput; scope: ProviderConfigScope };
    result: ProviderConfigDetails;
  };
  "provider.models.discover": {
    params: {
      config?: ProviderConfigInput;
      interactionId: string;
      providerId: string;
      requestCredential?: boolean;
    };
    result: ProviderModelDiscoveryResult;
  };
  "provider.auth.respond": {
    params: ProviderAuthResponse;
    result: { accepted: boolean };
  };
  "provider.auth.cancel": {
    params: { interactionId: string };
    result: { cancelled: boolean };
  };
  "provider.login": {
    params: { interactionId: string; providerId: string; type: ProviderAuthType };
    result: { authenticated: boolean };
  };
  "provider.logout": {
    params: { providerId: string };
    result: { authenticated: false };
  };
  "resource.copy": {
    params: {
      id: string;
      kind: PiResourceKind;
      name?: string;
      scope: PiResourceScope;
    };
    result: PiResourceDocumentSnapshot;
  };
  "resource.create": {
    params: { content: string; kind: PiResourceKind; name: string; scope: PiResourceScope };
    result: PiResourceDocumentSnapshot;
  };
  "resource.delete": {
    params: { expectedRevision: string; id: string; kind: PiResourceKind };
    result: { deleted: boolean; id: string };
  };
  "resource.get": {
    params: { id: string; kind: PiResourceKind };
    result: PiResourceDocumentSnapshot;
  };
  "resource.list": {
    params: { kind: PiResourceKind };
    result: PiResourceCatalogSnapshot;
  };
  "resource.update": {
    params: { content: string; expectedRevision: string; id: string; kind: PiResourceKind };
    result: PiResourceDocumentSnapshot;
  };
  "recovery.checkpoint.create": {
    params: { name: string; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.navigate": {
    params: { mode: RecoveryMode; sessionId: string; summarize?: boolean; targetId: string };
    result: RecoveryOperationResult;
  };
  "recovery.repair": {
    params: { action: RecoveryRepairAction; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.redo": {
    params: { mode: RecoveryMode; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.status": {
    params: { sessionId: string };
    result: RecoveryStatus;
  };
  "recovery.undo": {
    params: { mode: RecoveryMode; sessionId: string };
    result: RecoveryOperationResult;
  };
  "package.install": {
    params: { scope: PiPackageScope; source: string };
    result: PackageDescriptor;
  };
  "package.bootstrap": {
    params: { sources: string[] };
    result: PackageBootstrapResult;
  };
  "package.list": {
    params: Record<string, never>;
    result: PackageDescriptor[];
  };
  "package.remove": {
    params: { scope: PiPackageScope; source: string };
    result: { removed: boolean };
  };
  "package.setEnabled": {
    params: { enabled: boolean; scope: PiPackageScope; source: string };
    result: PackageDescriptor;
  };
  "package.update": {
    params: { source?: string };
    result: PackageDescriptor[];
  };
  "session.close": {
    params: { sessionId: string };
    result: { closed: boolean };
  };
  "session.create": {
    params: {
      cwd: string;
      model?: ModelSelection;
      name?: string;
      parentSession?: string;
      permissions?: PermissionPolicy;
      scope?: string[];
      tools?: string[];
      workFocus?: WorkFocusSelection;
      workFocusGeneration?: number;
      workFocusRole?: import("./work-focus.js").WorkFocusExecutionRole;
    };
    result: SessionSnapshot;
  };
  "session.list": {
    params: { cwd?: string };
    result: SessionSummary[];
  };
  /** Host-only snapshot of Pi's current committed input, never a parent-history capability. */
  "session.input.capture": {
    params: { sessionId: string };
    result: Pick<import("./harness-threads.js").ThreadInheritedContext, "text" | "anchors" | "images"> | null;
  };
  "session.entries": {
    params: { scope?: "all" | "branch"; sessionId: string };
    result: SessionEntriesResult;
  };
  "session.entries.read": {
    params: { cwd?: string; scope?: "all" | "branch"; sessionFile: string; sessionId: string };
    result: SessionEntriesResult;
  };
  "session.entry": {
    params: { entryId: string; sessionId: string };
    result: PiSessionEntry | null;
  };
  "session.fork": {
    params: { entryId: string; position?: "before" | "at"; sessionId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
  };
  "session.features.get": {
    params: { sessionId: string };
    result: PiSessionFeatureState;
  };
  "session.features.mutate": {
    params: { mutation: PiSessionFeatureMutation; sessionId: string };
    result: PiSessionFeatureState;
  };
  "session.navigate": {
    params: { sessionId: string; summarize?: boolean; targetId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
  };
  "session.recovery.navigation.commit": {
    params: {
      expectedLeafId: string | null;
      operationId: string;
      preparedTargetLeafId: string | null;
      sessionId: string;
      targetId: string;
    };
    result: {
      alreadyApplied: boolean;
      editorImages?: ImageAttachment[];
      editorText?: string;
      markerId: string;
      snapshot: SessionSnapshot;
    };
  };
  "session.recovery.navigation.commitLeaf": {
    params: {
      expectedLeafId: string | null;
      operationId: string;
      preparedTargetLeafId: string | null;
      sessionId: string;
    };
    result: {
      alreadyApplied: boolean;
      markerId: string;
      snapshot: SessionSnapshot;
    };
  };
  "session.recovery.navigation.prepare": {
    params: { sessionId: string; targetId: string };
    result: {
      currentLeafId: string | null;
      editorImages?: ImageAttachment[];
      editorText?: string;
      expectedLeafId: string | null;
      removedEntryIds: string[];
      targetId: string;
      targetLeafId: string | null;
    };
  };
  "session.recovery.navigation.prepareLeaf": {
    params: { sessionId: string; targetLeafId: string | null };
    result: {
      currentLeafId: string | null;
      expectedLeafId: string | null;
      removedEntryIds: string[];
      targetLeafId: string | null;
    };
  };
  "session.open": {
    params: {
      cwd?: string;
      model?: ModelSelection;
      permissions?: PermissionPolicy;
      sessionFile?: string;
      sessionId?: string;
      scope?: string[];
      tools?: string[];
      workspace?: SessionWorkspaceBinding;
      workFocus?: WorkFocusSelection;
      workFocusGeneration?: number;
      workFocusRole?: import("./work-focus.js").WorkFocusExecutionRole;
    };
    result: SessionSnapshot;
  };
  "session.resolve": {
    params: { sessionFile: string };
    result: { cwd: string; sessionFile: string; sessionId: string };
  };
  "session.header": {
    params: { sessionId: string };
    result: SessionHeader | null;
  };
  "session.rename": {
    params: { name: string; sessionFile?: string; sessionId: string };
    result: { name?: string; sessionId: string };
  };
  "session.snapshot": {
    params: { sessionId: string };
    result: SessionSnapshot;
  };
  "session.reconcile": {
    params: { scopes: Array<"branch" | "all">; sessionId: string };
    result: SessionReconcileResult;
  };
  "session.stats": {
    params: { sessionId: string };
    result: SessionStats;
  };
  "session.summary": {
    params: { sessionId: string };
    result: SessionSummary;
  };
  "session.tree": {
    params: { sessionId: string };
    result: SessionTreeResult;
  };
  "harness.embed": {
    params: HarnessEmbedParams;
    result: HarnessEmbedResult;
  };
  "harness.rerank": {
    params: HarnessRerankParams;
    result: HarnessRerankResult;
  };
  /**
   * Fast Decision Model batch: typed questions against authorized material.
   * Internal Application Host -> Pi workspace-worker inference authority (D-312).
   */
  "harness.fastDecision": {
    params: HarnessFastDecisionParams;
    result: HarnessFastDecisionResult;
  };
  /** Internal Application Host -> Pi workspace-worker inference authority. */
  "harness.inference.describe": {
    params: Record<string, never>;
    result: HarnessInferenceBindingSnapshot;
  };
  /** Out-of-band cancellation for an internal embedding/rerank batch. */
  "harness.inference.cancel": {
    params: { batchId: string };
    result: { cancelled: boolean };
  };
  "settings.get": {
    params: Record<string, never>;
    result: PiSettingsSnapshot;
  };
  "settings.update": {
    params: {
      expectedRevision: string;
      remove: string[];
      scope: PiConfigScope;
      set: { [key: string]: JsonValue };
    };
    result: PiSettingsSnapshot;
  };
}

export type HostMethod = keyof HostMethodMap;

export type HostMethodParams<M extends HostMethod> = HostMethodMap[M]["params"];

export type HostMethodResult<M extends HostMethod> = HostMethodMap[M]["result"];

import path from "node:path";
import { stat } from "node:fs/promises";
import { createOutputStore, type OutputStore } from "./output-store.js";
import { createPathLockService, type PathLockService } from "./path-lock.js";
import { discoverShells } from "./shell-discovery.js";
import type { HarnessShellSetting } from "./harness-shell-settings.js";
import type { HarnessWebBinding } from "./harness-web-settings.js";
import { createShellSupervisor, selectInterpreter, type ShellCommandCompletedEvent, type ShellCommandOutputEvent, type ShellCommandStartedEvent, type ShellInterpreter, type ShellSupervisor } from "./shell-supervisor.js";
import type { TerminalSessionApi } from "../terminal/session-api.js";
import { createHarnessSearchService, type HarnessSearchDeps, type HarnessSearchService } from "./search-service.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import { createExploreQueryStore, type ExploreQueryStore } from "./explore-query-store.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { Zone2MaterialRequest, Zone2MaterialResult } from "../knowledge/context-runtime.js";
import type { TodoToolDeps } from "./todo-tool.js";
import type { RecallToolDeps } from "./recall-tool.js";
import type { KnowledgeSuggestionsSettings } from "./knowledge-suggestions.js";
import type { createLspNavigationServices } from "./lsp-nav.js";
import type { StructureSource } from "../structure/types.js";
import type { ThreadRegistry } from "./thread-registry.js";
import type { ThreadTranscriptReader } from "./thread-transcript.js";
import { createVerificationCoordinator, type VerificationCoordinator } from "./verification-coordinator.js";
import type { CapturedThreadDraftBaseline, PrepareIsolatedBranchInput } from "./thread-runtime.js";
import { createObservationCursorStore, type ObservationCursorStore } from "./observation-cursors.js";
import { createZone2DeliveryService } from "./zone2-threads.js";
import { clearManagedShellCompletionWatches } from "./harness-services.js";
import { HarnessServiceError } from "./service-error.js";
import type { HarnessPathAuthority } from "./path-authority.js";
import { canonicalizePathIdentity, normalizePathIdentity } from "../workspace/path-safety.js";
import {
  discoverProjects,
  getWorkContext,
  operationDirAbsolute,
  resetWorkContext,
  seedWorkContext,
  selectOperationDir,
  setQueryScope,
  validateStoredWorkContext,
  type WorkContextDeps,
} from "./work-context.js";
import { readHistoryPage } from "@varin/protocol";
import {
  COMPACTION_QUERY_CAPABILITIES,
  COMPACTION_QUERY_METHODS,
} from "@varin/protocol";
import type {
  CompactionHistoryParams,
  CompactionHistoryResult,
  ContextDiscoverParams,
  ContextDiscoverResult,
  ContextGetResult,
  ContextResetParams,
  ContextScopeParams,
  ContextSelectParams,
  HarnessActorContext,
  HarnessActorIdentity,
  HarnessCapability,
  HarnessWorkContextState,
  AgentInputContext,
  PiWorkContextCommit,
  PiWorkContextSnapshot,
} from "@varin/protocol";

export interface WorkContextJournal {
  read(actor: HarnessActorIdentity): Promise<PiWorkContextSnapshot>;
  commit(actor: HarnessActorIdentity, input: PiWorkContextCommit): Promise<PiWorkContextSnapshot>;
}
import type {
  SurfaceSnapshotOverlayResult,
  SurfaceSnapshotReadResult,
} from "../documents/surface-snapshot-store.js";

export interface HarnessSessionContext {
  actor: HarnessActorIdentity;
  grantedCapabilities: readonly HarnessCapability[] | Promise<readonly HarnessCapability[]>;
  workspaceId: string | null;
  workspaceRoot: string;
  /** Absolute authorized workspace root; used to seed the work context. */
  authorityWorkspaceRoot?: string;
  /** Resolved for this workspace at session register. Host-wide options are only a fallback. */
  shellSetting?: HarnessShellSetting;
  shellResolution?: { invalid: { reason: string; hint: string } };
  /** Frozen credential-free web provider/policy identity for this worker generation. */
  webBinding?: HarnessWebBinding;
  /** Prepared from Pi's active branch before actor publication. */
  preparedWorkContext?: { state: HarnessWorkContextState; leafId: string | null; entryId: string | null; authorityRootIdentity: string; sessionRootIdentity: string };
}

interface SessionEntry {
  actor: Omit<HarnessActorIdentity, "runId">;
  grantedCapabilities: Promise<readonly HarnessCapability[]>;
  shellSupervisor: ShellSupervisor | null;
  interpreter: ShellInterpreter | { unavailable: { reason: string; hint: string } };
  workspaceId: string | null;
  workspaceRoot: string;
  /** Absolute authorized workspace root (the base `operationDir` is relative to). */
  authorityRoot: string;
  authorityRootIdentity: string;
  sessionRootIdentity: string;
  workspaceScope?: readonly string[];
  workContext: HarnessWorkContextState;
  workContextLeafId: string | null;
  workContextEntryId: string | null;
  workContextVerified: boolean;
  workContextTail: Promise<void>;
  webBinding?: HarnessWebBinding;
}

export function deriveHarnessCapabilities(
  activeTools: readonly string[],
  availability: { documentRead?: boolean; documentPathOverlay?: boolean; threadRuntime: boolean; experiments?: boolean; settings?: boolean; followUps?: boolean },
): readonly HarnessCapability[] {
  const tools = new Set(activeTools);
  const capabilities = new Set<HarnessCapability>([
    // Hidden session extensions use these even when their corresponding
    // user-facing tools are not shown.
    "context.session",
    "read.lsp",
    "read.output",
  ]);
  if (tools.has("grep") || tools.has("explore")) capabilities.add("read.search");
  if (availability.documentRead && (tools.has("read") || tools.has("document_read"))) capabilities.add("read.document");
  if (availability.documentPathOverlay && (tools.has("find") || tools.has("ls"))) capabilities.add("read.document");
  if (tools.has("webfetch") || tools.has("websearch") || tools.has("research_search")) capabilities.add("read.web");
  if (tools.has("bash")) capabilities.add("process.shell");
  if (tools.has("write") || tools.has("edit") || tools.has("apply_patch")) capabilities.add("write.document");
  if (
    availability.threadRuntime
    && ["dispatch", "threads", "wait", "send", "read_thread", "merge", "kill", "submit_facts", "update"].some((name) => tools.has(name))
  ) {
    capabilities.add("control.thread");
  }
  if (
    availability.experiments
    && ["experiment", "resources", "research_source"].some((name) => tools.has(name))
  ) {
    capabilities.add("read.experiment");
    if (tools.has("experiment")) capabilities.add("control.experiment");
    if (tools.has("research_source")) capabilities.add("write.research-source");
  }
  if (
    availability.settings
    && ["settings_search", "settings_read", "settings_update"].some((name) => tools.has(name))
  ) {
    capabilities.add("read.settings");
    if (tools.has("settings_update")) capabilities.add("control.settings");
  }
  if (
    availability.followUps
    && ["follow_up", "follow_up_check", "follow_up_now"].some((name) => tools.has(name))
  ) {
    capabilities.add("read.followup");
    capabilities.add("control.followup");
  }
  return [...capabilities];
}

/** Read-source lookup used by the native Pi read wrapper. */
export type HarnessDocumentReadLookup =
  | SurfaceSnapshotReadResult
  | {
    status: "working-branch";
    revision: string;
    provenance: import("@varin/protocol").WorkingBranchReadProvenance;
    base64?: string;
    missing?: true;
    message?: string;
  };

export type HarnessDocumentReadSource = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => HarnessDocumentReadLookup | Promise<HarnessDocumentReadLookup>;

/** Write admission for native Pi write/edit/apply_patch wrappers (D-089). */
export type HarnessDocumentWriteGuard = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => Promise<import("@varin/protocol").DocumentWriteGuardResult>;

/** Shared surface-aware mutation plan for root-session write/edit/apply_patch (D-225). */
export type HarnessDocumentSurfaceWrite = (
  sessionId: string,
  workspaceId: string,
  context: AgentInputContext,
  changes: ReadonlyArray<{
    resourceId: string;
    action: import("@varin/protocol").DocumentSurfaceWriteAction;
    content?: string;
    edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  }>,
  signal?: AbortSignal,
) => Promise<import("@varin/protocol").DocumentSurfaceWriteResult>;

export type HarnessDocumentBranchWrite = (
  sessionId: string,
  changes: ReadonlyArray<{
    resourceId: string;
    action: import("@varin/protocol").DocumentBranchWriteAction;
    content?: string;
    edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  }>,
  expectedRevision?: number,
  signal?: AbortSignal,
) => Promise<import("@varin/protocol").DocumentBranchWriteResult>;

export type HarnessWorkingBranchEnsureMaterialized = (
  sessionId: string,
  signal?: AbortSignal,
) => Promise<import("@varin/protocol").WorkingBranchEnsureMaterializedResult>;

export type HarnessDocumentPathOverlayLookup =
  | SurfaceSnapshotOverlayResult
  | {
    status: "ready";
    authority: "working-branch";
    entries: import("../documents/surface-snapshot-store.js").SurfaceSnapshotOverlayEntry[];
  };

/** Content-free fixed path lookup used by native Pi find/ls wrappers. */
export type HarnessDocumentPathOverlay = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => HarnessDocumentPathOverlayLookup | Promise<HarnessDocumentPathOverlayLookup>;

export interface HarnessServiceHost {
  outputStore: OutputStore;
  observationCursors: ObservationCursorStore;
  pathLockService: PathLockService;
  searchService: HarnessSearchService;
  exploreQueryStore: ExploreQueryStore;
  diagnosticsProvider: DiagnosticsProvider | null;
  lspNavigationServices: ReturnType<typeof createLspNavigationServices> | null;
  structureSource: StructureSource | null;
  /**
   * Graph relations for one path. `stale` is decided by the caller, which knows
   * the excerpt revision, so the provider does not report it. Throwing means
   * "not answered" and must degrade the annotation, not the search (D-112).
   */
  fileRelations: ((workspaceId: string, path: string) => Promise<Omit<import("@varin/protocol").ExploreFileRelation, "stale"> | null>) | null;
  /**
   * Resolve an execution session to its owning, already-open symbol graph.
   * The graph is owned by the project workspace; the execution workspace only
   * owns Documents/LSP/path access for an isolated Run.
   */
  graphRecall: ((sessionId: string, executionWorkspaceId: string) => Promise<{
    workspaceId: string;
    store: import("../knowledge/store.js").KnowledgeStore;
    /** Stored line/revision facts may be returned directly only in this view. */
    directFactsCompatible: boolean;
  } | null>) | null;
  /**
   * Bounded live resolution of references/calls around a queried anchor
   * (D-240). Absent when no language supervisor is wired — `related` then
   * answers stored relations only.
   */
  relationCollector: import("./related-tool.js").RelatedRelationCollector | null;
  semanticRecall: ((
    workspaceId: string,
    question: string,
    limit: number,
    options?: {
      signal?: AbortSignal;
      issueReceipt?: boolean;
      engineOptions?: import("./pdf-engine.js").PdfEngineOptions;
      roots?: readonly string[];
      sessionId?: string;
      inputContext?: import("@varin/protocol").AgentInputContext;
      threadDocuments?: Array<{ path: string; content: string; revision: string }>;
      threadQuery?: import("./working-state/working-branch-query.js").WorkingBranchQuerySnapshot;
    },
  ) => Promise<import("./explore.js").ExploreSemanticSearch>) | null;
  pinWorkingBranchQuery?: (
    sessionId: string,
    options?: import("./working-state/working-branch-lookups.js").WorkingBranchPinOptions,
  ) => Promise<import("./working-state/working-branch-lookups.js").WorkingBranchQuerySnapshot | null>;
  harnessSettings?: (
    workspaceId: string,
  ) => import("@varin/protocol").PiSettingsSnapshot | null | Promise<import("@varin/protocol").PiSettingsSnapshot | null>;
  rerankExploreViews?: (input: {
    workspaceId: string;
    query: string;
    documents: Array<{ id: string; text: string; revision?: string }>;
    settings: import("@varin/protocol").HarnessRerankSettings;
    signal?: AbortSignal;
  }) => Promise<import("@varin/protocol").HarnessRerankResult>;
  /**
   * Per-purpose fast-decision binding status resolved by the Pi runtime
   * (D-312). The `ready` binding carries the credential-free
   * `configurationId` the caller freezes onto a query.
   */
  fastDecisionStatus?: (
    workspaceId: string,
    purpose: import("@varin/protocol").HarnessFastDecisionPurpose,
  ) => Promise<import("@varin/protocol").HarnessFastDecisionPurposeStatus>;
  /**
   * Fast Decision batch (D-312): typed questions over authorized material,
   * executed by the workspace runtime against the binding frozen at query
   * start. `settings` is that frozen binding; the runtime rejects a request
   * whose identity no longer matches the live one.
   */
  fastDecision?: (input: {
    workspaceId: string;
    purpose: import("@varin/protocol").HarnessFastDecisionPurpose;
    settings: import("@varin/protocol").HarnessResolvedFastDecisionBinding;
    goal: string;
    materials: import("@varin/protocol").FastDecisionMaterial[];
    questions: import("@varin/protocol").FastDecisionQuestion[];
    signal?: AbortSignal;
  }) => Promise<import("@varin/protocol").HarnessFastDecisionResult>;
  permissionAudit: ((record: import("@varin/protocol").PermissionAuditRecord) => void) | null;
  webFetchService: {
    fetch: (input: import("@varin/protocol").WebFetchRequest | string, ctx: {
      workspaceId: string;
      authority: import("@varin/protocol").RetrievalReceiptAuthority;
      render?: boolean;
      domainPolicy?: import("@varin/protocol").HarnessWebDomainPolicy;
      signal?: AbortSignal;
      issueReceipt?: boolean;
    }) => Promise<import("@varin/protocol").FetchResult>;
  } | null;
  webSearchService: import("./router.js").HarnessService<"web.search"> | null;
  /** Read-only egress probe — reports policy, decision, and resolution without fetching. */
  networkDiagnostics?: {
    diagnose: (
      url: string,
      override?: import("@varin/protocol").NetworkDiagnoseParams["override"],
    ) => Promise<import("@varin/protocol").NetworkDiagnosisResult>;
  } | null;
  researchSearchService: import("./router.js").HarnessService<"research.search"> | null;
  researchDecideService?: import("./router.js").HarnessService<"research.decide"> | null;
  materialCollectionsService?: import("./router.js").HarnessService<"materials.collections"> | null;
  documentReader?: import("./document-reading.js").DocumentReader | null;
  readMaterialFile?: (ctx: import("./router.js").HarnessServiceContext, path: import("./router.js").HarnessAuthorizedPath) => Promise<Buffer>;
  /** Read disk bytes from the already-authorized canonical target through a verified file handle. */
  readAuthorizedDiskFile?: (ctx: import("./router.js").HarnessServiceContext, path: import("./router.js").HarnessAuthorizedPath) => Promise<Buffer>;
  documentReadingSettings?: (sessionId: string) => Promise<import("@varin/protocol").HarnessSettings["documentReading"]>;
  materialWebPolicy?: (sessionId: string) => Promise<import("@varin/protocol").HarnessWebDomainPolicy>;
  documentReadSource: HarnessDocumentReadSource | null;
  documentPathOverlay: HarnessDocumentPathOverlay | null;
  documentWriteGuard: HarnessDocumentWriteGuard | null;
  documentSurfaceWrite: HarnessDocumentSurfaceWrite | null;
  documentBranchWrite: HarnessDocumentBranchWrite | null;
  workingBranchEnsureMaterialized: HarnessWorkingBranchEnsureMaterialized | null;
  // Phase 2: knowledge, zone2, compaction ack, todo, recall
  knowledgeStore: KnowledgeStore | null;
  userKnowledgeStore: KnowledgeStore | null;
  zone2Provider: ((request: Zone2MaterialRequest) => Promise<Zone2MaterialResult>) | null;
  zone2Delivery: ReturnType<typeof createZone2DeliveryService>;
  onSessionCompacted: ((sessionId: string) => void) | null;
  recallDepsProvider: ((sessionId: string, workspaceId: string | null) => Promise<RecallToolDeps>) | null;
  knowledgeSuggestDepsProvider: ((
    sessionId: string,
    workspaceId: string | null,
  ) => Promise<{ store: KnowledgeStore; settings: KnowledgeSuggestionsSettings; onChanged?: () => void } | null>) | null;
  todoDepsProvider: ((sessionId: string) => Promise<TodoToolDeps>) | null;
  // Phase 3: Thread registry
  threadRegistry: ThreadRegistry | null;
  threadCaptureDraftBaseline: ((sessionId: string, workspaceId: string, context: import("@varin/protocol").AgentInputContext) => Promise<CapturedThreadDraftBaseline>) | null;
  threadPrepareIsolatedBranch: ((input: PrepareIsolatedBranchInput) => Promise<{ branchId: string; worktree: import("@varin/protocol").ThreadWorktree }>) | null;
  threadSpawnSession: ((input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>) | null;
  /**
   * Capture the parent session's committed input at dispatch time for an
   * `inherit` Thread (D-285.4): compaction summary + retained raw messages
   * rendered as bounded text plus history anchors. Null when the session has
   * no capturable material.
   */
  threadCaptureInputContext?: ((input: { sessionId: string }) => Promise<Pick<import("@varin/protocol").ThreadInheritedContext, "text" | "anchors" | "images"> | null>) | null;
  /**
   * Start a new Run on a settled Thread for an execution `request`
   * (D-285.5/3.18B): `continue` resumes the retained session; `fresh`
   * rebuilds the input on a new session while results/files/transcript stay.
   */
  threadContinueRun?: ((input: {
    workspaceId: string;
    parent: import("@varin/protocol").ThreadParent;
    threadId: string;
    mode: "continue" | "fresh";
    task: string;
    /** Idempotency record excluded when pending messages flush into the input. */
    requestId?: string;
    /** Skip the shared-budget admission check (dequeue path already gated). */
    admitted?: boolean;
    /** Requester identity recorded on a parked continuation. */
    from?: import("@varin/protocol").ThreadMessagePeer;
    /** Resolved capability/model re-route frozen for the new Run (7B/D-300). */
    frozen?: import("@varin/protocol").ThreadRunFrozenConfig;
  }) => Promise<{ runId?: string }>) | null;
  /** Retry lost Runs under a parent scope when the shared budget may have room. */
  threadResumeLost?: ((workspaceId: string, parent: import("@varin/protocol").ThreadParent) => Promise<void>) | null;
  threadKillSession: ((threadId: string, keepWorktree?: boolean, workspaceId?: string) => Promise<void>) | null;
  requireThreadMergeJournal: boolean;
  threadApplyWorktreeDiff: ((
    workspaceId: string,
    parent: import("@varin/protocol").ThreadParent,
    threadId: string,
    resultRevision?: number,
    executionId?: string,
    extras?: {
      signal?: AbortSignal;
      sourceOwner?: { ownerId: string; generation: number };
      expectedBindingFingerprint?: string;
      resolutions?: import("@varin/protocol").ThreadConflictResolution[];
    },
  ) => Promise<{
    merged: number;
    conflicts: string[];
    conflictState?: "none" | "markers" | "parent-unchanged";
    changedFiles?: string[];
    diffStats?: import("@varin/protocol").ThreadDiffStats;
    appliedPaths?: string[];
    surfaceTargetPaths?: string[];
    preview?: import("@varin/protocol").ThreadIntegrationPreview;
    status?: "applied" | "conflict" | "compensated" | "needs-attention";
    operationId?: string;
    resultRevision?: number;
  }>) | null;
  /** Incorporate a published parent result revision into a started child
   * thread's working baseline (D-286/3.18D); conditional three-way, never a
   * snapshot overwrite. */
  threadUpdateBaseline?: ((
    workspaceId: string,
    parent: import("@varin/protocol").ThreadParent,
    threadId: string,
    resultRevision?: number,
    extras?: { signal?: AbortSignal },
  ) => Promise<{
    status: "applied" | "conflict" | "needs-attention";
    threadId: string;
    resultRevision: number;
    baseRef: string;
    updatedFromParent: string[];
    keptPaths: string[];
    mergedPaths: string[];
    conflicts: { path: string; reason?: string }[];
    message?: string;
  }>) | null;
  threadSendToSession: ((sessionId: string, message: string, meta: { from: string; requestId?: string; messageId?: string }) => Promise<void>) | null;
  threadTranscriptReader: ThreadTranscriptReader | null;
  threadHistoryEntries: ((sessionId: string) => Promise<import("@varin/protocol").SessionEntriesResult>) | null;
  registerSession(ctx: HarnessSessionContext): void;
  prepareWorkContext(ctx: HarnessSessionContext): Promise<HarnessSessionContext>;
  dropSession(sessionId: string, actor?: HarnessActorIdentity): void;
  /**
   * D-314: register a broker-spawned compaction worker as an auxiliary actor
   * of `parent`'s session. Its harness queries carry the parent session
   * identity plus the worker's own workerId; `leafEntryId` bounds history
   * reads to the material frozen at task start. No-op unless the parent
   * identity is still the registered session actor.
   */
  registerAuxiliaryActor(parent: HarnessActorIdentity, workerId: string, leafEntryId: string): void;
  dropAuxiliaryActor(workerId: string): void;
  /** Serve a compaction worker's frozen-range history read (auxiliary actors only). */
  compactionHistory(actor: HarnessActorContext, params: import("@varin/protocol").CompactionHistoryParams): Promise<import("@varin/protocol").CompactionHistoryResult>;
  /**
   * D-314: run one frozen compaction task in a dedicated worker subprocess.
   * Wired in the application host to the runtime broker; the parent session
   * worker is the only valid caller (enforced by the service).
   */
  runCompactionTask: ((
    actor: HarnessActorIdentity,
    spec: import("@varin/protocol").CompactionTaskSpec,
    signal: AbortSignal,
  ) => Promise<import("@varin/protocol").CompactionRunResult>) | null;
  hasActor(identity: HarnessActorIdentity): boolean;
  resolveActor(identity: HarnessActorIdentity, contextEntryId?: string | null): Promise<HarnessActorContext | null>;
  // RR2: session work context (operation dir + query scope, Host-owned, CAS-revised)
  workContextGet(actor: HarnessActorContext): ContextGetResult;
  workContextSelect(actor: HarnessActorContext, params: ContextSelectParams): Promise<ContextGetResult>;
  workContextScope(actor: HarnessActorContext, params: ContextScopeParams): Promise<ContextGetResult>;
  workContextReset(actor: HarnessActorContext, params: ContextResetParams): Promise<ContextGetResult>;
  workContextDiscover(actor: HarnessActorContext, params: ContextDiscoverParams, signal?: AbortSignal): Promise<ContextDiscoverResult>;
  /** Current context revision for respond piggyback; undefined without a registered session. */
  workContextRevision(sessionId: string): number | undefined;
  workContextIdentity(sessionId: string): { revision: number; entryId: string | null } | undefined;
  /** Absolute operation dir for shell anchoring; undefined without a registered session. */
  workContextOperationDir(sessionId: string): string | undefined;
  getShellSupervisor(sessionId: string): ShellSupervisor | null;
  /** Wait for this session's current and retiring shells to stop and release their writers. */
  closeSessionShell(sessionId: string): Promise<void>;
  hasActiveCommandAtDirectory(directory: string): boolean;
  getInterpreter(sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null;
  getWebBinding(sessionId: string): HarnessWebBinding | null;
  resolveWorkspaceRoot?(workspaceId: string): Promise<string | null>;
  readExploreFile?: ExploreFileReader;
  storeRetrievalArtifact?: (
    workspaceId: string,
    bytes: Buffer,
    authority?: import("@varin/protocol").RetrievalReceiptAuthority,
  ) => Promise<import("@varin/protocol").RetrievalArtifactRef>;
  readRetrievalArtifact?: (
    workspaceId: string,
    artifact: import("@varin/protocol").RetrievalArtifactRef,
  ) => Promise<Buffer | null>;
  readRetrievalArtifactSlice?: (
    workspaceId: string,
    artifact: import("@varin/protocol").RetrievalArtifactRef,
    offset: number,
    length: number,
  ) => Promise<Buffer | null>;
  protectRetrievalEvidence?: (input: {
    workspaceId: string;
    threadId: string;
    runId: string;
    evidence: import("@varin/protocol").RetrievalEvidence;
    receiptAuthority: import("@varin/protocol").RetrievalReceiptAuthority;
  }) => Promise<void>;
  lookupWebFetchReceipt?: (
    workspaceId: string,
    authority: import("@varin/protocol").RetrievalReceiptAuthority,
    receiptId: string,
  ) => Promise<import("@varin/protocol").RetrievalUrlReceipt | null>;
  releaseWebFetchReceipts?: (sessionId: string, workspaceId: string | null) => Promise<void>;
  releaseRetrievalTemporaryArtifacts?: (
    workspaceId: string,
    authority: import("@varin/protocol").RetrievalReceiptAuthority,
  ) => Promise<void>;
  /** Dirty paths this turn's fixed source still owns (D-088). */
  agentInputDraftPaths?: (sessionId: string, context: import("@varin/protocol").AgentInputContext) => readonly string[];
  agentInputSurfaceOwner?: import("../documents/authority.js").DocumentAuthority["agentInputSurfaceOwner"];
  commitAgentInputContext: (sessionId: string, context: import("@varin/protocol").AgentInputContext) => { committed: boolean };
  releaseAgentInputContext: (sessionId: string, context: import("@varin/protocol").AgentInputContext) => { released: boolean };
  verification: VerificationCoordinator;
  // Phase 4: experiment execution and resource facts (7C/7D, D-300)
  experimentService: import("./experiments.js").ExperimentService | null;
  resourceService: import("./resources.js").ResourceService | null;
  sourceService: import("./sources.js").SourceService | null;
  /** Agent-facing settings catalog service (D-306). */
  settingsService: import("./settings-service.js").SettingsService | null;
  /** Durable follow-up registrations and continuation delivery (D-307). */
  followUpService: import("./followups.js").FollowUpService | null;
  /** Project scheduled-task authority shared with GUI/CLI/Markdown (D-307). */
  scheduledTaskService: import("../scheduled-tasks/service.js").ScheduledTaskService | null;
  managedRemoteTargets: import("./managed-remote-client.js").ManagedRemoteTargetRegistry | null;
  /** Deliver one terminal shell fact into the same 7G observer used by local PTY commands. */
  observeShellCompletion(sessionId: string, event: ShellCommandCompletedEvent): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessServiceHostOptions {
  search: HarnessSearchDeps["search"];
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  /** Path authority shared with the router; authorizes context mutations. */
  pathAuthority?: HarnessPathAuthority;
  /** Pi SessionManager active-branch journal, accessed out-of-band during a tool call. */
  workContextJournal?: WorkContextJournal;
  /** Production injects the Rust-kernel lease authority; tests may use the local helper. */
  pathLockService?: PathLockService;
  readExploreFile?: ExploreFileReader;
  agentInputDraftPaths?: HarnessServiceHost["agentInputDraftPaths"];
  agentInputSurfaceOwner?: HarnessServiceHost["agentInputSurfaceOwner"];
  commitAgentInputContext?: HarnessServiceHost["commitAgentInputContext"];
  releaseAgentInputContext?: HarnessServiceHost["releaseAgentInputContext"];
  dropAgentInputContexts?: (sessionId: string) => void;
  diagnosticsProvider?: DiagnosticsProvider;
  lspNavigationServices?: ReturnType<typeof createLspNavigationServices>;
  structureSource?: StructureSource;
  fileRelations?: HarnessServiceHost["fileRelations"];
  graphRecall?: HarnessServiceHost["graphRecall"];
  relationCollector?: HarnessServiceHost["relationCollector"];
  semanticRecall?: HarnessServiceHost["semanticRecall"];
  pinWorkingBranchQuery?: HarnessServiceHost["pinWorkingBranchQuery"];
  harnessSettings?: HarnessServiceHost["harnessSettings"];
  rerankExploreViews?: HarnessServiceHost["rerankExploreViews"];
  fastDecisionStatus?: HarnessServiceHost["fastDecisionStatus"];
  fastDecision?: HarnessServiceHost["fastDecision"];
  permissionAudit?: (record: import("@varin/protocol").PermissionAuditRecord) => void;
  shellSetting?: HarnessShellSetting;
  /**
   * Machine-level discovery. Production passes the Host construction result.
   * When omitted, the Host discovers once from the real environment so a
   * forgotten option cannot collapse Windows to "Git for Windows not found".
   */
  discoveredShells?: { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  discoverShells?: () => { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  /** Per-workspace fallback when the session context does not carry a setting. */
  resolveShellSetting?: (workspaceId: string | null) => HarnessShellSetting;
  remote?: boolean;
  /**
   * Called when a session's shell supervisor is created to register a
   * process-mode writer with the document authority. Returns a handle
   * with a close() method, or null if registration is not available.
   */
  registerWriter?: (sessionId: string, workspaceRoot: string) => Promise<{ close: () => Promise<void> } | null>;
  createTerminalSession?: TerminalSessionApi["createTerminalSession"];
  /** Receives the single PTY-confirmed completion fact for 7G context delivery. */
  onShellCompleted?: (sessionId: string, event: ShellCommandCompletedEvent) => void | Promise<void>;
  /** Durable shell lifecycle producers used by follow-up and Zone 2. */
  onShellStarted?: (sessionId: string, event: ShellCommandStartedEvent) => void | Promise<void>;
  onShellOutput?: (sessionId: string, event: ShellCommandOutputEvent) => void | Promise<void>;
  /** Web fetch service (null on cloud/web hosts without fetch capability) */
  webFetchService?: HarnessServiceHost["webFetchService"];
  /** Web search service (null when no search provider available) */
  webSearchService?: HarnessServiceHost["webSearchService"];
  /** Read-only outbound egress probe (diagnostics; never performs a fetch). */
  networkDiagnostics?: HarnessServiceHost["networkDiagnostics"];
  /** Scholarly metadata service. Uses public OpenAlex/Semantic Scholar APIs. */
  researchSearchService?: HarnessServiceHost["researchSearchService"];
  /** Fast-decision consumer for Web and scholarly candidates (D-315 L5). */
  researchDecideService?: HarnessServiceHost["researchDecideService"];
  /** Material collections service (D-315 L3). */
  materialCollectionsService?: HarnessServiceHost["materialCollectionsService"];
  documentReader?: HarnessServiceHost["documentReader"];
  readMaterialFile?: HarnessServiceHost["readMaterialFile"];
  readAuthorizedDiskFile?: HarnessServiceHost["readAuthorizedDiskFile"];
  documentReadingSettings?: HarnessServiceHost["documentReadingSettings"];
  materialWebPolicy?: HarnessServiceHost["materialWebPolicy"];
  /** Surface-aware native Pi read source (null when Documents is unavailable). */
  documentReadSource?: HarnessDocumentReadSource;
  /** Surface-aware native Pi find/ls path overlay (null when unavailable). */
  documentPathOverlay?: HarnessDocumentPathOverlay;
  /** Classify a path against this turn's fixed draft (kept for inspect; writes use surfaceWrite). */
  documentWriteGuard?: HarnessDocumentWriteGuard;
  /** Shared surface-aware mutation plan for native write / edit / apply_patch. */
  documentSurfaceWrite?: HarnessDocumentSurfaceWrite;
  documentBranchWrite?: HarnessDocumentBranchWrite;
  workingBranchEnsureMaterialized?: HarnessWorkingBranchEnsureMaterialized;
  // Phase 2 options
  knowledgeStore?: KnowledgeStore;
  userKnowledgeStore?: KnowledgeStore;
  zone2Provider?: (request: Zone2MaterialRequest) => Promise<Zone2MaterialResult>;
  onSessionCompacted?: (sessionId: string) => void;
  recallDepsProvider?: (sessionId: string, workspaceId: string | null) => Promise<RecallToolDeps>;
  knowledgeSuggestDepsProvider?: HarnessServiceHost["knowledgeSuggestDepsProvider"];
  todoDepsProvider?: (sessionId: string) => Promise<TodoToolDeps>;
  // Phase 3 options
  threadRegistry?: ThreadRegistry;
  threadCaptureDraftBaseline?: HarnessServiceHost["threadCaptureDraftBaseline"];
  threadPrepareIsolatedBranch?: HarnessServiceHost["threadPrepareIsolatedBranch"];
  threadSpawnSession?: (input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>;
  threadCaptureInputContext?: HarnessServiceHost["threadCaptureInputContext"];
  threadContinueRun?: HarnessServiceHost["threadContinueRun"];
  threadResumeLost?: HarnessServiceHost["threadResumeLost"];
  threadKillSession?: (threadId: string, keepWorktree?: boolean, workspaceId?: string) => Promise<void>;
  threadApplyWorktreeDiff?: HarnessServiceHost["threadApplyWorktreeDiff"];
  threadUpdateBaseline?: HarnessServiceHost["threadUpdateBaseline"];
  requireThreadMergeJournal?: boolean;
  threadSendToSession?: (sessionId: string, message: string, meta: { from: string; requestId?: string; messageId?: string }) => Promise<void>;
  threadTranscriptReader?: ThreadTranscriptReader;
  threadHistoryEntries?: NonNullable<HarnessServiceHost["threadHistoryEntries"]>;
  /** D-314: dedicated compaction worker subprocess runner (broker wiring). */
  runCompactionTask?: NonNullable<HarnessServiceHost["runCompactionTask"]>;
  verification?: VerificationCoordinator;
  storeRetrievalArtifact?: HarnessServiceHost["storeRetrievalArtifact"];
  readRetrievalArtifact?: HarnessServiceHost["readRetrievalArtifact"];
  readRetrievalArtifactSlice?: HarnessServiceHost["readRetrievalArtifactSlice"];
  protectRetrievalEvidence?: HarnessServiceHost["protectRetrievalEvidence"];
  lookupWebFetchReceipt?: HarnessServiceHost["lookupWebFetchReceipt"];
  releaseWebFetchReceipts?: HarnessServiceHost["releaseWebFetchReceipts"];
  releaseRetrievalTemporaryArtifacts?: HarnessServiceHost["releaseRetrievalTemporaryArtifacts"];
  experimentService?: HarnessServiceHost["experimentService"];
  resourceService?: HarnessServiceHost["resourceService"];
  sourceService?: HarnessServiceHost["sourceService"];
  settingsService?: HarnessServiceHost["settingsService"];
  followUpService?: HarnessServiceHost["followUpService"];
  scheduledTaskService?: HarnessServiceHost["scheduledTaskService"];
  managedRemoteTargets?: HarnessServiceHost["managedRemoteTargets"];
}

export function createHarnessServiceHost(options: HarnessServiceHostOptions): HarnessServiceHost {
  const outputStore = createOutputStore();
  const observationCursors = createObservationCursorStore();
  const pathLockService = options.pathLockService ?? createPathLockService();
  const exploreQueryStore = createExploreQueryStore();
  const searchService = createHarnessSearchService({
    search: options.search,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    ...(options.readExploreFile ? { readFile: options.readExploreFile } : {}),
    ...(options.pinWorkingBranchQuery ? { pinWorkingBranchQuery: options.pinWorkingBranchQuery } : {}),
    ...(options.agentInputDraftPaths ? { draftPaths: options.agentInputDraftPaths } : {}),
  });
  const diagnosticsProvider = options.diagnosticsProvider ?? null;
  const lspNavigationServices = options.lspNavigationServices ?? null;
  const structureSource = options.structureSource ?? null;
  const fileRelations = options.fileRelations ?? null;
  const graphRecall = options.graphRecall ?? null;
  const relationCollector = options.relationCollector ?? null;
  const semanticRecall = options.semanticRecall ?? null;
  const pinWorkingBranchQuery = options.pinWorkingBranchQuery;
  const harnessSettings = options.harnessSettings;
  const rerankExploreViews = options.rerankExploreViews;
  const permissionAudit = options.permissionAudit ?? null;
  const webFetchService = options.webFetchService ?? null;
  const webSearchService = options.webSearchService ?? null;
  const networkDiagnostics = options.networkDiagnostics ?? null;
  const researchSearchService = options.researchSearchService ?? null;
  const researchDecideService = options.researchDecideService ?? null;
  const materialCollectionsService = options.materialCollectionsService ?? null;
  const documentReadSource = options.documentReadSource ?? null;
  const documentPathOverlay = options.documentPathOverlay ?? null;
  const documentWriteGuard = options.documentWriteGuard ?? null;
  const documentSurfaceWrite = options.documentSurfaceWrite ?? null;
  const documentBranchWrite = options.documentBranchWrite ?? null;
  const workingBranchEnsureMaterialized = options.workingBranchEnsureMaterialized ?? null;
  // Phase 2
  const knowledgeStore = options.knowledgeStore ?? null;
  const userKnowledgeStore = options.userKnowledgeStore ?? null;
  const zone2Provider = options.zone2Provider ?? null;
  const zone2Delivery = createZone2DeliveryService();
  const onSessionCompacted = options.onSessionCompacted ?? null;
  const recallDepsProvider = options.recallDepsProvider ?? null;
  const knowledgeSuggestDepsProvider = options.knowledgeSuggestDepsProvider ?? null;
  const todoDepsProvider = options.todoDepsProvider ?? null;
  // Phase 3
  const threadRegistry = options.threadRegistry ?? null;
  const threadCaptureDraftBaseline = options.threadCaptureDraftBaseline ?? null;
  const threadPrepareIsolatedBranch = options.threadPrepareIsolatedBranch ?? null;
  const threadSpawnSession = options.threadSpawnSession ?? null;
  const threadCaptureInputContext = options.threadCaptureInputContext ?? null;
  const threadContinueRun = options.threadContinueRun ?? null;
  const threadResumeLost = options.threadResumeLost ?? null;
  const threadKillSession = options.threadKillSession ?? null;
  const threadApplyWorktreeDiff = options.threadApplyWorktreeDiff ?? null;
  const threadUpdateBaseline = options.threadUpdateBaseline ?? null;
  const threadSendToSession = options.threadSendToSession ?? null;
  const threadTranscriptReader = options.threadTranscriptReader ?? null;
  const threadHistoryEntries = options.threadHistoryEntries ?? null;
  const runCompactionTask = options.runCompactionTask ?? null;
  const verification = options.verification ?? createVerificationCoordinator();
  const commitAgentInputContext = options.commitAgentInputContext ?? ((_sessionId, context) => ({
    // A Host without a snapshot authority may acknowledge disk/unavailable
    // sources, but it must not claim an opaque ready snapshot was committed.
    committed: context.source === "disk" || context.snapshot.status === "unavailable",
  }));
  const releaseAgentInputContext = options.releaseAgentInputContext ?? (() => ({ released: false }));

  const sessions = new Map<string, SessionEntry>();
  const observedShellCompletions = new Set<string>();
  const shellCompletionWrites = new Map<string, Promise<void>>();
  const observeShellCompletion = (sessionId: string, event: ShellCommandCompletedEvent): Promise<void> => {
    const key = `${sessionId}\0${event.executionId}`;
    if (observedShellCompletions.has(key)) return Promise.resolve();
    const existing = shellCompletionWrites.get(key);
    if (existing) return existing;
    const write = Promise.resolve(options.onShellCompleted?.(sessionId, event)).then(() => {
      observedShellCompletions.add(key);
    }).catch((error: unknown) => {
      console.error('[HarnessShell] Completion observation failed:', sessionId, error);
      throw error;
    }).finally(() => {
      if (shellCompletionWrites.get(key) === write) shellCompletionWrites.delete(key);
    });
    shellCompletionWrites.set(key, write);
    return write;
  };
  // A broker session can disappear before its PTY exits. Keep that writer visible
  // to worktree reclamation until disposal has actually completed.
  const retiringShells = new Map<ShellSupervisor, { sessionId: string; pending: Promise<void> | null }>();
  const stopShell = (sessionId: string, supervisor: ShellSupervisor): Promise<void> => {
    const previous = retiringShells.get(supervisor);
    if (previous?.pending) return previous.pending;
    const entry = previous ?? { sessionId, pending: null };
    retiringShells.set(supervisor, entry);
    entry.pending = Promise.resolve().then(() => supervisor.dispose()).then(() => {
      retiringShells.delete(supervisor);
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
  const retireShell = (sessionId: string, supervisor: ShellSupervisor | null): void => {
    if (!supervisor) return;
    void stopShell(sessionId, supervisor).catch((error: unknown) => {
      console.error('[HarnessShell] Session shell shutdown failed:', sessionId, error);
    });
  };
  const discoveredShells = options.discoveredShells
    ?? (options.discoverShells ?? discoverShells)();

  const validateJournalSnapshot = async (
    ctx: HarnessSessionContext,
    snapshot: PiWorkContextSnapshot,
  ): Promise<NonNullable<HarnessSessionContext["preparedWorkContext"]>> => {
    const authorityRoot = ctx.authorityWorkspaceRoot ?? ctx.workspaceRoot;
    let authorityRootIdentity: string;
    let sessionRootIdentity: string;
    try {
      [authorityRootIdentity, sessionRootIdentity] = await Promise.all([
        canonicalizePathIdentity(authorityRoot),
        canonicalizePathIdentity(ctx.workspaceRoot),
      ]);
    } catch {
      throw new HarnessServiceError("unavailable", "Work-context workspace or launch directory is missing or inaccessible");
    }
    const state = snapshot.context ?? seedWorkContext(authorityRoot, ctx.workspaceRoot);
    const sameDirectory = async (storedPath: string, currentIdentity: string): Promise<boolean> => {
      try {
        const storedIdentity = await canonicalizePathIdentity(storedPath);
        if (normalizePathIdentity(storedIdentity) === normalizePathIdentity(currentIdentity)) return true;
        // Windows may report an 8.3 path for one spelling and the long name
        // for another. Compare the existing directory itself before treating
        // a journal binding as a different workspace.
        const [stored, current] = await Promise.all([
          stat(storedPath, { bigint: true }),
          stat(currentIdentity, { bigint: true }),
        ]);
        return stored.isDirectory() && current.isDirectory() && stored.ino !== 0n
          && stored.dev === current.dev && stored.ino === current.ino;
      } catch {
        return false;
      }
    };
    if (snapshot.context && (snapshot.context.workspaceId !== ctx.workspaceId
      || !await sameDirectory(snapshot.context.authorityRoot, authorityRootIdentity)
      || !await sameDirectory(snapshot.context.sessionRoot, sessionRootIdentity))) {
      throw new HarnessServiceError("unavailable", "Stored work context belongs to a different workspace or session launch directory");
    }
    if (!options.pathAuthority || !ctx.workspaceId) {
      throw new HarnessServiceError("unavailable", "Work-context path authority is unavailable");
    }
    const actor: HarnessActorContext = {
      ...ctx.actor,
      workspaceId: ctx.workspaceId,
      grantedCapabilities: await ctx.grantedCapabilities,
      ...(ctx.actor.workspaceScope?.length ? { workspaceScope: ctx.actor.workspaceScope } : {}),
    };
    const { workspaceScope: _scope, ...anchorActor } = actor;
    const validated = await validateStoredWorkContext(state, {
      workspaceRoot: authorityRoot,
      sessionRoot: ctx.workspaceRoot,
      authorize: (candidate, authorizeOptions) => options.pathAuthority!.resolve(actor, candidate, authorizeOptions),
      ...(actor.workspaceScope?.length ? {
        authorizeAnchor: (candidate, authorizeOptions) => options.pathAuthority!.resolve(anchorActor, candidate, authorizeOptions),
        anchorScopeRoots: actor.workspaceScope.map((scope) => path.isAbsolute(scope) ? scope : path.resolve(authorityRoot, scope)),
      } : {}),
    });
    return { state: validated, leafId: snapshot.leafId, entryId: snapshot.entryId, authorityRootIdentity, sessionRootIdentity };
  };

  const prepareWorkContext = async (ctx: HarnessSessionContext): Promise<HarnessSessionContext> => {
    if (!options.workContextJournal) return ctx;
    const snapshot = await options.workContextJournal.read(ctx.actor);
    const preparedWorkContext = await validateJournalSnapshot(ctx, snapshot);
    return { ...ctx, preparedWorkContext };
  };

  const registerSession = (ctx: HarnessSessionContext): void => {
    const sessionId = ctx.actor.sessionId;
    if (options.workContextJournal && !ctx.preparedWorkContext) {
      throw new HarnessServiceError("unavailable", "Work context was not restored before session registration");
    }
    const seededContext = ctx.preparedWorkContext?.state
      ?? seedWorkContext(ctx.authorityWorkspaceRoot, ctx.workspaceRoot);
    const previous = sessions.get(sessionId);
    if (previous) {
      retireShell(sessionId, previous.shellSupervisor);
      observationCursors.clearKind(sessionId, "shell");
      options.dropAgentInputContexts?.(sessionId);
      exploreQueryStore.dropSession(sessionId);
    }
    const interpreterResult = ctx.shellResolution
      ? { unavailable: ctx.shellResolution.invalid }
      : selectInterpreter({
        platform: process.platform,
        workspaceRoot: ctx.workspaceRoot,
        setting: ctx.shellSetting
          ?? options.resolveShellSetting?.(ctx.workspaceId)
          ?? options.shellSetting
          ?? "auto",
        discovered: discoveredShells,
        remote: options.remote ?? false,
      });

    let shellSupervisor: ShellSupervisor | null = null;
    if ("kind" in interpreterResult) {
      shellSupervisor = createShellSupervisor({
        interpreter: interpreterResult,
        outputStore,
        sessionId,
        cwd: ctx.workspaceRoot ?? undefined,
        commandLifecycle: {
          started: async (event) => {
            await verification.beginCommand({ ...event, actor: ctx.actor });
            await options.onShellStarted?.(sessionId, event);
          },
          output: (event) => options.onShellOutput?.(sessionId, event),
          completed: async (event) => {
            await verification.completeCommand({ ...event, actor: ctx.actor });
            await observeShellCompletion(sessionId, event);
          },
        },
        ...(options.registerWriter ? {
          registerWriter: () => options.registerWriter!(sessionId, ctx.workspaceRoot),
        } : {}),
        ...(options.createTerminalSession ? {
          createTerminalSession: options.createTerminalSession,
        } : {}),
      });
    }

    const actor = {
      authorityInstanceId: ctx.actor.authorityInstanceId,
      sessionId,
      workerId: ctx.actor.workerId,
      workerGeneration: ctx.actor.workerGeneration,
    };
    if (ctx.workspaceId) {
      verification.attachParentSession(sessionId, {
        workspaceId: ctx.workspaceId,
        parentRoot: ctx.workspaceRoot,
        parentSessionId: sessionId,
        actor: ctx.actor,
      });
    }
    const authorityRoot = ctx.authorityWorkspaceRoot ?? ctx.workspaceRoot;
    sessions.set(sessionId, {
      actor,
      grantedCapabilities: Promise.resolve(ctx.grantedCapabilities).then((capabilities) => (
        Object.freeze([...new Set(capabilities)])
      )),
      shellSupervisor,
      interpreter: interpreterResult,
      workspaceId: ctx.workspaceId,
      workspaceRoot: ctx.workspaceRoot,
      authorityRoot,
      authorityRootIdentity: ctx.preparedWorkContext?.authorityRootIdentity ?? authorityRoot,
      sessionRootIdentity: ctx.preparedWorkContext?.sessionRootIdentity ?? ctx.workspaceRoot,
      workContext: seededContext,
      workContextLeafId: ctx.preparedWorkContext?.leafId ?? null,
      workContextEntryId: ctx.preparedWorkContext?.entryId ?? null,
      workContextVerified: true,
      workContextTail: Promise.resolve(),
      ...(ctx.actor.workspaceScope?.length ? { workspaceScope: [...ctx.actor.workspaceScope] } : {}),
      ...(ctx.webBinding ? { webBinding: ctx.webBinding } : {}),
    });
    // A fresh shell anchors at the session's initial operation dir.
    shellSupervisor?.setAnchorCwd(operationDirAbsolute(
      sessions.get(sessionId)!.workContext,
      authorityRoot,
    ));
  };

  const dropSession = (sessionId: string, actor?: HarnessActorIdentity): void => {
    const entry = sessions.get(sessionId);
    // Only the session's own worker can retire it: an auxiliary (compaction)
    // worker exit shares the sessionId but must never drop the registration.
    if (actor && (!entry
      || entry.actor.authorityInstanceId !== actor.authorityInstanceId
      || entry.actor.workerId !== actor.workerId
      || entry.actor.workerGeneration !== actor.workerGeneration)) return;
    clearManagedShellCompletionWatches(host, sessionId);
    if (entry) {
      void options.releaseWebFetchReceipts?.(sessionId, entry.workspaceId).catch((error: unknown) => {
        console.error('[HarnessWebFetch] Temporary receipt release failed:', error);
      });
      retireShell(sessionId, entry.shellSupervisor);
      sessions.delete(sessionId);
    }
    for (const [workerId, aux] of auxiliaryActors) {
      if (aux.sessionId === sessionId) auxiliaryActors.delete(workerId);
    }
    outputStore.dropSession(sessionId);
    exploreQueryStore.dropSession(sessionId);
    observationCursors.clearObserver(sessionId);
    zone2Delivery.abort(sessionId);
    threadRegistry?.clearCursorsForSession(sessionId);
    void Promise.resolve(pathLockService.dropSession(sessionId)).catch((error: unknown) => {
      console.error('[HarnessPathLock] Session lease release failed:', error);
    });
    options.dropAgentInputContexts?.(sessionId);
    verification.revokeSessionActor(sessionId);
  };

  const hasActiveCommandAtDirectory = (directory: string): boolean => {
    for (const entry of sessions.values()) {
      if (entry.shellSupervisor?.hasActiveCommandAt(directory)) return true;
    }
    for (const supervisor of retiringShells.keys()) {
      if (supervisor.hasActiveCommandAt(directory)) return true;
    }
    return false;
  };

  const closeSessionShell = async (sessionId: string): Promise<void> => {
    const supervisors = new Set<ShellSupervisor>();
    const current = sessions.get(sessionId)?.shellSupervisor;
    if (current) supervisors.add(current);
    for (const [supervisor, entry] of retiringShells) {
      if (entry.sessionId === sessionId) supervisors.add(supervisor);
    }
    await Promise.all([...supervisors].map((supervisor) => stopShell(sessionId, supervisor)));
  };

  const getShellSupervisor = (sessionId: string): ShellSupervisor | null => {
    return sessions.get(sessionId)?.shellSupervisor ?? null;
  };

  const getInterpreter = (sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null => {
    return sessions.get(sessionId)?.interpreter ?? null;
  };

  const getWebBinding = (sessionId: string): HarnessWebBinding | null => sessions.get(sessionId)?.webBinding ?? null;

  // D-314 auxiliary actors: a session's dedicated compaction worker. Keyed
  // by the worker's own id; queries resolve under the parent session with a
  // read-only method allowlist, and history reads stop at the frozen leaf.
  const auxiliaryActors = new Map<string, {
    leafEntryId: string;
    parentWorkerId: string;
    sessionId: string;
    authorityInstanceId: string;
    workerGeneration: number;
  }>();

  const registerAuxiliaryActor = (
    parent: HarnessActorIdentity,
    workerId: string,
    leafEntryId: string,
  ): void => {
    const entry = sessions.get(parent.sessionId);
    if (!entry || entry.actor.workerId !== parent.workerId || !hasActor(parent)) {
      throw new HarnessServiceError("unavailable", "The compaction parent session is no longer registered");
    }
    auxiliaryActors.set(workerId, {
      authorityInstanceId: parent.authorityInstanceId,
      leafEntryId,
      parentWorkerId: parent.workerId,
      sessionId: parent.sessionId,
      workerGeneration: parent.workerGeneration,
    });
  };

  const dropAuxiliaryActor = (workerId: string): void => {
    auxiliaryActors.delete(workerId);
  };

  const auxiliaryActor = (identity: HarnessActorIdentity) => {
    const aux = auxiliaryActors.get(identity.workerId);
    const parent = sessions.get(identity.sessionId)?.actor;
    return aux
      && parent?.workerId === aux.parentWorkerId
      && parent.authorityInstanceId === aux.authorityInstanceId
      && parent.workerGeneration === aux.workerGeneration
      && aux.sessionId === identity.sessionId
      && aux.authorityInstanceId === identity.authorityInstanceId
      && aux.workerGeneration === identity.workerGeneration
      ? aux
      : undefined;
  };

  const hasActor = (identity: HarnessActorIdentity): boolean => {
    if (auxiliaryActor(identity)) return true;
    const entry = sessions.get(identity.sessionId);
    return Boolean(
      entry
      && entry.actor.authorityInstanceId === identity.authorityInstanceId
      && entry.actor.workerId === identity.workerId
      && entry.actor.workerGeneration === identity.workerGeneration
    );
  };

  const resolveActor = async (identity: HarnessActorIdentity, contextEntryId?: string | null): Promise<HarnessActorContext | null> => {
    const entry = sessions.get(identity.sessionId);
    if (!entry) return null;
    if (auxiliaryActor(identity)) {
      return {
        ...identity,
        allowedMethods: [...COMPACTION_QUERY_METHODS],
        workspaceId: entry.workspaceId,
        operationDir: entry.workContext.operationDir,
        contextRevision: entry.workContext.revision,
        queryScope: entry.workContext.queryScope === null ? null : [...entry.workContext.queryScope],
        ...(entry.workspaceScope ? { workspaceScope: entry.workspaceScope } : {}),
        grantedCapabilities: [...COMPACTION_QUERY_CAPABILITIES],
      };
    }
    if (!hasActor(identity)) return null;
    const grantedCapabilities = await entry.grantedCapabilities;
    if (options.workContextJournal && (!entry.workContextVerified
      || contextEntryId === undefined || contextEntryId !== entry.workContextEntryId)) {
      await refreshWorkContext(entry, { ...identity, workspaceId: entry.workspaceId, grantedCapabilities,
        ...(entry.workspaceScope ? { workspaceScope: entry.workspaceScope } : {}) });
    }
    if (sessions.get(identity.sessionId) !== entry || !hasActor(identity)) return null;
    if (contextEntryId !== undefined && contextEntryId !== entry.workContextEntryId) {
      throw new HarnessServiceError("invalid-params", "Conversation branch changed before this tool was admitted; retry with the current work context", true);
    }
    return {
      ...identity,
      workspaceId: entry.workspaceId,
      operationDir: entry.workContext.operationDir,
      contextRevision: entry.workContext.revision,
      queryScope: entry.workContext.queryScope === null ? null : [...entry.workContext.queryScope],
      ...(entry.workspaceScope ? { workspaceScope: entry.workspaceScope } : {}),
      grantedCapabilities,
    };
  };

  // ── RR2: session work context ─────────────────────────────────────
  const workContextDeps = (actor: HarnessActorContext): (WorkContextDeps & { authorizeScopeRoots: string[] }) | null => {
    const entry = sessions.get(actor.sessionId);
    if (!entry || !options.pathAuthority) return null;
    const workspaceRoot = entry.authorityRoot;
    const authority = options.pathAuthority;
    const { workspaceScope: _scope, ...anchorActor } = actor;
    return {
      workspaceRoot,
      sessionRoot: entry.workspaceRoot,
      cursorBinding: JSON.stringify([
        actor.authorityInstanceId,
        actor.sessionId,
        actor.workerId,
        actor.workerGeneration,
        actor.workspaceId,
      ]),
      assertCurrent: () => {
        if (sessions.get(actor.sessionId) !== entry || !hasActor(actor)) {
          throw new HarnessServiceError("forbidden", "Work context owner was retired during the request");
        }
      },
      authorize: (candidate, authorizeOptions) => authority.resolve(actor, candidate, authorizeOptions),
      ...(actor.workspaceScope?.length ? {
        authorizeAnchor: (candidate: string, authorizeOptions: { allowMissing: boolean }) => authority.resolve(anchorActor, candidate, authorizeOptions),
        anchorScopeRoots: actor.workspaceScope.map((scope) => path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope)),
      } : {}),
      authorizeScopeRoots: actor.workspaceScope?.length
        ? actor.workspaceScope.map((scope) => (path.isAbsolute(scope) ? scope : path.resolve(workspaceRoot, scope)))
        : [workspaceRoot],
    };
  };

  const queueWorkContext = <T>(entry: SessionEntry, action: () => Promise<T>): Promise<T> => {
    const operation = entry.workContextTail.then(action);
    entry.workContextTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const refreshWorkContext = (entry: SessionEntry, actor: HarnessActorContext): Promise<void> => {
    if (!options.workContextJournal) return Promise.resolve();
    return queueWorkContext(entry, async () => {
      entry.workContextVerified = false;
      const snapshot = await options.workContextJournal!.read(actor);
      const prepared = await validateJournalSnapshot({
        actor,
        grantedCapabilities: actor.grantedCapabilities,
        workspaceId: entry.workspaceId,
        workspaceRoot: entry.workspaceRoot,
        authorityWorkspaceRoot: entry.authorityRoot,
      }, snapshot);
      if (sessions.get(actor.sessionId) !== entry || !hasActor(actor)) {
        throw new HarnessServiceError("forbidden", "Work context owner was retired during restoration");
      }
      entry.workContext = prepared!.state;
      entry.workContextLeafId = prepared!.leafId;
      entry.workContextEntryId = prepared!.entryId;
      entry.workContextVerified = true;
      entry.shellSupervisor?.setAnchorCwd(operationDirAbsolute(entry.workContext, entry.authorityRoot));
    });
  };

  const workContextEntry = (actor: HarnessActorContext): { entry: SessionEntry; deps: WorkContextDeps & { authorizeScopeRoots: string[] } } => {
    const entry = sessions.get(actor.sessionId);
    const deps = entry ? workContextDeps(actor) : null;
    if (!entry || !deps || !entry.workContextVerified) {
      throw new HarnessServiceError("unavailable", "Work context is unavailable for this session");
    }
    deps.assertCurrent?.();
    return { entry, deps };
  };

  const workContextGet = (actor: HarnessActorContext): ContextGetResult => {
    const { entry, deps } = workContextEntry(actor);
    return { ...getWorkContext(entry.workContext, deps), contextEntryId: entry.workContextEntryId };
  };

  const mutateWorkContext = (
    actor: HarnessActorContext,
    mutate: (candidate: HarnessWorkContextState, deps: WorkContextDeps) => Promise<ContextGetResult>,
  ): Promise<ContextGetResult> => {
    const { entry, deps } = workContextEntry(actor);
    return queueWorkContext(entry, async () => {
      deps.assertCurrent?.();
      if (!entry.workContextVerified) throw new HarnessServiceError("unavailable", "Work context requires restoration before mutation");
      if (options.workContextJournal) {
        // Ordinary Pi messages advance the leaf even when context is unchanged.
        // Read it at this mutation's admission; a cached leaf is never a CAS token.
        const snapshot = await options.workContextJournal.read(actor);
        const restored = await validateJournalSnapshot({
          actor,
          grantedCapabilities: actor.grantedCapabilities,
          workspaceId: entry.workspaceId,
          workspaceRoot: entry.workspaceRoot,
          authorityWorkspaceRoot: entry.authorityRoot,
        }, snapshot);
        deps.assertCurrent?.();
        const changed = restored.entryId !== entry.workContextEntryId
          || JSON.stringify(restored.state) !== JSON.stringify(entry.workContext);
        entry.workContext = restored.state;
        entry.workContextLeafId = restored.leafId;
        entry.workContextEntryId = restored.entryId;
        if (changed) {
          entry.shellSupervisor?.setAnchorCwd(operationDirAbsolute(entry.workContext, entry.authorityRoot));
          throw new HarnessServiceError("invalid-params", "Work context changed before this mutation; re-read context and retry", true);
        }
      }
      const previous = entry.workContext;
      const candidate: HarnessWorkContextState = {
        operationDir: previous.operationDir,
        queryScope: previous.queryScope === null ? null : [...previous.queryScope],
        revision: previous.revision,
      };
      await mutate(candidate, deps);
      deps.assertCurrent?.();
      if (options.workContextJournal) {
        let committed: PiWorkContextSnapshot;
        try {
          committed = await options.workContextJournal.commit(actor, {
            sessionId: actor.sessionId,
            expectedLeafId: entry.workContextLeafId,
            expectedRevision: previous.revision,
            context: {
              ...candidate,
              workspaceId: entry.workspaceId ?? "",
              authorityRoot: entry.authorityRootIdentity,
              sessionRoot: entry.sessionRootIdentity,
            },
          });
          if (!committed.context || committed.context.revision !== candidate.revision
            || committed.context.operationDir !== candidate.operationDir
            || JSON.stringify(committed.context.queryScope) !== JSON.stringify(candidate.queryScope)) {
            throw new Error("Pi returned a different work-context commit");
          }
        } catch (error) {
          // The append may have committed before its response was lost. Never
          // publish the candidate on an uncertain acknowledgement; re-read Pi.
          entry.workContextVerified = false;
          try {
            const snapshot = await options.workContextJournal.read(actor);
            const restored = await validateJournalSnapshot({
              actor,
              grantedCapabilities: actor.grantedCapabilities,
              workspaceId: entry.workspaceId,
              workspaceRoot: entry.workspaceRoot,
              authorityWorkspaceRoot: entry.authorityRoot,
            }, snapshot);
            deps.assertCurrent?.();
            entry.workContext = restored!.state;
            entry.workContextLeafId = restored!.leafId;
            entry.workContextEntryId = restored!.entryId;
            entry.workContextVerified = true;
            entry.shellSupervisor?.setAnchorCwd(operationDirAbsolute(entry.workContext, entry.authorityRoot));
          } catch {
            // resolveActor retries restoration before another request is admitted.
          }
          throw new HarnessServiceError("unavailable", `Work-context commit was not acknowledged; re-read context before retrying: ${error instanceof Error ? error.message : String(error)}`, true);
        }
        deps.assertCurrent?.();
        entry.workContextLeafId = committed.leafId;
        entry.workContextEntryId = committed.entryId;
      }
      entry.workContext = candidate;
      entry.workContextVerified = true;
      entry.shellSupervisor?.setAnchorCwd(operationDirAbsolute(candidate, deps.workspaceRoot));
      return { ...getWorkContext(candidate, deps), contextEntryId: entry.workContextEntryId };
    });
  };

  const workContextSelect = async (actor: HarnessActorContext, params: ContextSelectParams): Promise<ContextGetResult> => {
    return mutateWorkContext(actor, (candidate, deps) => selectOperationDir(candidate, params, deps));
  };

  const workContextScope = async (actor: HarnessActorContext, params: ContextScopeParams): Promise<ContextGetResult> => {
    return mutateWorkContext(actor, (candidate, deps) => setQueryScope(candidate, params, deps));
  };

  const workContextReset = async (actor: HarnessActorContext, params: ContextResetParams): Promise<ContextGetResult> => {
    return mutateWorkContext(actor, (candidate, deps) => resetWorkContext(candidate, params, deps));
  };

  const workContextDiscover = async (
    actor: HarnessActorContext,
    params: ContextDiscoverParams,
    signal?: AbortSignal,
  ): Promise<ContextDiscoverResult> => {
    const { deps } = workContextEntry(actor);
    return discoverProjects(params, { ...deps, ...(signal ? { signal } : {}) });
  };

  const workContextRevision = (sessionId: string): number | undefined => (
    sessions.get(sessionId)?.workContextVerified ? sessions.get(sessionId)?.workContext.revision : undefined
  );

  const workContextIdentity = (sessionId: string): { revision: number; entryId: string | null } | undefined => {
    const entry = sessions.get(sessionId);
    return entry?.workContextVerified
      ? { revision: entry.workContext.revision, entryId: entry.workContextEntryId }
      : undefined;
  };

  const workContextOperationDir = (sessionId: string): string | undefined => {
    const entry = sessions.get(sessionId);
    return entry?.workContextVerified ? operationDirAbsolute(entry.workContext, entry.authorityRoot) : undefined;
  };

  const compactionHistory = async (
    actor: HarnessActorContext,
    params: CompactionHistoryParams,
  ): Promise<CompactionHistoryResult> => {
    const aux = auxiliaryActor(actor);
    if (!aux) {
      throw new HarnessServiceError("denied", "compaction.history is restricted to a session's compaction worker");
    }
    if (!threadHistoryEntries) {
      throw new HarnessServiceError("unavailable", "Session history reads are unavailable");
    }
    const source = await threadHistoryEntries(actor.sessionId);
    if (source.sessionId !== actor.sessionId) {
      throw new HarnessServiceError("unavailable", "The history source identity did not match the session");
    }
    const leafIndex = source.entries.findIndex((entry) => entry.id === aux.leafEntryId);
    // Entries appended after the task froze (N) are not part of the material.
    // A missing leaf means the active branch no longer proves the frozen source;
    // serving it would leak a later branch or N into the compaction worker.
    if (leafIndex < 0) {
      throw new HarnessServiceError(
        "unavailable",
        `The frozen history leaf is no longer available on the active branch: ${aux.leafEntryId}`,
      );
    }
    const entries = source.entries.slice(0, leafIndex + 1);
    let page: ReturnType<typeof readHistoryPage>;
    try {
      page = readHistoryPage(entries, params);
    } catch (error) {
      throw new HarnessServiceError("invalid-params", error instanceof Error ? error.message : String(error));
    }
    return {
      ...page,
      details: {
        ...page.details,
        boundEntry: aux.leafEntryId,
        boundFound: true,
        scope: "frozen-branch",
      },
    };
  };

  const dispose = async (): Promise<void> => {
    clearManagedShellCompletionWatches(host);
    const disposes: Promise<void>[] = [];
    const sessionIds = new Set([...sessions.keys(), ...[...retiringShells.values()].map((entry) => entry.sessionId)]);
    await Promise.all([...sessionIds].map(closeSessionShell));
    sessions.clear();
    exploreQueryStore.dispose();
    outputStore.dispose();
    observationCursors.dispose();
    zone2Delivery.dispose();
    await pathLockService.dispose();
    if (knowledgeStore) disposes.push(knowledgeStore.close());
    if (userKnowledgeStore) disposes.push(userKnowledgeStore.close());
    await Promise.all(disposes);
  };

  const host: HarnessServiceHost = {
    outputStore,
    exploreQueryStore,
    observationCursors,
    pathLockService,
    searchService,
    diagnosticsProvider,
    lspNavigationServices,
    structureSource,
    fileRelations,
    graphRecall,
    relationCollector,
    semanticRecall,
    ...(pinWorkingBranchQuery ? { pinWorkingBranchQuery } : {}),
    ...(harnessSettings ? { harnessSettings } : {}),
    ...(rerankExploreViews ? { rerankExploreViews } : {}),
    permissionAudit,
    webFetchService,
    webSearchService,
    networkDiagnostics,
    researchSearchService,
    researchDecideService,
    materialCollectionsService,
    documentReader: options.documentReader ?? null,
    ...(options.readMaterialFile ? { readMaterialFile: options.readMaterialFile } : {}),
    ...(options.readAuthorizedDiskFile ? { readAuthorizedDiskFile: options.readAuthorizedDiskFile } : {}),
    ...(options.documentReadingSettings ? { documentReadingSettings: options.documentReadingSettings } : {}),
    ...(options.materialWebPolicy ? { materialWebPolicy: options.materialWebPolicy } : {}),
    documentReadSource,
    documentPathOverlay,
    documentWriteGuard,
    documentSurfaceWrite,
    documentBranchWrite,
    workingBranchEnsureMaterialized,
    knowledgeStore,
    userKnowledgeStore,
    zone2Provider,
    zone2Delivery,
    onSessionCompacted,
    recallDepsProvider,
    knowledgeSuggestDepsProvider,
    todoDepsProvider,
    threadRegistry,
    threadCaptureDraftBaseline,
    threadPrepareIsolatedBranch,
    threadSpawnSession,
    threadCaptureInputContext,
    threadContinueRun,
    threadResumeLost,
    threadKillSession,
    threadApplyWorktreeDiff,
    threadUpdateBaseline,
    requireThreadMergeJournal: options.requireThreadMergeJournal ?? false,
    threadSendToSession,
    threadTranscriptReader,
    threadHistoryEntries,
    registerAuxiliaryActor,
    dropAuxiliaryActor,
    compactionHistory,
    runCompactionTask,
    verification,
    experimentService: options.experimentService ?? null,
    resourceService: options.resourceService ?? null,
    sourceService: options.sourceService ?? null,
    settingsService: options.settingsService ?? null,
    followUpService: options.followUpService ?? null,
    scheduledTaskService: options.scheduledTaskService ?? null,
    managedRemoteTargets: options.managedRemoteTargets ?? null,
    observeShellCompletion,
    commitAgentInputContext,
    releaseAgentInputContext,
    registerSession,
    prepareWorkContext,
    dropSession,
    hasActor,
    resolveActor,
    workContextGet,
    workContextSelect,
    workContextScope,
    workContextReset,
    workContextDiscover,
    workContextRevision,
    workContextIdentity,
    workContextOperationDir,
    getShellSupervisor,
    closeSessionShell,
    hasActiveCommandAtDirectory,
    getInterpreter,
    getWebBinding,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    dispose,
    ...(options.readExploreFile ? { readExploreFile: options.readExploreFile } : {}),
    ...(options.storeRetrievalArtifact ? { storeRetrievalArtifact: options.storeRetrievalArtifact } : {}),
    ...(options.readRetrievalArtifact ? { readRetrievalArtifact: options.readRetrievalArtifact } : {}),
    ...(options.readRetrievalArtifactSlice ? { readRetrievalArtifactSlice: options.readRetrievalArtifactSlice } : {}),
    ...(options.protectRetrievalEvidence ? { protectRetrievalEvidence: options.protectRetrievalEvidence } : {}),
    ...(options.lookupWebFetchReceipt ? { lookupWebFetchReceipt: options.lookupWebFetchReceipt } : {}),
    ...(options.releaseRetrievalTemporaryArtifacts ? { releaseRetrievalTemporaryArtifacts: options.releaseRetrievalTemporaryArtifacts } : {}),
    ...(options.agentInputDraftPaths ? { agentInputDraftPaths: options.agentInputDraftPaths } : {}),
    ...(options.agentInputSurfaceOwner ? { agentInputSurfaceOwner: options.agentInputSurfaceOwner } : {}),
  };
  return host;
}

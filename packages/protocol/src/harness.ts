/**
 * Harness service request channel — typed protocol for worker→host service calls.
 *
 * The worker emits a `harness.request` event; the host routes it to a registered
 * service and calls `harness.respond` with the result. This mirrors the
 * `workspace.mutation.request` / `workspace.mutation.respond` pattern so the
 * channel works across every transport (local, Electron, relay) without the
 * worker holding host credentials.
 */

import type {
  ThreadListParams,
  ThreadListResult,
  ThreadWaitParams,
  ThreadWaitResult,
  ThreadSendParams,
  ThreadSendResult,
  ThreadReadParams,
  ThreadReadResult,
  ThreadMergeParams,
  ThreadMergeResult,
  ThreadUpdateParams,
  ThreadUpdateResult,
  ThreadKillParams,
  ThreadKillResult,
  ThreadDispatchParams,
  ThreadDispatchResult,
  ThreadFactsSetParams,
  ThreadFactsSetResult,
  RetrievalUrlReceipt,
} from "./harness-threads.js";
import type {
  PermissionAuditRecord,
  PermissionInspectParams,
  PermissionInspectResult,
} from "./permission-gate.js";
import type {
  DocumentAnalysis,
  DocumentFindHit,
  DocumentOverview,
  DocumentPageImage,
  DocumentReadRequest,
  MaterialsCollectionParams,
  MaterialsCollectionResult,
  ResearchDecideParams,
  ResearchDecideResult,
  WebFetchRequest,
  WebDocumentRegion,
  WebSearchRequest,
  WebSearchResult,
  WebSnapshotRef,
  WebSnapshotStructure,
} from "./harness-web.js";
import type { AgentInputContext, JsonValue } from "./types.js";

export interface OutputSlice {
  observationRef?: string;
  text: string;
  offset: number;
  length: number;
  nextOffset: number;
  total: number;
  eof: boolean;
}

export interface OutputRef {
  durability: "ephemeral";
  generation: string;
  handle: string;
}

export type ShellOutputKind = "vitest" | "tsc" | "eslint" | "git" | "package-manager" | "generic";

/**
 * Stage timestamps for one accepted shell command. `acceptedAt` starts the
 * Host's `waitMs` observation budget; `sentAt` marks when the framed payload
 * reached the shell; `firstOutputAt` is the first observed output byte.
 * `detachedAt` ends the foreground response, while `endedAt` is the real
 * command/process termination time.
 */
export interface ShellExecTiming {
  acceptedAt: number;
  sentAt?: number;
  firstOutputAt?: number;
  /** Foreground observation ended while the process remained alive. */
  detachedAt?: number;
  /** Actual process/command termination only; never the observation deadline. */
  endedAt?: number;
  /** Time the Host returned its foreground shell.exec response. */
  respondedAt?: number;
}

export interface ShellOutputOrganization {
  kind: ShellOutputKind;
  omitted: boolean;
  partial: boolean;
}

export interface ShellExecResultCompleted {
  kind: "completed";
  exitCode: number | null;
  durationMs: number;
  cwd: string;
  stdout: string;
  stderr: string;
  handle: string | null;
  shown: { head: number; tail: number; total: number } | null;
  display?: string;
  organized?: ShellOutputOrganization;
  /** Original Pi tool call identity used to recover an accepted execution. */
  toolCallId?: string;
  executionId?: string;
  target?: string;
  timing?: ShellExecTiming;
}

export interface ShellExecResultBackground {
  observationRef?: string;
  kind: "background";
  id: string;
  waitedMs: number;
  cwd: string;
  outputSoFar: string;
  command?: string;
  display?: string;
  organized?: ShellOutputOrganization;
  toolCallId?: string;
  executionId?: string;
  target?: string;
  timing?: ShellExecTiming;
}

/** Accepted execution whose shell/process preparation has not finished yet. */
export interface ShellExecResultPreparing {
  kind: "preparing";
  /** Stable shell.read/get_output identity; this is not a runtime shell id. */
  id: string;
  command: string;
  waitedMs: number;
  toolCallId?: string;
  executionId: string;
  target?: string;
  timing: ShellExecTiming;
}

export interface ShellExecResultSpawnFailed {
  kind: "spawn-failed";
  reason: string;
  interpreter: string;
  hint: string;
}

export type ShellExecResult =
  | ShellExecResultCompleted
  | ShellExecResultBackground
  | ShellExecResultPreparing
  | ShellExecResultSpawnFailed;

export interface ShellReadResult extends OutputSlice {
  running: boolean;
  /** Accepted, but no payload has reached the shell yet. */
  phase?: "preparing";
  exitCode?: number;
  /** True when the supervised process reached its terminal state through cancellation. */
  cancelled?: boolean;
  executionId?: string;
  cwd?: string;
  command?: string;
  display?: string;
  organized?: ShellOutputOrganization;
  /** Actual runtime shell identity when `id` was a recovery alias. */
  shellId?: string;
  target?: string;
  /**
   * The queried identity resolves to an accepted execution that never ran
   * (spawn failure, disposal). The value carries the failure reason; the
   * output slice stays empty. Distinct from "not found" (unknown identity).
   */
  spawnFailed?: string;
  /** The reference belonged to a prior Host/session generation whose live output is not retained. */
  unavailable?: string;
  observation?: {
    mode: "incremental";
    first: boolean;
    sinceMs?: number;
    lastOutputAgoMs?: number;
  };
}

export interface SearchContentParams {
  pattern: string;
  path?: string;
  /**
   * RR4: multiple scope roots for a single query (multi-project recall).
   * Each entry is authorized independently; the effective scope is the union
   * applied before result budgeting. `paths` takes precedence over `path`.
   */
  paths?: string[];
  glob?: string[];
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  before?: number;
  after?: number;
  context?: number;
  limit?: number;
}

export interface SearchContentHit {
  line: number;
  text: string;
  before: string[];
  after: string[];
  /** Source document revision reported by the search backend. */
  revision?: string;
}

/**
 * Unique-file coverage of one search pattern. Distinct from hit-level
 * `partial`: a per-file hit cap does not change how many matching files
 * were seen. Explore candidate-mode only.
 */
export type ExploreTermCoverage = "complete" | "lower-bound" | "unknown";

export interface SearchContentFile {
  /**
   * Reopenable resource reference. Single-workspace queries return the
   * workspace-relative resource id; queries spanning multiple resource roots
   * (file roots, external directories) return absolute canonical paths so the
   * result reopens under the same authorized root regardless of session
   * classification.
   */
  path: string;
  hits: SearchContentHit[];
}

export interface SearchContentResult {
  status: "ready" | "empty" | "unavailable";
  files: SearchContentFile[];
  totalHits: number;
  totalFiles: number;
  /**
   * Files actually scanned, only when the backend reports an exact count.
   * Absent means the count is unknown — consumers must not present a
   * fabricated zero. `totalFiles` counts files with hits, not scanned files.
   */
  searchedFiles?: number;
  partial: boolean;
  handle?: string;
  /**
   * Explore candidate-mode only: matching files that had hits but were omitted
   * because the file count itself exceeded the working budget. Exact for this
   * single query. Absent on grep.
   */
  filesDropped?: number;
  /**
   * Unique-file coverage for this pattern. Distinct from `partial`, which also
   * folds per-file hit caps and display-budget trims that do not change how
   * many matching files were seen. Absent on grep.
   */
  fileCoverage?: ExploreTermCoverage;
}

export interface DiagnosticItem {
  line: number;
  character: number;
  severity: string;
  code?: string;
  message: string;
  source: string;
}

/** Which text a Host language answer was computed from (D-087). */
export type LanguageTextProvenance = "disk" | "surface-draft" | "working-branch";

export interface DiagnosticsResult {
  observationRef?: string;
  status: "ready" | "pending" | "unavailable";
  snapshot?: string;
  /** Text identity the diagnosed document was bound to. */
  revision?: string;
  source?: LanguageTextProvenance;
  diagnostics: DiagnosticItem[];
  resolvedDiagnostics?: DiagnosticItem[];
  observation?: {
    mode: "incremental";
    first: boolean;
    sinceMs?: number;
    added: number;
    resolved: number;
  };
  reason?: string;
}

export interface LspNavigationResult {
  status: "ready" | "empty" | "unavailable";
  text: string;
  value?: JsonValue;
  /** Text identity the queried document was bound to (D-087). */
  revision?: string;
  source?: LanguageTextProvenance;
  /**
   * Files whose positions the language server computed from its own read. LSP
   * does not report the version it used, so they carry no bound revision.
   */
  unpinnedPaths?: string[];
}

export type FsLockParams =
  | { action: "acquire"; paths: string[]; timeoutMs?: number }
  | { action: "release"; leaseId: string };

export type FsLockResult =
  | { held: true; leaseIds: string[] }
  | { held: false; released: boolean };

export type FetchResult =
  | {
    status: "ok";
    url: string;
    finalUrl: string;
    contentType: string;
    title?: string;
    markdown: string;
    bytes: number;
    fromCache: boolean;
    rendered: boolean;
    receipt?: RetrievalUrlReceipt;
    /** Content-pinned snapshot when the Host material store is wired. */
    snapshot?: WebSnapshotRef;
    /** Original material reference, unaffected by a new text/structure analysis. */
    sourceSnapshot?: WebSnapshotRef;
    overview?: DocumentOverview;
    pageImages?: DocumentPageImage[];
    analysis?: DocumentAnalysis;
    findHits?: DocumentFindHit[];
    /** Detected structure of the readable body (pages/headings/…). */
    structure?: WebSnapshotStructure;
    /** When a position selector was applied, the one-based line range of the
     * returned markdown inside the fixed body. */
    range?: { startLine: number; endLine: number; totalLines: number };
    /** A real rendered page image, returned only when a caller asks for it. */
    pageImage?: {
      page: number;
      mimeType: "image/png";
      data: string;
      byteLength: number;
      region?: WebDocumentRegion;
    };
    ocr?: {
      status: "not-needed" | "used" | "unavailable";
      engine?: string;
      pages?: number[];
      detail?: string;
    };
  }
  | { status: "structure-unsupported"; snapshotId: string; kind: string }
  | { status: "position-not-found"; snapshotId: string; detail: string }
  | { status: "redirect-cross-host"; url: string; location: string; statusCode: number }
  | { status: "blocked"; url: string; reason: "private-network" | "domain-blocked" | "scheme" | "special-purpose" }
  | { status: "empty-shell"; url: string; hint: string }
  | { status: "renderer-unavailable"; url: string }
  | { status: "page-image-unavailable"; snapshotId: string; page?: number; reason: string }
  | { status: "snapshot-missing"; snapshotId: string }
  | { status: "failed"; url: string; reason: string; errorClass?: FetchErrorClass };

/**
 * Machine-readable egress failure classes for `web.fetch` and network
 * diagnostics — DNS failure, proxy problems, and policy denials are
 * distinguishable instead of collapsing into a raw error string.
 */
export type FetchErrorClass =
  | "dns"
  | "scheme-denied"
  | "private-network"
  | "special-purpose"
  | "proxy-unavailable"
  | "proxy-auth"
  | "proxy-config-invalid"
  | "tls"
  | "connect"
  | "http"
  | "timeout"
  | "cancelled"
  | "unknown";

/** Read-only outbound-network probe. Does not perform a fetch. */
export interface NetworkDiagnoseParams {
  url: string;
  /** Optional per-request policy probe (diagnostic only; never persisted). */
  override?: { mode?: "auto" | "direct" | "proxy"; proxyUrl?: string; noProxy?: string };
}

export interface NetworkDiagnosisResult {
  url: string;
  /** Static URL/scheme/literal/configuration check; does not include DNS. */
  decision: "allowed" | "blocked";
  reason?: string;
  /** Read-only address sample. A later fetch may resolve and route differently. */
  addressCheck: "not-run" | "public" | "blocked" | "dns-error" | "proxy-side-unverified" | "system-managed";
  policy: {
    version: number;
    mode: "direct" | "proxy" | "system";
    /** Sanitized origin only — credentials are never exposed. */
    proxyOrigin?: string;
    proxyAuth?: "basic";
    noProxy: string[];
    source: "app" | "env" | "override" | "none";
    invalid?: string;
  };
  /** Where the target name would resolve. Proxy-side results are unverified here. */
  resolution: "not-run" | "local" | "proxy-side" | "static-literal" | "system";
  addresses?: Array<{ address: string; class: "public" | "private" | "special-purpose" }>;
  lookupError?: string;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  /** Provider-returned summary or abstract text, when the adapter supplies one. */
  summary?: string;
}

/**
 * The source selected for a native Pi `read` call. Disk reads stay inside the
 * Pi runtime; surface drafts are returned as save-compatible bytes by the
 * authenticated Application Host.
 */
export type WorkingBranchPathOrigin = "base" | "delta" | "draft-base" | "materialized";

export interface WorkingBranchReadProvenance {
  branchId: string;
  revision: number;
  origin: WorkingBranchPathOrigin;
}

export type DocumentReadSourceResult =
  | { source: "disk"; base64: string }
  | { base64: string; revision: string; source: "surface-draft" }
  | {
    source: "working-branch";
    revision: string;
    provenance: WorkingBranchReadProvenance;
    base64?: string;
    missing?: true;
  };

/**
 * Content-free view of fixed editor paths used by the native Pi find/ls
 * wrappers. File entries carry the immutable surface revision; directories
 * are virtual ancestors and therefore have no content revision.
 */
export interface DocumentPathOverlayEntry {
  /** Path relative to the authorized request root; "." denotes that root. */
  path: string;
  kind: "file" | "directory";
  revision?: string;
}

export interface DocumentPathOverlayParams {
  path: string;
  /** Native find's glob. Omitted for ls, which lists all immediate entries. */
  pattern?: string;
}

export type DocumentPathOverlayResult =
  | { status: "disk" }
  | { status: "ready"; entries: DocumentPathOverlayEntry[]; removedPaths?: string[]; authority?: "surface" | "working-branch" };

/**
 * Whether a native `write` / `edit` / `apply_patch` may proceed on one path.
 *
 * Reads follow this turn's fixed editor draft while writes apply to disk. When
 * those differ, writing text derived from the draft would persist the user's
 * unsaved changes without their decision, so the write is refused with an
 * actionable reason instead (D-089). `revision` is the draft identity the
 * refusal was computed against.
 */
export type DocumentWriteGuardResult =
  | { status: "allow" }
  | { status: "conflict"; message: string; revision: string }
  | { status: "unavailable"; message: string };

export type DocumentSurfaceWriteAction = "write" | "edit" | "delete";

export interface DocumentSurfaceWriteChange {
  path: string;
  action: DocumentSurfaceWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  expectedRevision?: string;
  expectedHash?: string;
}

/**
 * Apply one or more text mutations against this turn's fixed surface snapshot
 * and the live Document Registry buffer (D-225). `{ status: "disk" }` means no
 * path is owned by that snapshot, so the caller uses the journaled disk path.
 */
export interface DocumentSurfaceWriteParams {
  path?: string;
  action?: DocumentSurfaceWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  changes?: DocumentSurfaceWriteChange[];
}

export type DocumentSurfaceWritePathStatus =
  | "applied"
  | "conflict"
  | "unavailable"
  | "compensated"
  | "needs-attention"
  | "disk";

export interface DocumentSurfaceWritePathResult {
  path: string;
  target: "surface" | "disk";
  status: DocumentSurfaceWritePathStatus;
  revision?: string;
  message?: string;
}

export type DocumentSurfaceWriteResult =
  | { status: "disk" }
  | {
      status: "applied" | "conflict" | "unavailable" | "partial";
      results: DocumentSurfaceWritePathResult[];
      operationId?: string;
      message?: string;
    };

export type DocumentBranchWriteAction = "write" | "edit" | "delete";

export interface DocumentBranchWriteChange {
  path: string;
  action: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

/**
 * Commit one or more text mutations to the unpublished WorkingState delta.
 * `expectedRevision` is the CAS token captured when the tool started.
 * `{ status: "disk" }` means this Run is not on a virtual branch view.
 */
export interface DocumentBranchWriteParams {
  expectedRevision?: number;
  path?: string;
  action?: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
  changes?: DocumentBranchWriteChange[];
}

export type DocumentBranchWriteResult =
  | { status: "disk" }
  | { status: "committed"; revision: number; provenance: WorkingBranchReadProvenance }
  | { status: "conflict"; revision: number; message: string }
  | { status: "rejected"; message: string };

export type WorkingBranchEnsureMaterializedResult =
  | { status: "virtual" }
  | { status: "materialized"; path: string }
  | { status: "failed"; message: string };

// ── Phase 2: Zone 2, compaction, todo, recall ──────────────────────

export interface Zone2AssembleParams {
  /** Delivered observations still represented by raw retained Pi input. */
  retainedObservationRefs?: string[];
  /** Terminal shell facts already present in retained native input (not log cursors). */
  observedShellExecutions?: string[];
  /** Revisions still represented by raw retained Pi context, not by a summary. */
  knownMaterial?: Record<string, string>;
  afterEventId?: number;
  contextUsage?: { used: number; window: number };
  query?: string;
  sinceTurn: number;
  /**
   * Current Pi session branch entry IDs (ancestor path from root to leaf).
   * Used to resolve the single visible revision of each memory block.
   */
  branchEntryIds: string[];
}

export interface Zone2AssembleResult {
  /** Prepared environment delivery; confirm only after the model request starts. */
  deliveryId?: string;
  /** Shell terminal facts actually represented in this candidate content. */
  shellCompletions?: string[];
  observationRefs?: string[];
  materialRevisions?: Record<string, string>;
  content: string | null;
  eventCursor: number;
}

export interface ContextRetentionParams {
  /** Opaque receipts still present in Pi's raw input after a cut or navigation. */
  retainedObservationRefs: string[];
  retainedGit: boolean;
}

/** Complete current scoped team snapshot, transient for one model request. */
export type Zone2StatusParams = Record<string, never>;

export interface Zone2StatusResult {
  status: "ready" | "empty" | "unavailable";
  content: string | null;
  reason?: string;
}

export interface Zone2DeliveredParams {
  deliveryId: string;
}

export interface Zone2DeliveredResult {
  committed: boolean;
}

export interface ContextRetentionResult {
  acknowledged: boolean;
}

export interface TodoUpsertParams {
  items: Array<{ text: string; status: "open" | "done" | "blocked" }>;
  branchEntryIds: string[];
  confidence?: number;
}

export interface TodoUpsertResult {
  text: string;
  materialRevisions?: Record<string, string>;
}

export interface RecallSearchParams {
  query: string;
  k?: number;
}

export interface RecallSearchResultItem {
  scope: string;
  title: string;
  via: string;
  id: number;
}

export interface RecallSearchResult {
  text: string;
  results: RecallSearchResultItem[];
  details?: {
    vector: "unconfigured" | "unavailable" | "failed" | "empty" | "partial" | "used";
    spaceId?: string;
  };
}

export interface KnowledgeSuggestParams {
  content: string;
  trigger?: string;
}

export interface KnowledgeSuggestResult {
  created: boolean;
  skippedReason?: "empty" | "duplicate" | "no-workspace";
  suggestion?: {
    id: number;
    content: string;
    trigger: string;
    status: "suggested" | "accepted";
    scope: "workspace" | "user" | "session" | "bot";
  };
}

export interface RelatedQueryParams {
  /** Workspace path or symbol / connection-literal name. */
  anchor: string;
}

export type RelatedQueryStatus = "ready" | "empty" | "unavailable" | "failed";

/**
 * Per-source status for resolved relations. `unsupported` means no language
 * provider answered the feature at all (no `referencesProvider` /
 * `callHierarchyProvider`), which is different from a resolved-but-empty set.
 */
export type RelatedRelationStatus = "ready" | "empty" | "unavailable" | "unsupported" | "partial" | "failed";

/**
 * One resolved reference site: "path:line refers to the queried symbol".
 * `pinned` is true only when the site file's text identity was bound at resolve
 * time; other-file sites are the language server's own read and stay unpinned.
 */
export interface RelatedReferenceSite {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based column when the resolver reported one. */
  character?: number;
  /** Enclosing catalog symbol at the site, when known. */
  caller?: string;
  /** Resolved definition file when the query pinned one. */
  targetPath?: string;
  targetName?: string;
  pinned: boolean;
  /** The target file's catalog revision moved after this row was resolved. */
  staleTarget?: boolean;
  /** Which resolution produced the row: lsp.references / lsp.definition / callHierarchy. */
  resolvedBy: string;
}

/** One resolved call edge: `caller` at path:line calls `callee`. */
export interface RelatedCallEdge {
  /** Call-site file. */
  path: string;
  /** 1-based call-site line. */
  line: number;
  character?: number;
  /** Enclosing symbol making the call, when known. */
  caller?: string;
  /** Called symbol name. */
  callee: string;
  targetPath?: string;
  targetName?: string;
  pinned: boolean;
  staleTarget?: boolean;
  resolvedBy: string;
}

/** Query-time file class shared by explore and related. Not stored on the graph. */
export type HarnessFileRole = "source" | "test" | "docs" | "lock" | "other";
export type HarnessFileRoleGround = "filename-pattern" | "project-declaration" | "unknown";

export interface HarnessFileRoleDecision {
  path: string;
  role: HarnessFileRole;
  ground: HarnessFileRoleGround;
}

export interface RelatedQueryResult {
  text: string;
  status: RelatedQueryStatus;
  anchor: { kind: "path" | "name"; value: string };
  /** Query-time decoration of every path in this result. Not a graph fact. */
  roles: HarnessFileRoleDecision[];
  definitions: Array<{ name: string; kind: string; path: string }>;
  imports: {
    items: Array<{ specifier: string; path: string; resolvedPath?: string }>;
    unresolved: Array<{ specifier: string; path: string; reason: "non-relative" | "unresolved-relative" }>;
    incomplete: boolean;
  };
  importers: {
    items: Array<{ path: string; specifier: string }>;
    incomplete: boolean;
  };
  connections: {
    items: Array<{
      literal: string;
      callee: string;
      path: string;
      otherEnds: Array<{ path: string; kind: string; callee?: string }>;
    }>;
    incomplete: boolean;
  };
  /**
   * Language-service-resolved reference sites for the anchor (name anchors)
   * or references made inside the file (path anchors). Persisted in the symbol
   * graph from real lsp.references / lsp.definition / callHierarchy results;
   * unrelated to same-name text hits.
   */
  references: {
    status: RelatedRelationStatus;
    items: RelatedReferenceSite[];
    incomplete: boolean;
  };
  /**
   * Resolved call edges: `callers` are sites calling the anchor, `callees`
   * are calls the anchor makes. From callHierarchy / resolved references only.
   */
  calls: {
    status: RelatedRelationStatus;
    callers: RelatedCallEdge[];
    callees: RelatedCallEdge[];
    incomplete: boolean;
  };
}

export interface ExploreSearchParams {
  question: string;
  paths?: string[];
  limit?: number;
  /** Known symbols, method names, error text, or path fragments. Literal matches; not a hard filter. */
  anchors?: string[];
}

export type ExploreSourceStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "not-requested"
  | "forbidden";

export type ExploreStructureProvider = "lsp" | "tree-sitter";

export type ExploreStructureStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "failed"
  | "cancelled"
  | "not-requested";

export interface ExploreStructureUnit {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  omitted?: Array<{ startLine: number; endLine: number }>;
}

export interface ExploreStructureSource {
  provider: ExploreStructureProvider | null;
  status: ExploreStructureStatus;
}

export interface ExploreSearchSnippet {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  why: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch";
  unit?: ExploreStructureUnit;
  structure?: ExploreStructureSource;
  /** Formatter must keep this range intact or omit the whole excerpt. */
  required?: boolean;
}

export interface ExploreSearchIssue {
  path: string;
  status: "unavailable" | "failed" | "stale" | "forbidden";
  message: string;
}

export interface ExploreSearchProvenance {
  path: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch" | null;
  status: ExploreSourceStatus;
  matchedGroups: string[];
}

/**
 * `ready` — every excerpt path was answered by the graph. `partial` — at least
 * one lookup failed or the graph was not open for that workspace. `unavailable`
 * — no lookup succeeded. An absent `relations` means no excerpt path had any
 * edge, which is different from all three of these.
 */
export type ExploreRelationStatus = "ready" | "partial" | "unavailable";

export type ExploreGraphStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "not-requested";

export type ExploreQueryRelation = "register" | "import" | "define" | "unknown";
export type ExploreQueryDomain = "implementation" | "design" | "dependency" | "unknown";

export interface ExploreQueryDetails {
  objects: string[];
  relation: ExploreQueryRelation;
  domain: ExploreQueryDomain;
}

export interface ExploreTermWeight {
  term: string;
  kind: "object" | "content" | "anchor";
  /** Distinct files in this call's candidate pool that matched the group. */
  uniqueFiles: number;
  coverage: ExploreTermCoverage;
  variants: string[];
  /**
   * Query-internal weight. Ordinary match contribution is 1. Extra
   * distinctiveness is added only when `coverage` is `complete`.
   */
  weight: number;
}

/**
 * Per-call term weights. This is not corpus IDF: N and df are this
 * query's candidate pool after hit-budget truncation.
 */
export interface ExploreDistinctivenessDetails {
  scope: "query-pool";
  poolFiles: number;
  terms: ExploreTermWeight[];
}

export type ExploreArrivalKind = "lexical" | "graph" | "semantic";
export type ExploreGraphArrivalReason = "object-triggered" | "statement-evidence" | "same-container";

export interface ExploreLexicalArrival {
  kind: "lexical";
  groups: string[];
  hits: string[];
}

export interface ExploreGraphArrival {
  kind: "graph";
  edgeKind?: "connects" | "associates" | "definition" | "import" | "references" | "calls" | "action";
  arrivalReason: ExploreGraphArrivalReason;
}

export interface ExploreSemanticArrival {
  kind: "semantic";
  queryVariant?: string;
  blockId?: string;
  rank?: number;
  similarity?: number;
}

export type ExploreArrival = ExploreLexicalArrival | ExploreGraphArrival | ExploreSemanticArrival;
export type ExploreAssessment = "verified-relation" | "object-present" | "name-only" | "unverified";
export type ExplorePurpose = "primary" | "support" | "candidate";

/** Generated windows for this call, packed or not. Used by observation meters. */
export interface ExploreWindowTrace {
  path: string;
  startLine: number;
  endLine: number;
  why: string;
  packed: boolean;
  hits: string[];
  arrivals: ExploreArrival[];
  assessment: ExploreAssessment;
  purpose: ExplorePurpose;
  unit?: ExploreStructureUnit;
}

export interface ExploreSkippedQueries {
  /** Broad/content-word patterns not launched because a direct clue already verified. */
  reason: "direct-verified";
  patterns: string[];
}

export type ExploreSemanticStatus =
  | "not-requested"
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "stale"
  | "incomplete";

export type ExploreSemanticCoverage = "empty" | "partial" | "complete";
export type ExploreIndexLifecycle = "idle" | "building" | "rebuilding" | "ready";

export interface ExploreSemanticDetails {
  status: ExploreSemanticStatus;
  coverage: ExploreSemanticCoverage;
  /** Limits of current-version checks and filesystem change observation. */
  note?: string;
  generation?: string;
  spaceId?: string;
  scope?: { scopeKind: string; scopeId: string };
  index: { lifecycle: ExploreIndexLifecycle };
  blocks?: number;
  units?: number;
  primary?: number;
  /** Paths whose body is available but whose vectors are not yet in this view. */
  gaps?: ExploreSemanticGap[];
}

export interface ExploreRerankDetails {
  status: ExploreModelStageStatus;
  providerId?: string;
  modelId?: string;
  batchId?: string;
  evaluated?: number;
  note?: string;
}

export interface ExploreGraphDetails {
  status: ExploreGraphStatus;
  /** Distinct definition files, not hit count. */
  definitions: number;
  /** Distinct confirmed-connection (`connects`) files. */
  connections: number;
  /** Distinct association-candidate files. Not the same evidence grade as `connections`. */
  associates?: number;
  imports: number;
  /**
   * Distinct files contributed by resolved `references`/`calls` edges
   * (language-service results persisted on the graph, D-240).
   */
  relations?: number;
  /**
   * Floor of graph-source files that exceeded the independent graph budget.
   * Combined with rg `searched.filesDropped` by taking the maximum, not the sum.
   */
  filesDropped?: number;
  partial?: boolean;
}

export interface ExploreFileRelation {
  path: string;
  /** Disk revision the edges were collected from; null on legacy rows. */
  documentRevision: string | null;
  /**
   * The graph revision differs from the excerpt the agent is reading, so the
   * edges may name lines that moved. The edge itself is still evidence; its
   * line numbers are not (agent-harness 7.2).
   */
  stale: boolean;
  /** Link extraction was blocked for this revision, so edges may be missing. */
  incomplete: boolean;
  imports: Array<{ specifier: string; line: number }>;
  connections: Array<{ callee: string; literal: string; line: number }>;
  associations: Array<{ callee: string; literal: string; line: number }>;
  /**
   * Language-service-resolved relations collected on this file. `pinned` means
   * the site text was bound at resolve time; unpinned sites are the server's
   * own read and `staleTarget` means the target file's catalog revision moved
   * after the row was written (D-240).
   */
  references?: Array<{
    value: string;
    line: number;
    caller?: string;
    targetPath?: string;
    targetName?: string;
    pinned: boolean;
    staleTarget?: boolean;
    resolvedBy: string;
  }>;
  calls?: Array<{
    callee: string;
    line: number;
    caller?: string;
    targetPath?: string;
    targetName?: string;
    pinned: boolean;
    staleTarget?: boolean;
    resolvedBy: string;
  }>;
}

/**
 * Dedicated reranker output is scores only. It cannot carry complementary
 * groups, required ranges, or gaps, and it is not run in the same batch as
 * the explore model by default (D-174, D-176).
 */
export interface ExploreRerankScore {
  viewId: string;
  score: number;
}

export type ExploreModelStageStatus = "used" | "skipped" | "unconfigured" | "disabled" | "failed" | "cancelled";

export interface ExploreModelParticipation {
  plan: ExploreModelStageStatus;
  select: ExploreModelStageStatus;
  followup: ExploreModelStageStatus;
  rerank?: ExploreModelStageStatus;
  /**
   * Fast Decision Model participation (D-312): the Host-side progressive
   * loop judges material and chooses follow-up actions inside one query.
   */
  fastDecision?: ExploreModelStageStatus;
  note?: string;
}

/**
 * Fast-decision provenance inside `ExploreResult.details` (D-312). Counts and
 * identities are facts about what ran; provider values are never restated as
 * verified relevance.
 */
export interface ExploreFastDecisionDetails {
  status: "used" | "failed" | "cancelled";
  providerId?: string;
  modelId?: string;
  servedModelId?: string;
  /** Model call batches that completed. */
  batches: number;
  rounds: number;
  viewsJudged: number;
  actionsOffered: number;
  actionsExecuted: number;
  /** Action identities the model chose and the Host executed. */
  executed: string[];
  /** Question ids the provider left unanswered across all batches. */
  missing: number;
  /** Materials withheld from a batch by the model-input budget. */
  unevaluatedMaterials: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  note?: string;
}

export type ExploreSemanticGapReason =
  | "draft-vector-pending"
  | "draft-unavailable"
  | "thread-vector-pending"
  | "index-read-failed"
  | "content-changed"
  | "index-watch-unavailable";

export interface ExploreSemanticGap {
  path: string;
  reason: ExploreSemanticGapReason;
}

export type ExploreQueryTaskFamily = "lexical" | "graph" | "semantic" | "plan" | "followup" | "model";
export type ExploreQueryTaskStatus =
  | "pending"
  | "running"
  | "ready"
  | "empty"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "incomplete";

export interface ExploreQuerySourceState {
  id: string;
  family: ExploreQueryTaskFamily;
  status: ExploreQueryTaskStatus;
}

export interface ExploreQueryVocab {
  objects: string[];
  anchors: string[];
  catalog?: { symbolCount: number; fileCount?: number };
  packages?: string[];
  entries?: string[];
}

export interface ExploreQueryStartParams {
  question: string;
  paths?: string[];
  limit?: number;
  anchors?: string[];
  /** Whole public-explore remaining wait, not a fresh per-RPC budget. */
  budgetMs?: number;
  /** Leave judge/present time. Algorithm-only `explore.search` leaves this false. */
  reserveForJudge?: boolean;
}

export interface ExploreQueryStartResult {
  queryId: string;
  question: string;
  deadlineAt: number;
  parsed: ExploreQueryDetails;
  vocab: ExploreQueryVocab;
  sources: ExploreQuerySourceState[];
  inputSource: AgentInputContext["source"];
  /** Frozen user choice for the relevance/plan stage of this query. */
  decisionMode?: import("./harness-settings.js").HarnessExploreDecisionMode;
  /**
   * The fast-decision binding frozen for this query at start (D-312). "ready"
   * means the Host runs the progressive selection/action loop inside this
   * query; other states leave the query on the existing algorithmic path.
   */
  fastDecision?: { status: "ready" | "disabled" | "unconfigured" | "invalid" | "unavailable" };
}

export interface ExploreGroupedSearchPlanGroup {
  id: string;
  concept: string;
  expressions: string[];
  expectedMaterials?: string[];
}

export interface ExploreGroupedSearchPlan {
  behavior: string;
  groups: ExploreGroupedSearchPlanGroup[];
}

export interface ExploreQueryPlanParams {
  queryId: string;
  plan: ExploreGroupedSearchPlan;
}

export interface ExploreQueryPlanResult {
  queryId: string;
  launched: string[];
  reused: string[];
  sources: ExploreQuerySourceState[];
}

export interface ExploreQueryRange {
  rangeId: string;
  startLine: number;
  endLine: number;
}

export interface ExploreQueryView {
  viewId: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  revision: string;
  source: "disk" | "surface-draft" | "working-branch";
  ranges: ExploreQueryRange[];
  arrivals: ExploreArrival[];
  assessment: ExploreAssessment;
  purpose: ExplorePurpose;
  why: string;
  unit?: ExploreStructureUnit;
  /** Not sent to the candidate model; selecting it is rejected as unseen. */
  unevaluated?: boolean;
}

export interface ExploreQueryViewsParams {
  queryId: string;
}

export interface ExploreQueryViewsResult {
  queryId: string;
  question: string;
  hypotheses?: { behavior?: string; expectedMaterials?: string[] };
  views: ExploreQueryView[];
  unevaluated: number;
  sources: ExploreQuerySourceState[];
  deadlineAt: number;
}

export interface ExploreQuerySelectedRange {
  viewId: string;
  rangeIds?: string[];
  startLine?: number;
  endLine?: number;
  required?: boolean;
}

export interface ExploreQuerySelectionGroup {
  id: string;
  purpose: string;
  views: ExploreQuerySelectedRange[];
  gap?: string;
}

export interface ExploreQuerySelectParams {
  queryId: string;
  groups: ExploreQuerySelectionGroup[];
  /** Keep earlier accepted groups and merge by group id. Incremental follow-up uses this. */
  merge?: boolean;
}

export interface ExploreQuerySelectResult {
  queryId: string;
  accepted: Array<{ groupId: string; viewIds: string[] }>;
  rejected: Array<{ groupId?: string; viewId?: string; reason: string }>;
  gaps: string[];
}

export interface ExploreQueryFollowupLocate {
  kind: "symbol" | "path" | "connect";
  value: string;
}

export interface ExploreQueryFollowupSearch {
  expression: string;
}

/**
 * A concrete next step generated by the Host from actually-read material
 * (D-312). The model picks action ids; the query owner executes the bound
 * operation through the existing search/graph/read services.
 */
export interface ExploreQueryAction {
  /** Stable identity for this candidate; also the dedup key. */
  actionId: string;
  kind:
    | "symbol"     // locate definitions of a real symbol
    | "connect"    // follow a connection literal to its other end
    | "path"       // read a located path (whole file, outline-driven)
    | "read"       // read a path, optionally a line range or a locate hint
    | "importers"  // who imports this file
    | "callers"    // who calls this symbol
    | "references" // reference sites of this symbol
    | "calls";     // call sites whose enclosing caller is this symbol
  /** Symbol, literal, or path — a real value found in material. */
  target: string;
  /** `read` window bounds; clamped to the real file when applied. */
  startLine?: number;
  endLine?: number;
  /**
   * Center a `read`/`path` window on this name inside the target file, e.g.
   * the resolved callee a call edge points at.
   */
  locate?: { text: string; kind: "identifier" | "literal" };
  /** Why this candidate exists, e.g. which material produced it. */
  why: string;
}

export interface ExploreQueryFollowupParams {
  queryId: string;
  searches?: ExploreQueryFollowupSearch[];
  locates?: ExploreQueryFollowupLocate[];
  /** Host-issued action candidates chosen by the fast-decision model. */
  actions?: ExploreQueryAction[];
  gaps?: string[];
}

export interface ExploreQueryFollowupResult {
  queryId: string;
  launched: string[];
  reused: string[];
  newViews: ExploreQueryView[];
  /** Action ids the query owner actually executed. */
  actionsExecuted?: string[];
  /** Action ids rejected as unknown, stale, or out of scope. */
  actionsRejected?: Array<{ actionId: string; reason: string }>;
  sources: ExploreQuerySourceState[];
}

export interface ExploreQueryFinishParams {
  queryId: string;
  model?: ExploreModelParticipation;
}

export interface ExploreQueryCancelParams {
  queryId: string;
}

export interface ExploreQueryReleaseParams {
  queryId: string;
}

export interface HarnessCancelData {
  requestId?: string;
  queryId?: string;
}

export interface ExploreSearchResult {
  text: string;
  snippets: ExploreSearchSnippet[];
  issues: ExploreSearchIssue[];
  notRequested: { count: number; paths: string[] };
  omitted: Array<{ path: string; startLine: number; endLine: number; reason: string }>;
  partial: boolean;
  /**
   * `filesDropped` is a floor, not a total: query terms and search roots match overlapping
   * file sets, so the distinct union cannot be recovered from per-query counts. It carries
   * the largest single-query drop, and the model-visible body says "at least".
   */
  searched: { patterns: number; files: number; ms: number; incomplete: boolean; filesDropped?: number };
  handle: string;
  details: {
    provenance: ExploreSearchProvenance[];
    anchors: { supplied: string[]; used: string[]; truncated: number };
    byteBudget: number;
    structure?: {
      files: Array<{
        path: string;
        provider: ExploreStructureProvider | null;
        status: ExploreStructureStatus;
      }>;
    };
    /**
     * Outbound graph facts for excerpt paths only. `connections` are confirmed
     * call/register shapes; `associations` are same-string literals whose own
     * call shape is not a connection, so they are candidates, not facts.
     */
    relations?: { status: ExploreRelationStatus; files: ExploreFileRelation[] };
    /**
     * Path-level graph recall (definitions, connection endpoints, reverse
     * imports). The graph never supplies line numbers for excerpts; those are
     * re-located in the current text. Distinct from `relations`, which annotate
     * already-selected excerpts.
     */
    graph?: ExploreGraphDetails;
    query?: ExploreQueryDetails;
    skippedQueries?: ExploreSkippedQueries;
    distinctiveness?: ExploreDistinctivenessDetails;
    windows?: ExploreWindowTrace[];
    semantic?: ExploreSemanticDetails;
    rerank?: ExploreRerankDetails;
    /** Fast-decision loop facts: rounds, chosen actions, unanswered questions. */
    fastDecision?: ExploreFastDecisionDetails;
    model?: ExploreModelParticipation;
    /** Per-source production outcome. failed/empty/unavailable/incomplete/cancelled stay distinct. */
    sources?: ExploreQuerySourceState[];
  };
}

/**
 * Model-facing result for the staged explore query. Large path-level omission
 * and provenance lists remain in the session-authorized output handle; this
 * projection carries counts and bounded summaries while direct
 * `explore.search` keeps its full result contract.
 */
export interface ExploreQueryFinishResult {
  text: string;
  /** The selected current excerpts needed to answer the query. */
  snippets: ExploreSearchSnippet[];
  issueCount: number;
  notRequestedCount: number;
  omittedCount: number;
  partial: boolean;
  searched: ExploreSearchResult["searched"];
  handle: string;
  details: ExploreQueryFinishDetails;
}

export interface ExploreQueryFinishDetails {
  provenance: { statusCounts: Partial<Record<ExploreSourceStatus, number>> };
  anchors: ExploreSearchResult["details"]["anchors"];
  byteBudget: number;
  structure?: {
    fileCount: number;
    providers: Partial<Record<ExploreStructureProvider | "none", number>>;
    statuses: Partial<Record<ExploreStructureStatus, number>>;
  };
  relations?: {
    status: ExploreRelationStatus;
    fileCount: number;
    staleFiles: number;
    incompleteFiles: number;
    edgeCounts: { imports: number; connections: number; associations: number; references: number; calls: number };
  };
  graph?: ExploreGraphDetails;
  query?: { objectCount: number; relation: ExploreQueryRelation; domain: ExploreQueryDomain };
  skippedQueries?: { reason: "direct-verified"; patternCount: number };
  distinctiveness?: { scope: "query-pool"; poolFiles: number; termCount: number };
  semantic?: Omit<ExploreSemanticDetails, "gaps"> & { gapCount?: number };
  rerank?: ExploreRerankDetails;
  fastDecision?: Omit<ExploreFastDecisionDetails, "executed">;
  model?: ExploreModelParticipation;
  sources?: {
    count: number;
    families: Partial<Record<ExploreQueryTaskFamily, number>>;
    statuses: Partial<Record<ExploreQueryTaskStatus, number>>;
  };
}

export interface HarnessServiceMap {
  "permission.inspect": { params: PermissionInspectParams; result: PermissionInspectResult };
  "permission.audit": { params: PermissionAuditRecord; result: { accepted: boolean } };

  /**
   * `waitMs` is the post-accept foreground observation budget, not a command
   * execution deadline: the call may still carry admission and transport time
   * before acceptance, and expiry returns the real pending/background state
   * with a queryable identity instead of a failure.
   */
  "shell.exec": { params: { command: string; cwd?: string; waitMs?: number; toolCallId?: string; target?: string }; result: ShellExecResult };
  "shell.read": { params: { id: string; offset?: number; length?: number; waitMs?: number; target?: string }; result: ShellReadResult };
  "shell.write": { params: { id: string; text: string }; result: { accepted: boolean } };
  "shell.kill": { params: { id: string }; result: { killed: boolean } };
  "output.store": { params: { text: string; label?: string }; result: { ref: OutputRef; total: number } };
  "output.read": { params: { handle: string; offset?: number; length?: number }; result: OutputSlice };
  "search.content": { params: SearchContentParams; result: SearchContentResult };
  "lsp.diagnostics": { params: { path: string; waitMs?: number }; result: DiagnosticsResult };
  "lsp.diagnosticsSnapshot": { params: { path: string; full?: boolean }; result: DiagnosticsResult };
  "lsp.symbols": { params: { path: string; query: string }; result: LspNavigationResult };
  "lsp.definition": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "lsp.references": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "lsp.hover": { params: { path: string; line: number; character?: number }; result: LspNavigationResult };
  "fs.lock": { params: FsLockParams; result: FsLockResult };
  "web.fetch": { params: WebFetchRequest; result: FetchResult };
  "materials.read": { params: DocumentReadRequest; result: FetchResult };
  "web.search": { params: WebSearchRequest; result: WebSearchResult };
  "network.diagnose": { params: NetworkDiagnoseParams; result: NetworkDiagnosisResult };
  "materials.collections": { params: MaterialsCollectionParams; result: MaterialsCollectionResult };
  "research.search": { params: import("./research-search.js").ScholarlySearchParams; result: import("./research-search.js").ScholarlySearchResult };
  "research.decide": { params: ResearchDecideParams; result: ResearchDecideResult };
  "zone2.assemble": { params: Zone2AssembleParams; result: Zone2AssembleResult };
  "zone2.status": { params: Zone2StatusParams; result: Zone2StatusResult };
  "zone2.delivered": { params: Zone2DeliveredParams; result: Zone2DeliveredResult };
  "context.retained": { params: ContextRetentionParams; result: ContextRetentionResult };
  "todo.upsert": { params: TodoUpsertParams; result: TodoUpsertResult };
  "recall.search": { params: RecallSearchParams; result: RecallSearchResult };
  "knowledge.suggest": { params: KnowledgeSuggestParams; result: KnowledgeSuggestResult };
  // Phase 3: Thread operations
  "thread.dispatch": { params: ThreadDispatchParams; result: ThreadDispatchResult };
  "thread.facts.set": { params: ThreadFactsSetParams; result: ThreadFactsSetResult };
  "thread.list": { params: ThreadListParams; result: ThreadListResult };
  "thread.wait": { params: ThreadWaitParams; result: ThreadWaitResult };
  "thread.send": { params: ThreadSendParams; result: ThreadSendResult };
  "thread.read": { params: ThreadReadParams; result: ThreadReadResult };
  "thread.history": { params: import("./harness-history.js").HistoryReadParams & { runId: string }; result: import("./harness-history.js").HistoryReadResult };
  "thread.merge": { params: ThreadMergeParams; result: ThreadMergeResult };
  "thread.update": { params: ThreadUpdateParams; result: ThreadUpdateResult };
  "thread.kill": { params: ThreadKillParams; result: ThreadKillResult };
  "explore.search": {
    params: ExploreSearchParams;
    result: ExploreSearchResult;
  };
  "explore.query.start": {
    params: ExploreQueryStartParams;
    result: ExploreQueryStartResult;
  };
  "explore.query.plan": {
    params: ExploreQueryPlanParams;
    result: ExploreQueryPlanResult;
  };
  "explore.query.views": {
    params: ExploreQueryViewsParams;
    result: ExploreQueryViewsResult;
  };
  "explore.query.select": {
    params: ExploreQuerySelectParams;
    result: ExploreQuerySelectResult;
  };
  "explore.query.followup": {
    params: ExploreQueryFollowupParams;
    result: ExploreQueryFollowupResult;
  };
  "explore.query.finish": {
    params: ExploreQueryFinishParams;
    result: ExploreQueryFinishResult;
  };
  "explore.query.cancel": {
    params: ExploreQueryCancelParams;
    result: { cancelled: boolean };
  };
  "explore.query.release": {
    params: ExploreQueryReleaseParams;
    result: { released: boolean };
  };
  "related.query": {
    params: RelatedQueryParams;
    result: RelatedQueryResult;
  };
  "document.readSource": { params: { path: string }; result: DocumentReadSourceResult };
  "document.pathOverlay": { params: DocumentPathOverlayParams; result: DocumentPathOverlayResult };
  "document.writeGuard": { params: { path: string }; result: DocumentWriteGuardResult };
  "document.surfaceWrite": { params: DocumentSurfaceWriteParams; result: DocumentSurfaceWriteResult };
  "document.branchWrite": { params: DocumentBranchWriteParams; result: DocumentBranchWriteResult };
  "workingBranch.ensureMaterialized": { params: Record<string, never>; result: WorkingBranchEnsureMaterializedResult };
  "surface.snapshot.commit": { params: { context: AgentInputContext }; result: { committed: boolean } };
  "surface.snapshot.release": { params: { context: AgentInputContext }; result: { released: boolean } };
  // Phase 7C/7D: experiment execution and resource facts (D-300)
  "experiment.submit": { params: import("./harness-experiments.js").ExperimentSubmitParams; result: import("./harness-experiments.js").ExperimentSubmitResult };
  "experiment.list": { params: import("./harness-experiments.js").ExperimentListParams; result: import("./harness-experiments.js").ExperimentListResult };
  "experiment.get": { params: import("./harness-experiments.js").ExperimentGetParams; result: import("./harness-experiments.js").ExperimentGetResult };
  "experiment.logs": { params: import("./harness-experiments.js").ExperimentLogsParams; result: import("./harness-experiments.js").ExperimentLogsResult };
  "experiment.artifact": { params: import("./harness-experiments.js").ExperimentArtifactReadParams; result: import("./harness-experiments.js").ExperimentArtifactReadResult };
  "experiment.cancel": { params: import("./harness-experiments.js").ExperimentCancelParams; result: import("./harness-experiments.js").ExperimentCancelResult };
  "experiment.wait": { params: import("./harness-experiments.js").ExperimentWaitParams; result: import("./harness-experiments.js").ExperimentWaitResult };
  "experiment.collect": { params: import("./harness-experiments.js").ExperimentCollectParams; result: import("./harness-experiments.js").ExperimentCollectResult };
  "resource.list": { params: Record<string, never>; result: import("./harness-experiments.js").ResourceListResult };
  "source.register": { params: import("./harness-experiments.js").SourceRegisterParams; result: import("./harness-experiments.js").SourceRegisterResult };
  "source.list": { params: import("./harness-experiments.js").SourceListParams; result: import("./harness-experiments.js").SourceListResult };
  // Stage S (D-306): conversational settings backed by the shared catalog
  "settings.search": { params: import("./harness-settings-service.js").SettingsSearchParams; result: import("./harness-settings-service.js").SettingsSearchResult };
  "settings.read": { params: import("./harness-settings-service.js").SettingsReadParams; result: import("./harness-settings-service.js").SettingsReadResult };
  "settings.update": { params: import("./harness-settings-service.js").SettingsUpdateParams; result: import("./harness-settings-service.js").SettingsUpdateResult };
  "settings.action": { params: import("./harness-settings-service.js").SettingsActionParams; result: import("./harness-settings-service.js").SettingsActionResult };
  // Stage W (D-307): durable follow-up registration, triggers, continuation
  "followup.register": { params: import("./harness-followups.js").FollowUpRegisterParams; result: import("./harness-followups.js").FollowUpRegisterResult };
  "followup.list": { params: import("./harness-followups.js").FollowUpListParams; result: import("./harness-followups.js").FollowUpListResult };
  "followup.get": { params: import("./harness-followups.js").FollowUpGetParams; result: import("./harness-followups.js").FollowUpGetResult };
  "followup.update": { params: import("./harness-followups.js").FollowUpUpdateParams; result: import("./harness-followups.js").FollowUpUpdateResult };
  "followup.cancel": { params: import("./harness-followups.js").FollowUpCancelParams; result: import("./harness-followups.js").FollowUpGetResult };
  "followup.check": { params: import("./harness-followups.js").FollowUpCheckParams; result: import("./harness-followups.js").FollowUpCheckResult };
  "followup.fire": { params: import("./harness-followups.js").FollowUpFireParams; result: import("./harness-followups.js").FollowUpGetResult };
  // Stage W (D-307): calendar task management over the scheduled-task authority
  "schedule.list": { params: import("./harness-scheduled-tasks.js").ScheduleListParams; result: import("./harness-scheduled-tasks.js").ScheduleListResult };
  "schedule.get": { params: import("./harness-scheduled-tasks.js").ScheduleGetParams; result: import("./harness-scheduled-tasks.js").ScheduleGetResult };
  "schedule.upsert": { params: import("./harness-scheduled-tasks.js").ScheduleUpsertParams; result: import("./harness-scheduled-tasks.js").ScheduleUpsertResult };
  "schedule.remove": { params: import("./harness-scheduled-tasks.js").ScheduleRemoveParams; result: import("./harness-scheduled-tasks.js").ScheduleRemoveResult };
  "schedule.run": { params: import("./harness-scheduled-tasks.js").ScheduleRunParams; result: import("./harness-scheduled-tasks.js").ScheduleRunResult };
  "schedule.setEnabled": { params: import("./harness-scheduled-tasks.js").ScheduleSetEnabledParams; result: import("./harness-scheduled-tasks.js").ScheduleSetEnabledResult };
  "schedule.loop.read": { params: import("./harness-scheduled-tasks.js").ScheduleLoopReadParams; result: import("./harness-scheduled-tasks.js").ScheduleLoopReadResult };
  "schedule.loop.update": { params: import("./harness-scheduled-tasks.js").ScheduleLoopUpdateParams; result: import("./harness-scheduled-tasks.js").ScheduleLoopUpdateResult };
  "schedule.loop.remove": { params: import("./harness-scheduled-tasks.js").ScheduleLoopRemoveParams; result: import("./harness-scheduled-tasks.js").ScheduleLoopRemoveResult };
  "schedule.status": { params: import("./harness-scheduled-tasks.js").ScheduleStatusParams; result: import("./harness-scheduled-tasks.js").ScheduleStatusResult };
  // D-314: internal compaction task — parent session submits the frozen spec;
  // the compaction worker reads authorized history through compaction.history.
  "compaction.run": { params: import("./harness-compaction.js").CompactionTaskSpec; result: import("./harness-compaction.js").CompactionRunResult };
  "compaction.history": { params: import("./harness-compaction.js").CompactionHistoryParams; result: import("./harness-compaction.js").CompactionHistoryResult };
}

export type HarnessMethod = keyof HarnessServiceMap;

/**
 * Coarse, host-enforced capabilities for worker-to-host harness services.
 * These describe structural authority only; interactive allow/ask/deny policy
 * remains owned by the Pi tool gate.
 */
export type HarnessCapability =
  | "context.session"
  | "control.experiment"
  | "read.experiment"
  | "write.research-source"
  | "control.thread"
  | "process.shell"
  | "read.lsp"
  | "read.output"
  | "read.document"
  | "read.search"
  | "read.web"
  | "read.settings"
  | "control.settings"
  | "read.followup"
  | "control.followup"
  | "read.schedule"
  | "control.schedule"
  | "write.document";

export const HARNESS_METHOD_CAPABILITY = {
  "permission.inspect": "context.session",
  "permission.audit": "context.session",
  "shell.exec": "process.shell",
  "shell.read": "process.shell",
  "shell.write": "process.shell",
  "shell.kill": "process.shell",
  "output.store": "read.output",
  "output.read": "read.output",
  "search.content": "read.search",
  "lsp.diagnostics": "read.lsp",
  "lsp.diagnosticsSnapshot": "read.lsp",
  "lsp.symbols": "read.lsp",
  "lsp.definition": "read.lsp",
  "lsp.references": "read.lsp",
  "lsp.hover": "read.lsp",
  "fs.lock": "write.document",
  "web.fetch": "read.web",
  "materials.read": "read.document",
  "web.search": "read.web",
  "network.diagnose": "read.web",
  "research.search": "read.web",
  "research.decide": "read.web",
  "materials.collections": "read.web",
  "zone2.assemble": "context.session",
  "zone2.status": "context.session",
  "zone2.delivered": "context.session",
  "context.retained": "context.session",
  "todo.upsert": "context.session",
  "recall.search": "context.session",
  "knowledge.suggest": "context.session",
  "thread.dispatch": "control.thread",
  "thread.facts.set": "control.thread",
  "thread.list": "control.thread",
  "thread.wait": "control.thread",
  "thread.send": "control.thread",
  "thread.read": "control.thread",
  "thread.history": "context.session",
  "thread.merge": "control.thread",
  "thread.update": "control.thread",
  "thread.kill": "control.thread",
  "explore.search": "read.search",
  "explore.query.start": "read.search",
  "explore.query.plan": "read.search",
  "explore.query.views": "read.search",
  "explore.query.select": "read.search",
  "explore.query.followup": "read.search",
  "explore.query.finish": "read.search",
  "explore.query.cancel": "read.search",
  "explore.query.release": "read.search",
  "related.query": "read.search",
  "document.readSource": "read.document",
  "document.pathOverlay": "read.document",
  "document.writeGuard": "write.document",
  "document.surfaceWrite": "write.document",
  "document.branchWrite": "write.document",
  "workingBranch.ensureMaterialized": "write.document",
  "surface.snapshot.commit": "context.session",
  "surface.snapshot.release": "context.session",
  "experiment.submit": "control.experiment",
  "experiment.list": "read.experiment",
  "experiment.get": "read.experiment",
  "experiment.logs": "read.experiment",
  "experiment.artifact": "read.experiment",
  "experiment.cancel": "control.experiment",
  "experiment.wait": "read.experiment",
  "experiment.collect": "control.experiment",
  "resource.list": "read.experiment",
  "source.register": "write.research-source",
  "source.list": "read.experiment",
  "settings.search": "read.settings",
  "settings.read": "read.settings",
  "settings.update": "control.settings",
  "settings.action": "control.settings",
  "followup.register": "control.followup",
  "followup.list": "read.followup",
  "followup.get": "read.followup",
  "followup.update": "control.followup",
  "followup.cancel": "control.followup",
  "followup.check": "control.followup",
  "followup.fire": "control.followup",
  "schedule.list": "read.schedule",
  "schedule.get": "read.schedule",
  "schedule.upsert": "control.schedule",
  "schedule.remove": "control.schedule",
  "schedule.run": "control.schedule",
  "schedule.setEnabled": "control.schedule",
  "schedule.loop.read": "read.schedule",
  "schedule.loop.update": "control.schedule",
  "schedule.loop.remove": "control.schedule",
  "schedule.status": "read.schedule",
  "compaction.run": "context.session",
  "compaction.history": "context.session",
} as const satisfies Record<HarnessMethod, HarnessCapability>;

/** Identity attached by the broker after it has pinned a worker to a session. */
export interface HarnessActorIdentity {
  authorityInstanceId: string;
  sessionId: string;
  runId?: string;
  /** Broker-pinned relative workspace paths for a restricted child Run. */
  workspaceScope?: readonly string[];
  workerId: string;
  workerGeneration: number;
}

/** Identity completed with workspace and frozen authority by the Host. */
export interface HarnessActorContext extends HarnessActorIdentity {
  /**
   * Session classification: the project workspace this chat is associated
   * with, if any. HR0: `null` is a fully registered state — path resolution,
   * todo/subtask ownership, and tool admission do not require it.
   */
  workspaceId: string | null;
  workspaceScope?: readonly string[];
  /**
   * Absolute authority root the session's relative paths anchor to: the
   * authorized workspace root for bound sessions, the session's own launch
   * directory for unbound ones. Pinned per request at actor resolution.
   */
  authorityRoot?: string | null;
  /**
   * Absolute session launch directory (the session's cwd). Relative tool
   * paths anchor here rather than at the authority root; absent only when a
   * registered session has no resolvable launch directory. Pinned per
   * request at actor resolution.
   */
  cwd?: string | null;
  grantedCapabilities: readonly HarnessCapability[];
  /**
   * Internal auxiliary actors (e.g. a session's compaction worker) may carry
   * an explicit method allowlist; when present the router rejects every
   * method outside it regardless of the granted capability category.
   */
  allowedMethods?: readonly HarnessMethod[];
}

const HARNESS_METHODS: ReadonlySet<string> = new Set<string>([
  "permission.inspect",
  "permission.audit",
  "shell.exec",
  "shell.read",
  "shell.write",
  "shell.kill",
  "output.store",
  "output.read",
  "search.content",
  "lsp.diagnostics",
  "lsp.diagnosticsSnapshot",
  "lsp.symbols",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
  "fs.lock",
  "web.fetch",
  "materials.read",
  "web.search",
  "network.diagnose",
  "research.search",
  "research.decide",
  "materials.collections",
  "zone2.assemble",
  "zone2.status",
  "zone2.delivered",
  "context.retained",
  "todo.upsert",
  "recall.search",
  "knowledge.suggest",
  "thread.dispatch",
  "thread.facts.set",
  "thread.list",
  "thread.wait",
  "thread.send",
  "thread.read",
  "thread.history",
  "thread.merge",
  "thread.update",
  "thread.kill",
  "explore.search",
  "explore.query.start",
  "explore.query.plan",
  "explore.query.views",
  "explore.query.select",
  "explore.query.followup",
  "explore.query.finish",
  "explore.query.cancel",
  "explore.query.release",
  "related.query",
  "document.readSource",
  "document.pathOverlay",
  "document.writeGuard",
  "document.surfaceWrite",
  "document.branchWrite",
  "workingBranch.ensureMaterialized",
  "surface.snapshot.commit",
  "surface.snapshot.release",
  "experiment.submit",
  "experiment.list",
  "experiment.get",
  "experiment.logs",
  "experiment.artifact",
  "experiment.cancel",
  "experiment.wait",
  "experiment.collect",
  "resource.list",
  "source.register",
  "source.list",
  "settings.search",
  "settings.read",
  "settings.update",
  "settings.action",
  "followup.register",
  "followup.list",
  "followup.get",
  "followup.update",
  "followup.cancel",
  "followup.check",
  "followup.fire",
  "schedule.list",
  "schedule.get",
  "schedule.upsert",
  "schedule.remove",
  "schedule.run",
  "schedule.setEnabled",
  "schedule.loop.read",
  "schedule.loop.update",
  "schedule.loop.remove",
  "schedule.status",
  "compaction.run",
  "compaction.history",
]);

export function isHarnessMethod(value: unknown): value is HarnessMethod {
  return typeof value === "string" && HARNESS_METHODS.has(value);
}

export type HarnessError = {
  code: "unavailable" | "timeout" | "compaction-stalled" | "invalid-params" | "not-found" | "expired" | "denied" | "forbidden" | "failed" | "ambiguous";
  message: string;
  retryable?: boolean;
};

export interface HarnessRequestData {
  requestId: string;
  method: HarnessMethod;
  params: unknown;
  /** Current immutable input source selected by SessionHost. */
  inputContext?: AgentInputContext;
  /**
   * How long the worker is prepared to wait, in milliseconds. The router
   * uses it instead of its own default so a deliberately long call such as
   * `thread.wait` is not aborted at the default 30s. Clamped by the router
   * to `HARNESS_MAX_REQUEST_TIMEOUT_MS`; absent means "use the default".
   * A zero transport timeout is reserved for methods with their own wait
   * deadline or lifecycle, including scheduler waits and shell observations;
   * cancellation and actor lifetime still bound the request.
   */
  timeoutMs?: number;
}

/**
 * Upper bound the router applies to a worker-supplied `timeoutMs`. A worker
 * must not be able to pin a host handler open indefinitely.
 */
export const HARNESS_MAX_REQUEST_TIMEOUT_MS = 3_600_000;

export type HarnessRespondParams = {
  requestId: string;
  sessionId: string;
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: HarnessError }
);

/**
 * Build the typed `harness.respond` params from a router outcome.
 * Callers pass this to `piRuntimeBroker.requestForWorker(identity.workerId, 'harness.respond', params)` —
 * auxiliary workers (e.g. a session's compaction worker) are addressed by worker, not session.
 */
export function buildHarnessRespondParams(
  sessionId: string,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
): HarnessRespondParams {
  if (outcome.ok) return { requestId, sessionId, ok: true, result: outcome.result };
  return { requestId, sessionId, ok: false, error: outcome.error };
}

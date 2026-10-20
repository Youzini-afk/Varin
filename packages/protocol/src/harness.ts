/** Shared service-domain data exchanged by native owners and product surfaces. */
import type { DocumentAnalysis, DocumentFindHit, DocumentOverview, DocumentPageImage, WebDocumentRegion, WebSnapshotRef, WebSnapshotStructure } from "./harness-web.js";
import type { AgentInputContext } from "./types.js";

export interface OutputSlice {
  observationRef?: string;
  text: string;
  offset: number;
  length: number;
  nextOffset: number;
  total: number;
  eof: boolean;
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
  /** Original tool call identity used to recover an accepted execution. */
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

/**
 * Unique-file coverage of one search pattern. Distinct from hit-level
 * `partial`: a per-file hit cap does not change how many matching files
 * were seen. Explore candidate-mode only.
 */
export type ExploreTermCoverage = "complete" | "lower-bound" | "unknown";

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
    /** Content-pinned snapshot when the Host material store is wired. */
    snapshot?: WebSnapshotRef;
    /** Fetch succeeded, but durable material publication failed. No snapshot is claimed. */
    snapshotError?: { message: string; code?: string };
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
  | { status: "renderer-unavailable"; url: string; reason: "disabled" | "unsupported" }
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

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  /** Provider-returned summary or abstract text, when the adapter supplies one. */
  summary?: string;
}

/** A bounded display page, independent of the size of its source file. */
export interface DocumentReadPageRequest {
  offset: number;
  limit: number;
  maxBytes: number;
}

export type DocumentReadPage =
  | { kind: "text"; text: string; startLine: number; lineCount: number; eof: boolean;
      nextOffset?: number; totalLines?: number; truncatedBy: "lines" | "bytes" | null;
      firstLineExceedsLimit?: true }
  | { kind: "binary"; format: string; byteLength: number }
  | { kind: "image"; base64: string };

export type DocumentSurfaceWriteAction = "write" | "edit" | "delete";

export type DocumentSurfaceWritePathStatus =
  | "applied"
  | "conflict"
  | "unavailable"
  | "compensated"
  | "needs-attention"
  | "disk";

// ── Unified memory (BC1) ───────────────────────────────────────────

/** What kind of durable claim a memory row carries. */
export type MemoryNature = "experience" | "decision" | "preference" | "judgment" | "instruction";

/** A range in an original source, with UTF-16 offsets into its text projection. */
interface MemorySourceRange {
  id: string;
  revision: string;
  start: number;
  end: number;
}
/** UTF-16 ranges. Branch/head witness visibility; they do not change immutable item identity. */
export type MemorySourceSpan = MemorySourceRange & (
  | { kind: 'history-item'; threadId: string; branchId: string; headId: string }
);

export interface MemorySourceExcerpt {
  span: MemorySourceSpan;
  status: "available" | "changed" | "unavailable";
  text?: string;
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
  /** Required members of each group must be delivered together. */
  requiredGroups?: string[];
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
  tokenizer?: string;
}

/**
 * Fast-decision provenance inside `ExploreResult.details` (D-312). Counts and
 * identities are facts about what ran; provider values are never restated as
 * verified relevance.
 */
export interface ExploreFastDecisionDetails {
  status: "used" | "skipped" | "failed" | "cancelled";
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
  tokenizer?: string;
  reusedJudgments?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  note?: string;
}

export type ExploreSemanticGapReason =
  | "draft-vector-pending"
  | "draft-unavailable"
  | "thread-vector-pending"
  | "index-read-failed"
  | "index-not-ready"
  | "content-changed"
  | "index-watch-unavailable"
  | "unsupported-files";

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
  /** Actual search expressions or action targets, independent of opaque ids. */
  targets?: string[];
}

/** Presentation receipts from the existing explore coordinator. Times are
 * elapsed at observation, not per-source durations. Candidate text is not
 * duplicated here; only final snippets carry their frozen source contents.
 */
export type ExploreProgressPhase = "starting" | "planning" | "collecting" | "selecting" | "following-up"
  | "finishing" | "complete" | "partial" | "empty" | "failed" | "unavailable" | "cancelled";

export type ExploreProgressActivity = { sequence: number; elapsedMs: number } & (
  | { kind: "phase"; phase: ExploreProgressPhase }
  | { kind: "source"; source: ExploreQuerySourceState }
  | { kind: "read"; viewId: string; path: string; startLine: number; endLine: number;
      revision: string; source: ExploreQueryView["source"] }
);

export interface ExploreToolProgress {
  phase: ExploreProgressPhase;
  elapsedMs: number;
  /** Distinct versioned views received by the coordinator, before selection. */
  receivedSnippets: number;
  receivedFiles: number;
  selectedViewIds?: string[];
  sources: ExploreQuerySourceState[];
  activities: ExploreProgressActivity[];
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
  inputSource: AgentInputContext["source"] | "fixed_branch" | "materialized";
  /** Frozen user choice for the relevance/plan stage of this query. */
  decisionMode?: import("./harness-settings.js").HarnessExploreDecisionMode;
  /**
   * The fast-decision binding frozen for this query at start (D-312). "ready"
   * means the Host runs the progressive selection/action loop inside this
   * query; other states leave the query on the existing algorithmic path.
   */
  fastDecision?: { status: "ready" | "disabled" | "unconfigured" | "invalid" | "unavailable" };
  /** Frozen responsibility assignment; no runtime provider cascade. */
  duties?: { actions: "source" | "llm" | "fast-decision"; selection: "source" | "llm" | "fast-decision" | "rerank" };
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
  /** Stable source location, separate from this immutable rendition and revision. */
  materialId?: string;
  /** Source paths connected by observed lookup dependencies, not asserted call edges. */
  relatedPaths?: string[];
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
  seen?: string[];
}

export interface ExploreQueryViewsResult {
  queryId: string;
  question: string;
  hypotheses?: { behavior?: string; expectedMaterials?: string[] };
  views: ExploreQueryView[];
  unevaluated: number;
  sources: ExploreQuerySourceState[];
  deadlineAt: number;
  sequence: number;
  pending: boolean;
  actions: ExploreQueryAction[];
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
  selectedViews: ExploreQueryView[];
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
    | "prepare-structure" // explicitly resolve a missing cold outline for read material
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
  dependencies?: Array<{ viewId: string; revision: string }>;
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
  /** Operations accepted for asynchronous execution; collect/wait observes progress. */
  actionsAccepted: string[];
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
    byteBudget?: number;
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
  /** Complete excerpts actually present in text; the handle retains all prepared excerpts. */
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

export type HarnessError = {
  code: "unavailable" | "timeout" | "invalid-params" | "not-found" | "expired" | "denied" | "forbidden" | "failed" | "ambiguous";
  message: string;
  retryable?: boolean;
};

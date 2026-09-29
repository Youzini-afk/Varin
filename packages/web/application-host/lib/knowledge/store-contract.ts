/** Shared private KnowledgeStore contract. No native module is loaded here. */

// ── Types ──────────────────────────────────────────────────────────

export type NodeId = number;

export type EventKind = "edit" | "command" | "diagnostic" | "turn" | "source" | "user-mark";
export type EventSource = "agent" | "user" | "external";

export interface EventRefs {
  path?: string;
  journalObject?: string;
  url?: string;
  handle?: string;
}

export interface EventInput {
  kind: EventKind;
  at: number; // epoch ms
  sessionId: string;
  turnIndex?: number;
  text: string;
  refs?: EventRefs;
  data?: Record<string, unknown>;
  /** Stable identity for an event that must be idempotent within its store. */
  dedupeKey?: string;
  source: EventSource;
}

export interface StoredEvent extends EventInput {
  id: NodeId;
}

export interface SessionInput {
  sessionId: string;
  profile: string;
  workspaceId: string;
  startedAt: number;
  harness: unknown;
}

export type BlockUpdatedBy = "agent" | "memory-agent" | "user";

export interface Block {
  sessionId: string;
  label: string;
  content: string;
  updatedBy: BlockUpdatedBy;
  cursorTurn?: number;
  updatedAt: number;
  /**
   * The Pi session leaf entry ID at the time this block was written.
   * Used for branch-aware visibility: a block is visible on the current
   * branch if its sourceLeafId is in the current branch's ancestor path
   * (i.e. in `sessionManager.getBranch().map(e => e.id)`).
   * null/undefined = legacy block written before branch tracking.
   */
  sourceLeafId?: string | null;
}

export interface BlockInput {
  sessionId: string;
  label: string;
  content: string;
  updatedBy: BlockUpdatedBy;
  cursorTurn?: number;
  expectedUpdatedAt?: number | null;
  /**
   * The Pi session leaf entry ID at write time. See Block.sourceLeafId.
   */
  sourceLeafId?: string | null;
  /** Active branch ancestor path used to resolve the visible prior revision. */
  branchEntryIds?: readonly string[];
}

export interface BlockChange {
  previous: Block | null;
  current: Block | null;
}

export class KnowledgeBlockConflictError extends Error {
  readonly current: Block | null;

  constructor(current: Block | null) {
    super("Session block changed after it was opened");
    this.name = "KnowledgeBlockConflictError";
    this.current = current;
  }
}

export type KnowledgeScope = "workspace" | "user" | "session" | "bot";
export type KnowledgeStatus = "suggested" | "accepted" | "dismissed";

/**
 * What kind of durable claim a knowledge row carries (BC1). `experience` is an
 * observed episode; `decision`/`preference`/`judgment` are agent- or
 * user-authored conclusions; `instruction` is an explicit user requirement —
 * the only nature that speaks with user authority.
 */
export type MemoryNature = "experience" | "decision" | "preference" | "judgment" | "instruction";
export const MEMORY_NATURES: readonly MemoryNature[] = ["experience", "decision", "preference", "judgment", "instruction"];

/**
 * Where a memory came from. `kind` names the producer path (`user-mark`,
 * `user-message`, `memory.remember`, `memory-organizer`, …); the optional refs
 * bind the row to the work that produced it — a session, thread, run, or
 * session entry — so a memory stays reachable from its real provenance.
 */
export interface KnowledgeSource {
  kind: string;
  /** Stable source-range identity for automatic retries and forgetting. */
  key?: string;
  sessionId?: string;
  threadId?: string;
  runId?: string;
  entryId?: string;
}

/** Values that identify the revision a caller opened before a mutation. */
export interface KnowledgeExpectedRevision {
  content: string;
  trigger: string;
  /** Optional for legacy review-tray callers; Settings always supplies it. */
  status?: KnowledgeStatus;
  /** `null` identifies an active row with no invalidAt field. */
  invalidAt?: number | null;
}

export interface KnowledgeInput {
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  content: string;
  trigger: string;
  nature?: MemoryNature;
  source?: KnowledgeSource;
  /**
   * `supplements` records a `supplements` edge to an existing memory in the
   * same scope — the organizer's "refine an existing memory" relation. The
   * target must be an existing knowledge row in the same store.
   */
  supplements?: NodeId;
}

export interface Knowledge {
  id: NodeId;
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  content: string;
  trigger: string;
  nature?: MemoryNature;
  source?: KnowledgeSource;
  /** Existing memory this row refines (`supplements` edge target), if any. */
  supplements?: NodeId;
  createdAt: number;
  invalidAt?: number;
  recallCount: number;
  recalledAt?: number;
}

export interface KnowledgeSupersedeChain {
  current: Knowledge;
  predecessors: Knowledge[];
  successors: Knowledge[];
  chain: Knowledge[];
}

export interface KnowledgeCreateIfAbsentResult {
  created: boolean;
  duplicate: boolean;
  knowledge: Knowledge;
}

export class KnowledgeMutationError extends Error {
  readonly code: "conflict" | "not-found" | "invalid";

  constructor(code: KnowledgeMutationError["code"], message: string) {
    super(message);
    this.name = "KnowledgeMutationError";
    this.code = code;
  }
}

export interface KnowledgeOrEvent {
  id: NodeId;
  type: "knowledge" | "event";
  payload: Record<string, unknown>;
}

/**
 * Durable background-organizer coverage (BC2). One row per source key inside
 * the store it covers — `session:<id>` for session sources (event + entry
 * cursors), `run:<runId>` for thread-run reports. `pending`/`processing`/
 * `prepared` rows are unfinished work a restarted Host must resume; `failed`
 * keeps the cursor where the failure left it so the range retries instead of
 * silently passing.
 */
export type OrganizerProgressStatus =
  | "pending"
  | "processing"
  | "prepared"
  | "formed"
  | "reviewed-empty"
  | "failed";

/**
 * A memory proposal durably stored between prepare and commit. Proposals
 * carry no batch-local source index — attribution lives on the progress row's
 * `key`, which names the source range the proposal was distilled from.
 */
export interface OrganizerPreparedProposal {
  action: "new" | "supplement" | "correct";
  scope: "workspace" | "user" | "bot";
  nature?: string;
  content: string;
  trigger?: string;
  target?: number;
}

export interface OrganizerProgress {
  key: string;
  status: OrganizerProgressStatus;
  /**
   * Content fingerprint of the covered source range. Coverage only counts
   * when the row is terminal (`formed`/`reviewed-empty`) AND the fingerprint
   * matches the range's current content — a changed source reopens coverage.
   */
  sourceKey?: string;
  /** Last processed store event id for session sources. */
  eventCursor?: number;
  /** Last processed Pi entry id for session sources. */
  entryCursor?: string;
  /** Knowledge ids this source produced, for audit and late-result checks. */
  produced?: number[];
  /**
   * `prepared` rows hold their proposals here so a crash between prepare and
   * commit replays exactly these proposals instead of re-narrating divergent
   * ones. Cleared when the row reaches a terminal status.
   */
  proposals?: OrganizerPreparedProposal[];
  /** Frozen end cursors for a prepared session range. Appended turns cannot
   * change the proposal set that must be replayed before new material. */
  preparedRange?: { eventCursor?: number; entryCursor?: string };
  updatedAt: number;
  lastError?: string;
}

export interface RecallResult {
  node: KnowledgeOrEvent;
  score: number;
  via: "text" | "vector" | "graph" | "associated";
}

export interface EmbeddingProvider {
  id: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SymbolGraphRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface SymbolGraphSymbolInput {
  name: string;
  kind: string;
  range: SymbolGraphRange;
}

export type SymbolMatchTier = "exact" | "name-contains" | "path-contains";

export interface SymbolGraphSearchResult extends SymbolGraphSymbolInput {
  id: NodeId;
  path: string;
  score: number;
  /** Which score bucket produced this hit. Definition ranking depends on the distinction. */
  match: SymbolMatchTier;
  /**
   * Disk revision the range was computed from, or null for rows written before
   * ranges carried a text identity (D-087). A consumer that cannot match it
   * against the current text must degrade instead of trusting the range.
   */
  documentRevision: string | null;
}

export interface SymbolGraphCatalogStats {
  symbolCount: number;
  fileCount: number;
  linkCount: number;
  /** Live TriviumDB node count across all node types, not just graph rows. */
  nodeCount: number;
  languages: string[];
  paths: string[];
}

export interface SymbolGraphImportersResult {
  path: string;
  resolved: Array<{ path: string; specifier: string }>;
}

export type SymbolGraphLinkKind = "import" | "connects" | "associates";

export interface SymbolGraphLinkInput {
  kind: SymbolGraphLinkKind;
  value: string;
  /** Inclusive, 1-based. */
  line: number;
  /** Required for connects/associates; omitted for import specifiers. */
  callee?: string;
}

export interface SymbolGraphFileRelations {
  path: string;
  documentRevision: string | null;
  generation: string | null;
  /**
   * Version of the extractor (queries, call classification, outline flatten)
   * that produced this generation, or null for rows written before it was
   * recorded. The catalog is a function of the file *and* the extractor, so a
   * scan re-collects a file whose revision is current but whose extractor is
   * not (D-143). This is a cache key, not a schema version: nothing reads or
   * converts the old rows, they are recomputed from source.
   */
  extractor: number | null;
  /**
   * Link extraction was blocked when this generation was written, so the edge
   * set is a floor. Distinct from a file that genuinely has no edges.
   */
  linksIncomplete: boolean;
  imports: Array<{ specifier: string; line: number; documentRevision: string | null }>;
  connections: Array<{ callee: string; literal: string; line: number; documentRevision: string | null }>;
  associations: Array<{ callee: string; literal: string; line: number; documentRevision: string | null }>;
  /** Language-service-resolved reference sites inside this file (D-240). */
  references: SymbolGraphRelationRecord[];
  /** Language-service-resolved call sites inside this file (D-240). */
  calls: SymbolGraphRelationRecord[];
  /**
   * Outgoing file edges whose target payload is gone. Used to assert that a
   * re-collect participates in the same generation lifecycle.
   */
  danglingEdges: number;
}

export interface SymbolGraphLinkSearchResult {
  path: string;
  kind: SymbolGraphLinkKind;
  value: string;
  line: number;
  callee?: string;
  documentRevision: string | null;
}

/**
 * Language-service-resolved relation kinds (D-240). `references` is "this site
 * refers to the queried symbol"; `calls` is "this call site resolves to callee
 * C" (callHierarchy). Neither is a same-name, import, or string match — the
 * language server resolved them. They share the file→link row model and the
 * site file's generation lifecycle.
 */
export type SymbolGraphRelationKind = "references" | "calls";

/** Which resolution produced the row. */
export type SymbolGraphRelationSource =
  | "lsp.references"
  | "lsp.definition"
  | "lsp.callHierarchy.incoming"
  | "lsp.callHierarchy.outgoing";

export interface SymbolGraphRelationInput {
  kind: SymbolGraphRelationKind;
  /**
   * Symbol name written at the site: the referenced name for `references`,
   * the callee name for `calls`.
   */
  value: string;
  /** 1-based site line in `path`. */
  line: number;
  /** 1-based site column when the resolver reported one. */
  character?: number;
  /** Enclosing symbol at the site (the caller), when known. */
  caller?: string;
  /** Resolved other end: definition/callee file and symbol. */
  targetPath?: string;
  targetName?: string;
  targetKind?: string;
  targetLine?: number;
  /** Queried position that produced this row (provenance). */
  anchorPath?: string;
  anchorLine?: number;
  resolvedBy: SymbolGraphRelationSource;
  /**
   * Revision of the site file bound at resolve time, or null when the language
   * server read the file itself — the site position is then unpinned (D-087).
   */
  siteRevision?: string | null;
}

export interface SymbolGraphRelationRecord {
  kind: SymbolGraphRelationKind;
  path: string;
  value: string;
  line: number;
  character?: number;
  caller?: string;
  targetPath?: string;
  targetName?: string;
  targetKind?: string;
  targetLine?: number;
  anchorPath?: string;
  anchorLine?: number;
  resolvedBy: SymbolGraphRelationSource;
  /** true when the site position was bound to `documentRevision` at resolve time. */
  pinned: boolean;
  documentRevision: string | null;
  /** Catalog revision of `targetPath` observed when the row was written. */
  targetObservedRevision: string | null;
  /** The target file's catalog revision moved after this row was written. */
  staleTarget: boolean;
}

// ── Store interface ────────────────────────────────────────────────

export interface PutEventResult {
  id: NodeId;
  inserted: boolean;
}

/**
 * Terminal command observations are projected once per Pi session. JSON
 * encoding keeps session/command boundaries unambiguous when either contains
 * punctuation used by a human-readable key.
 */
export const terminalCommandDedupeKey = (sessionId: string, commandId: string): string => (
  `terminal-command:${JSON.stringify([sessionId, commandId])}`
);

export interface KnowledgeStore {
  readonly dim: number;
  /** O(1) in-process revision for accepted/suggested knowledge mutations. */
  knowledgeRevision(): string;
  putEvent(e: EventInput): Promise<PutEventResult>;
  listEvents(filter: { sessionId: string; afterId?: NodeId; minTurnIndex?: number }): Promise<StoredEvent[]>;
  /** Distinct session ids that have written events into this store. */
  listEventSessionIds(): Promise<string[]>;
  /** Read one organizer coverage row, or null when the source is untouched. */
  getOrganizerProgress(key: string): Promise<OrganizerProgress | null>;
  /** Upsert one organizer coverage row by key. */
  putOrganizerProgress(progress: OrganizerProgress): Promise<void>;
  /** All organizer coverage rows in this store (reconcile/status surface). */
  listOrganizerProgress(): Promise<OrganizerProgress[]>;
  putSession(s: SessionInput): Promise<NodeId>;
  /**
   * Read blocks for a session. If `branchEntryIds` is provided, only blocks
   * whose `sourceLeafId` is in that array (or null/undefined for legacy
   * blocks) are returned — this is the ancestor-resolution view. If omitted,
   * all blocks for the session are returned (legacy/debug behavior).
   */
  getBlocks(sessionId: string, branchEntryIds?: readonly string[]): Promise<Block[]>;
  upsertBlock(b: BlockInput): Promise<Block>;
  /**
   * Delete a block. A branch-scoped delete writes a tombstone at the active
   * leaf so sibling branches retain their inherited revision. If
   * `expectedUpdatedAt` is provided, deletion is conditional on the visible
   * block revision matching.
   */
  deleteBlock(
    sessionId: string,
    label: string,
    options?: {
      branchEntryIds?: readonly string[];
      expectedUpdatedAt?: number | null;
      sourceLeafId?: string | null;
      updatedBy?: BlockUpdatedBy;
      cursorTurn?: number;
    },
  ): Promise<void>;
  putKnowledge(k: KnowledgeInput): Promise<NodeId>;
  /**
   * Atomically create one knowledge row unless the same normalized content
   * already exists in this scope, including dismissed and retired history.
   */
  createKnowledgeIfAbsent(k: KnowledgeInput, options?: { expectedRevision?: string; explicit?: boolean }): Promise<KnowledgeCreateIfAbsentResult>;
  updateSuggestedKnowledge(
    id: NodeId,
    patch: { content: string; trigger: string },
    expectedScope?: KnowledgeScope,
    expected?: KnowledgeExpectedRevision,
  ): Promise<void>;
  updateAcceptedKnowledge(
    id: NodeId,
    patch: { content: string; trigger: string },
    expectedScope?: KnowledgeScope,
    expected?: KnowledgeExpectedRevision,
  ): Promise<void>;
  /**
   * Atomic correction (BC1): insert a new accepted row carrying `input` and
   * retire `id` behind a `supersedes` edge in the same writer transaction.
   * The predecessor keeps its provenance; derived recall drops it through
   * `invalidAt` immediately.
   */
  supersedeKnowledge(
    id: NodeId,
    input: KnowledgeInput,
    expectedScope?: KnowledgeScope,
    expected?: KnowledgeExpectedRevision,
  ): Promise<{ id: NodeId; previous: Knowledge }>;
  /**
   * Hide one knowledge row from current-effective queries by setting `invalidAt`.
   * Does not delete the node, other scopes, or supersede neighbors (D-208).
   */
  retireKnowledge(
    id: NodeId,
    expectedScope?: KnowledgeScope,
    expected?: KnowledgeExpectedRevision,
  ): Promise<void>;
  getKnowledge(id: NodeId): Promise<Knowledge | null>;
  listKnowledge(filter: { scope?: KnowledgeScope; status?: KnowledgeStatus; activeOnly?: boolean }): Promise<Knowledge[]>;
  getSupersedeChain(id: NodeId, expectedScope?: KnowledgeScope): Promise<KnowledgeSupersedeChain | null>;
  acceptKnowledge(id: NodeId, opts: {
    supersedes?: NodeId[] | undefined;
    expectedScope?: KnowledgeScope;
    expected?: KnowledgeExpectedRevision;
    edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string; expectedStatus?: KnowledgeStatus; expectedInvalidAt?: number | null };
  }): Promise<void>;
  dismissKnowledge(id: NodeId, expectedScope?: KnowledgeScope, expected?: KnowledgeExpectedRevision): Promise<void>;
  recordRecall(ids: NodeId[]): Promise<void>;
  recall(query: string, k: number): Promise<RecallResult[]>;
  touchFile(path: string, language: string): Promise<NodeId>;
  /**
   * Replace one file's symbols. `documentRevision` is the disk revision the
   * ranges were computed from; the graph records committed facts, so a range
   * derived from an editor buffer is never stored (D-087).
   */
  replaceFileSymbols(
    path: string,
    language: string,
    symbols: SymbolGraphSymbolInput[],
    documentRevision: string,
    links?: readonly SymbolGraphLinkInput[],
    options?: {
      linksIncomplete?: boolean;
      extractor?: number;
      /** Compact association calls held until a confirmed connect exists. */
      associationCandidates?: readonly SymbolGraphLinkInput[];
    },
  ): Promise<{ fileId: NodeId; symbols: number; edges: number }>;
  /**
   * Reconcile generation-bound association candidates with current connections.
   * This creates or removes link rows without re-publishing the file's symbols.
   */
  resolveAssociationCandidates(): Promise<{ activated: number }>;
  removeFileSymbols(
    path: string,
    options?: {
      expectedDocumentRevision?: string | null;
      expectedGeneration?: string | null;
      signal?: AbortSignal;
    },
  ): Promise<{ removedFiles: number; removedSymbols: number }>;
  /**
   * Persist language-service-resolved reference/call rows onto the site file's
   * current generation (D-240). Rows carry the bound site revision when the
   * collector synced the file itself, else null — unpinned positions. A row's
   * relation key (kind, value, target, anchor) is replace-on-write, so a
   * re-resolution of the same relation supersedes its earlier sites.
   */
  recordResolvedRelations(
    path: string,
    language: string,
    relations: readonly SymbolGraphRelationInput[],
  ): Promise<{ recorded: number }>;
  /**
   * Authoritative reparse for one anchor (D-240 rework). Deletes every
   * existing relation row resolved from `(anchorPath, anchorLine)` across all
   * files, then inserts the new rows. A site that disappeared between the
   * previous and current resolution is removed — the result shrinks from two
   * sites to one or to empty. The batch identity is the anchor, not individual
   * non-empty path writes.
   */
  replaceResolvedRelationsForAnchor(
    anchor: { path: string; line: number },
    rows: ReadonlyArray<{ path: string; language: string; relations: readonly SymbolGraphRelationInput[] }>,
    kinds?: readonly SymbolGraphRelationKind[],
  ): Promise<{ recorded: number; removed: number }>;
  searchSymbols(query: string, k: number, roots?: readonly string[]): Promise<SymbolGraphSearchResult[]>;
  getDefinedSymbols(path: string): Promise<Array<Omit<SymbolGraphSearchResult, "score" | "match">>>;
  getFileRelations(path: string): Promise<SymbolGraphFileRelations | null>;
  findLinks(value: string): Promise<SymbolGraphLinkSearchResult[]>;
  /**
   * Resolved reference sites for a symbol name — rows where `value` (the name
   * at the site) or `targetName` (the resolved name) match. `roots` scopes the
   * site paths before the result is returned (D-240).
   */
  findReferences(name: string, roots?: readonly string[]): Promise<SymbolGraphRelationRecord[]>;
  /** Resolved call sites whose callee is `name` — "who calls name". */
  findCallers(name: string, roots?: readonly string[]): Promise<SymbolGraphRelationRecord[]>;
  /** Resolved call sites whose enclosing caller is `caller` — "what caller calls". */
  findCalls(caller: string, roots?: readonly string[]): Promise<SymbolGraphRelationRecord[]>;
  catalogStats(): Promise<SymbolGraphCatalogStats>;
  findImporters(path: string): Promise<SymbolGraphImportersResult>;
  /**
   * Values that are a confirmed connection literal somewhere in the graph.
   * Gates association candidates: plan 3.11 marks a *same-name* string as a
   * candidate, not every string-literal call (D-109).
   */
  connectionLiterals(values: readonly string[]): Promise<Set<string>>;
  deleteSession(sessionId: string): Promise<void>;
  runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }>;
  close(): Promise<void>;
}

export interface OpenWorkspaceKnowledgeDeps {
  dataDir: string;
  hostId: string;
  /**
   * Storage shard key. Workspace/user stores keep their existing key; HR0
   * session-owned stores use `session-*` keys derived from the session scope.
   */
  workspaceId: string;
  /** Owner scope classification for records written into this store. */
  scope?: KnowledgeScope;
  embedding: EmbeddingProvider | null;
  onBlocksChanged?: (sessionId: string, change: BlockChange) => void;
  onKnowledgeChanged?: (ids: readonly NodeId[]) => void;
  onPersistenceError?: (error: unknown) => void;
}

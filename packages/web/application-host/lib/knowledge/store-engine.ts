/**
 * Knowledge store v1 — TriviumDB-backed workspace knowledge base.
 *
 * Design: design/harness-knowledge.md §7.1, §7.2, §7.2.1
 * Plan: plan/agent-harness-plan.md §2.1
 *
 * Node types: event, session, block, knowledge, organizer, file, symbol, link.
 * Edges: supersedes (knowledge → knowledge), defines (file → symbol),
 * imports / connects / associates (file → link). Additive link kinds share the
 * file generation; gated association candidates are compact metadata on the
 * current file row until a connects row confirms their literal. There is no
 * schema version or migration runner (D-105).
 * `associates` is gated on the literal already being a confirmed connection
 * value elsewhere, so `connectionLiterals` must track the connects set (D-109).
 *
 * Authority .tdb stays on placeholder dim=8 all-zero vectors. Knowledge
 * semantic recall lives in a derived generation store (D-196), not here.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { normalizeGraphPath, resolveImportSpecifier } from "./import-resolve.js";
import { pathInRoots } from "../workspace/path-scope.js";

// triviumdb is a CJS package — use createRequire to avoid ESM named-import
// issues when running under pure Node (outside vite-node/vitest).
const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");
type Vector = import("triviumdb").Vector;
type TransactionOperation = import("triviumdb").TransactionOperation;

import { mergeSourceSpans, overlappingSource, parseSourceSpans } from "../memory/memory-sources.js";
import {
  type EmbeddingProvider,
  type NodeId,
  type EventKind,
  type EventSource,
  type EventRefs,
  type EventInput,
  type StoredEvent,
  type SessionInput,
  type BlockUpdatedBy,
  type Block,
  type BlockInput,
  type BlockChange,
  KnowledgeBlockConflictError,
  type KnowledgeScope,
  type KnowledgeStatus,
  type KnowledgeExpectedRevision,
  type KnowledgeInput,
  type Knowledge,
  type KnowledgeSource,
  type MemoryNature,
  MEMORY_NATURES,
  type KnowledgeSupersedeChain,
  type KnowledgeCreateIfAbsentResult,
  KnowledgeMutationError,
  type OrganizerProgress,
  type OrganizerProgressStatus,
  type OrganizerPreparedProposal,
  type RecallResult,
  type SymbolGraphRange,
  type SymbolMatchTier,
  type SymbolGraphSearchResult,
  type SymbolGraphLinkKind,
  type SymbolGraphFileRelations,
  type SymbolGraphRelationKind,
  type SymbolGraphRelationSource,
  type SymbolGraphRelationInput,
  type SymbolGraphRelationRecord,
  type PutEventResult,
  terminalCommandDedupeKey,
  type KnowledgeStore,
  type OpenWorkspaceKnowledgeDeps,
} from "./store-contract.js";
import { createStorePersistence, trackStoreMutations } from "./persistence.js";

export interface KnowledgeStoreEngine extends KnowledgeStore {
  runBatch<T>(operation: () => Promise<T>): Promise<T>;
}
export type KnowledgeStoreEngineOptions = Omit<OpenWorkspaceKnowledgeDeps, "embedding"> & {
  embedding: Pick<EmbeddingProvider, "dim"> | null;
};

// ── Implementation ─────────────────────────────────────────────────

const PLACEHOLDER_DIM = 8;
/** `substringLookup` rejects shorter needles (TriviumDB 0.8.6 n-gram index). */
const NGRAM_MIN_CHARS = 3;
/**
 * `maxResults` on `indexedLookup` / `substringLookup` is a fail-closed row
 * budget, not a LIMIT: exceeding it throws `TDB_QUERY_BUDGET`, and the default
 * is 10,000 — below one repository's symbol count. The graph's whole-type reads
 * (counters, file shape, import resolution) and substring candidates need to
 * see everything, so they raise the ceiling to the API's maximum (1,000,000).
 * It still throws rather than truncating, which is the honest failure for
 * derived data (D-141).
 */
const GRAPH_RESULT_CEILING = 1_000_000;
/** Quiet period before a derived graph write is persisted (D-140). */
const GRAPH_FLUSH_QUIET_MS = 250;
/** Upper bound on deferral, so a long catalog scan still persists as it goes. */
const GRAPH_FLUSH_MAX_DEFER_MS = 30_000;
const BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_RETENTION_BATCH = 5000;

const commandIdFromPayload = (payload: Record<string, unknown>): string | undefined => {
  const data = payload["data"];
  if (!data || typeof data !== "object") return undefined;
  const commandId = (data as Record<string, unknown>)["commandId"];
  return typeof commandId === "string" && commandId.length > 0 ? commandId : undefined;
};

function zeroVector(dim: number): Vector {
  return new Array(dim).fill(0);
}

function scoreSymbolMatch(
  nameLower: string,
  pathLower: string,
  terms: readonly string[],
): { score: number; match: SymbolMatchTier } | null {
  const normalizedName = nameLower;
  const haystack = `${nameLower} ${pathLower}`;
  let score = 0;
  let match: SymbolMatchTier | undefined;
  for (const term of terms) {
    if (normalizedName === term) {
      score += 4;
      match = "exact";
    } else if (normalizedName.includes(term)) {
      score += 2;
      if (match !== "exact") match = "name-contains";
    } else if (haystack.includes(term)) {
      score += 1;
      if (!match) match = "path-contains";
    }
  }
  return score > 0 && match ? { score, match } : null;
}

export async function openKnowledgeStoreEngine(deps: KnowledgeStoreEngineOptions): Promise<KnowledgeStoreEngine> {
  const { dataDir, workspaceId, embedding } = deps;

  // Ensure directory exists
  const dbDir = join(dataDir, "knowledge", deps.hostId);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, `${workspaceId}.tdb`);

  const recallScope: KnowledgeScope = deps.scope ?? (workspaceId === "user" ? "user" : "workspace");
  const dim = embedding?.dim ?? PLACEHOLDER_DIM;
  const nativeDb = new TriviumDB(dbPath, {
    dim,
    syncMode: "normal",
    loadTextIndex: true,
    // TriviumDB 0.8.7 fixed the parsed-cache O(N) recency bug. Keep the
    // explicit zero-cache policy for large, mixed catalogs: it avoids keeping
    // parsed payloads resident and remains faster for cold full-catalog reads.
    // Revisit with representative repeated-read measurements, not the old bug.
    payloadCacheMb: 0,
  });
  let writeTail: Promise<unknown> = Promise.resolve();
  function enqueueWrite<T>(fn: () => T): Promise<T> {
    const result = writeTail.then(fn, fn);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
  const persistence = createStorePersistence({
    flush: () => nativeDb.flush(),
    close: () => nativeDb.close(),
    enqueue: enqueueWrite,
    quietMs: GRAPH_FLUSH_QUIET_MS,
    maxDeferMs: GRAPH_FLUSH_MAX_DEFER_MS,
    onError: (error) => {
      if (deps.onPersistenceError) deps.onPersistenceError(error);
      else console.error("[KnowledgeStore] Deferred checkpoint failed");
    },
  });
  const db = trackStoreMutations(nativeDb, persistence);
  try {
    const knowledgeInstanceId = randomUUID();
    let knowledgeEpoch = 0;
    let knowledgeMutationEpoch = 0;
    const bumpKnowledgeEpoch = (): void => {
      knowledgeMutationEpoch += 1;
      persistence.afterCommit(() => { knowledgeEpoch += 1; });
    };
    const knowledgeRevision = (): string => `${knowledgeInstanceId}:${knowledgeEpoch}`;

    // Property indexes. All are persistent and idempotent to create, and
    // creating one over existing rows backfills it, so an older database picks
    // these up on its first open after an upgrade (D-141).
    db.createIndex("type");
    db.createIndex("sessionId");
    db.createOrderedIndex("at");
    db.createIndex("status");
    db.createIndex("scope");
    db.createIndex("path");
    db.createIndex("active");
    db.createIndex("dedupeKey");
    db.createIndex("kind");
    // Command events written before durable dedupe keys existed have enough
    // information to be backfilled. Scan the indexed command-event subset when
    // opening a store so the normal command path can use the persistent index
    // rather than scanning the workspace for every observation. If an old row
    // lacks a commandId there is no honest identity to invent, so it remains a
    // legacy non-deduped row.
    let migratedCommandDedupeKeys = false;
    for (const id of db.indexedLookup({ type: "event", kind: "command" }, Math.max(1, db.nodeCount()))) {
      const payload = db.getPayload(id) as Record<string, unknown> | null;
      if (
        !payload
        || payload["type"] !== "event"
        || payload["kind"] !== "command"
        || (typeof payload["dedupeKey"] === "string" && payload["dedupeKey"].length > 0)
        || typeof payload["sessionId"] !== "string"
      ) continue;
      const commandId = commandIdFromPayload(payload);
      if (!commandId) continue;
      db.patchPayload(id, {
        $set: { dedupeKey: terminalCommandDedupeKey(payload["sessionId"] as string, commandId) },
      });
      migratedCommandDedupeKeys = true;
    }
    if (migratedCommandDedupeKeys) persistence.commit();
    // Symbol graph: equality lookups that used to be JS-side maps rebuilt on
    // every open (D-134 / D-139), and substring search over lowercased names and
    // paths. `substringLookup` needs three characters, so exact matches on short
    // names go through the hash index on `nameLower` instead.
    db.createIndex("value");
    db.createIndex("nameLower");
    db.createNgramIndex("nameLower");
    // Resolved-relation lookups: targetPath for delete/rename invalidation of
    // incoming edges, targetName and caller for the recall queries (D-240).
    db.createIndex("targetPath");
    db.createIndex("targetName");
    db.createIndex("caller");
    db.createNgramIndex("pathLower");
    db.createIndex("hasAssociationCandidates");

    const placeholderVec = zeroVector(dim);
    const publishBlocksChanged = (sessionId: string, change: BlockChange): void => {
      try {
        persistence.afterCommit(() => deps.onBlocksChanged?.(sessionId, change));
      } catch {
        // UI projection is observational and cannot turn a committed block write
        // into a reported storage failure.
      }
    };

    // Session data and knowledge share this database with the much larger derived
    // symbol catalog. Select through persistent indexes BEFORE reading payloads:
    // even an empty session otherwise walks the entire catalog on the Host thread.
    // The query budget fails closed; it must never silently truncate session data.
    type StoredNode = { id: number; payload: Record<string, unknown> };
    const lookup = (equalities: Record<string, unknown>): StoredNode[] => (
      db.indexedLookup(equalities, GRAPH_RESULT_CEILING).flatMap((id) => {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        return payload ? [{ id, payload }] : [];
      })
    );

    const knowledgeSourceFromPayload = (value: unknown): KnowledgeSource | undefined => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const source = value as Record<string, unknown>;
      if (typeof source["kind"] !== "string" || !source["kind"]) return undefined;
      const pick = (key: string) => typeof source[key] === "string" && source[key] ? source[key] as string : undefined;
      return {
        kind: source["kind"] as string,
        ...(pick("key") ? { key: pick("key")! } : {}),
        ...(pick("proposalKey") ? { proposalKey: pick("proposalKey")! } : {}),
        ...(pick("sessionId") ? { sessionId: pick("sessionId")! } : {}),
        ...(pick("threadId") ? { threadId: pick("threadId")! } : {}),
        ...(pick("runId") ? { runId: pick("runId")! } : {}),
        ...(pick("entryId") ? { entryId: pick("entryId")! } : {}),
        ...(Array.isArray(source["spans"]) ? { spans: parseSourceSpans(source["spans"]) } : {}),
      };
    };
    const knowledgeFromPayload = (id: NodeId, p: Record<string, unknown>): Knowledge | null => {
      if (p["type"] !== "knowledge") return null;
      const invalidAt = p["invalidAt"] as number | undefined;
      const nature = p["nature"];
      const source = p["source"] !== undefined ? knowledgeSourceFromPayload(p["source"]) : undefined;
      const supplements = db.getEdges(id).find((edge) => edge.label === "supplements")?.targetId;
      return {
        id,
        scope: p["scope"] as KnowledgeScope,
        status: p["status"] as KnowledgeStatus,
        content: p["content"] as string,
        trigger: p["trigger"] as string,
        ...(typeof nature === "string" && (MEMORY_NATURES as readonly string[]).includes(nature)
          ? { nature: nature as MemoryNature } : {}),
        ...(source ? { source } : {}),
        ...(supplements !== undefined ? { supplements } : {}),
        createdAt: p["createdAt"] as number,
        ...(invalidAt !== undefined ? { invalidAt } : {}),
        recallCount: (p["recallCount"] as number) ?? 0,
        ...(p["recalledAt"] !== undefined ? { recalledAt: p["recalledAt"] as number } : {}),
      };
    };
    const knowledgeInsertPayload = (k: KnowledgeInput, now: number): Record<string, unknown> => ({
      type: "knowledge",
      scope: k.scope,
      status: k.status,
      content: k.content,
      trigger: k.trigger,
      ...(k.nature ? { nature: k.nature } : {}),
      ...(k.source ? { source: k.source } : {}),
      createdAt: now,
      recallCount: 0,
    });
    /** Validate before inserting or retiring any row: a rejected edge must not
     * leave an uncommitted mutation in the live TDB handle. */
    const assertSupplementsTarget = (target: NodeId | undefined, scope: KnowledgeScope): void => {
      if (target === undefined) return;
      const targetPayload = db.getPayload(target) as Record<string, unknown> | null;
      if (!targetPayload || targetPayload["type"] !== "knowledge" || targetPayload["scope"] !== scope) {
        throw new KnowledgeMutationError("invalid", `Supplements target ${target} is not a knowledge row in scope ${scope}`);
      }
    };
    const linkSupplements = (id: NodeId, target: NodeId | undefined): void => {
      if (target !== undefined) db.link(id, target, "supplements", 1);
    };
    const notifyKnowledge = (ids: readonly NodeId[]): void => {
      if (ids.length === 0 || !deps.onKnowledgeChanged) return;
      persistence.afterCommit(() => deps.onKnowledgeChanged?.(ids));
    };
    const ORGANIZER_STATUSES: readonly string[] = [
      "pending", "processing", "prepared", "formed", "reviewed-empty", "failed",
    ];
    const organizerProposalFromPayload = (value: unknown): OrganizerPreparedProposal | null => {
      const p = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      const action = p["action"];
      const scope = p["scope"];
      const content = p["content"];
      if (action !== "new" && action !== "supplement" && action !== "correct") return null;
      if (scope !== "workspace" && scope !== "user" && scope !== "bot") return null;
      if (typeof content !== "string" || !content) return null;
      const nature = p["nature"];
      const trigger = p["trigger"];
      const target = p["target"];
      const expected = p["expectedTarget"] && typeof p["expectedTarget"] === "object" && !Array.isArray(p["expectedTarget"])
        ? p["expectedTarget"] as Record<string, unknown> : null;
      if (p["expectedTarget"] !== undefined && (!expected || typeof expected["content"] !== "string"
        || typeof expected["trigger"] !== "string"
        || (expected["status"] !== "accepted" && expected["status"] !== "suggested" && expected["status"] !== "dismissed")
        || (expected["invalidAt"] !== null && typeof expected["invalidAt"] !== "number"))) return null;
      return {
        action,
        scope,
        ...(typeof nature === "string" && nature ? { nature } : {}),
        content,
        ...(Array.isArray(p["spans"]) ? { spans: parseSourceSpans(p["spans"]) } : {}),
        ...(typeof trigger === "string" && trigger ? { trigger } : {}),
        ...(Number.isSafeInteger(target) ? { target: target as number } : {}),
        ...(expected ? { expectedTarget: {
          content: expected["content"] as string,
          trigger: expected["trigger"] as string,
          status: expected["status"] as KnowledgeStatus,
          invalidAt: expected["invalidAt"] as number | null,
        } } : {}),
      };
    };
    const organizerEventPartial = (value: unknown, key: string): { id: number; offset: number } | undefined => {
      if (value === undefined) return undefined;
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      if (!row || !Number.isSafeInteger(row["id"]) || !Number.isSafeInteger(row["offset"])
        || (row["offset"] as number) <= 0) {
        throw new KnowledgeMutationError("invalid", `Invalid event segment in organizer row ${key}`);
      }
      return { id: row["id"] as number, offset: row["offset"] as number };
    };
    const organizerEntryPartial = (value: unknown, key: string): { id: string; offset: number } | undefined => {
      if (value === undefined) return undefined;
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      if (!row || typeof row["id"] !== "string" || !row["id"]
        || !Number.isSafeInteger(row["offset"]) || (row["offset"] as number) <= 0) {
        throw new KnowledgeMutationError("invalid", `Invalid entry segment in organizer row ${key}`);
      }
      return { id: row["id"], offset: row["offset"] as number };
    };
    const organizerProgressFromPayload = (p: Record<string, unknown>): OrganizerProgress | null => {
      if (p["type"] !== "organizer" || typeof p["key"] !== "string" || !p["key"]) return null;
      const status = p["status"];
      if (typeof status !== "string" || !ORGANIZER_STATUSES.includes(status)) return null;
      if (typeof p["updatedAt"] !== "number") return null;
      const produced = p["produced"];
      const proposals = p["proposals"];
      if (status === "prepared" && !Array.isArray(proposals)) {
        throw new KnowledgeMutationError("invalid", `Prepared organizer row ${p["key"]} has no proposals`);
      }
      const parsedProposals = Array.isArray(proposals) ? proposals.map(organizerProposalFromPayload) : undefined;
      if (parsedProposals?.some((row) => row === null)) {
        throw new KnowledgeMutationError("invalid", `Prepared organizer row ${p["key"]} has an invalid proposal`);
      }
      const preparedRange = p["preparedRange"] && typeof p["preparedRange"] === "object" && !Array.isArray(p["preparedRange"])
        ? p["preparedRange"] as Record<string, unknown> : null;
      const preparedSource = p["preparedSource"] !== undefined
        ? knowledgeSourceFromPayload(p["preparedSource"]) : undefined;
      if (p["preparedSource"] !== undefined && !preparedSource) {
        throw new KnowledgeMutationError("invalid", `Prepared organizer row ${p["key"]} has invalid source identity`);
      }
      const eventPartial = organizerEventPartial(p["eventPartial"], p["key"]);
      const entryPartial = organizerEntryPartial(p["entryPartial"], p["key"]);
      const preparedEventPartial = preparedRange ? organizerEventPartial(preparedRange["eventPartial"], p["key"]) : undefined;
      const preparedEntryPartial = preparedRange ? organizerEntryPartial(preparedRange["entryPartial"], p["key"]) : undefined;
      return {
        key: p["key"],
        status: status as OrganizerProgressStatus,
        ...(Array.isArray(p["coveredSources"]) ? { coveredSources: parseSourceSpans(p["coveredSources"]) } : {}),
        ...(typeof p["sourceKey"] === "string" && p["sourceKey"] ? { sourceKey: p["sourceKey"] as string } : {}),
        ...(Number.isSafeInteger(p["eventCursor"]) ? { eventCursor: p["eventCursor"] as number } : {}),
        ...(eventPartial ? { eventPartial } : {}),
        ...(typeof p["entryCursor"] === "string" && p["entryCursor"] ? { entryCursor: p["entryCursor"] as string } : {}),
        ...(entryPartial ? { entryPartial } : {}),
        ...(Number.isSafeInteger(p["runEndOffset"]) && (p["runEndOffset"] as number) >= 0
          ? { runEndOffset: p["runEndOffset"] as number } : {}),
        ...(Array.isArray(produced) && produced.every(Number.isSafeInteger) ? { produced: produced as number[] } : {}),
        ...(parsedProposals ? { proposals: parsedProposals as OrganizerPreparedProposal[] } : {}),
        ...(preparedSource ? { preparedSource } : {}),
        ...(preparedRange ? { preparedRange: {
          ...(Number.isSafeInteger(preparedRange["eventCursor"]) ? { eventCursor: preparedRange["eventCursor"] as number } : {}),
          ...(preparedEventPartial ? { eventPartial: preparedEventPartial } : {}),
          ...(typeof preparedRange["entryCursor"] === "string" ? { entryCursor: preparedRange["entryCursor"] as string } : {}),
          ...(preparedEntryPartial ? { entryPartial: preparedEntryPartial } : {}),
        } } : {}),
        updatedAt: p["updatedAt"],
        ...(typeof p["lastError"] === "string" && p["lastError"] ? { lastError: p["lastError"] as string } : {}),
      };
    };
    const normalizeKnowledgeContent = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
    const matchesExpectedRevision = (
      payload: Record<string, unknown>,
      expected: KnowledgeExpectedRevision,
    ): boolean => {
      if (payload["content"] !== expected.content || payload["trigger"] !== expected.trigger) return false;
      if (expected.status !== undefined && payload["status"] !== expected.status) return false;
      if (expected.invalidAt !== undefined) {
        const currentInvalid = typeof payload["invalidAt"] === "number" ? payload["invalidAt"] : null;
        if (currentInvalid !== expected.invalidAt) return false;
      }
      return true;
    };

    type StoredBlockNode = { id: number; payload: Record<string, unknown> };
    const blockFromPayload = (payload: Record<string, unknown>): Block => ({
      sessionId: payload["sessionId"] as string,
      label: payload["label"] as string,
      content: typeof payload["content"] === "string" ? payload["content"] : "",
      updatedBy: payload["updatedBy"] as BlockUpdatedBy,
      ...(payload["cursorTurn"] !== undefined ? { cursorTurn: payload["cursorTurn"] as number } : {}),
      updatedAt: payload["updatedAt"] as number,
      ...(payload["sourceLeafId"] !== undefined ? { sourceLeafId: payload["sourceLeafId"] as string | null } : {}),
    });
    const blockNodes = (sessionId: string, label?: string): StoredBlockNode[] => lookup({ type: "block", sessionId }).filter(({ payload }) => (
      payload["type"] === "block"
      && payload["sessionId"] === sessionId
      && (label === undefined || payload["label"] === label)
    ));
    const isDeletedBlock = (node: StoredBlockNode): boolean => node.payload["deleted"] === true;
    const sourceLeafOf = (node: StoredBlockNode): string | null => (
      typeof node.payload["sourceLeafId"] === "string" ? node.payload["sourceLeafId"] as string : null
    );
    const newestNode = (nodes: StoredBlockNode[]): StoredBlockNode | null => (
      nodes.toSorted((left, right) => (
        Number(right.payload["updatedAt"] ?? 0) - Number(left.payload["updatedAt"] ?? 0)
        || right.id - left.id
      ))[0] ?? null
    );
    /** Resolve one label to the closest revision on the active ancestor path. */
    const visibleBlockNode = (
      nodes: StoredBlockNode[],
      branchEntryIds: readonly string[],
    ): StoredBlockNode | null => {
      const rank = new Map(branchEntryIds.map((entryId, index) => [entryId, index]));
      let selected: StoredBlockNode | null = null;
      let selectedRank = Number.NEGATIVE_INFINITY;
      for (const node of nodes) {
        const sourceLeafId = sourceLeafOf(node);
        const nodeRank = sourceLeafId === null ? -1 : rank.get(sourceLeafId);
        if (nodeRank === undefined) continue;
        const updatedAt = Number(node.payload["updatedAt"] ?? 0);
        const selectedUpdatedAt = Number(selected?.payload["updatedAt"] ?? 0);
        if (
          selected === null
          || nodeRank > selectedRank
          || (nodeRank === selectedRank && (updatedAt > selectedUpdatedAt || (updatedAt === selectedUpdatedAt && node.id > selected.id)))
        ) {
          selected = node;
          selectedRank = nodeRank;
        }
      }
      return selected;
    };

    /**
     * Symbol graph reads go through TriviumDB's property indexes. Before 0.8.6 the
     * store kept eight JS-side maps (path → ids, links by value, connection literal
     * refcounts, denormalized symbol and link rows, file languages) that every
     * write had to keep consistent and every open rebuilt by walking all nodes
     * (D-109 / D-134 / D-139). `indexedLookup` and `substringLookup` answer the
     * same questions from persistent indexes, so what remains in memory is:
     *
     * - three lazily seeded counters, because counting rows through an index
     *   call still marshals every id (24K symbol ids ≈ 90 ms), and `explore`
     *   asks for the count once per query;
     * - one lazily rebuilt shape cache (file paths, languages, resolved reverse
     *   imports), because import resolution is Varin's rule, not the
     *   database's, and it depends on the whole path set (D-139).
     *
     * Both are dropped on any graph write and rebuilt on the next read (D-141).
     */
    const LINK_KINDS = new Set<SymbolGraphLinkKind>(["import", "connects", "associates"]);
    const RELATION_KINDS = new Set<SymbolGraphRelationKind>(["references", "calls"]);
    const RELATION_SOURCES = new Set<SymbolGraphRelationSource>([
      "lsp.references",
      "lsp.definition",
      "lsp.callHierarchy.incoming",
      "lsp.callHierarchy.outgoing",
    ]);
    const validLinkLine = (line: number): boolean => Number.isSafeInteger(line) && line >= 1;
    const validRange = (range: SymbolGraphRange): boolean => (
      [range.startLine, range.startCharacter, range.endLine, range.endCharacter]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      && (range.endLine > range.startLine || (range.endLine === range.startLine && range.endCharacter >= range.startCharacter))
    );

    const fileNodes = (path: string) => lookup({ type: "file", path });
    const symbolNodes = (path: string) => lookup({ type: "symbol", path });
    const linkNodes = (path: string) => lookup({ type: "link", path });

    interface GraphCounters { files: number; symbols: number; links: number }
    let graphCounters: GraphCounters | null = null;
    const counters = (): GraphCounters => {
      if (graphCounters) return graphCounters;
      graphCounters = {
        files: db.indexedLookup({ type: "file" }, GRAPH_RESULT_CEILING).length,
        symbols: db.indexedLookup({ type: "symbol", active: true }, GRAPH_RESULT_CEILING).length,
        links: db.indexedLookup({ type: "link", active: true }, GRAPH_RESULT_CEILING).length,
      };
      return graphCounters;
    };
    const bumpCounters = (delta: Partial<GraphCounters>): void => {
      if (!graphCounters) return;
      graphCounters = {
        files: graphCounters.files + (delta.files ?? 0),
        symbols: graphCounters.symbols + (delta.symbols ?? 0),
        links: graphCounters.links + (delta.links ?? 0),
      };
    };

    /**
     * Two lazy layers, dropped together on any graph write. The file layer is
     * cheap (one indexed lookup over file nodes) and is all `catalogStats` needs;
     * the importer layer resolves every import specifier against the path set and
     * is only paid when `findImporters` is actually asked.
     */
    interface FileShape { paths: Set<string>; sortedPaths: string[]; languages: string[] }
    type ImportersByTarget = Map<string, Array<{ path: string; specifier: string }>>;
    let fileShapeCache: FileShape | null = null;
    let importersCache: ImportersByTarget | null = null;
    const invalidateGraphShape = (): void => {
      fileShapeCache = null;
      importersCache = null;
    };
    const fileShape = (): FileShape => {
      if (fileShapeCache) return fileShapeCache;
      const paths = new Set<string>();
      const languages = new Set<string>();
      for (const { payload } of lookup({ type: "file" })) {
        if (typeof payload["path"] !== "string") continue;
        paths.add(payload["path"]);
        if (typeof payload["language"] === "string") languages.add(payload["language"]);
      }
      fileShapeCache = { paths, sortedPaths: [...paths].toSorted(), languages: [...languages].toSorted() };
      return fileShapeCache;
    };
    const importers = (): ImportersByTarget => {
      if (importersCache) return importersCache;
      // Resolution needs the whole path set: a file added later can make another
      // file's specifier resolve, which is why any write drops this (D-139).
      const known = fileShape().paths;
      const byTarget: ImportersByTarget = new Map();
      for (const { payload } of lookup({ type: "link", kind: "import", active: true })) {
        const importer = payload["path"];
        const specifier = payload["value"];
        if (typeof importer !== "string" || typeof specifier !== "string") continue;
        const result = resolveImportSpecifier(importer, specifier, known);
        if (result.status !== "resolved") continue;
        const bucket = byTarget.get(result.resolvedPath);
        if (bucket) bucket.push({ path: importer, specifier });
        else byTarget.set(result.resolvedPath, [{ path: importer, specifier }]);
      }
      importersCache = byTarget;
      return byTarget;
    };

    const edgeLabelForKind = (kind: SymbolGraphLinkKind | SymbolGraphRelationKind): "imports" | "connects" | "associates" | "references" | "calls" => (
      kind === "import" ? "imports" : kind
    );

    /**
     * Two rows describe the same resolved relation when their kind, site value,
     * and resolved other end agree — re-resolving that relation replaces its
     * earlier sites instead of stacking duplicates.
     */
    const relationKeyOf = (payload: Record<string, unknown>): string => (
      [
        String(payload["kind"] ?? ""),
        String(payload["value"] ?? ""),
        String(payload["targetPath"] ?? ""),
        String(payload["targetName"] ?? ""),
        String(payload["anchorPath"] ?? ""),
        String(payload["anchorLine"] ?? ""),
      ].join("\u0000")
    );

    const relationFromPayload = (
      payload: Record<string, unknown>,
      path: string,
      staleTargetPaths: Set<string>,
    ): SymbolGraphRelationRecord | null => {
      const kind = payload["kind"];
      const value = payload["value"];
      const line = Number(payload["line"]);
      if (
        payload["type"] !== "link"
        || payload["active"] !== true
        || !RELATION_KINDS.has(kind as SymbolGraphRelationKind)
        || typeof value !== "string"
        || !value
        || !validLinkLine(line)
        || !RELATION_SOURCES.has(payload["resolvedBy"] as SymbolGraphRelationSource)
      ) return null;
      const targetPath = typeof payload["targetPath"] === "string" ? payload["targetPath"] : undefined;
      const documentRevision = typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null;
      return {
        kind: kind as SymbolGraphRelationKind,
        path,
        value,
        line,
        ...(Number.isSafeInteger(Number(payload["character"])) && Number(payload["character"]) >= 1
          ? { character: Number(payload["character"]) }
          : {}),
        ...(typeof payload["caller"] === "string" ? { caller: payload["caller"] } : {}),
        ...(targetPath ? { targetPath } : {}),
        ...(typeof payload["targetName"] === "string" ? { targetName: payload["targetName"] } : {}),
        ...(typeof payload["targetKind"] === "string" ? { targetKind: payload["targetKind"] } : {}),
        ...(Number.isSafeInteger(Number(payload["targetLine"])) && Number(payload["targetLine"]) >= 1
          ? { targetLine: Number(payload["targetLine"]) }
          : {}),
        ...(typeof payload["anchorPath"] === "string" ? { anchorPath: payload["anchorPath"] } : {}),
        ...(Number.isSafeInteger(Number(payload["anchorLine"])) && Number(payload["anchorLine"]) >= 1
          ? { anchorLine: Number(payload["anchorLine"]) }
          : {}),
        resolvedBy: payload["resolvedBy"] as SymbolGraphRelationSource,
        pinned: documentRevision !== null,
        documentRevision,
        targetObservedRevision: typeof payload["targetObservedRevision"] === "string"
          ? payload["targetObservedRevision"] as string
          : null,
        staleTarget: targetPath !== undefined && staleTargetPaths.has(targetPath),
      };
    };

    /**
     * Whether the catalog's current revision of `targetPath` differs from the
     * revision recorded on the relation row — the row then reports `staleTarget`
     * rather than presenting a moved target as current (D-240).
     */
    const staleTargetPathsFor = (payloads: readonly Record<string, unknown>[]): Set<string> => {
      const targets = new Map<string, string | null>();
      for (const payload of payloads) {
        const targetPath = typeof payload["targetPath"] === "string" ? payload["targetPath"] : undefined;
        if (!targetPath || targets.has(targetPath)) continue;
        const observed = typeof payload["targetObservedRevision"] === "string"
          ? payload["targetObservedRevision"] as string
          : null;
        targets.set(targetPath, observed);
      }
      const stale = new Set<string>();
      for (const [targetPath, observed] of targets) {
        const current = fileNodes(targetPath)[0]?.payload;
        const currentRevision = typeof current?.["documentRevision"] === "string"
          ? current["documentRevision"] as string
          : null;
        if (currentRevision !== observed) stale.add(targetPath);
      }
      return stale;
    };
    const assertGraphText = (value: string, label: string): string => {
      const text = value.trim();
      if (!text) throw new KnowledgeMutationError("invalid", `${label} is required`);
      return text;
    };

    const scheduleGraphFlush = (): void => persistence.defer();

    const store: KnowledgeStore = {
      dim,
      knowledgeRevision,

      async putEvent(e: EventInput): Promise<PutEventResult> {
        return enqueueWrite(() => {
          const commandId = e.kind === "command" ? commandIdFromPayload({ data: e.data }) : undefined;
          const dedupeKey = e.kind === "command" && commandId
            ? terminalCommandDedupeKey(e.sessionId, commandId)
            : e.dedupeKey;
          if (dedupeKey) {
            const existingId = db.indexedLookup({ type: "event", kind: "command", dedupeKey }, 1)[0];
            if (existingId !== undefined) return { id: existingId, inserted: false };
          }
          const payload = {
            type: "event",
            kind: e.kind,
            at: e.at,
            sessionId: e.sessionId,
            ...(e.turnIndex !== undefined ? { turnIndex: e.turnIndex } : {}),
            text: e.text,
            ...(e.refs ? { refs: e.refs } : {}),
            ...(e.data ? { data: e.data } : {}),
            ...(dedupeKey ? { dedupeKey } : {}),
            source: e.source,
          };
          const id = db.insert(placeholderVec, payload);
          db.indexText(id, e.text);
          persistence.commit();
          return { id, inserted: true };
        });
      },

      async listEvents(filter): Promise<StoredEvent[]> {
        const nodes = lookup({ type: "event", sessionId: filter.sessionId }).filter(({ payload }) => {
          if (payload["type"] !== "event" || payload["sessionId"] !== filter.sessionId) return false;
          const turnIndex = payload["turnIndex"];
          return filter.minTurnIndex === undefined
            || (typeof turnIndex === "number" && turnIndex >= filter.minTurnIndex);
        }).filter(({ id }) => filter.afterId === undefined || id > filter.afterId);
        return nodes.map(({ id, payload }) => ({
          id,
          kind: payload["kind"] as EventKind,
          at: payload["at"] as number,
          sessionId: payload["sessionId"] as string,
          ...(typeof payload["turnIndex"] === "number" ? { turnIndex: payload["turnIndex"] as number } : {}),
          text: payload["text"] as string,
          ...(payload["refs"] && typeof payload["refs"] === "object" ? { refs: payload["refs"] as EventRefs } : {}),
          ...(payload["data"] && typeof payload["data"] === "object" ? { data: payload["data"] as Record<string, unknown> } : {}),
          ...(typeof payload["dedupeKey"] === "string" ? { dedupeKey: payload["dedupeKey"] as string } : {}),
          source: payload["source"] as EventSource,
        })).sort((left, right) => left.id - right.id);
      },

      async listEventSessionIds(): Promise<string[]> {
        const ids = new Set<string>();
        for (const { payload } of lookup({ type: "event" })) {
          if (payload["type"] !== "event") continue;
          const sessionId = payload["sessionId"];
          if (typeof sessionId === "string" && sessionId) ids.add(sessionId);
        }
        return [...ids].sort();
      },

      async getOrganizerProgress(key: string): Promise<OrganizerProgress | null> {
        for (const { payload } of lookup({ type: "organizer" })) {
          if (payload["key"] !== key) continue;
          return organizerProgressFromPayload(payload);
        }
        return null;
      },

      async putOrganizerProgress(progress: OrganizerProgress): Promise<void> {
        return enqueueWrite(() => {
          const payload: Record<string, unknown> = {
            type: "organizer",
            key: progress.key,
            status: progress.status,
            ...(progress.coveredSources ? { coveredSources: progress.coveredSources } : {}),
            ...(progress.sourceKey !== undefined ? { sourceKey: progress.sourceKey } : {}),
            ...(progress.eventCursor !== undefined ? { eventCursor: progress.eventCursor } : {}),
            ...(progress.eventPartial !== undefined ? { eventPartial: { ...progress.eventPartial } } : {}),
            ...(progress.entryCursor !== undefined ? { entryCursor: progress.entryCursor } : {}),
            ...(progress.entryPartial !== undefined ? { entryPartial: { ...progress.entryPartial } } : {}),
            ...(progress.runEndOffset !== undefined ? { runEndOffset: progress.runEndOffset } : {}),
            ...(progress.produced !== undefined ? { produced: [...progress.produced] } : {}),
            ...(progress.proposals !== undefined ? { proposals: progress.proposals.map((p) => ({ ...p })) } : {}),
            ...(progress.preparedSource !== undefined ? { preparedSource: { ...progress.preparedSource } } : {}),
            ...(progress.preparedRange !== undefined ? { preparedRange: { ...progress.preparedRange } } : {}),
            updatedAt: progress.updatedAt,
            ...(progress.lastError ? { lastError: progress.lastError } : {}),
          };
          // Fields this row no longer carries must actually disappear — a
          // stale lastError or cursor would misreport the committed coverage.
          const unset: Record<string, boolean> = {};
          if (progress.sourceKey === undefined) unset.sourceKey = true;
          if (progress.coveredSources === undefined) unset.coveredSources = true;
          if (progress.eventCursor === undefined) unset.eventCursor = true;
          if (progress.eventPartial === undefined) unset.eventPartial = true;
          if (progress.entryCursor === undefined) unset.entryCursor = true;
          if (progress.entryPartial === undefined) unset.entryPartial = true;
          if (progress.runEndOffset === undefined) unset.runEndOffset = true;
          if (progress.produced === undefined) unset.produced = true;
          if (progress.proposals === undefined) unset.proposals = true;
          if (progress.preparedSource === undefined) unset.preparedSource = true;
          if (progress.preparedRange === undefined) unset.preparedRange = true;
          if (!progress.lastError) unset.lastError = true;
          const existing = lookup({ type: "organizer" }).filter(({ payload: p }) => p["key"] === progress.key);
          const [first, ...rest] = existing;
          if (first) {
            db.patchPayload(first.id, { $set: payload, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) });
            for (const duplicate of rest) db.delete(duplicate.id);
          } else {
            db.insert(placeholderVec, payload);
          }
          persistence.commit();
        });
      },

      async listOrganizerProgress(): Promise<OrganizerProgress[]> {
        return lookup({ type: "organizer" })
          .map(({ payload }) => organizerProgressFromPayload(payload))
          .filter((row): row is OrganizerProgress => row !== null)
          .sort((a, b) => a.key.localeCompare(b.key));
      },

      async putSession(s: SessionInput): Promise<NodeId> {
        return enqueueWrite(() => {
          const payload = {
            type: "session",
            sessionId: s.sessionId,
            profile: s.profile,
            workspaceId: s.workspaceId,
            startedAt: s.startedAt,
            harness: s.harness,
          };
          const id = db.insert(placeholderVec, payload);
          persistence.commit();
          return id;
        });
      },

      async getBlocks(sessionId: string, branchEntryIds?: readonly string[]): Promise<Block[]> {
        const nodes = blockNodes(sessionId);
        if (branchEntryIds === undefined) {
          // This unscoped view is retained only for migration/debug callers.
          // Production model/UI consumers resolve an explicit active branch.
          return nodes
            .filter((node) => !isDeletedBlock(node))
            .map((node) => blockFromPayload(node.payload))
            .sort((a, b) => a.label.localeCompare(b.label) || a.updatedAt - b.updatedAt);
        }
        const byLabel = new Map<string, StoredBlockNode[]>();
        for (const node of nodes) {
          const label = node.payload["label"] as string;
          const group = byLabel.get(label) ?? [];
          group.push(node);
          byLabel.set(label, group);
        }
        const visible: Block[] = [];
        for (const candidates of byLabel.values()) {
          const selected = visibleBlockNode(candidates, branchEntryIds);
          if (selected && !isDeletedBlock(selected)) visible.push(blockFromPayload(selected.payload));
        }
        return visible.sort((a, b) => a.label.localeCompare(b.label));
      },

      async upsertBlock(b: BlockInput): Promise<Block> {
        if (!BLOCK_NAME_RE.test(b.label)) {
          throw new Error(`Invalid block name: ${b.label}`);
        }
        const inputSourceLeaf = b.sourceLeafId ?? null;
        const branchEntryIds = b.branchEntryIds;
        if (
          inputSourceLeaf !== null
          && branchEntryIds !== undefined
          && branchEntryIds[branchEntryIds.length - 1] !== inputSourceLeaf
        ) {
          throw new Error("Block sourceLeafId must be the active branch leaf");
        }
        const { result, previous } = await enqueueWrite(() => {
          const candidates = blockNodes(b.sessionId, b.label);
          const resolvedNode = branchEntryIds === undefined
            ? newestNode(candidates.filter((node) => sourceLeafOf(node) === inputSourceLeaf))
            : visibleBlockNode(candidates, branchEntryIds);
          const current = resolvedNode && !isDeletedBlock(resolvedNode)
            ? blockFromPayload(resolvedNode.payload)
            : null;
          // Atomic CAS: check expectedUpdatedAt inside the write transaction.
          if (
            b.expectedUpdatedAt !== undefined
            && ((b.expectedUpdatedAt === null && current !== null)
              || (typeof b.expectedUpdatedAt === "number" && current?.updatedAt !== b.expectedUpdatedAt))
          ) {
            throw new KnowledgeBlockConflictError(current);
          }
          const now = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);

          const payload = {
            type: "block",
            sessionId: b.sessionId,
            label: b.label,
            content: b.content,
            updatedBy: b.updatedBy,
            ...(b.cursorTurn !== undefined ? { cursorTurn: b.cursorTurn } : {}),
            updatedAt: now,
            sourceLeafId: inputSourceLeaf,
            deleted: false,
          };

          const targetNode = newestNode(candidates.filter((node) => sourceLeafOf(node) === inputSourceLeaf));
          let id: number;
          if (targetNode) {
            db.updatePayload(targetNode.id, payload);
            id = targetNode.id;
          } else {
            id = db.insert(placeholderVec, payload);
          }
          db.indexText(id, b.content);
          persistence.commit();

          return { previous: current, result: {
            sessionId: b.sessionId,
            label: b.label,
            content: b.content,
            updatedBy: b.updatedBy,
            ...(b.cursorTurn !== undefined ? { cursorTurn: b.cursorTurn } : {}),
            updatedAt: now,
            sourceLeafId: inputSourceLeaf,
          } };
        });
        publishBlocksChanged(b.sessionId, { previous, current: result });
        return result;
      },

      async deleteBlock(
        sessionId: string,
        label: string,
        options?: {
          branchEntryIds?: readonly string[];
          expectedUpdatedAt?: number | null;
          sourceLeafId?: string | null;
          updatedBy?: BlockUpdatedBy;
          cursorTurn?: number;
        },
      ): Promise<void> {
        const branchEntryIds = options?.branchEntryIds;
        const expectedUpdatedAt = options?.expectedUpdatedAt;
        const sourceLeafId = options?.sourceLeafId
          ?? (branchEntryIds && branchEntryIds.length > 0 ? branchEntryIds[branchEntryIds.length - 1]! : null);
        const previous = await enqueueWrite(() => {
          const nodes = blockNodes(sessionId, label);
          const resolvedNode = branchEntryIds === undefined
            ? newestNode(nodes.filter((node) => sourceLeafOf(node) === sourceLeafId))
            : visibleBlockNode(nodes, branchEntryIds);
          const currentBlock = resolvedNode && !isDeletedBlock(resolvedNode)
            ? blockFromPayload(resolvedNode.payload)
            : null;
          // Atomic CAS for delete: check expectedUpdatedAt inside the write transaction.
          if (expectedUpdatedAt !== undefined) {
            if (
              (expectedUpdatedAt === null && currentBlock !== null)
              || (typeof expectedUpdatedAt === "number" && currentBlock?.updatedAt !== expectedUpdatedAt)
            ) {
              throw new KnowledgeBlockConflictError(currentBlock);
            }
          }
          if (branchEntryIds === undefined) {
            // Legacy unscoped deletion retains its historical whole-session behavior.
            for (const node of nodes) db.delete(node.id);
            if (nodes.length > 0) persistence.commit();
            return currentBlock;
          }
          if (!currentBlock) return null;
          const timestamp = Math.max(Date.now(), currentBlock.updatedAt + 1);
          const tombstone = {
            type: "block",
            sessionId,
            label,
            content: "",
            updatedBy: options?.updatedBy ?? "agent",
            ...(options?.cursorTurn !== undefined ? { cursorTurn: options.cursorTurn } : {}),
            updatedAt: timestamp,
            sourceLeafId,
            deleted: true,
          };
          const targetNode = newestNode(nodes.filter((node) => sourceLeafOf(node) === sourceLeafId));
          if (targetNode) db.updatePayload(targetNode.id, tombstone);
          else db.insert(placeholderVec, tombstone);
          persistence.commit();
          return currentBlock;
        });
        publishBlocksChanged(sessionId, { previous, current: null });
      },

      async putKnowledge(k: KnowledgeInput): Promise<NodeId> {
        return enqueueWrite(() => {
          if (recallScope === "user" && k.scope !== "user") {
            throw new KnowledgeMutationError("invalid", "User knowledge store rejects non-user scope writes");
          }
          assertSupplementsTarget(k.supplements, k.scope);
          const payload = knowledgeInsertPayload(k, Date.now());
          const id = db.insert(placeholderVec, payload);
          db.indexText(id, k.content);
          if (k.trigger) db.indexKeyword(id, k.trigger);
          linkSupplements(id, k.supplements);
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
          return id;
        });
      },

      async createKnowledgeIfAbsent(k: KnowledgeInput, options?: { expectedRevision?: string; explicit?: boolean }): Promise<KnowledgeCreateIfAbsentResult> {
        return enqueueWrite(() => {
          if (options?.expectedRevision !== undefined
            && (knowledgeRevision() !== options.expectedRevision || knowledgeMutationEpoch !== knowledgeEpoch)) {
            throw new KnowledgeMutationError("conflict", "Memory changed while the proposal was being prepared");
          }
          if (recallScope === "user" && k.scope !== "user") {
            throw new KnowledgeMutationError("invalid", "User knowledge store rejects non-user scope writes");
          }
          const identity = normalizeKnowledgeContent(k.content);
          if (!identity) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
          const explicitRemember = options?.explicit === true && k.status === "accepted";
          // This lookup intentionally stays inside the single writer queue. It
          // covers every status and retired row so concurrent model proposals
          // cannot insert two identities or resurrect dismissed history.
          const duplicate = lookup({ type: "knowledge", scope: k.scope }).filter(({ payload }) => (
            payload["type"] === "knowledge"
            && payload["scope"] === k.scope
            && (!explicitRemember || (payload["invalidAt"] === undefined && payload["status"] !== "dismissed"))
            && ((typeof payload["content"] === "string"
              && normalizeKnowledgeContent(payload["content"] as string) === identity)
              || (k.source?.kind === "memory-organizer"
                && k.source.proposalKey !== undefined
                && knowledgeSourceFromPayload(payload["source"])?.proposalKey === k.source.proposalKey)
              || (k.source?.kind === "memory-organizer"
                && (() => {
                  const previous = knowledgeSourceFromPayload(payload["source"]);
                  if (previous?.kind === "memory-organizer" && payload["invalidAt"] === undefined && payload["status"] !== "dismissed") return false;
                  // Explicit records and retired inference both claim their
                  // exact evidence, including rephrased late model results.
                  return previous?.spans?.some((old) => k.source?.spans?.some((next) => overlappingSource(old, next)))
                    || (!previous?.spans?.length && !k.source?.spans?.length && previous?.key !== undefined && previous.key === k.source!.key);
                })()))
          ))[0];
          if (duplicate) {
            // A repeated explicit statement can bring new original evidence.
            // Keep all of it so forgetting also suppresses the new source.
            if (explicitRemember && k.source?.spans?.length) {
              const previous = knowledgeSourceFromPayload(duplicate.payload["source"]);
              const source = { ...previous, ...k.source, spans: mergeSourceSpans([...(previous?.spans ?? []), ...k.source.spans]) };
              db.patchPayload(duplicate.id, { $set: { source } });
              duplicate.payload = { ...duplicate.payload, source };
              persistence.commit();
              bumpKnowledgeEpoch();
              notifyKnowledge([duplicate.id]);
            }
            if (explicitRemember && duplicate.payload["status"] === "suggested") {
              const source = knowledgeSourceFromPayload(duplicate.payload["source"]) ?? k.source;
              db.patchPayload(duplicate.id, { $set: {
                status: "accepted", ...(k.nature ? { nature: k.nature } : {}), ...(source ? { source } : {}),
              } });
              duplicate.payload = { ...duplicate.payload, status: "accepted", ...(k.nature ? { nature: k.nature } : {}), ...(source ? { source } : {}) };
              persistence.commit();
              bumpKnowledgeEpoch();
              notifyKnowledge([duplicate.id]);
            }
            const knowledge = knowledgeFromPayload(duplicate.id, duplicate.payload);
            if (!knowledge) throw new KnowledgeMutationError("invalid", `Invalid knowledge row: ${duplicate.id}`);
            return { created: false, duplicate: true, knowledge };
          }
          assertSupplementsTarget(k.supplements, k.scope);
          const payload = knowledgeInsertPayload(k, Date.now());
          const id = db.insert(placeholderVec, payload);
          db.indexText(id, k.content);
          if (k.trigger) db.indexKeyword(id, k.trigger);
          linkSupplements(id, k.supplements);
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
          const knowledge = knowledgeFromPayload(id, payload);
          if (!knowledge) throw new KnowledgeMutationError("invalid", `Invalid knowledge row: ${id}`);
          return { created: true, duplicate: false, knowledge };
        });
      },

      async getKnowledge(id: NodeId): Promise<Knowledge | null> {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        if (!payload) return null;
        return knowledgeFromPayload(id, payload);
      },

      async listKnowledge(filter: { scope?: KnowledgeScope; status?: KnowledgeStatus; activeOnly?: boolean }): Promise<Knowledge[]> {
        const nodes = lookup({
          type: "knowledge",
          ...(filter.scope ? { scope: filter.scope } : {}),
          ...(filter.status ? { status: filter.status } : {}),
        }).filter(({ payload: p }) => {
          if (p["type"] !== "knowledge") return false;
          if (filter.scope && p["scope"] !== filter.scope) return false;
          if (filter.status && p["status"] !== filter.status) return false;
          if (filter.activeOnly && p["invalidAt"] !== undefined) return false;
          return true;
        });

        const results: Knowledge[] = nodes.flatMap(({ id, payload: p }) => {
          const parsed = knowledgeFromPayload(id, p);
          return parsed ? [parsed] : [];
        });
        return results.sort((a, b) => b.createdAt - a.createdAt);
      },

      async updateSuggestedKnowledge(id, patch, expectedScope, expected): Promise<void> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
          }
          if (expectedScope && payload["scope"] !== expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${expectedScope} scope: ${id}`);
          }
          if (payload["status"] !== "suggested") {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer awaiting review`);
          }
          if (payload["invalidAt"] !== undefined) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer current`);
          }
          if (expected && !matchesExpectedRevision(payload, expected)) {
            throw new KnowledgeMutationError("conflict", `Knowledge suggestion ${id} changed after it was opened`);
          }
          if (!patch.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
          db.patchPayload(id, { $set: { content: patch.content, trigger: patch.trigger } });
          db.indexText(id, patch.content);
          if (patch.trigger) db.indexKeyword(id, patch.trigger);
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
        });
      },

      async updateAcceptedKnowledge(id, patch, expectedScope, expected): Promise<void> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge not found: ${id}`);
          }
          if (expectedScope && payload["scope"] !== expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge not found in ${expectedScope} scope: ${id}`);
          }
          if (payload["status"] !== "accepted") {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is not current accepted knowledge`);
          }
          if (payload["invalidAt"] !== undefined) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer current`);
          }
          if (expected && !matchesExpectedRevision(payload, expected)) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} changed after it was opened`);
          }
          if (!patch.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
          db.patchPayload(id, { $set: { content: patch.content, trigger: patch.trigger } });
          db.indexText(id, patch.content);
          if (patch.trigger) db.indexKeyword(id, patch.trigger);
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
        });
      },

      async supersedeKnowledge(id, input, expectedScope, expected): Promise<{ id: NodeId; previous: Knowledge }> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge not found: ${id}`);
          }
          const scope = payload["scope"] as KnowledgeScope;
          if (expectedScope && scope !== expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge not found in ${expectedScope} scope: ${id}`);
          }
          if (payload["status"] !== "accepted" || payload["invalidAt"] !== undefined) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is not current accepted knowledge`);
          }
          if (expected && !matchesExpectedRevision(payload, expected)) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} changed after it was opened`);
          }
          if (!input.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
          const previous = knowledgeFromPayload(id, payload);
          if (!previous) throw new KnowledgeMutationError("invalid", `Invalid knowledge row: ${id}`);
          assertSupplementsTarget(input.supplements ?? previous.supplements, scope);
          const now = Date.now();
          const inheritedNature = input.nature ?? previous.nature;
          const inheritedSource = input.source ?? previous.source;
          const nextPayload = knowledgeInsertPayload({
            ...input,
            scope,
            status: "accepted",
            // A correction inherits the predecessor's provenance class when the
            // caller does not restate one; `nature` defaults the same way.
            ...(inheritedNature ? { nature: inheritedNature } : {}),
            ...(inheritedSource ? { source: inheritedSource } : {}),
          }, now);
          const nextId = db.insert(placeholderVec, nextPayload);
          db.indexText(nextId, input.content);
          if (input.trigger) db.indexKeyword(nextId, input.trigger);
          db.patchPayload(id, { $set: { invalidAt: now } });
          db.link(nextId, id, "supersedes", 1);
          // A correction keeps the predecessor's supplements relation unless
          // the caller restates one.
          linkSupplements(nextId, input.supplements ?? previous.supplements);
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([nextId, id]);
          return { id: nextId, previous };
        });
      },

      async retireKnowledge(id, expectedScope, expected): Promise<void> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge not found: ${id}`);
          }
          if (expectedScope && payload["scope"] !== expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge not found in ${expectedScope} scope: ${id}`);
          }
          if (expected) {
            if (
              !matchesExpectedRevision(payload, expected)
              || (expected.invalidAt === undefined && payload["invalidAt"] !== undefined)
            ) {
              throw new KnowledgeMutationError("conflict", `Knowledge ${id} changed after it was opened`);
            }
          }
          if (payload["invalidAt"] !== undefined) return;
          db.patchPayload(id, { $set: { invalidAt: Date.now() } });
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
        });
      },

      async getSupersedeChain(id, expectedScope): Promise<KnowledgeSupersedeChain | null> {
        const current = await store.getKnowledge(id);
        if (!current) return null;
        if (expectedScope && current.scope !== expectedScope) return null;
        const catalog = (await store.listKnowledge({ scope: current.scope }))
          .filter((item) => item.scope === current.scope);
        const byId = new Map(catalog.map((item) => [item.id, item]));
        const outgoingOf = (from: NodeId): NodeId[] => db.getEdges(from)
          .filter((edge) => edge.label === "supersedes")
          .map((edge) => edge.targetId);
        const incomingOf = (to: NodeId): NodeId[] => {
          const found: NodeId[] = [];
          for (const item of catalog) {
            for (const edge of db.getEdges(item.id)) {
              if (edge.label === "supersedes" && edge.targetId === to) found.push(item.id);
            }
          }
          return found;
        };
        const collect = (start: NodeId, neighbors: (from: NodeId) => NodeId[]): Knowledge[] => {
          const collected: Knowledge[] = [];
          const seen = new Set<NodeId>([start]);
          const queue = [start];
          while (queue.length > 0) {
            const from = queue.shift()!;
            for (const nextId of neighbors(from)) {
              if (seen.has(nextId)) continue;
              const next = byId.get(nextId);
              if (!next) continue;
              seen.add(nextId);
              collected.push(next);
              queue.push(nextId);
            }
          }
          return collected.sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
        };
        const predecessors = collect(id, outgoingOf);
        const successors = collect(id, incomingOf);
        return {
          current,
          predecessors,
          successors,
          chain: [...predecessors, current, ...successors],
        };
      },

      async acceptKnowledge(id: NodeId, opts: {
        supersedes?: NodeId[];
        expectedScope?: KnowledgeScope;
        expected?: KnowledgeExpectedRevision;
        edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string; expectedStatus?: KnowledgeStatus; expectedInvalidAt?: number | null };
      }): Promise<void> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
          }
          if (opts.expectedScope && payload["scope"] !== opts.expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${opts.expectedScope} scope: ${id}`);
          }
          const expected = opts.expected ?? (opts.edit ? {
            content: opts.edit.expectedContent,
            trigger: opts.edit.expectedTrigger,
            ...(opts.edit.expectedStatus === undefined ? {} : { status: opts.edit.expectedStatus }),
            ...(opts.edit.expectedInvalidAt === undefined ? {} : { invalidAt: opts.edit.expectedInvalidAt }),
          } : undefined);
          if (expected && !matchesExpectedRevision(payload, expected)) {
            throw new KnowledgeMutationError("conflict", `Knowledge suggestion ${id} changed after it was opened`);
          }
          if (payload["invalidAt"] !== undefined) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer current`);
          }
          if (payload["status"] === "accepted") return;
          if (payload["status"] !== "suggested") {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer awaiting review`);
          }
          if (opts.edit) {
            if (!opts.edit.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
          }
          const superseded = [...new Set(opts.supersedes ?? [])].filter((oldId) => oldId !== id);
          for (const oldId of superseded) {
            const old = db.getPayload(oldId) as Record<string, unknown> | null;
            if (
              !old
              || old["type"] !== "knowledge"
              || old["status"] !== "accepted"
              || old["invalidAt"] !== undefined
              || old["scope"] !== payload["scope"]
            ) {
              throw new KnowledgeMutationError("invalid", `Knowledge ${oldId} cannot be superseded by ${id}`);
            }
          }
          db.patchPayload(id, { $set: {
            status: "accepted",
            ...(opts.edit ? { content: opts.edit.content, trigger: opts.edit.trigger } : {}),
          } });
          if (opts.edit) {
            db.indexText(id, opts.edit.content);
            if (opts.edit.trigger) db.indexKeyword(id, opts.edit.trigger);
          }
          if (superseded.length > 0) {
            const now = Date.now();
            for (const oldId of superseded) {
              db.patchPayload(oldId, { $set: { invalidAt: now } });
              db.link(id, oldId, "supersedes", 1);
            }
          }
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id, ...superseded]);
        });
      },

      async dismissKnowledge(id: NodeId, expectedScope, expected): Promise<void> {
        return enqueueWrite(() => {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "knowledge") {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
          }
          if (expectedScope && payload["scope"] !== expectedScope) {
            throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${expectedScope} scope: ${id}`);
          }
          if (expected && !matchesExpectedRevision(payload, expected)) {
            throw new KnowledgeMutationError("conflict", `Knowledge suggestion ${id} changed after it was opened`);
          }
          if (payload["invalidAt"] !== undefined) {
            throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer current`);
          }
          if (payload["status"] === "dismissed") return;
          if (payload["status"] !== "suggested") {
            throw new KnowledgeMutationError("conflict", `Accepted knowledge ${id} cannot be dismissed as a suggestion`);
          }
          db.patchPayload(id, { $set: { status: "dismissed" } });
          persistence.commit();
          bumpKnowledgeEpoch();
          notifyKnowledge([id]);
        });
      },

      async recordRecall(ids: NodeId[]): Promise<void> {
        return enqueueWrite(() => {
          const now = Date.now();
          let changed = false;
          for (const id of ids) {
            const payload = db.getPayload(id);
            if (payload && payload["type"] === "knowledge") {
              changed = true;
              db.patchPayload(id, {
                $set: { recalledAt: now },
                $inc: { recallCount: 1 },
              });
            }
          }
          if (changed) persistence.commit();
        });
      },

      async recall(query: string, k: number): Promise<RecallResult[]> {
        const nodes = lookup({ type: "knowledge", scope: recallScope, status: "accepted" }).filter(({ payload: p }) =>
          p["type"] === "knowledge"
          && p["scope"] === recallScope
          && p["status"] === "accepted"
          && p["invalidAt"] === undefined,
        );
        const queryLower = query.toLowerCase();
        const scored = nodes.map(({ id, payload }) => {
          const content = (payload["content"] as string) ?? "";
          const trigger = (payload["trigger"] as string) ?? "";
          const text = `${content} ${trigger}`.toLowerCase();
          const terms = queryLower.split(/\s+/).filter(Boolean);
          let score = 0;
          for (const term of terms) {
            if (text.includes(term)) score += 1;
          }
          return { id, payload, score, via: "text" as const };
        }).filter((row) => row.score > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, k);

        const results: RecallResult[] = scored.map(({ id, payload, score, via }) => ({
          node: { id, type: "knowledge", payload },
          score,
          via,
        }));
        if (results.length > 0) {
          await store.recordRecall(results.map((result) => result.node.id));
        }
        return results;
      },

      async touchFile(path, language): Promise<NodeId> {
        return enqueueWrite(() => {
          const normalizedPath = assertGraphText(path, "File path");
          const normalizedLanguage = assertGraphText(language, "File language");
          const existing = fileNodes(normalizedPath);
          const previous = existing[0]?.payload ?? {};
          const payload = {
            type: "file",
            path: normalizedPath,
            language: normalizedLanguage,
            modifiedAt: Date.now(),
            active: true,
            ...(typeof previous["generation"] === "string" ? { generation: previous["generation"] } : {}),
            ...(typeof previous["documentRevision"] === "string" ? { documentRevision: previous["documentRevision"] } : {}),
            ...(previous["linksIncomplete"] === true ? { linksIncomplete: true } : {}),
            ...(Array.isArray(previous["associationCandidates"])
              ? { associationCandidates: previous["associationCandidates"] }
              : {}),
            ...(previous["hasAssociationCandidates"] === true ? { hasAssociationCandidates: true } : {}),
            ...(Number.isSafeInteger(previous["extractor"]) ? { extractor: previous["extractor"] } : {}),
          };
          const fileId = existing[0]?.id ?? db.insert(placeholderVec, payload);
          const operations: TransactionOperation[] = [
            { type: "updatePayload", id: fileId, payload },
            ...existing.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
          ];
          db.commitTransaction(operations);
          bumpCounters({ files: existing.length === 0 ? 1 : 1 - existing.length });
          invalidateGraphShape();
          db.indexText(fileId, normalizedPath);
          scheduleGraphFlush();
          return fileId;
        });
      },

      async replaceFileSymbols(path, language, symbols, documentRevision, links = [], options = {}) {
        return enqueueWrite(() => {
          const normalizedPath = assertGraphText(path, "File path");
          const normalizedLanguage = assertGraphText(language, "File language");
          const normalizedRevision = assertGraphText(documentRevision, "Document revision");
          const associationCandidates = options.associationCandidates ?? [];
          for (const symbol of symbols) {
            assertGraphText(symbol.name, "Symbol name");
            assertGraphText(symbol.kind, "Symbol kind");
            if (!validRange(symbol.range)) throw new KnowledgeMutationError("invalid", `Invalid range for symbol ${symbol.name}`);
          }
          for (const link of links) {
            if (!LINK_KINDS.has(link.kind)) throw new KnowledgeMutationError("invalid", `Invalid link kind ${String(link.kind)}`);
            assertGraphText(link.value, "Link value");
            if (!validLinkLine(link.line)) throw new KnowledgeMutationError("invalid", `Invalid line for link ${link.value}`);
            if (link.kind !== "import") assertGraphText(link.callee ?? "", "Link callee");
          }
          for (const link of associationCandidates) {
            if (link.kind !== "associates") {
              throw new KnowledgeMutationError("invalid", "Association candidates must use the associates link kind");
            }
            assertGraphText(link.value, "Association candidate value");
            if (!validLinkLine(link.line)) {
              throw new KnowledgeMutationError("invalid", `Invalid line for association candidate ${link.value}`);
            }
            assertGraphText(link.callee ?? "", "Association candidate callee");
          }
          const associationFacts = [...new Map(
            [...associationCandidates, ...links.filter((link) => link.kind === "associates")]
              .map((link) => [JSON.stringify([link.value, link.line, link.callee]), link] as const),
          ).values()];
          const generation = randomUUID();
          const previousFiles = fileNodes(normalizedPath);
          const previousSymbols = symbolNodes(normalizedPath);
          const previousLinks = linkNodes(normalizedPath);
          const fileId = previousFiles[0]?.id ?? db.insert(placeholderVec, {
            type: "file",
            path: normalizedPath,
            language: normalizedLanguage,
            modifiedAt: Date.now(),
            active: true,
            generation,
            documentRevision: normalizedRevision,
          });
          // `nameLower` / `pathLower` exist for the n-gram indexes: substring
          // search is case-sensitive and `searchSymbols` compares lowercased.
          const pathLower = normalizedPath.toLowerCase();
          const pendingPayloads = symbols.map((symbol) => ({
            type: "symbol",
            path: normalizedPath,
            pathLower,
            language: normalizedLanguage,
            name: symbol.name,
            nameLower: symbol.name.toLowerCase(),
            kind: symbol.kind,
            range: { ...symbol.range },
            generation,
            documentRevision: normalizedRevision,
            active: false,
          }));
          const pendingLinkPayloads = links.map((link) => ({
            type: "link",
            path: normalizedPath,
            language: normalizedLanguage,
            kind: link.kind,
            value: link.value,
            line: link.line,
            ...(link.kind !== "import" && link.callee ? { callee: link.callee } : {}),
            generation,
            documentRevision: normalizedRevision,
            active: false,
          }));
          const symbolIds = pendingPayloads.length > 0
            ? db.batchInsert(pendingPayloads.map(() => placeholderVec), pendingPayloads)
            : [];
          const linkIds = pendingLinkPayloads.length > 0
            ? db.batchInsert(pendingLinkPayloads.map(() => placeholderVec), pendingLinkPayloads)
            : [];
          const activePayloads = pendingPayloads.map((payload) => ({ ...payload, active: true }));
          const activeLinkPayloads = pendingLinkPayloads.map((payload) => ({ ...payload, active: true }));
          const filePayload = {
            type: "file",
            path: normalizedPath,
            language: normalizedLanguage,
            modifiedAt: Date.now(),
            active: true,
            generation,
            documentRevision: normalizedRevision,
            ...(associationFacts.length > 0
              ? {
                  associationCandidates: associationFacts.map((link) => ({
                    kind: "associates" as const,
                    value: link.value,
                    line: link.line,
                    callee: link.callee,
                  })),
                  hasAssociationCandidates: true,
                }
              : { hasAssociationCandidates: false }),
            ...(options.linksIncomplete ? { linksIncomplete: true } : {}),
            ...(Number.isSafeInteger(options.extractor) ? { extractor: options.extractor } : {}),
          };
          const previousTargets = new Set([
            ...previousSymbols.map(({ id }) => id),
            ...previousLinks.map(({ id }) => id),
          ]);
          const outgoingUnlinks: TransactionOperation[] = db.getEdges(fileId).flatMap((edge) => (
            previousTargets.has(edge.targetId)
              ? [{ type: "unlinkLabel" as const, src: fileId, dst: edge.targetId, label: edge.label }]
              : []
          ));
          const operations: TransactionOperation[] = [
            { type: "updatePayload", id: fileId, payload: filePayload },
            ...previousFiles.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
            ...outgoingUnlinks,
            ...previousSymbols.map(({ id }) => ({ type: "delete" as const, id })),
            ...previousLinks.map(({ id }) => ({ type: "delete" as const, id })),
            ...symbolIds.flatMap((id, index): TransactionOperation[] => [
              { type: "updatePayload", id, payload: activePayloads[index] },
              { type: "upsertEdge", src: fileId, dst: id, label: "defines", weight: 1 },
            ]),
            ...linkIds.flatMap((id, index): TransactionOperation[] => [
              { type: "updatePayload", id, payload: activeLinkPayloads[index] },
              { type: "upsertEdge", src: fileId, dst: id, label: edgeLabelForKind(links[index]!.kind), weight: 1 },
            ]),
          ];
          db.commitTransaction(operations);
          bumpCounters({
            files: previousFiles.length === 0 ? 1 : 1 - previousFiles.length,
            symbols: symbolIds.length - previousSymbols.filter(({ payload }) => payload["active"] === true).length,
            links: links.length - previousLinks.filter(({ payload }) => payload["active"] === true).length,
          });
          invalidateGraphShape();
          db.indexText(fileId, normalizedPath);
          for (let index = 0; index < symbolIds.length; index += 1) {
            const id = symbolIds[index]!;
            const symbol = symbols[index]!;
            db.indexText(id, `${symbol.name} ${normalizedPath}`);
            db.indexKeyword(id, symbol.name);
          }
          for (let index = 0; index < linkIds.length; index += 1) {
            const id = linkIds[index]!;
            const link = links[index]!;
            db.indexText(id, `${link.value} ${normalizedPath}`);
            db.indexKeyword(id, link.value);
          }
          scheduleGraphFlush();
          return { fileId, symbols: symbolIds.length, edges: symbolIds.length + links.length };
        });
      },

      async resolveAssociationCandidates(): Promise<{ activated: number }> {
        return enqueueWrite(() => {
          const files = lookup({ type: "file", active: true, hasAssociationCandidates: true });
          if (files.length === 0) return { activated: 0 };

          type AssociationCandidate = { value: string; line: number; callee: string };
          const candidatesByFile = new Map<number, AssociationCandidate[]>();
          const values = new Set<string>();
          for (const file of files) {
            const raw = file.payload["associationCandidates"];
            if (!Array.isArray(raw)) continue;
            const candidates: AssociationCandidate[] = [];
            for (const value of raw) {
              if (!value || typeof value !== "object" || Array.isArray(value)) continue;
              const candidate = value as Record<string, unknown>;
              if (
                typeof candidate["value"] !== "string"
                || candidate["value"].trim().length === 0
                || !validLinkLine(Number(candidate["line"]))
                || typeof candidate["callee"] !== "string"
                || candidate["callee"].trim().length === 0
              ) continue;
              const normalized = {
                value: candidate["value"],
                line: Number(candidate["line"]),
                callee: candidate["callee"],
              };
              candidates.push(normalized);
              values.add(normalized.value);
            }
            if (candidates.length > 0) candidatesByFile.set(file.id, candidates);
          }
          if (values.size === 0) return { activated: 0 };

          const confirmed = new Set<string>();
          for (const value of values) {
            if (db.indexedLookup({ type: "link", kind: "connects", value, active: true }, GRAPH_RESULT_CEILING).length > 0) {
              confirmed.add(value);
            }
          }

          const operations: TransactionOperation[] = [];
          const newLinkRows: Array<{ file: StoredNode; candidate: AssociationCandidate; id: NodeId }> = [];
          let activated = 0;
          let deactivated = 0;
          for (const file of files) {
            const candidates = candidatesByFile.get(file.id);
            if (!candidates) continue;
            const generation = typeof file.payload["generation"] === "string" ? file.payload["generation"] : undefined;
            const revision = typeof file.payload["documentRevision"] === "string" ? file.payload["documentRevision"] : undefined;
            const candidateKeys = new Set(candidates.map((candidate) => (
              `${candidate.value}\u0000${candidate.line}\u0000${candidate.callee}`
            )));
            const activeAssociations = linkNodes(String(file.payload["path"]))
              .filter(({ payload }) => (
                payload["active"] === true
                && payload["kind"] === "associates"
                && payload["generation"] === generation
                && payload["documentRevision"] === revision
                && candidateKeys.has(`${String(payload["value"])}\u0000${Number(payload["line"])}\u0000${String(payload["callee"] ?? "")}`)
              ));
            const activeKeys = new Set(activeAssociations.map(({ payload }) => (
              `${String(payload["value"])}\u0000${Number(payload["line"])}\u0000${String(payload["callee"] ?? "")}`
            )));
            const toActivate = candidates.filter((candidate) => (
              confirmed.has(candidate.value)
              && !activeKeys.has(`${candidate.value}\u0000${candidate.line}\u0000${candidate.callee}`)
            ));
            const toDeactivate = activeAssociations.filter(({ payload }) => !confirmed.has(String(payload["value"])));
            if (toActivate.length === 0 && toDeactivate.length === 0) continue;

            const path = file.payload["path"];
            const language = file.payload["language"];
            if (typeof path !== "string" || typeof language !== "string") continue;
            const pendingPayloads = toActivate.map((candidate) => ({
              type: "link" as const,
              path,
              language,
              kind: "associates" as const,
              value: candidate.value,
              line: candidate.line,
              callee: candidate.callee,
              ...(generation ? { generation } : {}),
              ...(revision ? { documentRevision: revision } : {}),
              active: false,
            }));
            const linkIds = pendingPayloads.length > 0
              ? db.batchInsert(pendingPayloads.map(() => placeholderVec), pendingPayloads)
              : [];
            const activePayloads = pendingPayloads.map((payload) => ({ ...payload, active: true }));
            for (const [index, id] of linkIds.entries()) {
              const candidate = toActivate[index]!;
              newLinkRows.push({ file, candidate, id });
              operations.push(
                { type: "updatePayload", id, payload: activePayloads[index] },
                { type: "upsertEdge", src: file.id, dst: id, label: "associates", weight: 1 },
              );
            }
            for (const link of toDeactivate) {
              operations.push(
                { type: "unlinkLabel", src: file.id, dst: link.id, label: "associates" },
                { type: "delete", id: link.id },
              );
            }
            activated += toActivate.length;
            deactivated += toDeactivate.length;
          }
          if (operations.length === 0) return { activated: 0 };
          db.commitTransaction(operations);
          bumpCounters({ links: activated - deactivated });
          for (const row of newLinkRows) {
            db.indexText(row.id, `${row.candidate.value} ${String(row.file.payload["path"])}`);
            db.indexKeyword(row.id, row.candidate.value);
          }
          scheduleGraphFlush();
          return { activated };
        });
      },

      async removeFileSymbols(path, options) {
        return enqueueWrite(() => {
          if (options?.signal?.aborted) return { removedFiles: 0, removedSymbols: 0 };
          const normalizedPath = assertGraphText(path, "File path");
          const files = fileNodes(normalizedPath);
          if (options && files.length > 0) {
            const current = files[0]!.payload;
            const currentRevision = typeof current["documentRevision"] === "string" ? current["documentRevision"] : null;
            const currentGeneration = typeof current["generation"] === "string" ? current["generation"] : null;
            if (
              (options.expectedDocumentRevision !== undefined && options.expectedDocumentRevision !== currentRevision)
              || (options.expectedGeneration !== undefined && options.expectedGeneration !== currentGeneration)
            ) return { removedFiles: 0, removedSymbols: 0 };
          }
          const symbols = symbolNodes(normalizedPath);
          const links = linkNodes(normalizedPath);
          // Relations in *other* files whose resolved target was this path die
          // with it — a deleted/renamed target cannot stay a current fact (D-240).
          const incomingToTarget = lookup({ type: "link", targetPath: normalizedPath })
            .filter(({ payload }) => RELATION_KINDS.has(payload["kind"] as SymbolGraphRelationKind));
          const incomingOwnerId = new Map<number, { ownerId: number; label: "references" | "calls" }>();
          for (const row of incomingToTarget) {
            const owner = typeof row.payload["path"] === "string" ? fileNodes(row.payload["path"] as string)[0] : undefined;
            if (owner) {
              incomingOwnerId.set(row.id, {
                ownerId: owner.id,
                label: row.payload["kind"] === "calls" ? "calls" : "references",
              });
            }
          }
          const operations: TransactionOperation[] = [
            ...incomingToTarget.flatMap(({ id }) => {
              const owner = incomingOwnerId.get(id);
              return owner === undefined
                ? [{ type: "delete" as const, id }]
                : [
                    { type: "unlinkLabel" as const, src: owner.ownerId, dst: id, label: owner.label },
                    { type: "delete" as const, id },
                  ];
            }),
            ...symbols.map(({ id }) => ({ type: "delete" as const, id })),
            ...links.map(({ id }) => ({ type: "delete" as const, id })),
            ...files.map(({ id }) => ({ type: "delete" as const, id })),
          ];
          if (operations.length > 0) db.commitTransaction(operations);
          bumpCounters({
            files: -files.length,
            symbols: -symbols.filter(({ payload }) => payload["active"] === true).length,
            links: -links.filter(({ payload }) => payload["active"] === true).length
              - incomingToTarget.filter(({ payload }) => payload["active"] === true).length,
          });
          invalidateGraphShape();
          scheduleGraphFlush();
          return { removedFiles: files.length, removedSymbols: symbols.length };
        });
      },

      async recordResolvedRelations(path, language, relations) {
        return enqueueWrite(() => {
          if (relations.length === 0) return { recorded: 0 };
          const normalizedPath = assertGraphText(path, "File path");
          const normalizedLanguage = assertGraphText(language, "File language");
          for (const relation of relations) {
            if (!RELATION_KINDS.has(relation.kind)) {
              throw new KnowledgeMutationError("invalid", `Invalid relation kind ${String(relation.kind)}`);
            }
            assertGraphText(relation.value, "Relation value");
            if (!validLinkLine(relation.line)) {
              throw new KnowledgeMutationError("invalid", `Invalid line for relation ${relation.value}`);
            }
            if (!RELATION_SOURCES.has(relation.resolvedBy)) {
              throw new KnowledgeMutationError("invalid", `Invalid relation source ${String(relation.resolvedBy)}`);
            }
          }
          const files = fileNodes(normalizedPath);
          const existing = files[0];
          const previousLinks = linkNodes(normalizedPath).filter(({ payload }) => (
            RELATION_KINDS.has(payload["kind"] as SymbolGraphRelationKind)
          ));
          const fileId = existing?.id ?? db.insert(placeholderVec, {
            type: "file",
            path: normalizedPath,
            language: normalizedLanguage,
            modifiedAt: Date.now(),
            active: true,
          });
          const filePayload = existing?.payload;
          const generation = typeof filePayload?.["generation"] === "string" ? filePayload["generation"] : undefined;
          // The catalog's current revision of each target file — informational,
          // never a claim that the resolver read that revision (D-240).
          const targetRevisions = new Map<string, string | null>();
          for (const relation of relations) {
            if (!relation.targetPath || targetRevisions.has(relation.targetPath)) continue;
            const target = fileNodes(relation.targetPath)[0]?.payload;
            targetRevisions.set(
              relation.targetPath,
              typeof target?.["documentRevision"] === "string" ? target["documentRevision"] as string : null,
            );
          }
          // Replace-on-write per relation key: a fresh resolution of the same
          // relation supersedes the earlier sites without touching other keys.
          const incomingKeys = new Set(relations.map((relation) => relationKeyOf({
            kind: relation.kind,
            value: relation.value,
            targetPath: relation.targetPath,
            targetName: relation.targetName,
            anchorPath: relation.anchorPath,
            anchorLine: relation.anchorLine,
          })));
          const superseded = previousLinks.filter(({ payload }) => incomingKeys.has(relationKeyOf(payload)));
          const supersededIds = new Set(superseded.map(({ id }) => id));
          const outgoingUnlinks: TransactionOperation[] = db.getEdges(fileId).flatMap((edge) => (
            supersededIds.has(edge.targetId)
              ? [{ type: "unlinkLabel" as const, src: fileId, dst: edge.targetId, label: edge.label }]
              : []
          ));
          const pathLower = normalizedPath.toLowerCase();
          const pendingPayloads = relations.map((relation) => ({
            type: "link",
            path: normalizedPath,
            pathLower,
            language: normalizedLanguage,
            kind: relation.kind,
            value: relation.value,
            line: relation.line,
            ...(relation.character !== undefined ? { character: relation.character } : {}),
            ...(relation.caller !== undefined ? { caller: relation.caller } : {}),
            ...(relation.targetPath !== undefined ? { targetPath: relation.targetPath } : {}),
            ...(relation.targetName !== undefined ? { targetName: relation.targetName } : {}),
            ...(relation.targetKind !== undefined ? { targetKind: relation.targetKind } : {}),
            ...(relation.targetLine !== undefined ? { targetLine: relation.targetLine } : {}),
            ...(relation.anchorPath !== undefined ? { anchorPath: relation.anchorPath } : {}),
            ...(relation.anchorLine !== undefined ? { anchorLine: relation.anchorLine } : {}),
            resolvedBy: relation.resolvedBy,
            documentRevision: relation.siteRevision ?? null,
            ...(relation.targetPath !== undefined
              ? { targetObservedRevision: targetRevisions.get(relation.targetPath) ?? null }
              : {}),
            ...(generation ? { generation } : {}),
            active: true,
          }));
          const linkIds = pendingPayloads.length > 0
            ? db.batchInsert(pendingPayloads.map(() => placeholderVec), pendingPayloads)
            : [];
          const operations: TransactionOperation[] = [
            ...outgoingUnlinks,
            ...superseded.map(({ id }) => ({ type: "delete" as const, id })),
            ...linkIds.flatMap((id, index): TransactionOperation[] => [
              { type: "upsertEdge", src: fileId, dst: id, label: edgeLabelForKind(relations[index]!.kind), weight: 1 },
            ]),
          ];
          if (existing) {
            operations.push({ type: "updatePayload", id: fileId, payload: {
              ...filePayload,
              modifiedAt: Date.now(),
            } });
          }
          if (operations.length > 0) db.commitTransaction(operations);
          bumpCounters({ links: linkIds.length - superseded.length });
          for (let index = 0; index < linkIds.length; index += 1) {
            const id = linkIds[index]!;
            const relation = relations[index]!;
            db.indexText(id, `${relation.value} ${normalizedPath}`);
            db.indexKeyword(id, relation.value);
          }
          if (files.length === 0) bumpCounters({ files: 1 });
          invalidateGraphShape();
          scheduleGraphFlush();
          return { recorded: linkIds.length };
        });
      },

      async replaceResolvedRelationsForAnchor(anchor, rows, kinds) {
        return enqueueWrite(() => {
          const anchorPath = assertGraphText(anchor.path, "Anchor path");
          const anchorLine = anchor.line;
          if (!Number.isSafeInteger(anchorLine) || anchorLine < 1) {
            throw new KnowledgeMutationError("invalid", "Anchor line must be a positive integer");
          }
          // Validate all incoming rows first so a partial batch never lands.
          for (const entry of rows) {
            const normalizedPath = assertGraphText(entry.path, "File path");
            const normalizedLanguage = assertGraphText(entry.language, "File language");
            for (const relation of entry.relations) {
              if (!RELATION_KINDS.has(relation.kind)) {
                throw new KnowledgeMutationError("invalid", `Invalid relation kind ${String(relation.kind)}`);
              }
              assertGraphText(relation.value, "Relation value");
              if (!validLinkLine(relation.line)) {
                throw new KnowledgeMutationError("invalid", `Invalid line for relation ${relation.value}`);
              }
              if (!RELATION_SOURCES.has(relation.resolvedBy)) {
                throw new KnowledgeMutationError("invalid", `Invalid relation source ${String(relation.resolvedBy)}`);
              }
              void normalizedPath;
              void normalizedLanguage;
            }
          }
          // Find every existing relation row resolved from this anchor across
          // all files. The batch identity is the anchor — not individual paths.
          // anchorPath/anchorLine are not indexed; filter the indexed active-link
          // subset in JS rather than materializing every node in the catalog.
          const replacedKinds = new Set(kinds ?? ["references", "calls"]);
          const staleIds = lookup({ type: "link", active: true }).filter(({ payload }) => (
            payload["type"] === "link"
            && payload["active"] === true
            && RELATION_KINDS.has(payload["kind"] as SymbolGraphRelationKind)
            && replacedKinds.has(payload["kind"] as SymbolGraphRelationKind)
            && String(payload["anchorPath"] ?? "") === anchorPath
            && Number(payload["anchorLine"] ?? 0) === anchorLine
          )).map(({ id }) => id);
          // Delete stale rows and their edges.
          const deleteOps: TransactionOperation[] = [];
          for (const id of staleIds) {
            const fileEdges = db.getEdges(id);
            for (const edge of fileEdges) {
              deleteOps.push({ type: "unlinkLabel", src: id, dst: edge.targetId, label: edge.label });
            }
            deleteOps.push({ type: "delete", id });
          }
          // Insert new rows.
          const newLinkPayloads: Record<string, unknown>[] = [];
          const newLinkFileIds: number[] = [];
          const newLinkRelations: SymbolGraphRelationInput[] = [];
          for (const entry of rows) {
            const normalizedPath = assertGraphText(entry.path, "File path");
            const normalizedLanguage = assertGraphText(entry.language, "File language");
            const files = fileNodes(normalizedPath);
            const existing = files[0];
            const fileId = existing?.id ?? db.insert(placeholderVec, {
              type: "file",
              path: normalizedPath,
              language: normalizedLanguage,
              modifiedAt: Date.now(),
              active: true,
            });
            const filePayload = existing?.payload;
            const generation = typeof filePayload?.["generation"] === "string" ? filePayload["generation"] : undefined;
            const targetRevisions = new Map<string, string | null>();
            for (const relation of entry.relations) {
              if (!relation.targetPath || targetRevisions.has(relation.targetPath)) continue;
              const target = fileNodes(relation.targetPath)[0]?.payload;
              targetRevisions.set(
                relation.targetPath,
                typeof target?.["documentRevision"] === "string" ? target["documentRevision"] as string : null,
              );
            }
            const pathLower = normalizedPath.toLowerCase();
            for (const relation of entry.relations) {
              newLinkFileIds.push(fileId);
              newLinkRelations.push(relation);
              newLinkPayloads.push({
                type: "link",
                path: normalizedPath,
                pathLower,
                language: normalizedLanguage,
                kind: relation.kind,
                value: relation.value,
                line: relation.line,
                ...(relation.character !== undefined ? { character: relation.character } : {}),
                ...(relation.caller !== undefined ? { caller: relation.caller } : {}),
                ...(relation.targetPath !== undefined ? { targetPath: relation.targetPath } : {}),
                ...(relation.targetName !== undefined ? { targetName: relation.targetName } : {}),
                ...(relation.targetKind !== undefined ? { targetKind: relation.targetKind } : {}),
                ...(relation.targetLine !== undefined ? { targetLine: relation.targetLine } : {}),
                ...(relation.anchorPath !== undefined ? { anchorPath: relation.anchorPath } : {}),
                ...(relation.anchorLine !== undefined ? { anchorLine: relation.anchorLine } : {}),
                resolvedBy: relation.resolvedBy,
                documentRevision: relation.siteRevision ?? null,
                ...(relation.targetPath !== undefined
                  ? { targetObservedRevision: targetRevisions.get(relation.targetPath) ?? null }
                  : {}),
                ...(generation ? { generation } : {}),
                // Batch insertion happens before the graph transaction can refer
                // to the new numeric ids. Keep candidates invisible until the
                // same transaction activates them, links them, and deletes the
                // previous anchor rows.
                active: false,
              });
            }
          }
          const linkIds = newLinkPayloads.length > 0
            ? db.batchInsert(newLinkPayloads.map(() => placeholderVec), newLinkPayloads)
            : [];
          const insertOps: TransactionOperation[] = [
            ...deleteOps,
            ...linkIds.flatMap((id, index): TransactionOperation[] => [
              { type: "updatePayload", id, payload: { ...newLinkPayloads[index]!, active: true } },
              { type: "upsertEdge", src: newLinkFileIds[index]!, dst: id, label: edgeLabelForKind(newLinkRelations[index]!.kind), weight: 1 },
            ]),
          ];
          if (insertOps.length > 0) db.commitTransaction(insertOps);
          bumpCounters({ links: linkIds.length - staleIds.length });
          for (let index = 0; index < linkIds.length; index += 1) {
            const id = linkIds[index]!;
            const relation = newLinkRelations[index]!;
            const indexPath = typeof newLinkPayloads[index]!["path"] === "string" ? newLinkPayloads[index]!["path"] as string : "";
            db.indexText(id, `${relation.value} ${indexPath}`);
            db.indexKeyword(id, relation.value);
          }
          invalidateGraphShape();
          scheduleGraphFlush();
          return { recorded: linkIds.length, removed: staleIds.length };
        });
      },

      async searchSymbols(query, k, roots) {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0 || !Number.isSafeInteger(k) || k <= 0) return [];
        // Candidates come from the indexes; scoring is unchanged and still runs
        // over every term, so a candidate found through one term is scored on
        // all of them. The n-gram index needs three characters, so a shorter term
        // can only match a name exactly — `db` finds `db`, not `dbPath`, and
        // never matches a path (D-141).
        const candidateIds = new Set<number>();
        for (const term of terms) {
          if (term.length >= NGRAM_MIN_CHARS) {
            for (const id of db.substringLookup("nameLower", term, GRAPH_RESULT_CEILING)) candidateIds.add(id);
            for (const id of db.substringLookup("pathLower", term, GRAPH_RESULT_CEILING)) candidateIds.add(id);
          } else {
            for (const id of db.indexedLookup({ type: "symbol", nameLower: term }, GRAPH_RESULT_CEILING)) candidateIds.add(id);
          }
        }
        const results: SymbolGraphSearchResult[] = [];
        for (const id of candidateIds) {
          const payload = db.getPayload(id) as Record<string, unknown> | null;
          if (!payload || payload["type"] !== "symbol" || payload["active"] !== true) continue;
          const name = typeof payload["name"] === "string" ? payload["name"] : "";
          const path = typeof payload["path"] === "string" ? payload["path"] : "";
          const kind = typeof payload["kind"] === "string" ? payload["kind"] : "";
          const range = payload["range"] as SymbolGraphRange | undefined;
          // The n-gram lookup may return candidates from outside the query's
          // roots; discard them before scoring and the final Top-K slice.
          if (!name || !path || !kind || !range || !validRange(range) || (roots?.length && !pathInRoots(path, roots))) continue;
          const scored = scoreSymbolMatch(name.toLowerCase(), path.toLowerCase(), terms);
          if (!scored) continue;
          results.push({
            id,
            name,
            path,
            kind,
            range: { ...range },
            score: scored.score,
            match: scored.match,
            documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
          });
        }
        return results
          .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
          .slice(0, k);
      },

      async getDefinedSymbols(path) {
        const normalizedPath = assertGraphText(path, "File path");
        const file = fileNodes(normalizedPath)[0];
        if (!file) return [];
        return db.getEdges(file.id)
          .filter((edge) => edge.label === "defines")
          .flatMap((edge) => {
            const payload = db.getPayload(edge.targetId) as Record<string, unknown> | null;
            const range = payload?.["range"] as SymbolGraphRange | undefined;
            return payload?.["type"] === "symbol"
              && payload["active"] === true
              && typeof payload["name"] === "string"
              && typeof payload["path"] === "string"
              && typeof payload["kind"] === "string"
              && range
              && validRange(range)
              ? [{
                  id: edge.targetId,
                  name: payload["name"],
                  path: payload["path"],
                  kind: payload["kind"],
                  range: { ...range },
                  documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
                }]
              : [];
          })
          .toSorted((left, right) => left.range.startLine - right.range.startLine || left.range.startCharacter - right.range.startCharacter || left.name.localeCompare(right.name));
      },

      async getFileRelations(path) {
        const normalizedPath = assertGraphText(path, "File path");
        const file = fileNodes(normalizedPath)[0];
        if (!file) return null;
        const documentRevision = typeof file.payload["documentRevision"] === "string" ? file.payload["documentRevision"] : null;
        const generation = typeof file.payload["generation"] === "string" ? file.payload["generation"] : null;
        const imports: SymbolGraphFileRelations["imports"] = [];
        const connections: SymbolGraphFileRelations["connections"] = [];
        const associations: SymbolGraphFileRelations["associations"] = [];
        const relationPayloads: Record<string, unknown>[] = [];
        let danglingEdges = 0;
        for (const edge of db.getEdges(file.id)) {
          const payload = db.getPayload(edge.targetId) as Record<string, unknown> | null;
          if (!payload) {
            danglingEdges += 1;
            continue;
          }
          const line = payload["line"];
          const value = typeof payload["value"] === "string" ? payload["value"] : "";
          const revision = typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null;
          if (edge.label === "imports" && payload["type"] === "link" && payload["active"] === true && value && validLinkLine(Number(line))) {
            imports.push({ specifier: value, line: Number(line), documentRevision: revision });
            continue;
          }
          if (
            (edge.label === "connects" || edge.label === "associates")
            && payload["type"] === "link"
            && payload["active"] === true
            && value
            && typeof payload["callee"] === "string"
            && validLinkLine(Number(line))
          ) {
            const entry = { callee: payload["callee"], literal: value, line: Number(line), documentRevision: revision };
            if (edge.label === "connects") connections.push(entry);
            else associations.push(entry);
            continue;
          }
          if (edge.label === "references" || edge.label === "calls") {
            relationPayloads.push(payload);
            continue;
          }
          if (edge.label === "defines" && payload["type"] === "symbol") continue;
          if (edge.label === "defines" || edge.label === "imports" || edge.label === "connects" || edge.label === "associates") {
            danglingEdges += 1;
          }
        }
        const staleTargets = staleTargetPathsFor(relationPayloads);
        const references = relationPayloads
          .flatMap((payload) => {
            const record = relationFromPayload(payload, normalizedPath, staleTargets);
            return record?.kind === "references" ? [record] : [];
          })
          .toSorted((left, right) => left.line - right.line || left.value.localeCompare(right.value));
        const calls = relationPayloads
          .flatMap((payload) => {
            const record = relationFromPayload(payload, normalizedPath, staleTargets);
            return record?.kind === "calls" ? [record] : [];
          })
          .toSorted((left, right) => left.line - right.line || left.value.localeCompare(right.value));
        const byLine = <T extends { line: number; specifier?: string; literal?: string; callee?: string }>(left: T, right: T) => (
          left.line - right.line
          || (left.specifier ?? left.literal ?? "").localeCompare(right.specifier ?? right.literal ?? "")
          || (left.callee ?? "").localeCompare(right.callee ?? "")
        );
        return {
          path: normalizedPath,
          documentRevision,
          generation,
          extractor: Number.isSafeInteger(file.payload["extractor"]) ? file.payload["extractor"] as number : null,
          linksIncomplete: file.payload["linksIncomplete"] === true,
          imports: imports.toSorted(byLine),
          connections: connections.toSorted(byLine),
          associations: associations.toSorted(byLine),
          references,
          calls,
          danglingEdges,
        };
      },

      async connectionLiterals(values) {
        const found = new Set<string>();
        for (const value of new Set(values)) {
          if (db.indexedLookup({ type: "link", kind: "connects", value, active: true }, GRAPH_RESULT_CEILING).length > 0) found.add(value);
        }
        return found;
      },

      async findLinks(value) {
        const normalized = assertGraphText(value, "Link value");
        return lookup({ type: "link", value: normalized, active: true })
          .flatMap(({ payload }) => {
            const path = typeof payload["path"] === "string" ? payload["path"] : "";
            const kind = payload["kind"];
            const line = Number(payload["line"]);
            if (!path || !LINK_KINDS.has(kind as SymbolGraphLinkKind) || !validLinkLine(line)) return [];
            return [{
              path,
              kind: kind as SymbolGraphLinkKind,
              value: normalized,
              line,
              ...(typeof payload["callee"] === "string" ? { callee: payload["callee"] } : {}),
              documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
            }];
          })
          .toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind));
      },

      async findReferences(name, roots) {
        const normalized = assertGraphText(name, "Symbol name");
        const seen = new Set<number>();
        const rows = [
          ...lookup({ type: "link", kind: "references", value: normalized, active: true }),
          ...lookup({ type: "link", kind: "references", targetName: normalized, active: true }),
        ].filter(({ id }) => !seen.has(id) && seen.add(id));
        const staleTargets = staleTargetPathsFor(rows.map(({ payload }) => payload));
        return rows
          .flatMap(({ payload }) => {
            const path = typeof payload["path"] === "string" ? payload["path"] : "";
            if (!path || (roots?.length && !pathInRoots(path, roots))) return [];
            const record = relationFromPayload(payload, path, staleTargets);
            return record ? [record] : [];
          })
          .toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
      },

      async findCallers(name, roots) {
        const normalized = assertGraphText(name, "Callee name");
        const seen = new Set<number>();
        const rows = [
          ...lookup({ type: "link", kind: "calls", value: normalized, active: true }),
          ...lookup({ type: "link", kind: "calls", targetName: normalized, active: true }),
        ].filter(({ id }) => !seen.has(id) && seen.add(id));
        const staleTargets = staleTargetPathsFor(rows.map(({ payload }) => payload));
        return rows
          .flatMap(({ payload }) => {
            const path = typeof payload["path"] === "string" ? payload["path"] : "";
            if (!path || (roots?.length && !pathInRoots(path, roots))) return [];
            const record = relationFromPayload(payload, path, staleTargets);
            return record ? [record] : [];
          })
          .toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
      },

      async findCalls(caller, roots) {
        const normalized = assertGraphText(caller, "Caller name");
        const rows = lookup({ type: "link", kind: "calls", caller: normalized, active: true });
        const staleTargets = staleTargetPathsFor(rows.map(({ payload }) => payload));
        return rows
          .flatMap(({ payload }) => {
            const path = typeof payload["path"] === "string" ? payload["path"] : "";
            if (!path || (roots?.length && !pathInRoots(path, roots))) return [];
            const record = relationFromPayload(payload, path, staleTargets);
            return record ? [record] : [];
          })
          .toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
      },

      async catalogStats() {
        const counts = counters();
        const files = fileShape();
        return {
          symbolCount: counts.symbols,
          fileCount: counts.files,
          linkCount: counts.links,
          nodeCount: db.nodeCount(),
          languages: files.languages,
          paths: files.sortedPaths,
        };
      },

      async findImporters(path) {
        const target = normalizeGraphPath(assertGraphText(path, "File path"));
        const resolved = [...(importers().get(target) ?? [])];
        return {
          path: target,
          resolved: resolved.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
        };
      },

      async deleteSession(sessionId: string): Promise<void> {
        return enqueueWrite(() => {
          // Delete all events, blocks, and session nodes for this session
          const nodes = lookup({ sessionId }).filter(({ payload: p }) =>
            p["type"] !== "knowledge" && p["sessionId"] === sessionId,
          );
          let count = 0;
          for (const node of nodes) {
            db.delete(node.id);
            count++;
            if (count >= MAX_RETENTION_BATCH) break;
          }
          if (count > 0) persistence.commit();
        });
      },

      async runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }> {
        const cutoff = now.getTime() - policy.eventRetentionDays * 24 * 60 * 60 * 1000;
        return enqueueWrite(() => {
          const nodes = lookup({ type: "event" }).filter(({ payload: p }) => {
            if (p["type"] !== "event") return false;
            const at = p["at"] as number;
            return at < cutoff;
          });

          let removed = 0;
          for (const node of nodes) {
            db.delete(node.id);
            removed++;
            if (removed >= MAX_RETENTION_BATCH) break;
          }
          if (removed > 0) persistence.commit();
          return { removed };
        });
      },

      async close(): Promise<void> {
        return enqueueWrite(() => {
          persistence.close();
        });
      },
    };

    return { ...store, runBatch: (operation) => persistence.batch(operation) };
  } catch (error) {
    try { persistence.close(); } catch (closeError) {
      throw new AggregateError([error, closeError], "Knowledge store initialization and cleanup failed");
    }
    throw error;
  }
}

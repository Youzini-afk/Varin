/**
 * Background memory organizer (BC2). Reads durable source material — session
 * events, Pi conversation entries, and settled thread-run reports — then asks
 * the configured `models.memoryOrganizer` slot to narrate memory proposals.
 * The Host validates and commits proposals through the shared MemoryService;
 * coverage cursors live in the same store as the knowledge they produced, so
 * a restart resumes unfinished ranges instead of re-processing or losing them.
 *
 * Model split: deterministic dedupe/version checks stay in-process
 * (createKnowledgeIfAbsent over all statuses + supersede expected-revision
 * CAS); the `memory-organization` fast-decision purpose filters source
 * material when its binding is ready; the generative slot only narrates.
 * Model failures mark the claimed ranges `failed` and leave cursors in place —
 * they never commit empty successes.
 */

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSelectionMemories } from "./selection-memory.js";
import { MemoryInferenceError, memorySourceClaims, type MemoryInference, type MemoryInferenceBinding, type MemoryWork, type MemorySelectionRequest } from "./memory-inference.js";
import {
  estimateMemoryOrganizerInputTokens,
  mergeHarnessSettings,
  resolveHarnessModelSlot,
  memoryOrganizerOutputReservation,
  resolveFastDecisionPurpose,
  type HarnessFastDecisionPurposeStatus,
  type HarnessSettingsInput,
  type ModelSelection,
  type PiSessionEntry,
  type MemorySourceSpan,
} from "@varin/protocol";
import { botIdFromScopeId, isBotScopeId } from "../harness/owner-scope.js";
import {
  KnowledgeMutationError,
  MEMORY_NATURES,
  type Knowledge,
  type KnowledgeSource,
  type KnowledgeStore,
  type MemoryNature,
  type OrganizerProgress,
  type OrganizerProgressStatus,
  type OrganizerPreparedProposal,
} from "../knowledge/store.js";
import type { MemoryOwner, MemoryService } from "./memory-service.js";
import { entrySourceText, mergeSourceSpans, sourceRevision, uncoveredSourceSpans } from "./memory-sources.js";

// ── Boundaries ─────────────────────────────────────────────────────

const MAX_UNITS_PER_RUN = 8;
const MAX_EVENTS_PER_SESSION = 120;
const MAX_ENTRIES_PER_SESSION = 60;
const MAX_EXISTING_MATERIALS = 60;
const FAILED_RETRY_MS = 5 * 60_000;
const SETTLE_DEBOUNCE_MS = 2_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** A source must have room for at least a meaningful fragment and its label. */
const MIN_SEGMENT_CHARS = 64;

const MEMORY_ORGANIZER_SYSTEM = [
  "Extract durable memory proposals from the supplied work fragments and existing memories.",
  "Return a JSON object: {\"memories\":[{\"action\":\"new\",\"scope\":\"bot\",\"nature\":\"decision\",\"content\":\"...\",\"trigger\":\"...\",\"source\":\"u0\",\"quote\":\"...\"}]}. An empty memories array means no durable information to add.",
  "action is new, supplement, or correct. supplement and correct require target (k:<id>) from the supplied existing memories in the source scope; correct replaces it and supplement adds related information.",
  "Choose scope from the available scopes in the input. content holds the durable information; optional trigger describes when to recall it. Optional nature is experience, decision, preference, judgment, or instruction; instruction denotes an explicit user directive.",
  "source identifies the fragment (u<index>). quote is an exact supporting passage within that fragment, used to bind the memory to its original source.",
].join("\n");

// ── Deps and source shapes ─────────────────────────────────────────

export interface OrganizerRunSource {
  threadId: string;
  threadTitle: string;
  runId: string;
  sessionId: string | null;
  reportText: string;
  endedAt: string | null;
}

export interface MemoryOrganizerDeps {
  /** Trusted original Bot work owner. No Pi workspace-inference worker. */
  getInference(): MemoryInference;
  storeForScopeId(scopeId: string): Promise<KnowledgeStore | null>;
  /** Whether the scope's store file already exists (cheap — no store open). */
  hasStoreForScope(scopeId: string): boolean | Promise<boolean>;
  /** Bot scopes from the durable Bot registry. */
  listScopeIds(): Promise<string[]>;
  /** Sessions durably bound under a scope (thread runs incl. attached roots). */
  listScopeSessions(scopeId: string): Promise<string[]>;
  /** Terminal runs carrying a report under a scope. */
  listRunSources(scopeId: string): Promise<OrganizerRunSource[]>;
  canExecuteScope?(scopeId: string): Promise<boolean>;
  /** Returns the owning Bot scope, or null for ordinary Agent sessions. */
  scopeForSession(sessionId: string): Promise<string | null>;
  /** All native entries, including inactive branches; never wakes a live worker. */
  readEntries(sessionId: string): Promise<PiSessionEntry[]>;
  /**
   * Scope-level inference binding: when the `models.memoryOrganizer` slot is
   * unset, a `bot:<id>` scope inherits the Bot's own model so Bot memory keeps
   * organizing without a second configuration. Return null when nothing
   * binds — inference identity stays independent of workspace resources.
   */
  organizerModelForScope?(scopeId: string): Promise<ModelSelection | null>;
  memory: MemoryService;
  onError?(error: unknown): void;
  /** Test seam: millisecond clock. */
  now?(): number;
}

interface OrganizerUnit {
  key: string;
  label: string;
  texts: string[];
  source: KnowledgeSource;
  /** Coverage fingerprint for this exact source range+content. */
  sourceKey: string;
  /** Stable range identity for forgetting, independent of source text edits. */
  rangeKey: string;
  startEventCursor?: number;
  startEventPartial?: { id: number; offset: number };
  startEntryCursor?: string;
  startEntryPartial?: { id: string; offset: number };
  /** Next event cursor when this unit is covered. */
  eventCursor?: number;
  eventPartial?: { id: number; offset: number };
  /** Next entry cursor when this unit is covered. */
  entryCursor?: string;
  entryPartial?: { id: string; offset: number };
  runStartOffset?: number;
  runEndOffset?: number;
  hasMoreSource?: boolean;
}

interface OrganizerPromptScope {
  sourceScope: "bot";
  userMemoryEnabled: boolean;
}

interface OrganizerProposal {
  action: "new" | "supplement" | "correct";
  scope: "user" | "bot";
  nature?: MemoryNature;
  content: string;
  trigger?: string;
  target?: number;
  source?: string;
  quote: string;
}

// ── Helpers ────────────────────────────────────────────────────────

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const progressKeyForSession = (sessionId: string): string => `session:${sessionId}`;
const progressKeyForRun = (runId: string, part: number): string =>
  part === 0 ? `run:${runId}` : `run:${runId}:${part}`;

/**
 * The coverage fingerprint binds a progress row to the exact range+content it
 * covered. A terminal row whose sourceKey no longer matches is stale — the
 * source changed underneath it and must be reprocessed.
 */
const unitSourceKey = (scopeId: string, unit: OrganizerUnit | Omit<OrganizerUnit, "sourceKey" | "rangeKey">): string =>
  createHash("sha256").update(JSON.stringify([
    scopeId, unit.key, unit.source.spans?.map((span) => [span.kind, span.id, span.sessionId, span.scopeId, span.threadId, span.revision, span.start, span.end]), unit.texts,
    ...(unit.runStartOffset === undefined ? [] : [unit.runStartOffset, unit.runEndOffset]),
  ])).digest("hex");
const unitRangeKey = (scopeId: string, key: string, start: unknown, end: unknown): string =>
  createHash("sha256").update(JSON.stringify([scopeId, key, start, end])).digest("hex");
const preparedProposalKey = (source: KnowledgeSource, proposal: OrganizerPreparedProposal): string | undefined =>
  source.key ? createHash("sha256").update(JSON.stringify([
    source.key, proposal.action, proposal.scope, proposal.content, proposal.trigger, proposal.target,
    proposal.spans?.map((span) => [span.kind, span.id, span.sessionId, span.scopeId, span.threadId, span.revision, span.start, span.end]),
  ])).digest("hex") : undefined;

/** Terminal coverage for this exact source content — the transaction is done. */
const isCovered = (progress: OrganizerProgress | undefined, sourceKey: string): boolean =>
  progress !== undefined
  && (progress.status === "formed" || progress.status === "reviewed-empty")
  && progress.sourceKey === sourceKey;

const retryable = (progress: OrganizerProgress | undefined, now: number, force = false): boolean => {
  if (!progress) return true;
  if (progress.status === "failed") return force || now - progress.updatedAt >= FAILED_RETRY_MS;
  // "processing"/"prepared" rows are unfinished claims — a restart must resume them.
  return progress.status !== "formed" && progress.status !== "reviewed-empty";
};

/** Keep UTF-16 surrogate pairs intact while advancing a durable text offset. */
const takePrefix = (text: string, start: number, capacity: number): number => {
  let end = Math.min(text.length, start + capacity);
  if (end < text.length && end > start
    && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF
    && text.charCodeAt(end) >= 0xDC00 && text.charCodeAt(end) <= 0xDFFF) end -= 1;
  return end - start;
};

/**
 * Model output that does not parse as the organizer envelope is a transport/
 * prompt failure — return null so the range marks `failed` and retries rather
 * than advancing the cursor over material that was never judged.
 */
const parseProposals = (text: string): OrganizerProposal[] | null => {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
  const memories = record(parsed)["memories"];
  if (!Array.isArray(memories)) return null;
  const proposals: OrganizerProposal[] = [];
  for (const raw of memories) {
    const item = record(raw);
    const action = item["action"];
    const scope = item["scope"];
    const content = typeof item["content"] === "string" ? item["content"].trim() : "";
    if (!content) return null;
    if (action !== "new" && action !== "supplement" && action !== "correct") return null;
    if (scope !== "user" && scope !== "bot") return null;
    const nature = typeof item["nature"] === "string" && (MEMORY_NATURES as readonly string[]).includes(item["nature"])
      ? item["nature"] as MemoryNature
      : undefined;
    const trigger = typeof item["trigger"] === "string" ? item["trigger"] : undefined;
    const target = typeof item["target"] === "string" && /^k:\d+$/u.test(item["target"])
      ? Number(item["target"].slice(2))
      : undefined;
    const source = typeof item["source"] === "string" ? item["source"] : undefined;
    const quote = typeof item["quote"] === "string" ? item["quote"] : "";
    if (!quote.trim() || !source || !/^u\d+$/.test(source) || (action !== "new" && target === undefined)) return null;
    proposals.push({
      quote,
      action,
      scope,
      ...(nature ? { nature } : {}),
      content,
      ...(trigger ? { trigger } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(source ? { source } : {}),
    });
  }
  return proposals;
};

// ── Service ────────────────────────────────────────────────────────

export function createMemoryOrganizer(deps: MemoryOrganizerDeps) {
  const now = () => deps.now?.() ?? Date.now();
  const queued = new Set<string>();
  const forced = new Set<string>();
  const running = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const reservedSources = new Map<string, MemorySourceSpan[]>();
  const suspendedScopes = new Set<string>();
  const idleWaiters = new Map<string, Set<() => void>>();
  const pendingTasks = new Set<Promise<unknown>>();
  let disposed = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  const report = (error: unknown): void => {
    if (disposed) return;
    try { deps.onError?.(error); } catch { /* observation only */ }
  };
  const track = (task: Promise<unknown>): void => {
    pendingTasks.add(task);
    void task.catch(report).finally(() => pendingTasks.delete(task));
  };

  interface ResolvedOrganizerSettings {
    disabled?: boolean;
    autoOrganize: { user: boolean; bot: boolean };
    model: ModelSelection | null;
    /** Resolved (configurationId-bearing) fast-decision status for this run. */
    fastDecision: HarnessFastDecisionPurposeStatus | null;
  }

  const readHarnessSettings = async (): Promise<ResolvedOrganizerSettings> => {
    const inference = deps.getInference();
    const empty: ResolvedOrganizerSettings = {
      autoOrganize: { user: false, bot: false },
      model: null,
      fastDecision: null,
    };
    const document = await inference.settings();
    const globalHarness = record(record(document).harness) as HarnessSettingsInput;
    // Background inference resolves global configuration only — a project's
    // layer can disable organizing for its scope but never picks the model.
    const settings = mergeHarnessSettings(globalHarness, {});
    if (settings.models.memoryOrganizer?.enabled === false) return { ...empty, disabled: true };
    let fastDecision: HarnessFastDecisionPurposeStatus | null = null;
    try {
      if (resolveFastDecisionPurpose(settings.fastDecision, "memory-organization").status === "ready") {
        const status = await inference.describeDecision();
        if (status?.status === "ready") fastDecision = status;
      }
    } catch { fastDecision = null; }
    return {
      autoOrganize: settings.knowledge.autoOrganize,
      model: resolveHarnessModelSlot("memoryOrganizer", settings.models, null),
      fastDecision,
    };
  };

  const ownerFor = (scope: "user" | "bot", scopeId: string): MemoryOwner | null => {
    if (scope === "user") return { scope: "user", ownerId: null };
    return isBotScopeId(scopeId) ? { scope: "bot", ownerId: botIdFromScopeId(scopeId) } : null;
  };

  interface ProgressPatch {
    workId?: string;
    coveredSources?: MemorySourceSpan[];
    eventCursor?: number;
    eventPartial?: OrganizerProgress["eventPartial"] | null;
    entryCursor?: string;
    entryPartial?: OrganizerProgress["entryPartial"] | null;
    runEndOffset?: number;
    produced?: number[];
    lastError?: string;
    /** Set the coverage fingerprint; `null` clears a stale one. */
    sourceKey?: string | null;
    /** Set durable prepared proposals; `null` clears them (terminal rows). */
    proposals?: OrganizerPreparedProposal[] | null;
    preparedSource?: KnowledgeSource | null;
    /** Frozen end cursors for a prepared session range. */
    preparedRange?: OrganizerProgress["preparedRange"] | null;
  }

  const putProgress = async (
    store: KnowledgeStore,
    key: string,
    status: OrganizerProgressStatus,
    patch: ProgressPatch = {},
  ): Promise<void> => {
    const existing = await store.getOrganizerProgress(key);
    const sourceKey = patch.sourceKey !== undefined ? patch.sourceKey
      : existing?.sourceKey !== undefined ? existing.sourceKey : null;
    const proposals = patch.proposals !== undefined ? patch.proposals
      : existing?.proposals !== undefined ? existing.proposals : null;
    const preparedSource = patch.preparedSource !== undefined ? patch.preparedSource
      : existing?.preparedSource !== undefined ? existing.preparedSource : null;
    const preparedRange = patch.preparedRange !== undefined ? patch.preparedRange
      : existing?.preparedRange !== undefined ? existing.preparedRange : null;
    const eventPartial = patch.eventPartial !== undefined ? patch.eventPartial
      : existing?.eventPartial !== undefined ? existing.eventPartial : null;
    const entryPartial = patch.entryPartial !== undefined ? patch.entryPartial
      : existing?.entryPartial !== undefined ? existing.entryPartial : null;
    await store.putOrganizerProgress({
      key,
      status,
      ...((patch.workId ?? existing?.workId) ? { workId: (patch.workId ?? existing?.workId)! } : {}),
      coveredSources: mergeSourceSpans([...(existing?.coveredSources ?? []), ...(patch.coveredSources ?? []),
        ...((status === "formed" || status === "reviewed-empty") ? existing?.preparedSource?.spans ?? [] : [])]),
      ...(sourceKey !== null ? { sourceKey } : {}),
      ...(patch.eventCursor !== undefined ? { eventCursor: patch.eventCursor } : existing?.eventCursor !== undefined ? { eventCursor: existing.eventCursor } : {}),
      ...(eventPartial !== null ? { eventPartial } : {}),
      ...(patch.entryCursor !== undefined ? { entryCursor: patch.entryCursor } : existing?.entryCursor ? { entryCursor: existing.entryCursor } : {}),
      ...(entryPartial !== null ? { entryPartial } : {}),
      ...(patch.runEndOffset !== undefined ? { runEndOffset: patch.runEndOffset }
        : existing?.runEndOffset !== undefined ? { runEndOffset: existing.runEndOffset } : {}),
      ...(patch.produced !== undefined ? { produced: patch.produced } : existing?.produced ? { produced: existing.produced } : {}),
      ...(proposals !== null ? { proposals } : {}),
      ...(preparedSource !== null ? { preparedSource } : {}),
      ...(preparedRange !== null ? { preparedRange } : {}),
      updatedAt: now(),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    });
  };

  // ── Source collection ────────────────────────────────────────────

  const collectSessionUnit = async (
    store: KnowledgeStore,
    scopeId: string,
    sessionId: string,
    progress: OrganizerProgress | undefined,
    timestamp: number,
    unitChars: number,
    force: boolean,
    recordEmpty = true,
  ): Promise<OrganizerUnit | null> => {
    const key = progressKeyForSession(sessionId);
    const texts: string[] = [];
    const spans: MemorySourceSpan[] = [];
    let eventCursor = progress?.eventCursor;
    let eventPartial: OrganizerProgress["eventPartial"];
    let entryCursor = progress?.entryCursor;
    let entryPartial: OrganizerProgress["entryPartial"];
    const frozen = progress?.status === "prepared" ? progress.preparedSource?.spans : undefined;
    const capacity = frozen ? Number.MAX_SAFE_INTEGER : unitChars;
    let chars = 0;
    const [events, entries, localMemories, userMemories] = await Promise.all([
      store.listEvents({ sessionId }), deps.readEntries(sessionId),
      store.listKnowledge({}), deps.memory.list({ scope: "user", ownerId: null }),
    ]);
    const covered = [...(progress?.coveredSources ?? []), ...(!frozen ? reservedSources.get(scopeId) ?? [] : []), ...[...localMemories, ...userMemories]
      .flatMap((item) => item.source?.spans ?? [])];
    const materials = [
      ...events.map((event) => ({ span: { kind: "event" as const, id: String(event.id), scopeId, sessionId,
        revision: sourceRevision(event.text), start: 0, end: event.text.length }, text: event.text, label: event.kind })),
      ...entries.filter((entry) => entry.type === "message" && entry.message.role !== "toolResult").map((entry) => {
        const text = entrySourceText(entry);
        return { span: { kind: "pi-entry" as const, id: entry.id, sessionId,
          revision: sourceRevision(text), start: 0, end: text.length }, text,
        label: entry.type === "message" ? entry.message.role : entry.type };
      }),
    ];
    const pending = frozen ? frozen.map((span) => {
      const material = materials.find((row) => row.span.kind === span.kind && row.span.id === span.id);
      if (!material) throw new Error(`Prepared source is unavailable: ${span.kind} ${span.id}`);
      if (material.span.revision !== span.revision || span.end > material.text.length) {
        throw new SourceChangedError(`Prepared source changed: ${span.kind} ${span.id}`);
      }
      return { ...material, span };
    }) : materials.flatMap((material) => uncoveredSourceSpans(material.span, covered)
      .filter((span) => span.end > span.start).map((span) => ({ ...material, span })));
    let hasMoreSource = false;
    let eventCount = 0;
    let entryCount = 0;
    for (const [index, material] of pending.entries()) {
      const { span, text, label } = material;
      const prefix = `[${label}] `;
      const available = capacity - chars - prefix.length;
      const taken = available > 0 ? takePrefix(text, span.start, Math.min(available, span.end - span.start)) : 0;
      if (taken <= 0) {
        if (chars === 0) throw new Error(`Organizer model cannot fit source ${span.id}`);
        hasMoreSource = true;
        break;
      }
      texts.push(prefix + text.slice(span.start, span.start + taken));
      spans.push({ ...span, end: span.start + taken });
      chars += prefix.length + taken;
      if (span.kind === "event") {
        eventCount += 1;
        if (span.start + taken < text.length) eventPartial = { id: Number(span.id), offset: span.start + taken };
        else { eventCursor = Number(span.id); eventPartial = undefined; }
      } else {
        entryCount += 1;
        if (span.start + taken < text.length) entryPartial = { id: span.id, offset: span.start + taken };
        else { entryCursor = span.id; entryPartial = undefined; }
      }
      if (taken < span.end - span.start || (!frozen && (eventCount >= MAX_EVENTS_PER_SESSION || entryCount >= MAX_ENTRIES_PER_SESSION))) {
        hasMoreSource = taken < span.end - span.start || index < pending.length - 1;
        break;
      }
    }
    if (texts.length === 0) {
      if (progress?.status === "prepared") {
        throw new Error(`Prepared source content is unavailable for session ${sessionId}`);
      }
      if (recordEmpty && !(reservedSources.get(scopeId)?.length) && (!progress || progress.status === "failed" || progress.status === "processing")) {
        await mutationSettings(scopeId);
        await putProgress(store, key, "reviewed-empty", {
          eventPartial: null,
          entryPartial: null,
          sourceKey: null,
          proposals: null,
          preparedSource: null,
          preparedRange: null,
        });
      }
      return null;
    }
    const sourceEntryId = entryPartial?.id ?? entryCursor;
    const unit = {
      key,
      label: `session ${sessionId}`,
      texts,
      source: { kind: "memory-organizer", sessionId, spans,
        ...(sourceEntryId ? { entryId: sourceEntryId } : {}) },
      ...(progress?.eventCursor !== undefined ? { startEventCursor: progress.eventCursor } : {}),
      ...(progress?.eventPartial !== undefined ? { startEventPartial: progress.eventPartial } : {}),
      ...(progress?.entryCursor !== undefined ? { startEntryCursor: progress.entryCursor } : {}),
      ...(progress?.entryPartial !== undefined ? { startEntryPartial: progress.entryPartial } : {}),
      ...(eventCursor !== undefined ? { eventCursor } : {}),
      ...(eventPartial !== undefined ? { eventPartial } : {}),
      ...(entryCursor !== undefined ? { entryCursor } : {}),
      ...(entryPartial !== undefined ? { entryPartial } : {}),
      ...(hasMoreSource ? { hasMoreSource } : {}),
    };
    const sourceKey = unitSourceKey(scopeId, unit);
    // A failed original range cannot impose its backoff on later source bytes in this session.
    if (progress?.status === "failed" && progress.sourceKey === sourceKey && !retryable(progress, timestamp, force)) return null;
    return {
      ...unit,
      sourceKey,
      rangeKey: unitRangeKey(scopeId, key, spans.map((span) => [span.kind, span.id, span.sessionId, span.scopeId, span.threadId, span.start, span.end]), null),
    };
  };

  const collectRunUnits = async (
    store: KnowledgeStore,
    scopeId: string,
    source: OrganizerRunSource,
    timestamp: number,
    progress: Map<string, OrganizerProgress>,
    unitChars: number,
    force: boolean,
  ): Promise<OrganizerUnit[]> => {
    // Oversized reports subdivide into per-chunk units; each part carries its
    // own progress row so coverage survives a restart mid-report.
    const chunks: Array<{ text: string; start: number; end: number }> = [];
    let start = 0;
    do {
      const key = progressKeyForRun(source.runId, chunks.length);
      const frozenEnd = progress.get(key)?.runEndOffset;
      let end: number;
      if (frozenEnd !== undefined && frozenEnd > start && frozenEnd <= source.reportText.length) {
        end = frozenEnd;
      } else {
        const capEnd = Math.min(source.reportText.length, start + unitChars);
        const newline = capEnd < source.reportText.length
          ? source.reportText.lastIndexOf("\n", capEnd) : -1;
        const preferred = newline >= start + Math.floor(unitChars / 2) ? newline : capEnd;
        const taken = takePrefix(source.reportText, start, preferred - start);
        if (taken <= 0 && start < source.reportText.length) {
          throw new Error("Memory organizer source segment cannot fit one character");
        }
        end = start + taken;
      }
      chunks.push({ text: source.reportText.slice(start, end), start, end });
      start = end;
    } while (start < source.reportText.length);
    const units: OrganizerUnit[] = [];
    for (const [part, chunk] of chunks.entries()) {
      const key = progressKeyForRun(source.runId, part);
      const texts = [
        `Task report for "${source.threadTitle}"${chunks.length > 1 ? ` (part ${part + 1})` : ""}:`,
        chunk.text,
      ];
      const unit = {
        key,
        label: `run ${source.runId} (${source.threadTitle})`,
        texts,
        source: {
          kind: "memory-organizer",
          threadId: source.threadId,
          runId: source.runId,
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          spans: [{ kind: "run-report" as const, id: source.runId, scopeId, threadId: source.threadId,
            revision: sourceRevision(source.reportText), start: chunk.start, end: chunk.end }],
        },
        runStartOffset: chunk.start,
        runEndOffset: chunk.end,
      };
      const sourceKey = unitSourceKey(scopeId, unit);
      if ((reservedSources.get(scopeId) ?? []).some(held => unit.source.spans.some(span => memorySourceClaims([span])[0]!.source === memorySourceClaims([held])[0]!.source && span.start < held.end && held.start < span.end))) continue;
      const row = progress.get(key);
      // Terminal coverage only stands while the fingerprint matches — a report
      // rewritten under the same run id reopens the range. Failed rows wait
      // out their backoff before reclaiming.
      if (isCovered(row, sourceKey)) continue;
      if (row?.status === "failed" && !retryable(row, timestamp, force)) continue;
      units.push({ ...unit, sourceKey, rangeKey: unitRangeKey(scopeId, key, chunk.start, chunk.end) });
    }
    return units;
  };

  const collectUnits = async (
    store: KnowledgeStore,
    scopeId: string,
    unitChars: number,
    force: boolean,
  ): Promise<OrganizerUnit[]> => {
    const timestamp = now();
    const rows = await store.listOrganizerProgress();
    const progress = new Map(rows.map((row) => [row.key, row]));
    const units: OrganizerUnit[] = [];

    for (const source of await deps.listRunSources(scopeId)) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      units.push(...await collectRunUnits(store, scopeId, source, timestamp, progress, unitChars, force));
    }

    const sessionIds = new Set<string>([
      ...(await store.listEventSessionIds()),
      ...(await deps.listScopeSessions(scopeId)),
    ]);
    for (const sessionId of [...sessionIds].sort()) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      const row = progress.get(progressKeyForSession(sessionId));
      try {
        const unit = await collectSessionUnit(store, scopeId, sessionId, row, timestamp, unitChars, force);
        if (unit) units.push(unit);
      } catch (error) {
        if (row?.status !== "prepared") {
          await putProgress(store, progressKeyForSession(sessionId), "failed", { lastError: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        await putProgress(store, row.key, error instanceof SourceChangedError ? "pending" : "prepared", {
          ...(error instanceof SourceChangedError ? { proposals: null, preparedSource: null, preparedRange: null, sourceKey: null } : {}),
          lastError: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof SourceChangedError) queued.add(scopeId);
      }
    }
    return units.slice(0, MAX_UNITS_PER_RUN);
  };

  // ── Judgment + narration ─────────────────────────────────────────

  const buildPrompt = (
    units: readonly OrganizerUnit[],
    existing: readonly Knowledge[],
    scope: OrganizerPromptScope,
  ): string => {
    const sections: string[] = [
      "# Memory scope",
      JSON.stringify({
        sourceScope: scope.sourceScope,
        availableScopes: [scope.sourceScope, ...(scope.userMemoryEnabled ? ["user"] : [])],
      }),
      "# Source fragments",
    ];
    for (const [index, unit] of units.entries()) {
      sections.push(`## u${index} — ${unit.label}\n${unit.texts.join("\n")}`);
    }
    if (existing.length > 0) {
      sections.push(`# Existing memories (${scope.sourceScope})`);
      for (const item of existing) {
        sections.push(`- k:${item.id} [${item.status}${item.nature ? `/${item.nature}` : ""}] ${item.content}`);
      }
    }
    return sections.join("\n\n");
  };

  // ── Capacity ────────────────────────────────────────────────────

  interface BatchBudget { inputTokens: number; maxOutputTokens: number; unitChars: number }

  /** The provider descriptor supplies the hard context/output dimensions. */
  const resolveBudget = async (model: ModelSelection, scope: OrganizerPromptScope): Promise<BatchBudget> => {
    const descriptor = await deps.getInference().model(model);
    if (!descriptor) throw new Error(`Memory organizer model capacity is unavailable: ${model.providerId}/${model.modelId}`);
    const maxOutputTokens = memoryOrganizerOutputReservation(descriptor.contextWindow ?? 0, descriptor.maxTokens);
    const inputTokens = (descriptor.contextWindow ?? 0) - maxOutputTokens;
    const overhead = estimateMemoryOrganizerInputTokens(MEMORY_ORGANIZER_SYSTEM, buildPrompt([], [], scope));
    if (inputTokens <= overhead + MIN_SEGMENT_CHARS) {
      throw new Error(`Memory organizer model context cannot hold the organizer contract: ${model.providerId}/${model.modelId}`);
    }
    return {
      inputTokens,
      maxOutputTokens,
      // Collect generously for a single source. Full-prompt admission below
      // shrinks this segment when UTF-8 density or existing memories require it.
      unitChars: Math.max(MIN_SEGMENT_CHARS, Math.floor((inputTokens - overhead) * 1.5)),
    };
  };

  const selectPrompt = (
    units: readonly OrganizerUnit[],
    memories: readonly Knowledge[],
    inputTokens: number,
    scope: OrganizerPromptScope,
  ): { prompt: string; presented: Knowledge[] } | null => {
    const fits = (prompt: string) => estimateMemoryOrganizerInputTokens(MEMORY_ORGANIZER_SYSTEM, prompt) <= inputTokens;
    const sourceOnly = buildPrompt(units, [], scope);
    if (!fits(sourceOnly)) return null;
    const presented: Knowledge[] = [];
    for (const item of memories.slice(0, MAX_EXISTING_MATERIALS)) {
      if (fits(buildPrompt(units, [...presented, item], scope))) presented.push(item);
    }
    return { prompt: buildPrompt(units, presented, scope), presented };
  };

  /**
   * The narrating model for a scope: the `models.memoryOrganizer` slot wins;
   * a Bot scope falls back to the Bot's own model so `bot:<id>` memory
   * organizes without duplicating configuration.
   */
  const modelForScope = async (settings: ResolvedOrganizerSettings, scopeId: string): Promise<{
    selection: ModelSelection; source: "configured" | "bot";
  } | null> => {
    if (settings.disabled) return null;
    if (settings.model) return { selection: settings.model, source: "configured" };
    const botModel = await deps.organizerModelForScope?.(scopeId);
    return botModel ? { selection: botModel, source: "bot" } : null;
  };

  // ── Commit ───────────────────────────────────────────────────────

  const commitProposal = async (
    scopeId: string,
    proposal: OrganizerPreparedProposal,
    settings: ResolvedOrganizerSettings,
    source: KnowledgeSource,
    existingMemories: readonly Knowledge[],
    expectedRevision: string,
  ): Promise<number | null> => {
    const owner = ownerFor(proposal.scope, scopeId);
    if (!owner) return null;
    const proposalKey = preparedProposalKey(source, proposal);
    const proposalSource: KnowledgeSource = { ...source, ...(proposalKey ? { proposalKey } : {}),
      ...(proposal.spans ? { spans: proposal.spans } : {}) };
    // A source-scope switch does not authorize the user store — inferred
    // proposals may only land there when organizing user memory is enabled.
    if (owner.scope === "user" && !settings.autoOrganize.user) return null;
    // A previous attempt may have committed this proposal before crashing or
    // failing on a later row. Recover its durable receipt from provenance so
    // terminal progress lists every memory formed by the source range.
    const alreadyCommitted = existingMemories.find((item) => item.status === "accepted"
      && item.invalidAt === undefined
      && item.source?.kind === "memory-organizer"
      && (proposalKey ? item.source.proposalKey === proposalKey
        : source.key !== undefined && item.source.key === source.key
          && item.content.trim() === proposal.content.trim()));
    if (alreadyCommitted && alreadyCommitted.scope === owner.scope) return alreadyCommitted.id;
    const nature = proposal.nature !== undefined && (MEMORY_NATURES as readonly string[]).includes(proposal.nature)
      ? proposal.nature as MemoryNature
      : undefined;
    if (proposal.action === "new") {
      const result = await deps.memory.remember(owner, {
        content: proposal.content,
        ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
        ...(nature ? { nature } : {}),
        source: proposalSource,
        commit: "accepted",
        expectedRevision,
      });
      return result.created || (proposalKey ? result.item.source?.proposalKey === proposalKey
        : result.item.source?.key === source.key && source.key !== undefined)
        ? result.item.id : null;
    }
    // supplement/correct: targets came from the source scope's presented
    // memory list; a cross-scope numeric id must never address an unrelated
    // row in another store.
    if (proposal.target === undefined || proposal.scope !== "bot") return null;
    const item = existingMemories.find((memory) => memory.id === proposal.target);
    const expectedTarget = proposal.expectedTarget;
    if (!item || !expectedTarget || item.content !== expectedTarget.content
      || item.trigger !== expectedTarget.trigger || item.status !== expectedTarget.status
      || (item.invalidAt ?? null) !== (expectedTarget.invalidAt ?? null)) return null;
    if (proposal.action === "supplement") {
      const result = await deps.memory.remember(owner, {
        content: proposal.content,
        ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
        ...(nature ? { nature } : {}),
        source: proposalSource,
        supplements: item.id,
        commit: "accepted",
        expectedRevision,
      });
      return result.created || (proposalKey ? result.item.source?.proposalKey === proposalKey
        : result.item.source?.key === source.key && source.key !== undefined)
        ? result.item.id : null;
    }
    // Compare against the revision shown to the model, not a fresh read taken
    // after it answered (which would authorize overwriting intervening edits).
    if (item.invalidAt !== undefined || item.status !== "accepted") return null;
    const corrected = await deps.memory.correct(owner, item.id, {
      content: proposal.content,
      ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
      ...(nature ? { nature } : {}),
      source: proposalSource,
      expected: expectedTarget,
    }).catch((error: unknown) => {
      if (error instanceof KnowledgeMutationError && error.code === "conflict") return null;
      throw error;
    });
    return corrected?.id ?? null;
  };

  class SourceChangedError extends Error {}

  const assertSourceCurrent = async (store: KnowledgeStore, scopeId: string, unit: OrganizerUnit, _unitChars: number): Promise<void> => {
    // Re-read only to verify the frozen ranges; never re-collect/re-number today's materials.
    for (const span of unit.source.spans ?? []) {
      let text: string | undefined;
      if (span.kind === "run-report") text = (await deps.listRunSources(scopeId)).find(run => run.runId === span.id)?.reportText;
      else if (span.kind === "event") text = (await store.listEvents({ sessionId: span.sessionId ?? unit.source.sessionId! })).find(event => String(event.id) === span.id)?.text;
      else if (span.kind === "pi-entry") {
        const entry = (await deps.readEntries(span.sessionId ?? unit.source.sessionId!)).find(entry => entry.id === span.id);
        if (entry) text = entrySourceText(entry);
      }
      if (text === undefined) throw new Error(`Original organizer source is unavailable: ${unit.key}`);
      if (sourceRevision(text) !== span.revision || span.end > text.length) throw new SourceChangedError(`Original organizer source changed: ${unit.key}`);
    }
  };

  /** A crash can leave memory durable while its source progress is still
   * prepared. If the Pi source is now unavailable, recover the receipt from
   * the committed memory's range identity; never invent an uncommitted write. */
  const settleCommittedPrepared = async (store: KnowledgeStore, scopeId: string): Promise<boolean> => {
    let settled = false;
    for (const row of await store.listOrganizerProgress()) {
      if (row.status !== "prepared" || row.proposals === undefined) continue;
      const source = row.preparedSource;
      if (!source?.key || !row.sourceKey) continue;
      const produced = new Set<number>();
      let complete = true;
      for (const proposal of row.proposals) {
        const owner = ownerFor(proposal.scope, scopeId);
        if (!owner) { complete = false; break; }
        const proposalKey = preparedProposalKey(source, proposal);
        const matches = (await deps.memory.list(owner)).filter((item) =>
          item.status === "accepted" && item.source?.kind === "memory-organizer"
          && (proposalKey ? item.source.proposalKey === proposalKey
            : item.source.key === source.key && item.content.trim() === proposal.content.trim()));
        if (matches.length === 0) { complete = false; break; }
        produced.add(matches[0]!.id);
      }
      // Some proposals may still need the original source for a safe replay.
      // Leave that receipt prepared. Only call it unavailable when the run
      // really has disappeared; a healthy pending commit is not a source error.
      if (!complete) {
        if (source.runId && !(await deps.listRunSources(scopeId)).some((run) => run.runId === source.runId)) {
          await putProgress(store, row.key, "prepared", {
            lastError: "Prepared source is unavailable and not all proposals were committed; restore the source or retry when it returns",
          });
        }
        continue;
      }
      await putProgress(store, row.key, produced.size > 0 ? "formed" : "reviewed-empty", {
        ...(row.preparedRange?.eventCursor !== undefined ? { eventCursor: row.preparedRange.eventCursor } : {}),
        eventPartial: row.preparedRange?.eventPartial ?? null,
        ...(row.preparedRange?.entryCursor !== undefined ? { entryCursor: row.preparedRange.entryCursor } : {}),
        entryPartial: row.preparedRange?.entryPartial ?? null,
        produced: [...produced], sourceKey: row.sourceKey,
        proposals: null, preparedSource: null, preparedRange: null,
      });
      settled = true;
    }
    return settled;
  };

  // ── Scope run ────────────────────────────────────────────────────

  interface OrganizerRecipe {
    binding: MemoryInferenceBinding;
    units: OrganizerUnit[];
    presented: Knowledge[];
    promptScope: OrganizerPromptScope;
    budget: BatchBudget;
    decisionStatus: HarnessFastDecisionPurposeStatus | null;
    system: string;
  }
  const mutationSettings = async (scopeId: string) => {
    const settings = await readHarnessSettings();
    if (disposed || suspendedScopes.has(scopeId) || settings.disabled || !settings.autoOrganize.bot
      || deps.canExecuteScope && !await deps.canExecuteScope(scopeId)) {
      throw new MemoryInferenceError("memory-work-suspended", "Bot memory mutations are currently suspended");
    }
    return settings;
  };
  const recordWorkError = async (store: KnowledgeStore, units: OrganizerUnit[], error: unknown, workId?: string) => {
    const lastError = error instanceof Error ? error.message : String(error);
    for (const unit of units) {
      const row = await store.getOrganizerProgress(unit.key);
      if (!row || row.sourceKey !== unit.sourceKey || workId && row.workId !== workId
        || isCovered(row, unit.sourceKey) || row.lastError === lastError)
        continue;
      await putProgress(store, unit.key, row.status === "prepared" ? "prepared" : "failed", { lastError });
    }
  };
  const commitPrepared = async (store: KnowledgeStore, scopeId: string, preparedUnits: Array<{
    unit: OrganizerUnit;
    proposals: OrganizerPreparedProposal[];
  }>, unitChars: number, narratedRevision: string | null = null): Promise<void> => {
    // The original MemoryService is the only writer. Re-read enable gates before commit.
    const currentSettings = await readHarnessSettings();
    if (suspendedScopes.has(scopeId) || (deps.canExecuteScope && !await deps.canExecuteScope(scopeId)))
      return;
    if (!currentSettings.autoOrganize.bot)
      return;
    if (narratedRevision !== null && narratedRevision !== store.knowledgeRevision()) {
      throw new KnowledgeMutationError("conflict", "Memory changed while the organizer was narrating proposals");
    }
    const owner = ownerFor("bot", scopeId)!;
    const existing = await deps.memory.list(owner, { activeOnly: true });
    let revision = store.knowledgeRevision();
    const userOwner: MemoryOwner = { scope: "user", ownerId: null };
    let userRevision = currentSettings.autoOrganize.user ? await deps.memory.revision(userOwner) : "";
    for (const { unit, proposals } of preparedUnits) {
      await assertSourceCurrent(store, scopeId, unit, unitChars);
      const produced: number[] = [];
      for (const proposal of proposals) {
        const currentSettings = await mutationSettings(scopeId);
        if (proposal.scope === "user" && !currentSettings.autoOrganize.user)
          continue;
        if (revision !== store.knowledgeRevision()) {
          throw new KnowledgeMutationError("conflict", "Memory changed while the organizer was committing proposals");
        }
        const id = await commitProposal(scopeId, proposal, currentSettings, unit.source, existing, proposal.scope === "user" ? userRevision : revision);
        if (id !== null)
          produced.push(id);
        revision = store.knowledgeRevision();
        if (proposal.scope === "user" && currentSettings.autoOrganize.user) {
          userRevision = await deps.memory.revision(userOwner);
        }
      }
      await putProgress(store, unit.key, produced.length > 0 ? "formed" : "reviewed-empty", {
        ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
        eventPartial: unit.eventPartial ?? null,
        ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
        entryPartial: unit.entryPartial ?? null,
        produced,
        sourceKey: unit.sourceKey,
        proposals: null,
        preparedSource: null,
        preparedRange: null,
      });
    }
  };
  const prepareWork = async (store: KnowledgeStore, scopeId: string, original: MemoryWork<OrganizerRecipe>): Promise<void> => {
    // This writer-incarnation token fences only this preparation attempt.
    // Across reopen, original source/target snapshots and proposal CAS remain authoritative.
    const narratedRevision = store.knowledgeRevision();
    const inference = deps.getInference();
    let work = original;
    const recipe = work.recipe;
    const units = recipe.units;
    const rows = new Map((await store.listOrganizerProgress()).map(row => [row.key, row]));
    if (units.every(unit => isCovered(rows.get(unit.key), unit.sourceKey) || rows.get(unit.key)?.status === "prepared" && rows.get(unit.key)?.sourceKey === unit.sourceKey)) {
      await inference.finish(work);
      return;
    }
    work = await inference.decide(work, {
      purpose: "memory-organization", goal: "Decide which durable work fragments carry memory-worthy content",
      materials: units.map((unit, index) => ({ id: `u${index}`, label: unit.label, text: unit.texts.join("\n") })),
      questions: units.map((_, index) => ({
        id: `u${index}`, kind: "judge" as const,
        instructions: `Does material u${index} contain information useful beyond its immediate activity, such as a decision, requirement, preference, judgment, commitment, or notable outcome?`,
        criteria: { yes: "At least one durable fact survives beyond this task", no: "Only routine tool output or transient status" }
      })),
    }, recipe.decisionStatus);
    const judged = work.decision!.map(index => units[index]!);
    if (judged.some(unit => !unit))
      throw new Error("Original memory decision referenced an unknown source");
    for (const unit of units.filter((_, index) => !work.decision!.includes(index))) {
      await assertSourceCurrent(store, scopeId, unit, recipe.budget.unitChars);
      await mutationSettings(scopeId);
      await putProgress(store, unit.key, "reviewed-empty", {
        workId: work.workId, sourceKey: unit.sourceKey, coveredSources: unit.source.spans ?? [],
        ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}), eventPartial: unit.eventPartial ?? null,
        ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}), entryPartial: unit.entryPartial ?? null,
        proposals: null, preparedSource: null, preparedRange: null
      });
    }
    const preparedUnits: Array<{
      unit: OrganizerUnit;
      proposals: OrganizerPreparedProposal[];
    }> = [];
    if (judged.length) {
      const generated = await inference.generate(work, recipe.system, buildPrompt(judged, recipe.presented, recipe.promptScope), undefined, async () => {
        for (const unit of judged)
          await assertSourceCurrent(store, scopeId, unit, recipe.budget.unitChars);
      });
      work = generated.work;
      const narrated = parseProposals(generated.text);
      if (narrated === null)
        throw new MemoryInferenceError("memory-work-failed", "Memory organizer output is not a parseable proposals envelope");
      for (const unit of judged)
        await assertSourceCurrent(store, scopeId, unit, recipe.budget.unitChars);
      const byUnit = new Map<string, OrganizerPreparedProposal[]>();
      for (const proposal of narrated) {
        const unit = judged[Number(proposal.source!.slice(1))];
        if (!unit)
          throw new Error("Memory organizer referenced an unknown source");
        if (!ownerFor(proposal.scope, scopeId))
          throw new Error("Memory organizer referenced an unrelated owner scope");
        if (proposal.action !== "new" && (proposal.scope !== "bot"
          || !recipe.presented.some((item) => item.id === proposal.target))) {
          throw new Error("Memory organizer referenced a target outside its presented candidates");
        }
        const list = byUnit.get(unit.key) ?? [];
        const target = proposal.target === undefined ? undefined
          : recipe.presented.find((item) => item.id === proposal.target);
        const spans = (unit.source.spans ?? []).flatMap((span, index) => {
          const text = unit.source.runId ? unit.texts.at(-1)! : unit.texts[index]!.replace(/^\[[^\]]*\] /u, "");
          const offset = text.indexOf(proposal.quote);
          return offset < 0 ? [] : [{ ...span, start: span.start + offset, end: span.start + offset + proposal.quote.length }];
        });
        if (spans.length !== 1)
          throw new Error("Memory organizer quote must identify one exact source passage");
        list.push({
          action: proposal.action,
          scope: proposal.scope,
          ...(proposal.nature ? { nature: proposal.nature } : {}),
          content: proposal.content,
          spans,
          ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
          ...(proposal.target !== undefined ? { target: proposal.target } : {}),
          ...(target ? {
            expectedTarget: {
              content: target.content,
              trigger: target.trigger,
              status: target.status,
              invalidAt: target.invalidAt ?? null,
            }
          } : {}),
        });
        byUnit.set(unit.key, list);
      }
      for (const unit of judged) {
        const proposals = byUnit.get(unit.key) ?? [];
        const current = await store.getOrganizerProgress(unit.key);
        if (current?.status === "prepared" && (current.workId !== work.workId || current.sourceKey !== unit.sourceKey)) {
          throw new KnowledgeMutationError("conflict", "Another original source range has prepared proposals pending");
        }
        await putProgress(store, unit.key, "prepared", {
          sourceKey: unit.sourceKey,
          workId: work.workId,
          proposals,
          preparedSource: unit.source,
          ...(unit.key.startsWith("session:") ? {
            preparedRange: {
              ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
              ...(unit.eventPartial !== undefined ? { eventPartial: unit.eventPartial } : {}),
              ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
              ...(unit.entryPartial !== undefined ? { entryPartial: unit.entryPartial } : {}),
            }
          } : {}),
        });
        preparedUnits.push({ unit, proposals });
      }
    }
    // All prepared rows are durably acknowledged before releasing the original source claims.
    await inference.finish(work);
    await commitPrepared(store, scopeId, preparedUnits, recipe.budget.unitChars, narratedRevision);
  };
  const runScope = async (scopeId: string): Promise<void> => {
    if (disposed || !isBotScopeId(scopeId))
      return;
    running.add(scopeId);
    const force = forced.delete(scopeId);
    try {
      if (suspendedScopes.has(scopeId) || deps.canExecuteScope && !await deps.canExecuteScope(scopeId))
        return;
      const existingStore = await deps.hasStoreForScope(scopeId) ? await deps.storeForScopeId(scopeId) : null;
      if (existingStore)
        await settleCommittedPrepared(existingStore, scopeId);
      const settings = await readHarnessSettings();
      if (!settings.autoOrganize.bot || settings.disabled)
        return;
      const inference = deps.getInference();
      const pending = (await inference.list<OrganizerRecipe>(scopeId)).filter(work => work.mode === "automatic" && !work.consumed);
      const store = existingStore ?? await deps.storeForScopeId(scopeId);
      if (!store)
        return;
      for (const work of pending) {
        try {
          await prepareWork(store, scopeId, work);
        }
        catch (error) {
          await recordWorkError(store, work.recipe.units, error, work.workId);
          report(error);
        }
        if (disposed || suspendedScopes.has(scopeId))
          return;
      }
      // Reservations only affect their exact source revision/range, never another Bot/source.
      const unresolved = (await inference.list<OrganizerRecipe>(scopeId)).filter(work => work.mode === "automatic" && !work.consumed);
      reservedSources.set(scopeId, unresolved.flatMap(work => work.recipe.units.flatMap(unit => unit.source.spans ?? [])));
      const binding = await modelForScope(settings, scopeId);
      if (!binding)
        return;
      const promptScope: OrganizerPromptScope = { sourceScope: "bot", userMemoryEnabled: settings.autoOrganize.user };
      const budget = await resolveBudget(binding.selection, promptScope);
      const planningMemories = await deps.memory.list(ownerFor("bot", scopeId)!, { activeOnly: true });
      let unitChars = budget.unitChars;
      let candidates: OrganizerUnit[] = [];
      let freshUnits: OrganizerUnit[] = [];
      const preparedUnits: Array<{
        unit: OrganizerUnit;
        proposals: OrganizerPreparedProposal[];
      }> = [];
      while (true) {
        candidates = await collectUnits(store, scopeId, unitChars, force);
        const rows = new Map((await store.listOrganizerProgress()).map(row => [row.key, row]));
        freshUnits = [];
        preparedUnits.length = 0;
        for (const unit of candidates) {
          const row = rows.get(unit.key);
          if (isCovered(row, unit.sourceKey))
            continue;
          unit.source.key = unit.rangeKey;
          if (row?.status === "prepared" && row.sourceKey === unit.sourceKey && row.proposals) {
            preparedUnits.push({ unit, proposals: row.proposals });
            continue;
          }
          if (!selectPrompt([...freshUnits, unit], planningMemories, budget.inputTokens, promptScope))
            break;
          freshUnits.push(unit);
        }
        if (freshUnits.length || preparedUnits.length || !candidates.length)
          break;
        if (unitChars <= MIN_SEGMENT_CHARS)
          throw new Error("Memory organizer cannot fit the original source contract in the selected context");
        unitChars = Math.max(MIN_SEGMENT_CHARS, Math.floor(unitChars / 2));
      }
      if (preparedUnits.length) {
        try {
          await commitPrepared(store, scopeId, preparedUnits, unitChars);
        }
        catch (error) {
          await recordWorkError(store, preparedUnits.map(({ unit }) => unit), error);
          throw error;
        }
      }
      if (!freshUnits.length)
        return;
      const selected = selectPrompt(freshUnits, planningMemories, budget.inputTokens, promptScope)!;
      const nativeBinding = await inference.bind(binding.selection, budget.maxOutputTokens);
      const key = randomUUID();
      const work = await inference.admit({
        key, scopeId, mode: "automatic", spans: freshUnits.flatMap(unit => unit.source.spans ?? []),
        recipe: {
          binding: nativeBinding, units: freshUnits, presented: selected.presented, promptScope,
          budget: { ...budget, unitChars }, decisionStatus: settings.fastDecision, system: MEMORY_ORGANIZER_SYSTEM
        } satisfies OrganizerRecipe
      });
      for (const unit of freshUnits)
        await putProgress(store, unit.key, "processing", {
          sourceKey: unit.sourceKey, workId: work.workId,
          ...(unit.runEndOffset === undefined ? {} : { runEndOffset: unit.runEndOffset }), proposals: null, preparedSource: null, preparedRange: null
        });
      try {
        await prepareWork(store, scopeId, work);
      }
      catch (error) {
        await recordWorkError(store, freshUnits, error, work.workId);
        throw error;
      }
      if (freshUnits.length < candidates.length || candidates.length === MAX_UNITS_PER_RUN || freshUnits.some(unit => unit.hasMoreSource))
        queued.add(scopeId);
    }
    finally {
      reservedSources.delete(scopeId);
      running.delete(scopeId);
      for (const resolve of idleWaiters.get(scopeId) ?? [])
        resolve();
      idleWaiters.delete(scopeId);
      if (queued.delete(scopeId))
        schedule(scopeId);
    }
  };

  const schedule = (scopeId: string): void => {
    if (disposed || !isBotScopeId(scopeId) || suspendedScopes.has(scopeId)) return;
    queued.add(scopeId);
    if (running.has(scopeId) || timers.has(scopeId)) return;
    timers.set(scopeId, setTimeout(() => {
      timers.delete(scopeId);
      if (disposed) return;
      queued.delete(scopeId);
      track(runScope(scopeId));
    }, SETTLE_DEBOUNCE_MS));
  };

  const sweep = async (): Promise<void> => {
    if (disposed) return;
    for (const scopeId of await deps.listScopeIds()) {
      // User memory is an output of organization, never a source event store.
      // Opening it through storeForScopeId would create a second writer.
      if (disposed || !isBotScopeId(scopeId)) continue;
      try {
        // Cheap sources first: a scope with no threads and no store file does
        // not get an empty .tdb created by a background sweep.
        const runs = await deps.listRunSources(scopeId);
        const sessions = await deps.listScopeSessions(scopeId);
        const storeExists = await deps.hasStoreForScope(scopeId);
        if (runs.length === 0 && sessions.length === 0 && !storeExists) continue;
        const store = await deps.storeForScopeId(scopeId);
        if (!store) continue;
        const timestamp = now();
        const rows = await store.listOrganizerProgress();
        const hasWork = rows.some((row) => retryable(row, timestamp));
        const hasSources = hasWork
          || runs.length > 0
          || sessions.length > 0
          || (await store.listEventSessionIds()).length > 0;
        if (hasWork || hasSources) schedule(scopeId);
      } catch (error) {
        report(error);
      }
    }
  };

  const armSweep = (): void => {
    if (disposed || sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      track(sweep().finally(armSweep));
    }, SWEEP_INTERVAL_MS);
  };

  return {
    async suspendScope(scopeId: string): Promise<void> {
      suspendedScopes.add(scopeId);
      const timer = timers.get(scopeId);
      if (timer) clearTimeout(timer);
      timers.delete(scopeId);
      queued.delete(scopeId);
      forced.delete(scopeId);
      await deps.getInference().suspendScope(scopeId);
      if (running.has(scopeId)) await new Promise<void>((resolve) => {
        const waiters = idleWaiters.get(scopeId) ?? new Set();
        waiters.add(resolve);
        idleWaiters.set(scopeId, waiters);
      });
    },
    resumeScope(scopeId: string): void { deps.getInference().resumeScope(scopeId); suspendedScopes.delete(scopeId); schedule(scopeId); },
    /** First-run reconcile: pick up progress and sources left before shutdown. */
    start(): void {
      if (disposed) return;
      track(sweep());
      armSweep();
    },
    /** A session's run settled — its owner's sources may have new material. */
    noteSessionSettled(sessionId: string): void {
      if (disposed) return;
      track((async () => {
        const scopeId = await deps.scopeForSession(sessionId);
        if (scopeId) schedule(scopeId);
      })());
    },
    /** A thread run completed (or a scope otherwise gained material). */
    noteScope(scopeId: string): void {
      if (disposed || !isBotScopeId(scopeId)) return;
      schedule(scopeId);
    },
    /** User-requested retry bypasses only the automatic failure backoff. */
    retryScope(scopeId: string): void {
      if (disposed || !isBotScopeId(scopeId)) return;
      forced.add(scopeId);
      schedule(scopeId);
    },
    /** Disable switched off / shutting down: stop scheduling, cancel in-flight batches. */
    async dispose(): Promise<void> {
      if (disposed) { await Promise.allSettled([...pendingTasks]); return; }
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      forced.clear();
      if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
      await deps.getInference().close(await deps.listScopeIds());
      await Promise.allSettled([...pendingTasks]);
    },
    /** Explicit selection preview: no automatic-memory gate, coverage write or commit. */
    async extractSelection(scopeId: string, system: string, prompt: string, signal: AbortSignal, selection: MemorySelectionRequest): Promise<string> {
      if (disposed)
        throw new Error('Memory organizer is unavailable');
      signal.throwIfAborted();
      const inference = deps.getInference();
      let work = await inference.find<{
        binding: MemoryInferenceBinding;
        system: string;
        prompt: string;
        selection: MemorySelectionRequest;
      }>(selection.requestKey);
      if (work && (work.scopeId !== scopeId || work.mode !== "selection" || !isDeepStrictEqual(memorySourceClaims(selection.sources), work.claims)))
        throw new MemoryInferenceError('memory-work-identity-conflict', 'The original selection belongs to different sources.', 'none');
      if (!work && selection.retryOf) {
        const prior = await inference.find<{
          binding: MemoryInferenceBinding;
          system: string;
          prompt: string;
          selection: MemorySelectionRequest;
        }>(selection.retryOf);
        if (prior && prior.scopeId === scopeId && isDeepStrictEqual(prior.claims, memorySourceClaims(selection.sources)) && !prior.consumerFailed && prior.inference.some(op => op.outcome === 'succeeded')) {
          work = prior;
        }
      }
      if (!work) {
        const selected = await modelForScope(await readHarnessSettings(), scopeId);
        if (!selected)
          throw new MemoryInferenceError('memory-organizer-unconfigured', 'Configure the memory organizer model to extract memories.', 'none');
        const descriptor = await inference.model(selected.selection);
        const output = memoryOrganizerOutputReservation(descriptor.contextWindow ?? 0, descriptor.maxTokens);
        if (estimateMemoryOrganizerInputTokens(system, prompt) + output > (descriptor.contextWindow ?? 0))
          throw new MemoryInferenceError('memory-organizer-capacity', 'The selected passages exceed this model’s context capacity.', 'none');
        work = await inference.admit({
          key: selection.requestKey, scopeId, mode: 'selection', spans: selection.sources,
          ...(selection.retryOf ? { retryOf: selection.retryOf } : {}), recipe: { binding: await inference.bind(selected.selection, output), system, prompt, selection }
        });
      }
      const assertSelection = async () => {
        if (await deps.scopeForSession(selection.sessionId) !== scopeId)
          throw new MemoryInferenceError('memory-work-owner-changed', 'The selected conversation owner changed.', 'none');
        const entries = await deps.readEntries(selection.sessionId);
        for (const span of selection.sources) {
          const entry = entries.find(entry => entry.id === span.id);
          if (!entry || sourceRevision(entrySourceText(entry)) !== span.revision)
            throw new MemoryInferenceError('memory-work-source-changed', 'The selected source changed. Select it again.', 'none');
        }
      };
      const result = await inference.generate(work, work.recipe.system, work.recipe.prompt, signal, assertSelection);
      signal.throwIfAborted();
      await assertSelection();
      try {
        const input = JSON.parse(result.work.recipe.prompt) as {
          passages: Array<{
            role: string;
            text: string;
          }>;
        };
        parseSelectionMemories(result.text, result.work.recipe.selection.sources.map((span, index) => ({
          span, role: input.passages[index]!.role,
          passage: { entryId: span.id, start: span.start, revision: span.revision, text: input.passages[index]!.text }
        })));
      }
      catch (error) {
        await inference.reject(result.work);
        throw new MemoryInferenceError('memory-work-invalid-output', error instanceof Error ? error.message : 'The original memory output is invalid.', 'new_attempt');
      }
      await inference.finish(result.work);
      return result.text;
    },
    /** Scope settings and durable progress; read-only, never schedules a run. */
    async describe(scopeId: string): Promise<{
      enabled: boolean;
      model: ModelSelection | null;
      rows: OrganizerProgress[];
    }> {
      if (!isBotScopeId(scopeId)) return { enabled: false, model: null, rows: [] };
      const settings = await readHarnessSettings().catch(() => null);
      const binding = settings ? await modelForScope(settings, scopeId).catch(() => null) : null;
      const storeExists = await Promise.resolve(deps.hasStoreForScope(scopeId)).catch(() => false);
      const store = storeExists ? await deps.storeForScopeId(scopeId).catch(() => null) : null;
      const rows = store ? await store.listOrganizerProgress().catch(() => [] as OrganizerProgress[]) : [];
      return {
        enabled: settings !== null && settings.autoOrganize.bot && binding !== null,
        model: binding?.selection ?? null,
        rows,
      };
    },
    /** Pending task count for tests/diagnostics. */
    get pending(): number { return pendingTasks.size; },
  };
}

export type MemoryOrganizer = ReturnType<typeof createMemoryOrganizer>;

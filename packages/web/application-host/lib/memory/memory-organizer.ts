/**
 * Background memory organizer. Reads original native Bot history, then asks
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
import { mergeSourceSpans, sourceIdentity, sourceRevision, uncoveredSourceSpans } from "./memory-sources.js";

// ── Boundaries ─────────────────────────────────────────────────────

const FAILED_RETRY_MS = 5 * 60_000;
const SETTLE_DEBOUNCE_MS = 2_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** A source must have room for at least a meaningful fragment and its label. */
const MIN_SEGMENT_CHARS = 64;

const MEMORY_ORGANIZER_SYSTEM = [
  "Memory helps future conversations and work continue from an existing understanding. Decide what is worth keeping from these experiences and how to preserve its meaning and context alongside existing memories.",
  "Return a JSON object: {\"memories\":[{\"action\":\"new\",\"scope\":\"bot\",\"content\":\"...\",\"sources\":[{\"source\":\"u0\",\"quote\":\"...\"}]}]}. An empty memories array means nothing needs to be added. A memory may be a short observation or a connected account supported by several sources.",
  "action is new, supplement, or correct. supplement and correct require target (k:<id>) from the supplied existing memories in the source scope; correct replaces it and supplement adds related information.",
  "Choose scope from the available scopes in the input. content holds the durable information; optional trigger describes when to recall it. Optional nature is experience, decision, preference, judgment, or instruction; instruction denotes an explicit user directive.",
  "Each source identifies a fragment (u<index>); quote is an exact supporting passage within that fragment. A single source and quote on the memory itself is also accepted. Preserve the original scope, uncertainty and changes of understanding. Only user statements can establish user instructions.",
].join("\n");

// ── Deps and source shapes ─────────────────────────────────────────

export interface MemoryOrganizerDeps {
  /** Trusted original Bot work owner. */
  getInference(): MemoryInference;
  storeForScopeId(scopeId: string): Promise<KnowledgeStore | null>;
  /** Whether the scope's store file already exists (cheap — no store open). */
  hasStoreForScope(scopeId: string): boolean | Promise<boolean>;
  /** Bot scopes from the durable Bot registry. */
  listScopeIds(): Promise<string[]>;
  canExecuteScope?(scopeId: string): Promise<boolean>;
  nativeMaterials(scopeId: string, afterHeads?: Readonly<Record<string, string>>, sourceChars?: number): Promise<import('./bot-history.js').HistoryMemoryBatch>;
  hasNativeSources?(scopeId: string): Promise<boolean>;
  readNativeSource(scopeId: string, span: Extract<MemorySourceSpan, { kind: 'history-item' }>): Promise<string>;
  scopeForThread(threadId: string): Promise<string | null>;
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
  sources: Array<{ source: string; quote: string }>;
}

// ── Helpers ────────────────────────────────────────────────────────

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

/**
 * The coverage fingerprint binds a progress row to the exact range+content it
 * covered. A terminal row whose sourceKey no longer matches is stale — the
 * source changed underneath it and must be reprocessed.
 */
const unitSourceKey = (scopeId: string, unit: OrganizerUnit | Omit<OrganizerUnit, "sourceKey" | "rangeKey">): string =>
  createHash("sha256").update(JSON.stringify([
    scopeId, unit.key, unit.source.spans?.map((span) => [...sourceIdentity(span), span.revision, span.start, span.end]), unit.texts,
  ])).digest("hex");
const unitRangeKey = (scopeId: string, key: string, start: unknown, end: unknown): string =>
  createHash("sha256").update(JSON.stringify([scopeId, key, start, end])).digest("hex");
const preparedProposalKey = (source: KnowledgeSource, proposal: OrganizerPreparedProposal): string | undefined =>
  source.key ? createHash("sha256").update(JSON.stringify([
    source.key, proposal.action, proposal.scope, proposal.content, proposal.trigger, proposal.target,
    proposal.spans?.map((span) => [...sourceIdentity(span), span.revision, span.start, span.end]),
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
    const rawSources = item.sources ?? [{ source: item.source, quote: item.quote }];
    if (!Array.isArray(rawSources) || !rawSources.length || rawSources.some(source =>
      typeof source?.source !== 'string' || !/^u\d+$/u.test(source.source)
      || typeof source.quote !== 'string' || !source.quote.trim()) || (action !== "new" && target === undefined)) return null;
    const sources = rawSources as Array<{ source: string; quote: string }>;
    proposals.push({
      sources,
      action,
      scope,
      ...(nature ? { nature } : {}),
      content,
      ...(trigger ? { trigger } : {}),
      ...(target !== undefined ? { target } : {}),
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
    produced?: number[];
    lastError?: string;
    /** Set the coverage fingerprint; `null` clears a stale one. */
    sourceKey?: string | null;
    /** Set durable prepared proposals; `null` clears them (terminal rows). */
    proposals?: OrganizerPreparedProposal[] | null;
    preparedSource?: KnowledgeSource | null;
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
    await store.putOrganizerProgress({
      key,
      status,
      ...((patch.workId ?? existing?.workId) ? { workId: (patch.workId ?? existing?.workId)! } : {}),
      coveredSources: mergeSourceSpans([...(existing?.coveredSources ?? []), ...(patch.coveredSources ?? []),
        ...((status === "formed" || status === "reviewed-empty") ? existing?.preparedSource?.spans ?? [] : [])]),
      ...(sourceKey !== null ? { sourceKey } : {}),
      ...(patch.produced !== undefined ? { produced: patch.produced } : existing?.produced ? { produced: existing.produced } : {}),
      ...(proposals !== null ? { proposals } : {}),
      ...(preparedSource !== null ? { preparedSource } : {}),
      updatedAt: now(),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    });
  };

  // ── Source collection ────────────────────────────────────────────

  const collectUnits = async (
    store: KnowledgeStore,
    scopeId: string,
    unitChars: number,
    force: boolean,
  ): Promise<{ units: OrganizerUnit[]; heads: Record<string, string>; hasMore: boolean; blocked: boolean }> => {
    const timestamp = now();
    const rows = await store.listOrganizerProgress();
    const progress = new Map(rows.map((row) => [row.key, row]));
    const units: OrganizerUnit[] = [];

    const afterHeads = Object.fromEntries(rows.filter(row => row.key.startsWith('history-cursor:') && row.sourceKey)
      .map(row => [row.key.slice('history-cursor:'.length), row.sourceKey!]));
    const { materials: native, heads, hasMore = false } = await deps.nativeMaterials(scopeId, afterHeads, unitChars);
    let collectedChars = 0;
    let blocked = false;
    if (native.length) {
      const memories = [...await store.listKnowledge({}), ...await deps.memory.list({ scope: 'user', ownerId: null })];
      const covered = [...rows.flatMap(row => row.coveredSources ?? []), ...(reservedSources.get(scopeId) ?? []), ...memories.flatMap(item => item.source?.spans ?? [])];
      for (const material of native) {
        for (const uncovered of uncoveredSourceSpans(material.span, covered)) {
          let start = uncovered.start;
          while (start < uncovered.end && collectedChars < unitChars) {
            const length = takePrefix(material.text, start, Math.min(unitChars - material.role.length - 3, uncovered.end - start));
            if (!length) throw new Error('Organizer model cannot fit the original history passage');
            const span = { ...uncovered, start, end: start + length };
            const key = `history:${JSON.stringify(sourceIdentity(span))}:${start}`;
            const unit = { key, label: `Thread ${material.span.threadId}`, texts: [`[${material.role}] ${material.text.slice(start, span.end)}`],
              source: { kind: 'memory-organizer', threadId: material.span.threadId, spans: [span] },
              ...(span.end < uncovered.end ? { hasMoreSource: true } : {}) };
            const sourceKey = unitSourceKey(scopeId, unit); const row = progress.get(key);
            if (!isCovered(row, sourceKey) && (row?.status !== 'failed' || retryable(row, timestamp, force))) {
              units.push({ ...unit, sourceKey, rangeKey: unitRangeKey(scopeId, key, start, span.end) });
              collectedChars += length;
            } else if (row?.status === 'failed') blocked = true;
            start = span.end;
          }
        }
        if (collectedChars >= unitChars) break;
      }
    }

    return { units, heads, hasMore, blocked };
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
    for (const item of memories) {
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
      if (span.kind === 'history-item') text = await deps.readNativeSource(scopeId, span);
      if (text === undefined) throw new Error(`Original organizer source is unavailable: ${unit.key}`);
      if (sourceRevision(text) !== span.revision || span.end > text.length) throw new SourceChangedError(`Original organizer source changed: ${unit.key}`);
    }
  };

  /** A crash can leave memory durable while its source progress is still
   * prepared. If the source is now unavailable, recover the receipt from
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
      if (!complete) continue;
      await putProgress(store, row.key, produced.size > 0 ? "formed" : "reviewed-empty", {


        produced: [...produced], sourceKey: row.sourceKey,
        proposals: null, preparedSource: null,
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


        produced,
        sourceKey: unit.sourceKey,
        proposals: null,
        preparedSource: null,
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


        proposals: null, preparedSource: null
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
        const unit = judged[Number(proposal.sources[0]!.source.slice(1))];
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
        let userSource = false;
        const spans = proposal.sources.flatMap(citation => {
          const cited = judged[Number(citation.source.slice(1))];
          if (!cited) throw new Error('Memory organizer referenced an unknown source');
          const matches = (cited.source.spans ?? []).flatMap((span, index) => {
            const raw = cited.source.runId ? cited.texts.at(-1)! : cited.texts[index]!;
            const text = raw.replace(/^\[[^\]]*\] /u, '');
            const offset = text.indexOf(citation.quote);
            if (offset < 0) return [];
            userSource ||= raw.startsWith('[user] ');
            return [{ ...span, start: span.start + offset, end: span.start + offset + citation.quote.length }];
          });
          if (matches.length !== 1) throw new Error('Memory organizer quote must identify one exact source passage');
          return matches;
        });
        if (proposal.nature === 'instruction' && !userSource) throw new Error('Only a user passage can establish an instruction');
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
      if (!existingStore && deps.hasNativeSources && !await deps.hasNativeSources(scopeId)) return;
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
      let observedHeads: Record<string, string> = {};
      let sourceHasMore = false;
      let sourceBlocked = false;
      const preparedUnits: Array<{
        unit: OrganizerUnit;
        proposals: OrganizerPreparedProposal[];
      }> = [];
      while (true) {
        const collected = await collectUnits(store, scopeId, unitChars, force);
        candidates = collected.units;
        observedHeads = collected.heads;
        sourceHasMore = collected.hasMore;
        sourceBlocked = collected.blocked;
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
      if (!freshUnits.length) {
        const progress = await store.listOrganizerProgress();
        if (!candidates.length && !unresolved.length && !sourceBlocked) {
          for (const [branch, head] of Object.entries(observedHeads)) {
            const key = `history-cursor:${branch}`;
            if (progress.find(row => row.key === key)?.sourceKey !== head)
              await putProgress(store, key, 'reviewed-empty', { sourceKey: head });
          }
          if (sourceHasMore) queued.add(scopeId);
        }
        return;
      }
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

        });
      try {
        await prepareWork(store, scopeId, work);
      }
      catch (error) {
        await recordWorkError(store, freshUnits, error, work.workId);
        throw error;
      }
      // One final metadata/coverage pass commits the frozen scan boundary after all its
      // sources settle. It performs no extra inference when the batch is complete.
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
        const storeExists = await deps.hasStoreForScope(scopeId);
        // Discovery uses scope metadata at the production adapter; bodies are read by
        // collectUnits from its saved boundary, never as a periodic discovery scan.
        if (!storeExists) { schedule(scopeId); continue; }
        const store = await deps.storeForScopeId(scopeId);
        if (!store) continue;
        const timestamp = now();
        const rows = await store.listOrganizerProgress();
        const hasWork = rows.some((row) => retryable(row, timestamp));
        if (hasWork || storeExists) schedule(scopeId);
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
        const conversation = selection.conversation;
          if (await deps.scopeForThread(conversation.threadId) !== scopeId)
            throw new MemoryInferenceError('memory-work-owner-changed', 'The selected Thread owner changed.', 'none');
          for (const span of selection.sources) {
            if (span.kind !== 'history-item' || span.threadId !== conversation.threadId || span.branchId !== conversation.branchId || span.headId !== conversation.headId)
              throw new MemoryInferenceError('memory-work-source-changed', 'The selected history witness changed.', 'none');
            const text = await deps.readNativeSource(scopeId, span);
            if (sourceRevision(text) !== span.revision || span.end > text.length)
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

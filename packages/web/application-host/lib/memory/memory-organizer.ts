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
import {
  mergeHarnessSettings,
  resolveFastDecisionPurpose,
  type FastDecisionMaterial,
  type FastDecisionQuestion,
  type HarnessFastDecisionPurposeStatus,
  type HarnessFastDecisionResult,
  type HarnessInferenceBindingSnapshot,
  type HarnessMemoryOrganizeParams,
  type HarnessMemoryOrganizeResult,
  type HarnessSettingsInput,
  type ModelSelection,
  type PiSessionEntry,
  type PiSessionMessageEntry,
  type PiSettingsSnapshot,
} from "@varin/protocol";
import { botIdFromScopeId, isBotScopeId, isSessionScopeId } from "../harness/owner-scope.js";
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

// ── Boundaries ─────────────────────────────────────────────────────

const MAX_UNITS_PER_RUN = 8;
const MAX_EVENTS_PER_SESSION = 120;
const MAX_ENTRIES_PER_SESSION = 60;
const MAX_EXISTING_MATERIALS = 60;
const FAILED_RETRY_MS = 5 * 60_000;
const SETTLE_DEBOUNCE_MS = 2_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;
/**
 * Capacity-aware batching budgets. When the narrating model's contextWindow
 * is known, the source-material budget is a conservative share of it (~1.6
 * chars/token covers CJK-dense text); the fallback bounds a run when the
 * descriptor cannot be read. A single unit never exceeds its share so one
 * oversized source cannot starve the rest of the batch.
 */
const FALLBACK_BATCH_CHARS = 64_000;
const MIN_UNIT_CHARS = 4_000;
const MAX_BATCH_CHARS = 400_000;

const MEMORY_ORGANIZER_SYSTEM = [
  "You are Varin's background memory organizer. You read durable work fragments and the existing memory list, then emit JSON only.",
  "Output shape: {\"memories\":[{\"action\":\"new\"|\"supplement\"|\"correct\",\"scope\":\"workspace\"|\"user\"|\"bot\",\"nature\":\"experience\"|\"decision\"|\"preference\"|\"judgment\"|\"instruction\",\"content\":\"...\",\"trigger\":\"...\",\"target\":\"k:<id>\",\"source\":\"<material id>\"}]}.",
  "Rules: keep only durable facts — decisions, requirements, preferences, judgments, commitments, and notable outcomes; drop routine tool noise and ephemeral status.",
  "\"instruction\" is reserved for explicit user directives; never infer one.",
  "\"correct\" replaces an existing memory (target required); \"supplement\" adds a memory that refines or relates to an existing one (target required); \"new\" stands alone.",
  "content is one or two sentences preserving concrete facts (names, ids, dates); trigger is a short recall cue naming the situation this memory applies to.",
  "source is the material id the memory was distilled from. Emit {\"memories\":[]} when nothing is worth persisting.",
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

/** The Pi-runtime surface the organizer needs. Same structural seam as workspace-inference. */
export interface MemoryOrganizerBroker {
  requestForWorkspace(cwd: string, method: "settings.get", params: Record<string, never>): Promise<PiSettingsSnapshot>;
  requestForWorkspace(cwd: string, method: "model.list", params: Record<string, never>): Promise<import("@varin/protocol").ModelDescriptor[]>;
  requestForWorkspace(
    cwd: string,
    method: "harness.inference.describe",
    params: Record<string, never>,
  ): Promise<HarnessInferenceBindingSnapshot>;
  requestForWorkspace(
    cwd: string,
    method: "harness.fastDecision",
    params: import("@varin/protocol").HarnessFastDecisionParams,
  ): Promise<HarnessFastDecisionResult>;
  requestForWorkspace(
    cwd: string,
    method: "harness.memoryOrganize",
    params: HarnessMemoryOrganizeParams,
  ): Promise<HarnessMemoryOrganizeResult>;
  requestForWorkspace(
    cwd: string,
    method: "harness.inference.cancel",
    params: { batchId: string },
  ): Promise<{ cancelled: boolean }>;
}

export interface MemoryOrganizerDeps {
  /** Shared worker directory for inference transport (settings/describe/calls). */
  configCwd: string;
  getBroker(): MemoryOrganizerBroker | null;
  storeForScopeId(scopeId: string): Promise<KnowledgeStore | null>;
  /** Whether the scope's store file already exists (cheap — no store open). */
  hasStoreForScope(scopeId: string): boolean | Promise<boolean>;
  /**
   * Workspace + `bot:<id>` scopes that may own memory material: thread-catalog
   * scopes plus on-disk store keys (interactive sessions write events without
   * ever owning a Thread).
   */
  listScopeIds(): Promise<string[]>;
  /** Sessions durably bound under a scope (thread runs incl. attached roots). */
  listScopeSessions(scopeId: string): Promise<string[]>;
  /** Terminal runs carrying a report under a scope. */
  listRunSources(scopeId: string): Promise<OrganizerRunSource[]>;
  /**
   * Project-layer disable for a workspace scope: the workspace's own settings
   * may turn organizing off for itself but cannot touch user/bot switches.
   * Return null for non-workspace scopes or when per-scope settings are
   * unavailable — the user-level `autoOrganize` stays the gate.
   */
  autoOrganizeForScope?(scopeId: string): Promise<boolean | null>;
  /** Durable owner resolution for a session (`workspaceId`, `bot:<id>`, `session:<id>`). */
  scopeForSession(sessionId: string): Promise<string | null>;
  /** Branch entries for a session; never wakes a live worker (catalog path). */
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
  /** Next event cursor when this unit is covered. */
  eventCursor?: number;
  /** Next entry cursor when this unit is covered. */
  entryCursor?: string;
}

interface OrganizerProposal {
  action: "new" | "supplement" | "correct";
  scope: "workspace" | "user" | "bot";
  nature?: MemoryNature;
  content: string;
  trigger?: string;
  target?: number;
  source?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const scopeKind = (scopeId: string): "workspace" | "bot" =>
  (isBotScopeId(scopeId) ? "bot" : "workspace");

const messageText = (entry: PiSessionMessageEntry): string => {
  const message = entry.message;
  if (message.role === "user" || message.role === "custom") {
    const content = message.content;
    if (typeof content === "string") return content.trim();
    return content
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  if (message.role === "assistant") {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
};

const progressKeyForSession = (sessionId: string): string => `session:${sessionId}`;
const progressKeyForRun = (runId: string, part: number): string =>
  part === 0 ? `run:${runId}` : `run:${runId}:${part}`;

/**
 * The coverage fingerprint binds a progress row to the exact range+content it
 * covered. A terminal row whose sourceKey no longer matches is stale — the
 * source changed underneath it and must be reprocessed.
 */
const unitSourceKey = (scopeId: string, unit: { key: string; eventCursor?: number; entryCursor?: string; texts: string[] }): string =>
  createHash("sha256").update(JSON.stringify([scopeId, unit.key, unit.eventCursor, unit.entryCursor, unit.texts])).digest("hex");

/** Terminal coverage for this exact source content — the transaction is done. */
const isCovered = (progress: OrganizerProgress | undefined, sourceKey: string): boolean =>
  progress !== undefined
  && (progress.status === "formed" || progress.status === "reviewed-empty")
  && progress.sourceKey === sourceKey;

const retryable = (progress: OrganizerProgress | undefined, now: number): boolean => {
  if (!progress) return true;
  if (progress.status === "failed") return now - progress.updatedAt >= FAILED_RETRY_MS;
  // "processing"/"prepared" rows are unfinished claims — a restart must resume them.
  return progress.status !== "formed" && progress.status !== "reviewed-empty";
};

/** Split oversized source text at line boundaries so each chunk fits the unit budget. */
const chunkText = (text: string, cap: number): string[] => {
  if (text.length <= cap) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    let cut = rest.lastIndexOf("\n", cap);
    if (cut < Math.floor(cap / 2)) cut = cap;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
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
    if (scope !== "workspace" && scope !== "user" && scope !== "bot") return null;
    const nature = typeof item["nature"] === "string" && (MEMORY_NATURES as readonly string[]).includes(item["nature"])
      ? item["nature"] as MemoryNature
      : undefined;
    const trigger = typeof item["trigger"] === "string" ? item["trigger"] : undefined;
    const target = typeof item["target"] === "string" && /^k:\d+$/u.test(item["target"])
      ? Number(item["target"].slice(2))
      : undefined;
    const source = typeof item["source"] === "string" ? item["source"] : undefined;
    if (!source || !/^u\d+$/.test(source) || (action !== "new" && target === undefined)) return null;
    proposals.push({
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
  const running = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeBatches = new Map<string, string>();
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
    autoOrganize: { workspace: boolean; user: boolean; bot: boolean };
    model: ModelSelection | null;
    /** Resolved (configurationId-bearing) fast-decision status for this run. */
    fastDecision: HarnessFastDecisionPurposeStatus | null;
  }

  const readHarnessSettings = async (): Promise<ResolvedOrganizerSettings> => {
    const broker = deps.getBroker();
    const empty: ResolvedOrganizerSettings = {
      autoOrganize: { workspace: false, user: false, bot: false },
      model: null,
      fastDecision: null,
    };
    if (!broker) return empty;
    const snapshot = await broker.requestForWorkspace(deps.configCwd, "settings.get", {});
    const globalHarness = record(record(snapshot.global).harness) as HarnessSettingsInput;
    // Background inference resolves global configuration only — a project's
    // layer can disable organizing for its scope but never picks the model.
    const settings = mergeHarnessSettings(globalHarness, {});
    let fastDecision: HarnessFastDecisionPurposeStatus | null = null;
    try {
      if (resolveFastDecisionPurpose(settings.fastDecision, "memory-organization").status === "ready") {
        const described = await broker.requestForWorkspace(deps.configCwd, "harness.inference.describe", {});
        const status = described.fastDecision?.purposes?.["memory-organization"];
        if (status?.status === "ready") fastDecision = status;
      }
    } catch { fastDecision = null; }
    return {
      autoOrganize: settings.knowledge.autoOrganize,
      model: settings.models.memoryOrganizer ?? null,
      fastDecision,
    };
  };

  const ownerFor = (scope: "workspace" | "user" | "bot", scopeId: string): MemoryOwner | null => {
    if (scope === "user") return { scope: "user", ownerId: null };
    if (scope === "bot") {
      if (!isBotScopeId(scopeId)) return null;
      return { scope: "bot", ownerId: botIdFromScopeId(scopeId) };
    }
    return isBotScopeId(scopeId) ? null : { scope: "workspace", ownerId: scopeId };
  };

  interface ProgressPatch {
    eventCursor?: number;
    entryCursor?: string;
    produced?: number[];
    lastError?: string;
    /** Set the coverage fingerprint; `null` clears a stale one. */
    sourceKey?: string | null;
    /** Set durable prepared proposals; `null` clears them (terminal rows). */
    proposals?: OrganizerPreparedProposal[] | null;
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
    await store.putOrganizerProgress({
      key,
      status,
      ...(sourceKey !== null ? { sourceKey } : {}),
      ...(patch.eventCursor !== undefined ? { eventCursor: patch.eventCursor } : existing?.eventCursor !== undefined ? { eventCursor: existing.eventCursor } : {}),
      ...(patch.entryCursor !== undefined ? { entryCursor: patch.entryCursor } : existing?.entryCursor ? { entryCursor: existing.entryCursor } : {}),
      ...(patch.produced !== undefined ? { produced: patch.produced } : existing?.produced ? { produced: existing.produced } : {}),
      ...(proposals !== null ? { proposals } : {}),
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
  ): Promise<OrganizerUnit | null> => {
    // A session continues after its previous range was committed. Terminal
    // progress closes that range, never the conversation's future material.
    if (progress?.status === "failed" && !retryable(progress, timestamp)) return null;
    const key = progressKeyForSession(sessionId);
    const texts: string[] = [];
    let eventCursor = progress?.eventCursor;
    let entryCursor = progress?.entryCursor;
    // Capacity-aware accumulation: a unit stops at its character share and the
    // cursors only advance over material actually included — the remainder
    // stays pending for the next run instead of being silently clipped.
    let chars = 0;

    const events = (await store.listEvents({
      sessionId,
      ...(progress?.eventCursor !== undefined ? { afterId: progress.eventCursor } : {}),
    })).slice(0, MAX_EVENTS_PER_SESSION);
    for (const event of events) {
      const text = event.text;
      // Empty events carry nothing to narrate — they are covered, not pending.
      if (!text) { eventCursor = event.id; continue; }
      const line = `[${event.kind}] ${text}`;
      if (chars > 0 && chars + line.length > unitChars) break;
      texts.push(line);
      chars += line.length;
      eventCursor = event.id;
    }

    if (chars < unitChars) {
      const entries = await deps.readEntries(sessionId);
      if (entries) {
        const from = entryCursor ? entries.findIndex((entry) => entry.id === entryCursor) : -1;
        const fresh = (from >= 0 ? entries.slice(from + 1) : entries)
          .slice(0, MAX_ENTRIES_PER_SESSION);
        for (const entry of fresh) {
          if (entry.type !== "message") { entryCursor = entry.id; continue; }
          const text = messageText(entry);
          if (!text) { entryCursor = entry.id; continue; }
          const line = `[${entry.message.role}] ${text}`;
          // An entry that would overflow the budget stays uncovered — the
          // cursor must not advance past it. A single oversized entry is still
          // taken whole (chars === 0) rather than dropped forever.
          if (chars > 0 && chars + line.length > unitChars) break;
          texts.push(line);
          chars += line.length;
          entryCursor = entry.id;
          if (chars >= unitChars) break;
        }
      }
    }

    if (texts.length === 0) {
      // Revisited with nothing new: still record coverage when a stale
      // failed/processing row exists so the sweep stops claiming it.
      if (entryCursor !== progress?.entryCursor || eventCursor !== progress?.eventCursor) {
        await putProgress(store, key, "reviewed-empty", {
          ...(entryCursor !== undefined ? { entryCursor } : {}),
          ...(eventCursor !== undefined ? { eventCursor } : {}),
          sourceKey: null,
          proposals: null,
        });
      }
      return null;
    }
    const unit = {
      key,
      label: `session ${sessionId}`,
      texts,
      source: { kind: "memory-organizer", sessionId, ...(entryCursor ? { entryId: entryCursor } : {}) },
      ...(eventCursor !== undefined ? { eventCursor } : {}),
      ...(entryCursor !== undefined ? { entryCursor } : {}),
    };
    return { ...unit, sourceKey: unitSourceKey(scopeId, unit) };
  };

  const collectRunUnits = async (
    store: KnowledgeStore,
    scopeId: string,
    source: OrganizerRunSource,
    timestamp: number,
    progress: Map<string, OrganizerProgress>,
    unitChars: number,
  ): Promise<OrganizerUnit[]> => {
    // Oversized reports subdivide into per-chunk units; each part carries its
    // own progress row so coverage survives a restart mid-report.
    const chunks = chunkText(source.reportText, Math.max(MIN_UNIT_CHARS, unitChars));
    const units: OrganizerUnit[] = [];
    for (const [part, chunk] of chunks.entries()) {
      const key = progressKeyForRun(source.runId, part);
      const texts = [
        `Task report for "${source.threadTitle}"${chunks.length > 1 ? ` (part ${part + 1}/${chunks.length})` : ""}:`,
        chunk,
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
        },
      };
      const sourceKey = unitSourceKey(scopeId, unit);
      const row = progress.get(key);
      // Terminal coverage only stands while the fingerprint matches — a report
      // rewritten under the same run id reopens the range. Failed rows wait
      // out their backoff before reclaiming.
      if (isCovered(row, sourceKey)) continue;
      if (row?.status === "failed" && !retryable(row, timestamp)) continue;
      units.push({ ...unit, sourceKey });
    }
    return units;
  };

  const collectUnits = async (
    store: KnowledgeStore,
    scopeId: string,
    unitChars: number,
  ): Promise<OrganizerUnit[]> => {
    const timestamp = now();
    const rows = await store.listOrganizerProgress();
    const progress = new Map(rows.map((row) => [row.key, row]));
    const units: OrganizerUnit[] = [];

    for (const source of await deps.listRunSources(scopeId)) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      units.push(...await collectRunUnits(store, scopeId, source, timestamp, progress, unitChars));
    }

    const sessionIds = new Set<string>([
      ...(await store.listEventSessionIds()),
      ...(await deps.listScopeSessions(scopeId)),
    ]);
    for (const sessionId of [...sessionIds].sort()) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      const unit = await collectSessionUnit(store, scopeId, sessionId, progress.get(progressKeyForSession(sessionId)), timestamp, unitChars);
      if (unit) units.push(unit);
    }
    return units.slice(0, MAX_UNITS_PER_RUN);
  };

  // ── Judgment + narration ─────────────────────────────────────────

  const filterUnitsByFastDecision = async (
    status: HarnessFastDecisionPurposeStatus | null,
    units: OrganizerUnit[],
  ): Promise<OrganizerUnit[]> => {
    const broker = deps.getBroker();
    if (!broker || status?.status !== "ready") return units;
    const materials: FastDecisionMaterial[] = units.map((unit, index) => ({
      id: `u${index}`,
      label: unit.label,
      text: unit.texts.join("\n"),
    }));
    const questions: FastDecisionQuestion[] = units.map((unit, index) => ({
      id: `u${index}`,
      kind: "judge" as const,
      instructions: `Material u${index} comes from durable work history. Does it contain a fact worth persisting as memory: a decision, requirement, preference, judgment, commitment, or notable outcome?`,
      criteria: {
        yes: "At least one durable fact survives beyond this task",
        no: "Routine tool noise, transient status, or content already fully covered",
      },
    }));
    const batchId = randomUUID();
    activeBatches.set(batchId, "fast-decision");
    try {
      const result = await broker.requestForWorkspace(deps.configCwd, "harness.fastDecision", {
        configurationId: status.binding.configurationId,
        providerId: status.binding.providerId,
        modelId: status.binding.modelId,
        protocol: "typesafe-systemone",
        purpose: "memory-organization",
        goal: "Decide which durable work fragments carry memory-worthy content",
        materials,
        questions,
        batchId,
        ...(status.binding.endpoint ? { endpoint: status.binding.endpoint } : {}),
      });
      const keep = new Set<string>();
      for (const answer of result.answers) {
        if (answer.kind === "judge" && answer.value >= 0.5) keep.add(answer.id);
      }
      for (const id of result.missing) keep.add(id); // unanswered → keep for the generative pass
      return units.filter((_, index) => keep.has(`u${index}`));
    } finally {
      activeBatches.delete(batchId);
    }
  };

  const narrateProposals = async (
    model: ModelSelection,
    units: OrganizerUnit[],
    existing: Knowledge[],
  ): Promise<OrganizerProposal[]> => {
    const broker = deps.getBroker();
    if (!broker) throw new Error("Pi workspace binding is unavailable");
    const sections: string[] = ["# Source fragments"];
    for (const [index, unit] of units.entries()) {
      const block = `## u${index} — ${unit.label}\n${unit.texts.join("\n")}`;
      sections.push(block);
    }
    if (existing.length > 0) {
      sections.push("# Existing memories");
      for (const item of existing.slice(0, MAX_EXISTING_MATERIALS)) {
        sections.push(`- k:${item.id} [${item.status}${item.nature ? `/${item.nature}` : ""}] ${item.content}`);
      }
    }
    const batchId = randomUUID();
    activeBatches.set(batchId, "organize");
    try {
      const result = await broker.requestForWorkspace(deps.configCwd, "harness.memoryOrganize", {
        batchId,
        providerId: model.providerId,
        modelId: model.modelId,
        system: MEMORY_ORGANIZER_SYSTEM,
        prompt: sections.join("\n\n"),
      });
      if (result.batchId !== batchId) {
        throw new Error("Memory organize response does not match the submitted batch");
      }
      const proposals = parseProposals(result.text);
      if (proposals === null) {
        throw new Error("Memory organizer output is not a parseable proposals envelope");
      }
      return proposals;
    } finally {
      activeBatches.delete(batchId);
    }
  };

  // ── Capacity ────────────────────────────────────────────────────

  interface BatchBudget { batchChars: number; unitChars: number }

  /**
   * Source-material budget from the narrating model's context window. The
   * system prompt, existing-memory list, and the answer share the window, so
   * sources get a conservative ~1.6 chars/token share. Falls back to a fixed
   * budget when the descriptor cannot be read.
   */
  const resolveBudget = async (model: ModelSelection): Promise<BatchBudget> => {
    const broker = deps.getBroker();
    if (broker) {
      try {
        const models = await broker.requestForWorkspace(deps.configCwd, "model.list", {});
        const descriptor = models.find((m) => m.id === model.modelId && m.provider === model.providerId);
        const contextWindow = descriptor?.contextWindow;
        if (typeof contextWindow === "number" && contextWindow > 0) {
          const batchChars = Math.min(MAX_BATCH_CHARS, Math.floor(contextWindow * 1.6));
          return { batchChars, unitChars: Math.max(MIN_UNIT_CHARS, Math.floor(batchChars / MAX_UNITS_PER_RUN)) };
        }
      } catch { /* fall through to the bounded default */ }
    }
    return { batchChars: FALLBACK_BATCH_CHARS, unitChars: Math.max(MIN_UNIT_CHARS, Math.floor(FALLBACK_BATCH_CHARS / MAX_UNITS_PER_RUN)) };
  };

  /**
   * The narrating model for a scope: the `models.memoryOrganizer` slot wins;
   * a Bot scope falls back to the Bot's own model so `bot:<id>` memory
   * organizes without duplicating configuration.
   */
  const modelForScope = async (settings: ResolvedOrganizerSettings, scopeId: string): Promise<ModelSelection | null> => {
    if (settings.model) return settings.model;
    return await deps.organizerModelForScope?.(scopeId).catch(() => null) ?? null;
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
    // A source-scope switch does not authorize the user store — inferred
    // proposals may only land there when organizing user memory is enabled.
    if (owner.scope === "user" && !settings.autoOrganize.user) return null;
    const nature = proposal.nature !== undefined && (MEMORY_NATURES as readonly string[]).includes(proposal.nature)
      ? proposal.nature as MemoryNature
      : undefined;
    if (proposal.action === "new") {
      const result = await deps.memory.remember(owner, {
        content: proposal.content,
        ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
        ...(nature ? { nature } : {}),
        source,
        commit: "accepted",
        expectedRevision,
      });
      return result.created ? result.item.id : null;
    }
    // supplement/correct: targets came from the source scope's presented
    // memory list; a cross-scope numeric id must never address an unrelated
    // row in another store.
    if (proposal.target === undefined || proposal.scope !== scopeKind(scopeId)) return null;
    const item = existingMemories.find((memory) => memory.id === proposal.target);
    if (!item) return null;
    if (proposal.action === "supplement") {
      const result = await deps.memory.remember(owner, {
        content: proposal.content,
        ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
        ...(nature ? { nature } : {}),
        source,
        supplements: item.id,
        commit: "accepted",
        expectedRevision,
      });
      return result.created ? result.item.id : null;
    }
    // Compare against the revision shown to the model, not a fresh read taken
    // after it answered (which would authorize overwriting intervening edits).
    if (item.invalidAt !== undefined || item.status !== "accepted") return null;
    const corrected = await deps.memory.correct(owner, item.id, {
      content: proposal.content,
      ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
      ...(nature ? { nature } : {}),
      source,
      expected: {
        content: item.content,
        trigger: item.trigger,
        status: item.status,
        invalidAt: null,
      },
    }).catch((error: unknown) => {
      if (error instanceof KnowledgeMutationError && error.code === "conflict") return null;
      throw error;
    });
    return corrected?.id ?? null;
  };

  // ── Scope run ────────────────────────────────────────────────────

  const runScope = async (scopeId: string): Promise<void> => {
    if (disposed || isSessionScopeId(scopeId)) return;
    running.add(scopeId);
    try {
      const settings = await readHarnessSettings();
      if (!settings.autoOrganize[scopeKind(scopeId)]) return;
      const scopeGate = scopeKind(scopeId) === "workspace"
        ? await deps.autoOrganizeForScope?.(scopeId).catch(() => null)
        : null;
      if (scopeGate === false) return;
      const model = await modelForScope(settings, scopeId);
      if (!model) return;
      const store = await deps.storeForScopeId(scopeId);
      if (!store) return;

      const budget = await resolveBudget(model);
      const collected = await collectUnits(store, scopeId, budget.unitChars);
      if (collected.length === 0) return;
      const rows = await store.listOrganizerProgress();
      const progress = new Map(rows.map((row) => [row.key, row]));

      // Source revision → coverage: a terminal row only covers a range whose
      // fingerprint still matches; a `prepared` row replays its stored
      // proposals so a crash between prepare and commit never re-narrates.
      const freshUnits: OrganizerUnit[] = [];
      const preparedUnits: Array<{ unit: OrganizerUnit; proposals: OrganizerPreparedProposal[] }> = [];
      for (const unit of collected) {
        const row = progress.get(unit.key);
        if (isCovered(row, unit.sourceKey)) continue;
        // Provenance stays bound to the exact range the row covers — commit
        // receipts and automatic forgetting reference the same fingerprint.
        unit.source.key = unit.sourceKey;
        if (row?.status === "prepared" && row.sourceKey === unit.sourceKey && row.proposals !== undefined) {
          preparedUnits.push({ unit, proposals: row.proposals });
          continue;
        }
        freshUnits.push(unit);
      }
      if (freshUnits.length === 0 && preparedUnits.length === 0) return;

      // Units still in flight when a failure lands stay claimable: fresh ones
      // are marked failed for backoff; prepared ones keep their proposals.
      const pendingFresh = new Set(freshUnits.map((unit) => unit.key));
      const pendingPrepared = new Set(preparedUnits.map(({ unit }) => unit.key));
      try {
        for (const unit of freshUnits) {
          await putProgress(store, unit.key, "processing", { sourceKey: unit.sourceKey, proposals: null });
        }

        const judged = await filterUnitsByFastDecision(settings.fastDecision, freshUnits);
        if (disposed) return;
        for (const unit of freshUnits.filter((candidate) => !judged.includes(candidate))) {
          await putProgress(store, unit.key, "reviewed-empty", {
            ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
            ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
            proposals: null,
          });
          pendingFresh.delete(unit.key);
        }

        // The proposal set is computed against this exact memory state; if the
        // catalog moves before commit (a human forget, an explicit remember),
        // the unit stays prepared and the replay drops stale proposals through
        // dedupe instead of committing against an unseen state.
        let narratedRevision: string | null = null;
        if (judged.length > 0) {
          const owner = ownerFor(scopeKind(scopeId), scopeId)!;
          const existing = await deps.memory.list(owner, { activeOnly: true });
          narratedRevision = store.knowledgeRevision();
          const narrated = await narrateProposals(model, judged, existing);
          if (disposed) return;
          // Validate provenance/targets before anything from this response is
          // durably held. A missing source is not permission to attach one.
          const byUnit = new Map<string, OrganizerPreparedProposal[]>();
          for (const proposal of narrated) {
            const unit = judged[Number(proposal.source!.slice(1))];
            if (!unit) throw new Error("Memory organizer referenced an unknown source");
            if (!ownerFor(proposal.scope, scopeId)) throw new Error("Memory organizer referenced an unrelated owner scope");
            if (proposal.action !== "new" && (proposal.scope !== scopeKind(scopeId)
              || !existing.slice(0, MAX_EXISTING_MATERIALS).some((item) => item.id === proposal.target))) {
              throw new Error("Memory organizer referenced a target outside its presented candidates");
            }
            const list = byUnit.get(unit.key) ?? [];
            list.push({
              action: proposal.action,
              scope: proposal.scope,
              ...(proposal.nature ? { nature: proposal.nature } : {}),
              content: proposal.content,
              ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
              ...(proposal.target !== undefined ? { target: proposal.target } : {}),
            });
            byUnit.set(unit.key, list);
          }
          for (const unit of judged) {
            const proposals = byUnit.get(unit.key) ?? [];
            await putProgress(store, unit.key, "prepared", { sourceKey: unit.sourceKey, proposals });
            preparedUnits.push({ unit, proposals });
            pendingFresh.delete(unit.key);
            pendingPrepared.add(unit.key);
          }
        }

        // Commit phase. Settings re-read: a switch flipped mid-run still gates.
        const currentSettings = await readHarnessSettings();
        if (!currentSettings.autoOrganize[scopeKind(scopeId)]) return;
        if (scopeKind(scopeId) === "workspace" && await deps.autoOrganizeForScope?.(scopeId) === false) return;
        if (narratedRevision !== null && narratedRevision !== store.knowledgeRevision()) {
          throw new KnowledgeMutationError("conflict", "Memory changed while the organizer was narrating proposals");
        }
        const owner = ownerFor(scopeKind(scopeId), scopeId)!;
        const existing = await deps.memory.list(owner, { activeOnly: true });
        let revision = store.knowledgeRevision();
        const userOwner: MemoryOwner = { scope: "user", ownerId: null };
        let userRevision = currentSettings.autoOrganize.user ? await deps.memory.revision(userOwner) : "";
        for (const { unit, proposals } of preparedUnits) {
          const produced: number[] = [];
          for (const proposal of proposals) {
            if (proposal.scope === "user" && !currentSettings.autoOrganize.user) continue;
            if (disposed) return;
            if (revision !== store.knowledgeRevision()) {
              throw new KnowledgeMutationError("conflict", "Memory changed while the organizer was committing proposals");
            }
            const id = await commitProposal(scopeId, proposal, currentSettings, unit.source, existing,
              proposal.scope === "user" ? userRevision : revision);
            if (id !== null) produced.push(id);
            revision = store.knowledgeRevision();
            if (proposal.scope === "user" && currentSettings.autoOrganize.user) {
              userRevision = await deps.memory.revision(userOwner);
            }
          }
          await putProgress(store, unit.key, produced.length > 0 ? "formed" : "reviewed-empty", {
            ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
            ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
            produced,
            sourceKey: unit.sourceKey,
            proposals: null,
          });
          pendingPrepared.delete(unit.key);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const unit of freshUnits) {
          if (!pendingFresh.has(unit.key)) continue;
          await putProgress(store, unit.key, "failed", { lastError: message }).catch(report);
        }
        for (const { unit } of preparedUnits) {
          if (!pendingPrepared.has(unit.key)) continue;
          await putProgress(store, unit.key, "prepared", { lastError: message }).catch(report);
        }
        throw error;
      }
    } finally {
      running.delete(scopeId);
      if (queued.delete(scopeId)) schedule(scopeId);
    }
  };

  const schedule = (scopeId: string): void => {
    if (disposed) return;
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
    for (const scopeId of await deps.listScopeIds().catch(() => [] as string[])) {
      if (disposed || isSessionScopeId(scopeId)) continue;
      // Cheap sources first: the registry catalog answers without opening a
      // store, so a scope with no threads and no store file never gets an
      // empty .tdb created just by sweeping.
      const runs = await deps.listRunSources(scopeId).catch(() => [] as OrganizerRunSource[]);
      const sessions = await deps.listScopeSessions(scopeId).catch(() => [] as string[]);
      const storeExists = await Promise.resolve(deps.hasStoreForScope(scopeId)).catch(() => false);
      if (runs.length === 0 && sessions.length === 0 && !storeExists) continue;
      const store = await deps.storeForScopeId(scopeId).catch(() => null);
      if (!store) continue;
      const timestamp = now();
      const rows = await store.listOrganizerProgress().catch(() => []);
      const hasWork = rows.some((row) => retryable(row, timestamp));
      const hasSources = hasWork
        || runs.length > 0
        || sessions.length > 0
        || (await store.listEventSessionIds().catch(() => [])).length > 0;
      if (hasWork || hasSources) schedule(scopeId);
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
      if (disposed || isSessionScopeId(scopeId)) return;
      schedule(scopeId);
    },
    /** Disable switched off / shutting down: stop scheduling, cancel in-flight batches. */
    async dispose(): Promise<void> {
      if (disposed) { await Promise.allSettled([...pendingTasks]); return; }
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
      const broker = deps.getBroker();
      await Promise.allSettled([...activeBatches.keys()].map((batchId) =>
        broker?.requestForWorkspace(deps.configCwd, "harness.inference.cancel", { batchId })));
      activeBatches.clear();
      await Promise.allSettled([...pendingTasks]);
    },
    /**
     * Scope organizer state for the settings surface: enable/model readiness
     * plus durable progress rows (pending, prepared, failed with errors).
     * Read-only — never schedules a run.
     */
    async describe(scopeId: string): Promise<{
      enabled: boolean;
      model: ModelSelection | null;
      rows: OrganizerProgress[];
    }> {
      if (isSessionScopeId(scopeId)) return { enabled: false, model: null, rows: [] };
      const settings = await readHarnessSettings().catch(() => null);
      const kind = scopeKind(scopeId);
      const scopeGate = kind === "workspace" && settings
        ? await deps.autoOrganizeForScope?.(scopeId).catch(() => null)
        : null;
      const model = settings ? await modelForScope(settings, scopeId).catch(() => null) : null;
      const storeExists = await Promise.resolve(deps.hasStoreForScope(scopeId)).catch(() => false);
      const store = storeExists ? await deps.storeForScopeId(scopeId).catch(() => null) : null;
      const rows = store ? await store.listOrganizerProgress().catch(() => [] as OrganizerProgress[]) : [];
      return {
        enabled: settings !== null && settings.autoOrganize[kind] && scopeGate !== false,
        model: model ?? null,
        rows,
      };
    },
    /** Pending task count for tests/diagnostics. */
    get pending(): number { return pendingTasks.size; },
  };
}

export type MemoryOrganizer = ReturnType<typeof createMemoryOrganizer>;

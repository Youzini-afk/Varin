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
const progressKeyForRun = (runId: string): string => `run:${runId}`;

const retryable = (progress: OrganizerProgress | undefined, now: number): boolean => {
  if (!progress) return true;
  if (progress.status === "failed") return now - progress.updatedAt >= FAILED_RETRY_MS;
  // "processing" rows are unfinished claims — a restart must resume them.
  return progress.status !== "formed" && progress.status !== "reviewed-empty";
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

  const putProgress = async (
    store: KnowledgeStore,
    key: string,
    status: OrganizerProgressStatus,
    patch: Partial<Pick<OrganizerProgress, "eventCursor" | "entryCursor" | "produced" | "lastError">> = {},
  ): Promise<void> => {
    const existing = await store.getOrganizerProgress(key);
    await store.putOrganizerProgress({
      key,
      status,
      ...(patch.eventCursor !== undefined ? { eventCursor: patch.eventCursor } : existing?.eventCursor !== undefined ? { eventCursor: existing.eventCursor } : {}),
      ...(patch.entryCursor !== undefined ? { entryCursor: patch.entryCursor } : existing?.entryCursor ? { entryCursor: existing.entryCursor } : {}),
      ...(patch.produced !== undefined ? { produced: patch.produced } : existing?.produced ? { produced: existing.produced } : {}),
      updatedAt: now(),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    });
  };

  // ── Source collection ────────────────────────────────────────────

  const collectSessionUnit = async (
    store: KnowledgeStore,
    sessionId: string,
    progress: OrganizerProgress | undefined,
    timestamp: number,
  ): Promise<OrganizerUnit | null> => {
    // A session continues after its previous range was committed. Terminal
    // progress closes that range, never the conversation's future material.
    if (progress?.status === "failed" && !retryable(progress, timestamp)) return null;
    const key = progressKeyForSession(sessionId);
    const texts: string[] = [];
    let eventCursor = progress?.eventCursor;
    let entryCursor = progress?.entryCursor;

    const events = (await store.listEvents({
      sessionId,
      ...(progress?.eventCursor !== undefined ? { afterId: progress.eventCursor } : {}),
    })).slice(0, MAX_EVENTS_PER_SESSION);
    for (const event of events) {
      const text = event.text;
      if (text) texts.push(`[${event.kind}] ${text}`);
    }
    if (events.length > 0) eventCursor = events[events.length - 1]!.id;

    const entries = await deps.readEntries(sessionId);
    if (entries) {
      const from = entryCursor ? entries.findIndex((entry) => entry.id === entryCursor) : -1;
      const fresh = (from >= 0 ? entries.slice(from + 1) : entries)
        .slice(0, MAX_ENTRIES_PER_SESSION);
      for (const entry of fresh) {
        if (entry.type !== "message") continue;
        const text = messageText(entry);
        if (text) texts.push(`[${entry.message.role}] ${text}`);
      }
      const lastEntry = fresh.at(-1);
      if (lastEntry) entryCursor = lastEntry.id;
    }

    if (texts.length === 0) {
      // Revisited with nothing new: still record coverage when a stale
      // failed/processing row exists so the sweep stops claiming it.
      if (entryCursor !== progress?.entryCursor || eventCursor !== progress?.eventCursor) {
        await putProgress(store, key, "reviewed-empty", {
          ...(entryCursor !== undefined ? { entryCursor } : {}),
          ...(eventCursor !== undefined ? { eventCursor } : {}),
        });
      }
      return null;
    }
    return {
      key,
      label: `session ${sessionId}`,
      texts,
      source: { kind: "memory-organizer", sessionId, ...(entryCursor ? { entryId: entryCursor } : {}) },
      ...(eventCursor !== undefined ? { eventCursor } : {}),
      ...(entryCursor !== undefined ? { entryCursor } : {}),
    };
  };

  const collectRunUnit = async (
    store: KnowledgeStore,
    source: OrganizerRunSource,
    progress: OrganizerProgress | undefined,
    timestamp: number,
  ): Promise<OrganizerUnit | null> => {
    if (!retryable(progress, timestamp)) return null;
    const texts = [
      `Task report for "${source.threadTitle}":`,
      source.reportText,
    ];
    return {
      key: progressKeyForRun(source.runId),
      label: `run ${source.runId} (${source.threadTitle})`,
      texts,
      source: {
        kind: "memory-organizer",
        threadId: source.threadId,
        runId: source.runId,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      },
    };
  };

  const collectUnits = async (
    store: KnowledgeStore,
    scopeId: string,
  ): Promise<OrganizerUnit[]> => {
    const timestamp = now();
    const rows = await store.listOrganizerProgress();
    const progress = new Map(rows.map((row) => [row.key, row]));
    const units: OrganizerUnit[] = [];

    for (const source of await deps.listRunSources(scopeId)) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      const unit = await collectRunUnit(store, source, progress.get(progressKeyForRun(source.runId)), timestamp);
      if (unit) units.push(unit);
    }

    const sessionIds = new Set<string>([
      ...(await store.listEventSessionIds()),
      ...(await deps.listScopeSessions(scopeId)),
    ]);
    for (const sessionId of [...sessionIds].sort()) {
      if (units.length >= MAX_UNITS_PER_RUN) break;
      const unit = await collectSessionUnit(store, sessionId, progress.get(progressKeyForSession(sessionId)), timestamp);
      if (unit) units.push(unit);
    }
    return units;
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

  // ── Commit ───────────────────────────────────────────────────────

  const commitProposal = async (
    scopeId: string,
    proposal: OrganizerProposal,
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
    // The automatic-memory switch authorizes forming effective memories.
    // Claim nature/provenance carries inference; review status is not authority.
    const commitStatus = "accepted";
    if (proposal.action === "new" || proposal.action === "supplement") {
      const result = await deps.memory.remember(owner, {
        content: proposal.content,
        ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
        ...(proposal.nature ? { nature: proposal.nature } : {}),
        source,
        commit: commitStatus,
        expectedRevision,
      });
      return result.created ? result.item.id : null;
    }
    // Targets came from the source scope's memory list; a cross-scope numeric
    // id must never address an unrelated row in another store.
    if (proposal.target === undefined || proposal.scope !== scopeKind(scopeId)) return null;
    const targetOwner = owner;
    // Compare against the revision shown to the model, not a fresh read taken
    // after it answered (which would authorize overwriting intervening edits).
    const item = existingMemories.find((memory) => memory.id === proposal.target);
    if (!item || item.invalidAt !== undefined || item.status !== "accepted") {
      return null;
    }
    const corrected = await deps.memory.correct(targetOwner, item.id, {
      content: proposal.content,
      ...(proposal.trigger ? { trigger: proposal.trigger } : {}),
      ...(proposal.nature ? { nature: proposal.nature } : {}),
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
      if (!settings.model) return;
      const store = await deps.storeForScopeId(scopeId);
      if (!store) return;

      const units = await collectUnits(store, scopeId);
      if (units.length === 0) return;
      for (const unit of units) {
        unit.source.key = createHash("sha256").update(JSON.stringify([scopeId, unit.key, unit.eventCursor, unit.entryCursor, unit.texts])).digest("hex");
      }
      for (const unit of units) {
        await putProgress(store, unit.key, "processing");
      }

      try {
        const judged = await filterUnitsByFastDecision(settings.fastDecision, units);
        if (disposed) return;
        const rejected = units.filter((unit) => !judged.includes(unit));
        for (const unit of rejected) {
          await putProgress(store, unit.key, "reviewed-empty", {
            ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
            ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
          });
        }
        if (judged.length === 0) return;

        const owner = ownerFor(scopeKind(scopeId), scopeId)!;
        let revision = store.knowledgeRevision();
        const userOwner: MemoryOwner = { scope: "user", ownerId: null };
        let userRevision = settings.autoOrganize.user ? await deps.memory.revision(userOwner) : "";
        const existing = await deps.memory.list(owner, { activeOnly: true });
        const proposals = await narrateProposals(settings.model, judged, existing);
        if (disposed) return;
        const currentSettings = await readHarnessSettings();
        if (!currentSettings.autoOrganize[scopeKind(scopeId)]) return;
        if (scopeKind(scopeId) === "workspace" && await deps.autoOrganizeForScope?.(scopeId) === false) return;
        // Reject invalid provenance before any proposal from this response is
        // written. A missing source is not permission to attach the first one.
        for (const proposal of proposals) {
          if (!judged[Number(proposal.source!.slice(1))]) throw new Error("Memory organizer referenced an unknown source");
          if (!ownerFor(proposal.scope, scopeId)) throw new Error("Memory organizer referenced an unrelated owner scope");
          if (proposal.action !== "new" && (proposal.scope !== scopeKind(scopeId)
            || !existing.slice(0, MAX_EXISTING_MATERIALS).some((item) => item.id === proposal.target))) {
            throw new Error("Memory organizer referenced a target outside its presented candidates");
          }
        }

        const produced: number[] = [];
        for (const proposal of proposals) {
          if (proposal.scope === "user" && !currentSettings.autoOrganize.user) continue;
          const sourceUnit = judged.find((_, index) => proposal.source === `u${index}`);
          if (disposed) return;
          if (revision !== store.knowledgeRevision()) throw new KnowledgeMutationError("conflict", "Memory changed while the organizer was preparing proposals");
          const source = sourceUnit!.source;
          const id = await commitProposal(scopeId, proposal, settings, source, existing,
            proposal.scope === "user" ? userRevision : revision);
          if (id !== null) produced.push(id);
          revision = store.knowledgeRevision();
          if (proposal.scope === "user" && settings.autoOrganize.user) userRevision = await deps.memory.revision(userOwner);
        }
        for (const unit of judged) {
          await putProgress(store, unit.key, produced.length > 0 ? "formed" : "reviewed-empty", {
            ...(unit.eventCursor !== undefined ? { eventCursor: unit.eventCursor } : {}),
            ...(unit.entryCursor !== undefined ? { entryCursor: unit.entryCursor } : {}),
            produced,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const unit of units) {
          await putProgress(store, unit.key, "failed", { lastError: message }).catch(report);
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
    /** Pending task count for tests/diagnostics. */
    get pending(): number { return pendingTasks.size; },
  };
}

export type MemoryOrganizer = ReturnType<typeof createMemoryOrganizer>;

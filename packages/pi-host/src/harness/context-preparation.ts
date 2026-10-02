import { randomUUID } from "node:crypto";
import {
  buildSessionContext,
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { CompactionRecoverySettings, CompactionRunResult, CompactionTaskSpec, CompactionTrace, JsonValue } from "@varin/protocol";
import { retainedContextState } from "./retained-context.js";
import { activeCompactionMessages } from "./compaction-context.js";
import {
  compactionWorkerContext,
  serializeCompactionModel,
} from "./compaction-agent.js";

import {
  attachContextRequestBoundary, ContextCapacityError, estimateModelInputTokens,
  modelRequestOptions,
  type ContextModelRequest,
  type ContextRequestBoundaryOptions,
} from "./context-request-boundary.js";

/**
 * Context preparation extension — fixed-candidate background compaction.
 *
 * Design: design/harness-context.md §8.4–8.6, design/context-compaction-agent-design.md (D-314)
 * Plan: plan/agent-harness-plan.md §2.4A/B, §2.6A, stage C
 * Decisions: D-284, D-286, D-314
 *
 * Budget is measured on the `context` hook, which Pi runs before every
 * provider request — including tool-loop continuations inside one turn.
 * When usage crosses the soft waterline, a fixed candidate is prepared in
 * the background (P + S0 + A + B fixed at preparation time). The foreground
 * agent keeps running; normal appends do not invalidate the candidate.
 *
 * The candidate runs in a dedicated internal compaction worker subprocess
 * (broker-spawned pi-host, role "compaction") that receives the frozen
 * S0/A/B material plus the shared continuation prompt and may issue
 * read-only history/output/record queries under an auxiliary actor.
 *
 * When a constructed provider request needs space, the request boundary
 * adopts the matching candidate, waits for an in-flight one, or starts a
 * fresh task. Prepared summaries do not replace history merely because a
 * turn became idle; the request boundary uses Pi's native compaction writer.
 * Failure keeps the original history.
 */

export interface ContextPreparationConfig {
  /** Background preparation switch (harness.context.backgroundPreparation). */
  enabled: boolean;
  /** Fraction of usable input where preparation starts (default 0.75). */
  waterline: number;
  recovery: CompactionRecoverySettings;
}

export interface ContextPreparationStatus {
  candidate: "none" | "preparing" | "ready";
  candidateTaskId?: string;
  applicationRequested?: boolean;
  enabled: boolean;
}

interface FixedPreparation {
  /** Id of the compaction entry bounding the summarized range, or null. */
  boundaryCompactionId: string | null;
  /** First entry id included in the summarized range, or null. */
  firstSummarizedEntryId: string | null;
  /** Last entry id included in the summarized range. */
  lastSummarizedEntryId: string;
  firstKeptEntryId: string;
  /** Branch leaf id when the range was fixed; bounds B and history reads. */
  fixedLeafEntryId: string;
  isSplitTurn: boolean;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  /** Retained recent original (B): entries firstKept..fixedLeaf, verbatim. */
  keptMessages: AgentMessage[];
  keptEntries: { id: string; messages: AgentMessage[] }[];
  previousSummary: string | undefined;
  tokensBefore: number;
}

export interface PreparedCandidate extends FixedPreparation {
  id: string;
  epoch: number;
  fixedAt: number;
  modelKey: string;
  selectionKey: string;
  tokensAtFix: number;
  status: "in-flight" | "ready" | "failed";
  /** The exact frozen task submitted to the worker. */
  spec: CompactionTaskSpec;
  abort: AbortController;
  done: Promise<void>;
  summary?: string;
  trace?: CompactionTrace;
  usage?: Usage;
  error?: string;
  manualRequested?: boolean;
  manualReadyNotified?: boolean;
  applyRequested?: boolean;
}

export interface ContextPreparationOptions {
  /**
   * Run one frozen compaction task in the dedicated internal worker
   * subprocess. Bound to the session's harness bridge in session-host;
   * cancellation propagates to worker teardown.
   */
  runCompactionTask: (
    spec: CompactionTaskSpec,
    signal: AbortSignal,
  ) => Promise<CompactionRunResult>;
  /** Live harness background-preparation setting. */
  getPreparationConfig: () => ContextPreparationConfig;
  getProjectTrusted: () => boolean;
  /** Live Pi compaction settings (enabled, reserveTokens, keepRecentTokens). */
  getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Undefined means Pi's default, so the total-input planning target applies. */
  getExplicitKeepRecentTokens?: () => number | undefined;
  /** Publish native raw retention after an actual compaction or branch navigation. */
  onRetention?: (params: import("@varin/protocol").ContextRetentionParams) => void | Promise<void>;
  /** Per-request injection seam forwarded to the request boundary (D-300). */
  inject?: ContextRequestBoundaryOptions["inject"];
  onFailure?: (phase: "prepare" | "commit", message: string) => void;
  onSuccess?: (phase: "prepare" | "commit") => void;
  onStatus?: () => void;
  onManualReady?: (taskId: string) => void;
  onApplyRequested?: (taskId: string) => void;
  onManualCommitted?: (taskId: string) => void;
  onManualFailed?: (taskId: string, message: string) => void;
  onRetry?: (taskId: string, attempt: number, maxAttempts: number, reason: string) => void;
  onTaskFailed?: (taskId: string, message: string) => void;
  now?: () => number;
}

const DEFAULT_WATERLINE = 0.75;
/** Planned share of usable input after compaction; a target, not a limit. */
const POST_COMPACTION_TARGET = 0.6;
/** Estimated chars-per-token for request-shape prefixes (matches estimateTokens). */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Fixed preparation — mirrors the SDK-internal prepareCompaction using the
// exported cut-point primitives, with a caller-chosen keepRecent budget.
// ---------------------------------------------------------------------------

function lastCompactionIndex(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") return i;
  }
  return -1;
}

export function computeFixedPreparation(
  entries: SessionEntry[],
  keepRecentTokens: number,
  tokensBefore?: number,
  forcedKeptIndex?: number,
): FixedPreparation | undefined {
  if (entries.length === 0) return undefined;
  const prevIndex = lastCompactionIndex(entries);
  const boundaryCompactionId = prevIndex >= 0 ? (entries[prevIndex]!.id ?? null) : null;
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevIndex >= 0) {
    const prev = entries[prevIndex]!;
    previousSummary = prev.type === "compaction" ? prev.summary : undefined;
    const prevFirstKept = prev.type === "compaction"
      ? entries.findIndex((entry) => entry.id === prev.firstKeptEntryId)
      : -1;
    boundaryStart = prevFirstKept >= 0 ? prevFirstKept : prevIndex + 1;
  }
  const projected = new Map(buildSessionProjection(entries).entries.map(entry => [entry.sourceEntry.id,
    entry.messages.filter(message => message.role !== "system")]));
  // Native system state is retained by appendCompaction; it cannot be freed
  // by summarizing conversation. Cuts and material use the edited projection.
  const sourceMessages = (entry: SessionEntry): AgentMessage[] => entry.type === "compaction" ? [] : projected.get(entry.id) ?? [];
  const raw = entries.map((entry, index) => ({ entry, index, messages: sourceMessages(entry) }))
    .slice(boundaryStart).filter(item => item.messages.length > 0);
  const cutEntries: SessionEntry[] = raw.map(({ entry, messages }) => ({ ...entry, type: "message", message: messages[0]! }));
  // Pi's nearest-after cut search cannot find a point after a trailing
  // tool result. Keep at least that complete tool exchange; never choose a
  // tool-result boundary or accidentally retain the entire old branch.
  let pairedTailTokens = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const messages = raw[i]!.messages;
    if (messages.some((message) => message.role === "assistant" || message.role === "user")) break;
    pairedTailTokens += messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);
  }
  const cut = forcedKeptIndex === undefined
    ? (() => {
      // Pi's cut primitive counts a compaction summary as content even though
      // S0 already carries it separately. A terminal compaction could consume
      // the entire keep budget and snap the cut to the oldest raw message.
      if (raw.length === 0) return undefined;
      const relative = findCutPoint(cutEntries, 0, raw.length,
        Math.max(keepRecentTokens, pairedTailTokens + 1));
      const firstKeptEntryIndex = raw[relative.firstKeptEntryIndex]?.index;
      if (firstKeptEntryIndex === undefined) return undefined;
      return { firstKeptEntryIndex,
        turnStartIndex: relative.turnStartIndex < 0 ? -1 : raw[relative.turnStartIndex]!.index,
        isSplitTurn: relative.isSplitTurn };
    })()
    : (() => {
      const relativeIndex = raw.findIndex(entry => entry.index === forcedKeptIndex);
      if (relativeIndex <= 0) return undefined;
      const messages = raw[relativeIndex]!.messages;
      if (!messages.some((message) => message.role !== "toolResult")) return undefined;
      const relativeStart = findTurnStartIndex(cutEntries, relativeIndex, 0);
      const turnStart = relativeStart < 0 ? -1 : raw[relativeStart]!.index;
      const startsTurn = turnStart === forcedKeptIndex;
      return { firstKeptEntryIndex: forcedKeptIndex,
        turnStartIndex: startsTurn ? -1 : turnStart,
        isSplitTurn: !startsTurn && turnStart >= 0 };
    })();
  if (!cut) return undefined;
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept?.id) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const entry = entries[i]!;
    if (entry.type === "compaction") continue;
    const messages = sourceMessages(entry);
    messagesToSummarize.push(...messages);
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.firstKeptEntryIndex; i++) {
      turnPrefixMessages.push(...sourceMessages(entries[i]!));
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
  // A prior compaction entry can sit between retained old text and a new cut.
  // S0 carries that entry's summary; A's endpoint names its own last raw entry.
  let lastSummarizedEntryId: string | undefined;
  for (let i = cut.firstKeptEntryIndex - 1; i >= boundaryStart; i--) {
    if (sourceMessages(entries[i]!).length > 0) {
      lastSummarizedEntryId = entries[i]!.id;
      break;
    }
  }
  if (!lastSummarizedEntryId) return undefined;
  let firstSummarizedEntryId: string | null = null;
  for (let i = boundaryStart; i < cut.firstKeptEntryIndex; i++) {
    if (sourceMessages(entries[i]!).length > 0) {
      firstSummarizedEntryId = entries[i]!.id ?? null;
      break;
    }
  }
  const fixedLeaf = entries[entries.length - 1]!;
  if (!fixedLeaf.id) return undefined;
  // B: the recent original text retained verbatim — actual content, not a marker.
  const keptMessages: AgentMessage[] = [];
  const keptEntries: FixedPreparation["keptEntries"] = [];
  for (let i = cut.firstKeptEntryIndex; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === "compaction") continue;
    const messages = sourceMessages(entry);
    if (entry.id) keptEntries.push({ id: entry.id, messages });
    keptMessages.push(...messages);
  }
  return {
    boundaryCompactionId,
    firstSummarizedEntryId,
    firstKeptEntryId: firstKept.id,
    fixedLeafEntryId: fixedLeaf.id,
    isSplitTurn: cut.isSplitTurn,
    lastSummarizedEntryId,
    keptMessages,
    keptEntries,
    messagesToSummarize,
    previousSummary,
    tokensBefore: tokensBefore ?? estimateModelInputTokens({ messages: convertToLlm(activeCompactionMessages(buildSessionContext(entries).messages)) }),
    turnPrefixMessages,
  };
}

// ---------------------------------------------------------------------------
// Task spec — the program freezes identity and material; the compaction worker
// receives the structured S0/A/B content and the shared prompt, and only
// interprets it. Roles, order, and tool-call pairing survive end to end.
// ---------------------------------------------------------------------------

function buildCompactionTaskSpec(
  model: Model<Api>,
  sessionId: string,
  projectTrusted: boolean,
  preparation: FixedPreparation,
  summaryOut: number,
  request: ContextModelRequest | undefined,
  customInstructions?: string,
): CompactionTaskSpec {
  const requestOptions = modelRequestOptions(request?.options);
  return {
    sessionId,
    projectTrusted,
    boundaryCompactionId: preparation.boundaryCompactionId,
    firstSummarizedEntryId: preparation.firstSummarizedEntryId,
    lastSummarizedEntryId: preparation.lastSummarizedEntryId,
    firstKeptEntryId: preparation.firstKeptEntryId,
    fixedLeafEntryId: preparation.fixedLeafEntryId,
    isSplitTurn: preparation.isSplitTurn,
    summarizedMessages: preparation.messagesToSummarize as unknown as JsonValue[],
    turnPrefixMessages: preparation.turnPrefixMessages as unknown as JsonValue[],
    keptMessages: preparation.keptMessages as unknown as JsonValue[],
    ...(preparation.previousSummary === undefined
      ? {}
      : { previousSummary: preparation.previousSummary }),
    model: serializeCompactionModel(model),
    options: {
      maxTokens: summaryOut,
      ...(requestOptions.reasoning === undefined
        ? {}
        : { reasoning: String(requestOptions.reasoning) }),
      ...(requestOptions.thinkingBudgets === undefined
        ? {}
        : { thinkingBudgets: requestOptions.thinkingBudgets as Record<string, JsonValue> }),
      ...(requestOptions.temperature === undefined ? {} : { temperature: requestOptions.temperature }),
      ...(requestOptions.samplingParams === undefined
        ? {}
        : { samplingParams: requestOptions.samplingParams as Record<string, JsonValue> }),
      ...(requestOptions.transport === undefined
        ? {}
        : { transport: String(requestOptions.transport) }),
      ...(requestOptions.cacheRetention === undefined
        ? {}
        : { cacheRetention: String(requestOptions.cacheRetention) }),
      sessionId,
    },
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
}

/** Estimated tokens of the exact request the worker agent will send. */
function estimateWorkerRequest(spec: CompactionTaskSpec): number {
  const request = compactionWorkerContext(spec);
  return estimateModelInputTokens({
    systemPrompt: request.systemPrompt,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    messages: convertToLlm(request.messages),
  });
}

/** A reference is not a provider message: no partial tool result is orphaned. */
function keptReferenceText(message: AgentMessage): { text: string; incomplete: boolean } {
  if (message.role === "bashExecution") return { text: `[command ${message.command}]\n${message.output}`, incomplete: false };
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return { text: message.summary, incomplete: false };
  }
  const content = "content" in message ? message.content : undefined;
  const imageOmitted = Array.isArray(content) && content.some((block) => block.type === "image");
  const contentText = (blocks: typeof content): string => typeof blocks === "string" ? blocks
    : Array.isArray(blocks) ? blocks.map((block) => block.type === "text" ? block.text
      : block.type === "thinking" ? `[thinking] ${block.thinking}`
        : block.type === "toolCall" ? `[tool call ${block.name}, id ${block.id}, args ${JSON.stringify(block.arguments)}]`
          : block.type === "image" ? `[image ${block.mimeType}; body omitted, read entry if needed]`
            : JSON.stringify(block)).join("\n") : "";
  if (message.role === "toolResult") {
    return { text: `[tool result ${message.toolName}, call ${message.toolCallId}]\n${contentText(content)}`,
      incomplete: imageOmitted };
  }
  return { text: contentText(content), incomplete: imageOmitted };
}

/**
 * Keep A complete. If B cannot fit verbatim, provide attributed B excerpts
 * and an exact omitted-entry boundary. Leave room for one query response as
 * well as the final output, each measured against this model's output budget.
 */
function fitSpecToWindow(
  spec: CompactionTaskSpec,
  preparation: FixedPreparation,
  contextWindow: number,
): CompactionTaskSpec | undefined {
  const fits = (candidate: CompactionTaskSpec) =>
    estimateWorkerRequest(candidate) + 2 * candidate.options.maxTokens <= contextWindow;
  if (fits(spec)) return spec;

  const entries = preparation.keptEntries;
  const sources = entries.map(({ id, messages }) => messages.map((message) => ({
    entryId: id, role: message.role, ...keptReferenceText(message),
  })));
  for (let start = 0; start < entries.length; start++) {
    const references = sources.slice(start).flat();
    if (references.length === 0) continue;
    const omittedKeptThroughEntryId = start > 0 ? entries[start - 1]!.id : undefined;
    const withWidth = (width: number): CompactionTaskSpec => ({
      ...spec,
      keptMessages: [],
      keptExcerptEntries: references.map(({ entryId, role, text, incomplete }) => ({
        entryId, role, excerpt: text.slice(0, width), truncated: incomplete || text.length > width,
      })),
      ...(omittedKeptThroughEntryId === undefined ? {} : { omittedKeptThroughEntryId }),
    });
    if (!fits(withWidth(0))) continue;
    let low = 0;
    let high = Math.max(...references.map(({ text }) => text.length));
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(withWidth(middle))) low = middle;
      else high = middle - 1;
    }
    if (low === 0) continue;
    return withWidth(low);
  }
  return undefined;
}

/**
 * Move the A/B cut toward the prior boundary, only at legal Pi message starts.
 * A smaller A is still complete; the newly retained history joins B, whose
 * references can be paged without claiming its entire body was understood.
 */
function fitPreparationToWindow(
  entries: SessionEntry[],
  initial: FixedPreparation,
  model: Model<Api>,
  sessionId: string,
  projectTrusted: boolean,
  summaryOut: number,
  request: ContextModelRequest | undefined,
  customInstructions?: string,
): { preparation: FixedPreparation; spec: CompactionTaskSpec } | undefined {
  const previousIndex = lastCompactionIndex(entries);
  const boundaryStart = previousIndex < 0 ? 0 : (() => {
    const boundary = entries[previousIndex]!;
    const firstKept = boundary.type === "compaction"
      ? entries.findIndex((entry) => entry.id === boundary.firstKeptEntryId) : -1;
    return firstKept >= 0 ? firstKept : previousIndex + 1;
  })();
  const initialIndex = entries.findIndex((entry) => entry.id === initial.firstKeptEntryId);
  if (initialIndex < 0) return undefined;
  for (let index = initialIndex; index > boundaryStart; index--) {
    const preparation = index === initialIndex ? initial
      : computeFixedPreparation(entries, 0, initial.tokensBefore, index);
    if (!preparation) continue;
    const releasable = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      .reduce((total, message) => total + estimateTokens(message), 0);
    if (releasable <= summaryOut) break;
    const spec = fitSpecToWindow(
      buildCompactionTaskSpec(model, sessionId, projectTrusted, preparation, summaryOut, request, customInstructions),
      preparation, model.contextWindow,
    );
    if (spec) return { preparation, spec };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export type ContextPreparationExtension = ExtensionFactory & {
  status(): ContextPreparationStatus;
  attach(session: AgentSession, onEvent: (event: AgentSessionEvent) => void): void;
  isBound(): boolean;
  isCommitting(): boolean;
  observeRequest(request: ContextModelRequest): void;
  prepareManual(customInstructions?: string): { taskId: string; status: "preparing" | "ready" };
  applyManual(taskId: string): Promise<void> | undefined;
  cancelApplication(): boolean;
};

export function createContextPreparationExtension(
  options: ContextPreparationOptions,
): ContextPreparationExtension {
  let candidate: PreparedCandidate | undefined;
  let latestRequest: ContextModelRequest | undefined;
  let boundary: ReturnType<typeof attachContextRequestBoundary> | undefined;
  let boundSession: AgentSession | undefined;
  let api: ExtensionAPI | undefined;
  let latestContext: ExtensionContext | undefined;
  let epoch = 0;
  // Waterline adaptation per model: measured growth while a preparation ran
  // shifts the next preparation earlier so it still finishes before capacity.
  const prepStats = new Map<string, { durationMs: number }>();
  let lastTokens = 0;
  let lastAt = 0;
  const now = options.now ?? (() => Date.now());

  const isCompactionStall = (error: unknown): boolean => error !== null && typeof error === "object"
    && "code" in error && error.code === "compaction-stalled";

  const runWithRecovery = async (spec: CompactionTaskSpec, signal: AbortSignal): Promise<CompactionRunResult> => {
    const recovery = options.getPreparationConfig().recovery;
    const frozenSpec = { ...spec, recovery };
    const maxAttempts = recovery.enabled ? recovery.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        return await options.runCompactionTask({ ...frozenSpec, attempt }, signal);
      } catch (error) {
        if (signal.aborted || !isCompactionStall(error) || attempt >= maxAttempts) throw error;
        try { options.onRetry?.(spec.taskId ?? "", attempt + 1, maxAttempts,
          error instanceof Error ? error.message : String(error)); }
        catch { /* Progress observers cannot prevent a safe retry. */ }
      }
    }
  };

  // A candidate freezes its source prefix. Later append-only turns do not
  // invalidate that prefix, so the key must not include request messages.
  const modelKey = (model: Model<Api> | undefined): string =>
    model === undefined ? "" : JSON.stringify(serializeCompactionModel(model));
  const executionModel = (ctx: ExtensionContext): Model<Api> | undefined =>
    latestRequest?.model ?? boundSession?.routedModel?.model ?? ctx.model;
  const sourceWasEdited = (entries: SessionEntry[], fixedLeafId: string): boolean => {
    const fixedIndex = entries.findIndex(entry => entry.id === fixedLeafId);
    const sourceIds = new Set(entries.slice(0, fixedIndex + 1).map(entry => entry.id));
    return entries.slice(fixedIndex + 1).some(entry => entry.type === "context_edit" && sourceIds.has(entry.targetId));
  };

  // Growth rate measured between consecutive context events (tokens/ms).
  let tokenRatePerMs = 0;
  const effectiveWaterline = (usable: number, key: string): number => {
    const config = options.getPreparationConfig();
    const base = config.waterline > 0 && config.waterline < 1 ? config.waterline : DEFAULT_WATERLINE;
    const stats = prepStats.get(key);
    if (!stats || stats.durationMs <= 0 || tokenRatePerMs <= 0) return base;
    // Start the next preparation earlier by the growth expected while a
    // same-shape summary runs, so it is ready before capacity runs out.
    const expectedGrowth = (tokenRatePerMs * stats.durationMs) / usable;
    return Math.max(base / 2, base - expectedGrowth * 2);
  };

  const boundaryId = (entries: SessionEntry[]): string | null => {
    const index = lastCompactionIndex(entries);
    return index >= 0 ? (entries[index]!.id ?? null) : null;
  };

  const candidateValid = (
    cand: PreparedCandidate,
    ctx: ExtensionContext,
    branchEntries: SessionEntry[],
  ): boolean =>
    cand.epoch === epoch
    && cand.spec.sessionId === ctx.sessionManager.getSessionId()
    && cand.boundaryCompactionId === boundaryId(branchEntries)
    && cand.modelKey === modelKey(executionModel(ctx))
    && cand.selectionKey === modelKey(ctx.model)
    && !sourceWasEdited(branchEntries, cand.fixedLeafEntryId)
    && branchEntries.some((entry) => entry.id === cand.firstKeptEntryId)
    && branchEntries.some((entry) => entry.id === cand.lastSummarizedEntryId)
    && branchEntries.some((entry) => entry.id === cand.fixedLeafEntryId);

  const notifyManualReady = (cand: PreparedCandidate): void => {
    if (!cand.manualRequested || cand.manualReadyNotified) return;
    cand.manualReadyNotified = true;
    options.onManualReady?.(cand.id);
  };

  const failManual = (cand: PreparedCandidate, message: string): void => {
    if (!cand.manualRequested) return;
    cand.manualRequested = false;
    options.onManualFailed?.(cand.id, message);
  };

  const discard = (reason: string): void => {
    epoch += 1;
    if (!candidate) return;
    if (candidate.applyRequested && reason !== "compacted") boundary?.cancelIdleApplication();
    failManual(candidate, reason);
    if (candidate.status === "in-flight") candidate.abort.abort();
    candidate = undefined;
    void reason;
  };

  const failApplication = (error: unknown): void => {
    if (!candidate?.applyRequested) return;
    const message = error instanceof Error ? error.message : String(error);
    options.onFailure?.("commit", message);
    discard(message);
  };

  const applyWhileIdle = () => boundary?.applyWhileIdle()?.catch(error => {
    failApplication(error);
    throw error;
  });

  const prefixTokens = (ctx: ExtensionContext, pi: ExtensionAPI): number => {
    let chars = ctx.getSystemPrompt().length;
    try {
      const active = new Set(pi.getActiveTools());
      for (const tool of pi.getAllTools()) {
        if (active.has(tool.name)) {
          chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
        }
      }
    } catch {
      // Tool metadata unavailable — estimate from system prompt only.
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  };

  const startPreparation = (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    tokensNow: number,
    usable: number,
    manual?: { customInstructions?: string },
  ): PreparedCandidate | undefined => {
    const model = executionModel(ctx);
    if (!model) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    const reserve = options.getCompactionSettings().reserveTokens;
    const summaryOut = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
    const prefix = prefixTokens(ctx, pi);
    // keepRecent targets ~60% total after commit: prefix + summary out + kept raw.
    const keepRecent = options.getExplicitKeepRecentTokens?.()
      ?? Math.max(1, Math.floor(POST_COMPACTION_TARGET * usable) - prefix - summaryOut);
    // A previous compaction may be the current leaf while its retained B is
    // still too large for the next request. The retention target can leave no
    // A at all; retry with the smallest legal complete tail so the request
    // boundary can make another finite, source-bound pass.
    const preparation = computeFixedPreparation(entries, keepRecent, tokensNow)
      ?? computeFixedPreparation(entries, 1, tokensNow);
    if (!preparation) return undefined;
    const fitted = fitPreparationToWindow(entries, preparation, model, sessionId, options.getProjectTrusted(), summaryOut, latestRequest, manual?.customInstructions);
    if (!fitted) return undefined;
    const { preparation: fixed, spec } = fitted;
    const id = randomUUID();
    spec.taskId = id;
    const cand: PreparedCandidate = {
      ...fixed,
      spec,
      abort: new AbortController(),
      done: Promise.resolve(),
      epoch,
      fixedAt: now(),
      id,
      modelKey: modelKey(model),
      selectionKey: modelKey(ctx.model),
      status: "in-flight",
      tokensAtFix: tokensNow,
      ...(manual === undefined ? {} : { manualRequested: true }),
    };
    discard("replace invalid candidate");
    cand.epoch = epoch;
    candidate = cand;
    const sourceSignal = manual === undefined ? latestRequest?.options.signal : undefined;
    const cancel = () => {
      if (cand.manualRequested) return;
      cand.abort.abort();
      if (candidate === cand) discard("request cancelled");
    };
    sourceSignal?.addEventListener("abort", cancel, { once: true });
    if (sourceSignal?.aborted) cancel();
    options.onStatus?.();
    cand.done = (async () => {
      try {
        // The spec was frozen with the candidate; rebuilding it here would
        // let a newer request shape drift into an already-fixed task.
        const result = await runWithRecovery(cand.spec, cand.abort.signal);
        cand.abort.signal.throwIfAborted();
        if (candidate !== cand) return;
        if (!candidateValid(cand, ctx, ctx.sessionManager.getBranch())) {
          discard("compaction source changed while preparation ran");
          return;
        }
        if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
          throw new Error("Compaction returned no summary text");
        }
        cand.summary = result.summary;
        if (result.trace !== undefined) cand.trace = result.trace;
        if (result.usage !== undefined) cand.usage = result.usage as unknown as Usage;
        cand.status = "ready";
        prepStats.set(cand.modelKey, {
          durationMs: Math.max(1, now() - cand.fixedAt),
        });
        options.onSuccess?.("prepare");
        notifyManualReady(cand);
      } catch (error) {
        if (cand.abort.signal.aborted) return;
        cand.status = "failed";
        cand.error = error instanceof Error ? error.message : String(error);
        options.onFailure?.("prepare", cand.error);
        if (!cand.manualRequested && isCompactionStall(error)) options.onTaskFailed?.(cand.id, cand.error);
        failManual(cand, cand.error);
      } finally {
        sourceSignal?.removeEventListener("abort", cancel);
        options.onStatus?.();
      }
    })();
    return cand;
  };

  const commitFromEvent = async (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    _pi: ExtensionAPI,
  ): Promise<CompactionResult | undefined> => {
    // A committed or in-flight candidate for the same source is authoritative:
    // its fixed range was already summarized, and messages appended after
    // fixation stay raw behind firstKeptEntryId.
    if (event.signal.aborted) return undefined;
    if (candidate && event.customInstructions !== undefined
      && candidate.spec.customInstructions !== event.customInstructions) discard("manual summary focus changed");
    if (candidate && !candidateValid(candidate, ctx, event.branchEntries)) discard("compaction source changed");
    const cand = candidate;
    if (cand && candidateValid(cand, ctx, event.branchEntries)) {
      if (cand.status === "in-flight") {
        // Capacity is already needed — wait for this same in-flight call
        // rather than starting a second summarization.
        await new Promise<void>((resolve) => {
          const cancel = () => {
            if (!cand.manualRequested) {
              cand.abort.abort();
              if (candidate === cand) discard("compaction cancelled");
            }
            resolve();
          };
          event.signal.addEventListener("abort", cancel, { once: true });
          if (event.signal.aborted) cancel();
          void cand.done.finally(() => {
            event.signal.removeEventListener("abort", cancel);
            resolve();
          });
        });
      }
      if (event.signal.aborted) return undefined;
      if (cand.status === "ready" && candidateValid(cand, ctx, ctx.sessionManager.getBranch())) {
        options.onSuccess?.("commit");
        return {
          firstKeptEntryId: cand.firstKeptEntryId,
          summary: cand.summary!,
          tokensBefore: event.preparation.tokensBefore,
          ...(cand.usage === undefined ? {} : { usage: cand.usage }),
          details: { varinCompactionTrace: cand.trace ?? { taskId: cand.id, entries: [] } },
        };
      }
      options.onFailure?.("commit", cand.error ?? "The prepared source was cancelled or changed");
      return undefined;
    }
    // No usable candidate (not prepared, stale source, or manual focus):
    // run the same worker task synchronously from Pi's own preparation.
    // This is the blocking path the design allows; manual and automatic
    // compaction share the single worker mechanism.
    const model = executionModel(ctx);
    if (!model) return undefined;
    const keptIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
    const fixedLeaf = event.branchEntries[event.branchEntries.length - 1];
    if (keptIndex < 0 || !fixedLeaf?.id) {
      options.onFailure?.("commit", "The compaction boundary is not on the active branch");
      return undefined;
    }
    let taskId: string | undefined;
    try {
      // Reconstruct the frozen material from this branch, including the last
      // native compaction boundary. A Pi event can use a different cut, but
      // its prepared message array must never be mislabeled as another range.
      const preparation = computeFixedPreparation(event.branchEntries, 0,
        event.preparation.tokensBefore, keptIndex);
      if (!preparation) throw new ContextCapacityError("The compaction source has no complete replaceable range");
      const reserve = options.getCompactionSettings().reserveTokens;
      const summaryOut = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
      const sessionId = ctx.sessionManager.getSessionId();
      const fitted = fitPreparationToWindow(event.branchEntries, preparation,
        model, sessionId, options.getProjectTrusted(), summaryOut, latestRequest, event.customInstructions);
      if (!fitted) {
        throw new ContextCapacityError("No complete source prefix fits the summary request with query capacity; original history was retained");
      }
      const { spec, preparation: fixed } = fitted;
      taskId = spec.taskId;
      const sourceEpoch = epoch;
      const sourceModelKey = modelKey(model);
      const sourceSelectionKey = modelKey(ctx.model);
      const sourceIds = event.branchEntries.map((entry) => entry.id);
      const result = await runWithRecovery(spec, event.signal);
      event.signal.throwIfAborted();
      if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
        throw new Error("Compaction returned no summary text");
      }
      const live = ctx.sessionManager.getBranch();
      if (sourceEpoch !== epoch || ctx.sessionManager.getSessionId() !== sessionId
        || modelKey(executionModel(ctx)) !== sourceModelKey
        || modelKey(ctx.model) !== sourceSelectionKey
        || sourceWasEdited(live, fixed.fixedLeafEntryId)
        || !sourceIds.every((id, index) => live[index]?.id === id)) {
        throw new ContextCapacityError("The summary source changed while preparation was running");
      }
      options.onSuccess?.("commit");
      return {
        firstKeptEntryId: fixed.firstKeptEntryId,
        summary: result.summary,
        tokensBefore: event.preparation.tokensBefore,
        ...(result.usage === undefined ? {} : { usage: result.usage as unknown as Usage }),
        ...(result.trace === undefined ? {} : { details: { varinCompactionTrace: result.trace } }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onFailure?.("commit", message);
      if (taskId && isCompactionStall(error)) options.onTaskFailed?.(taskId, message);
      return undefined;
    }
  };

  const factory: ExtensionFactory = (pi) => {
    api = pi;
    // A final answer has no next model request. Apply the selected candidate
    // after Pi finishes this run instead of leaving it pending indefinitely.
    pi.on("agent_settled", () => applyWhileIdle()?.catch(() => undefined));
    pi.on("context", (event, ctx) => {
      latestContext = ctx;
      if ((!options.getPreparationConfig().enabled || !options.getCompactionSettings().enabled)
        && !candidate?.manualRequested) {
        discard("preparation disabled");
      }
      return { messages: activeCompactionMessages(event.messages) };
    });

    pi.on("session_before_compact", async (event, ctx) => {
      // Pi's post-agent-end check is not request admission. The bound adapter
      // owns automatic commits. Manual compaction uses this same worker seam;
      // failure must cancel instead of falling through to Pi's one-shot engine.
      if (boundary && (event.reason !== "manual" || boundary.isCommitting())) return { cancel: true };
      try {
        const compaction = await commitFromEvent(event, ctx, pi);
        return compaction === undefined ? { cancel: true } : { compaction };
      } catch (error) {
        options.onFailure?.("commit", error instanceof Error ? error.message : String(error));
        return { cancel: true };
      }
    });

    pi.on("session_compact", async (event, ctx) => {
      const details = event.compactionEntry.details as { varinCompactionTrace?: { taskId?: string } } | undefined;
      if (candidate?.manualRequested && details?.varinCompactionTrace?.taskId === candidate.id) {
        candidate.manualRequested = false;
        options.onManualCommitted?.(candidate.id);
      }
      discard("compacted");
      lastTokens = 0;
      lastAt = 0;
      tokenRatePerMs = 0;
      const retained = retainedContextState(ctx.sessionManager.getBranch());
      await options.onRetention?.({
        retainedObservationRefs: retained.observationRefs,
        retainedGit: retained.retainedGit,
      });
    });

    pi.on("session_compact_failed", (event) => {
      if (boundary && (event.reason !== "manual" || boundary.isCommitting())) return;
      if (candidate?.status === "ready") discard("commit failed");
    });

    pi.on("session_tree", async (_event, ctx) => {
      latestRequest = undefined;
      lastTokens = lastAt = tokenRatePerMs = 0;
      discard("branch navigation");
      const retained = retainedContextState(ctx.sessionManager.getBranch());
      await options.onRetention?.({ retainedObservationRefs: retained.observationRefs, retainedGit: retained.retainedGit });
    });
    pi.on("model_select", () => { latestRequest = undefined; discard("model changed"); });
    pi.on("session_before_switch", () => { latestRequest = undefined; discard("session switch"); });
    pi.on("session_before_fork", () => { latestRequest = undefined; discard("session fork"); });
    pi.on("session_shutdown", () => { latestRequest = undefined; discard("shutdown"); boundary?.dispose(); });
  };

  const extension = factory as ContextPreparationExtension;
  extension.isBound = () => boundary !== undefined;
  extension.isCommitting = () => boundary?.isCommitting() ?? false;
  extension.applyManual = (taskId) => {
    const ctx = boundSession?.extensionRunner?.createContext() ?? latestContext;
    if (!boundary || !ctx || !candidate || candidate.id !== taskId || candidate.status !== "ready"
      || !candidateValid(candidate, ctx, ctx.sessionManager.getBranch())) {
      throw new Error("The selected summary is not ready or no longer matches this session; prepare a new summary");
    }
    if (candidate.applyRequested) return applyWhileIdle();
    if (boundary.isCommitting()) throw new Error("Context compaction is already being applied; wait for it to finish");
    candidate.manualRequested = true;
    candidate.applyRequested = true;
    options.onApplyRequested?.(taskId);
    options.onStatus?.();
    return applyWhileIdle();
  };
  extension.cancelApplication = () => {
    if (!candidate?.applyRequested) return false;
    discard("Immediate summary application was cancelled");
    return true;
  };
  extension.prepareManual = (customInstructions) => {
    const ctx = boundSession?.extensionRunner?.createContext() ?? latestContext;
    if (!ctx || !api || !ctx.model) throw new Error("The session compaction context is unavailable");
    const focus = customInstructions?.trim() || undefined;
    const entries = ctx.sessionManager.getBranch();
    if (candidate && !candidateValid(candidate, ctx, entries)) discard("compaction source changed");
    if (candidate && candidate.status !== "failed" && candidate.spec.customInstructions === focus) {
      candidate.manualRequested = true;
      if (candidate.status === "ready") notifyManualReady(candidate);
      return { taskId: candidate.id, status: candidate.status === "ready" ? "ready" : "preparing" };
    }
    if (candidate) discard("manual summary focus changed");
    const usable = executionModel(ctx)!.contextWindow - options.getCompactionSettings().reserveTokens;
    const estimated = estimateModelInputTokens({ messages: convertToLlm(activeCompactionMessages(buildSessionContext(entries).messages)) });
    const tokensNow = Math.max(ctx.getContextUsage()?.tokens ?? 0, estimated);
    const started = startPreparation(ctx, api, tokensNow, usable, { ...(focus ? { customInstructions: focus } : {}) });
    if (!started) throw new Error("Nothing in this session can be compacted yet");
    return { taskId: started.id, status: "preparing" };
  };
  extension.observeRequest = (request) => {
    latestRequest = request;
    const at = now();
    if (lastAt > 0 && request.inputTokens > lastTokens && at > lastAt) {
      const rate = (request.inputTokens - lastTokens) / (at - lastAt);
      tokenRatePerMs = tokenRatePerMs === 0 ? rate : tokenRatePerMs * 0.7 + rate * 0.3;
    }
    lastTokens = request.inputTokens;
    lastAt = at;
    const ctx = boundSession?.extensionRunner?.createContext() ?? latestContext;
    if (!ctx || !api) return;
    const config = options.getPreparationConfig();
    if (!config.enabled || !options.getCompactionSettings().enabled) {
      if (!candidate?.manualRequested) discard("preparation disabled");
      return;
    }
    const usable = request.model.contextWindow - request.reserveTokens;
    if (candidate && !candidateValid(candidate, ctx, ctx.sessionManager.getBranch())) discard("request configuration or source changed");
    if (request.needsSpace || usable <= 0) return;
    if (request.inputTokens < effectiveWaterline(usable, modelKey(request.model)) * usable) return;
    if (candidate && candidate.status !== "failed") return;
    startPreparation(ctx, api, request.inputTokens, usable);
  };
  extension.attach = (session, onEvent) => {
    boundary?.dispose();
    boundSession = session;
    boundary = attachContextRequestBoundary(session, {
      getCompactionSettings: options.getCompactionSettings,
      hasPreparedExplicitCompaction: () => {
        const ctx = session.extensionRunner?.createContext() ?? latestContext;
        return !!(candidate?.manualRequested && candidate.status !== "failed" && ctx
          && candidateValid(candidate, ctx, ctx.sessionManager.getBranch()));
      },
      hasImmediateCompaction: () => candidate?.applyRequested === true,
      onImmediateFailure: failApplication,
      observe: extension.observeRequest,
      ...(options.inject ? { inject: options.inject } : {}),
      onEvent,
      onStatus: () => options.onStatus?.(),
      compact: async (request, signal) => {
        latestRequest = request;
        const ctx = session.extensionRunner?.createContext() ?? latestContext;
        if (!ctx || !api) throw new ContextCapacityError("The Pi context extension is unavailable");
        const entries = ctx.sessionManager.getBranch();
        if (candidate?.applyRequested && !candidateValid(candidate, ctx, entries)) {
          throw new ContextCapacityError("The selected summary no longer matches this session; no compaction was applied");
        }
        if (!candidate || !candidateValid(candidate, ctx, entries) || candidate.status === "failed") {
          if (!options.getCompactionSettings().enabled) {
            throw new ContextCapacityError("The explicit summary is no longer available and automatic compaction is disabled; original history was retained");
          }
          startPreparation(ctx, api, request.inputTokens, request.model.contextWindow - request.reserveTokens);
        }
        const fixed = candidate;
        if (!fixed || !candidateValid(fixed, ctx, entries)) {
          throw new ContextCapacityError("No complete source prefix fits a summary request. Page the oversized material or adjust model capacity; original history was retained.");
        }
        const result = await commitFromEvent({
          type: "session_before_compact", reason: "threshold", willRetry: false, signal, branchEntries: entries,
          preparation: { firstKeptEntryId: fixed.firstKeptEntryId, messagesToSummarize: fixed.messagesToSummarize,
            turnPrefixMessages: fixed.turnPrefixMessages, isSplitTurn: fixed.isSplitTurn,
            ...(fixed.previousSummary === undefined ? {} : { previousSummary: fixed.previousSummary }),
            tokensBefore: request.inputTokens, settings: options.getCompactionSettings(),
            fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() } },
        }, ctx, api);
        if (!result) throw new ContextCapacityError("Context preparation failed or was cancelled; original history was retained");
        return result;
      },
    });
  };
  extension.status = (): ContextPreparationStatus => ({
    ...(candidate && candidate.status !== "failed" ? {
      candidateTaskId: candidate.id, applicationRequested: candidate.applyRequested === true,
    } : {}),
    candidate: candidate === undefined
      ? "none"
      : candidate.status === "ready"
        ? "ready"
        : candidate.status === "in-flight"
          ? "preparing"
          : "none",
    enabled: options.getPreparationConfig().enabled,
  });

  return extension;
}

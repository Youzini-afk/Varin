import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeFixedPreparation,
  createContextPreparationExtension,
} from "../../src/harness/context-preparation.js";
import { buildSessionContext, convertToLlm, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RequestBudgetObservation } from "../../src/harness/context-request-boundary.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { CompactionRunResult, CompactionTaskSpec } from "@varin/protocol";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = { provider: "faux", id: "faux-1", contextWindow: 16_000, maxTokens: 400 };

const usage = (total: number): Usage => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const pad = (text: string, size: number): string => text + " " + "detail ".repeat(Math.ceil(size / 7)).slice(0, size);

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
} as AgentMessage);

const assistantMessage = (text: string, tokens: number): AgentMessage => ({
  role: "assistant",
  api: "faux",
  provider: "faux",
  model: "faux-1",
  content: [{ type: "text", text }],
  usage: usage(tokens),
  stopReason: "stop",
  timestamp: Date.now(),
} as unknown as AgentMessage);

const toolResultMessage = (text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "bash",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
} as unknown as AgentMessage);

const toolCallMessage = (text: string): AgentMessage => ({
  ...assistantMessage(text, 100),
  content: [{ type: "text", text }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
} as AgentMessage);

const entry = (id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message,
});

/**
 * A branch long enough for findCutPoint to split: each entry carries ~1_000
 * characters (~250 estimated tokens) so the keepRecent budget leaves real
 * material in the summarize range. The last assistant message reports
 * `tailTokens` usage, which drives the request-budget check.
 */
const branchEntries = (tailTokens: number): SessionEntry[] => [
  entry("e1", null, userMessage(pad("First task: inspect the repository layout and report back.", 1_000))),
  entry("e2", "e1", assistantMessage(pad("I will list the directories first.", 1_000), 120)),
  entry("e3", "e2", toolResultMessage(pad("packages/ docs/ kernel/", 1_000))),
  entry("e4", "e3", assistantMessage(pad("Now reading the architecture doc.", 1_000), 180)),
  entry("e5", "e4", userMessage(pad("Also check the harness plan.", 1_000))),
  entry("e6", "e5", assistantMessage(pad("Reading it now.", 1_000), tailTokens)),
];

interface RecordedCall {
  spec: CompactionTaskSpec;
  signal: AbortSignal;
  resolve: (result: CompactionRunResult) => void;
  reject: (error: unknown) => void;
}

const okResult = (text: string): CompactionRunResult => ({
  summary: text,
  usage: JSON.parse(JSON.stringify(usage(42))),
  queries: 0,
});

interface Harness {
  handlers: Map<string, (event: never, ctx: never) => unknown>;
  calls: RecordedCall[];
  failures: [string, string][];
  successes: string[];
  manualReady: string[];
  manualCommitted: string[];
  manualFailed: Array<{ taskId: string; message: string }>;
  compactions: import("@varin/protocol").ContextRetentionParams[];
  config: { enabled: boolean; waterline: number };
  entries: SessionEntry[];
  extension: ReturnType<typeof createContextPreparationExtension>;
  ctx: {
    model: typeof MODEL;
    getContextUsage: () => { tokens: number; contextWindow: number };
    getSystemPrompt: () => string;
    sessionManager: { getBranch: () => SessionEntry[]; getSessionId: () => string };
  };
}

const createHarness = (entries: SessionEntry[], tokensNow: number): Harness => {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const calls: RecordedCall[] = [];
  const harness: Harness = {
    handlers,
    calls,
    failures: [],
    successes: [],
    manualReady: [],
    manualCommitted: [],
    manualFailed: [],
    compactions: [],
    config: { enabled: true, waterline: 0.75 },
    entries,
    ctx: {
      model: MODEL,
      getContextUsage: () => ({ tokens: tokensNow, contextWindow: 16_000 }),
      getSystemPrompt: () => "You are a coding agent.",
      sessionManager: {
        getBranch: () => harness.entries,
        getSessionId: () => "session-1",
      },
    },
    extension: undefined as never,
  };
  harness.extension = createContextPreparationExtension({
    getProjectTrusted: () => true,
    runCompactionTask: (spec, signal) => new Promise<CompactionRunResult>((resolve, reject) => {
      calls.push({ spec, signal, resolve, reject });
    }),
    getPreparationConfig: () => harness.config,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 400, keepRecentTokens: 300 }),
    getExplicitKeepRecentTokens: () => 300,
    onRetention: (params) => { harness.compactions.push(params); },
    onFailure: (phase, message) => harness.failures.push([phase, message]),
    onSuccess: (phase) => harness.successes.push(phase),
    onManualReady: (taskId) => harness.manualReady.push(taskId),
    onManualCommitted: (taskId) => harness.manualCommitted.push(taskId),
    onManualFailed: (taskId, message) => harness.manualFailed.push({ taskId, message }),
  });
  harness.extension({
    on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
    getAllTools: () => [
      { name: "bash", description: "run a command", parameters: { type: "object" } },
      { name: "read", description: "read a file", parameters: { type: "object" } },
    ],
    getActiveTools: () => ["bash", "read"],
  } as never);
  return harness;
};

const fireContext = (harness: Harness, tokens: number, messages?: AgentMessage[]): void => {
  harness.ctx.getContextUsage = () => ({ tokens, contextWindow: 16_000 });
  const handler = harness.handlers.get("context")!;
  handler({
    type: "context",
    messages: messages ?? harness.entries.flatMap((e) => e.type === "message" ? [e.message] : []),
  } as never, harness.ctx as never);
  harness.extension.observeRequest({
    model: harness.ctx.model as never,
    context: { systemPrompt: harness.ctx.getSystemPrompt(),
      tools: ["bash", "read"].map((name) => ({ name, description: name === "bash" ? "run a command" : "read a file", parameters: { type: "object" } as never })),
      messages: convertToLlm(messages ?? harness.entries.flatMap((e) => e.type === "message" ? [e.message] : [])),
    },
    options: { sessionId: "session-1" }, inputTokens: tokens, reserveTokens: 400, needsSpace: false,
  });
};

const compactEvent = (
  harness: Harness,
  overrides?: { customInstructions?: string; signal?: AbortSignal; reason?: string },
): { type: string; preparation: unknown; branchEntries: SessionEntry[]; reason: string; willRetry: boolean; signal: AbortSignal; customInstructions?: string } => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: harness.entries[harness.entries.length - 2]!.id,
    messagesToSummarize: harness.entries.slice(0, -2).flatMap((e) => e.type === "message" ? [e.message] : []),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 900,
  },
  branchEntries: harness.entries,
  reason: overrides?.reason ?? "threshold",
  willRetry: false,
  signal: overrides?.signal ?? new AbortController().signal,
  ...(overrides?.customInstructions === undefined ? {} : { customInstructions: overrides.customInstructions }),
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context preparation extension", () => {
  it("starts a fixed background candidate over the waterline while the foreground turn keeps running", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    // context hook returns synchronously — the model request is not blocked.
    fireContext(harness, 12_000);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.extension.status().candidate, "preparing");
    // A tool-loop continuation request does not start a second task.
    fireContext(harness, 12_010);
    assert.equal(harness.calls.length, 1);
    // The frozen spec carries identity and structured S0/A/B material.
    const spec = harness.calls[0]!.spec;
    assert.equal(spec.sessionId, "session-1");
    assert.equal(spec.boundaryCompactionId, null);
    assert.ok(spec.firstSummarizedEntryId, "A range start is recorded");
    assert.ok(spec.summarizedMessages.length > 0, "A body is supplied");
    assert.ok(spec.keptMessages.length > 0, "B is real content, not a marker");
    assert.equal(spec.fixedLeafEntryId, "e6");
    // B is exactly the verbatim tail from firstKeptEntryId to the leaf.
    const keptIds = harness.entries
      .slice(harness.entries.findIndex((e) => e.id === spec.firstKeptEntryId))
      .flatMap((e) => (e.type === "message" ? [e.message] : []));
    assert.deepEqual(spec.keptMessages, JSON.parse(JSON.stringify(keptIds)));
    // A ends right before the kept range; roles and pairing are preserved.
    const summarizedIds = harness.entries
      .slice(0, harness.entries.findIndex((e) => e.id === spec.firstKeptEntryId))
      .flatMap((e) => (e.type === "message" ? [e.message] : []));
    assert.deepEqual(spec.summarizedMessages, JSON.parse(JSON.stringify(summarizedIds)));
    assert.deepEqual(
      (spec.summarizedMessages as { role: string }[]).map((m) => m.role),
      summarizedIds.map((m) => m.role),
    );
  });

  it("does nothing under the waterline, when disabled, or when Pi compaction is off", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 500);
    assert.equal(harness.calls.length, 0);

    harness.config.enabled = false;
    fireContext(harness, 12_000);
    assert.equal(harness.calls.length, 0);
  });

  it("commit waits for the in-flight candidate and adopts its fixed cut instead of a second task", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    assert.equal(harness.calls.length, 1);

    const event = compactEvent(harness);
    const commitPromise = harness.handlers.get("session_before_compact")!(event as never, harness.ctx as never);
    // The foreground request is waiting on the same in-flight worker task.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.calls.length, 1);

    harness.calls[0]!.resolve({ ...okResult("Working summary of earlier turns."), trace: {
      taskId: "preparation-1", entries: [{ kind: "assistant", at: 1, text: "Working summary of earlier turns." }],
    } });
    const result = await commitPromise as { compaction?: { summary: string; firstKeptEntryId: string } };
    assert.equal(result.compaction?.summary, "Working summary of earlier turns.");
    assert.deepEqual((result.compaction as { details?: unknown })?.details, { varinCompactionTrace: {
      taskId: "preparation-1", entries: [{ kind: "assistant", at: 1, text: "Working summary of earlier turns." }],
    } });
    assert.ok(harness.entries.some((e) => e.id === result.compaction?.firstKeptEntryId));
    assert.deepEqual(harness.successes, ["prepare", "commit"]);
    assert.equal(harness.calls.length, 1);
  });

  it("commits a ready candidate immediately without another worker task", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.resolve(okResult("Ready summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    const result = await harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    ) as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Ready summary.");
    assert.equal(harness.calls.length, 1);
  });

  it("runs the same worker task synchronously from Pi's preparation when no candidate exists", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    // The synchronous spec carries B verbatim through the fixed leaf as well.
    assert.ok(harness.calls[0]!.spec.keptMessages.length > 0);
    assert.equal(harness.calls[0]!.spec.fixedLeafEntryId, "e6");
    harness.calls[0]!.resolve({ ...okResult("Synchronous summary."), trace: {
      taskId: "manual-1", entries: [{ kind: "assistant", at: 2, text: "Synchronous summary." }],
    } });
    const result = await commitPromise as { compaction?: { summary: string; firstKeptEntryId: string } };
    assert.equal(result.compaction?.summary, "Synchronous summary.");
    assert.deepEqual((result.compaction as { details?: unknown })?.details, { varinCompactionTrace: {
      taskId: "manual-1", entries: [{ kind: "assistant", at: 2, text: "Synchronous summary." }],
    } });
    assert.equal(result.compaction?.firstKeptEntryId, harness.entries[harness.entries.length - 2]!.id);
    assert.deepEqual(harness.successes, ["commit"]);
  });

  it("a custom instruction bypasses the candidate and regenerates with the focus applied", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.resolve(okResult("Candidate summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness, { customInstructions: "Focus on the database schema" }) as never,
      harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 2);
    assert.equal(harness.calls[1]!.spec.customInstructions, "Focus on the database schema");
    harness.calls[1]!.resolve(okResult("Schema-focused summary."));
    const result = await commitPromise as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Schema-focused summary.");
  });

  it("reuses one candidate after new turns append behind its frozen source", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    assert.equal(harness.calls.length, 1);
    harness.entries.push(entry("e7", "e6", userMessage("A later clarification stays raw.")));
    fireContext(harness, 12_100);
    assert.equal(harness.calls.length, 1, "appending a turn must not restart the same summary");
    harness.calls[0]!.resolve(okResult("Frozen-prefix summary"));
    await waitFor(() => harness.extension.status().candidate === "ready");
    const result = await harness.handlers.get("session_before_compact")!(compactEvent(harness) as never, harness.ctx as never) as {
      compaction?: { summary: string; firstKeptEntryId: string };
    };
    assert.equal(result.compaction?.summary, "Frozen-prefix summary");
    assert.equal(result.compaction?.firstKeptEntryId, harness.calls[0]!.spec.firstKeptEntryId);
    assert.equal(harness.calls.length, 1);
  });

  it("shares a manual background candidate with later capacity admission", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    assert.equal(harness.calls.length, 0);
    const first = harness.extension.prepareManual();
    const repeated = harness.extension.prepareManual();
    assert.deepEqual(repeated, first);
    assert.equal(first.status, "preparing");
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0]!.spec.taskId, first.taskId);
    harness.config.enabled = false;
    fireContext(harness, 1_350);
    assert.equal(harness.extension.status().candidate, "preparing", "disabling automatic preparation must not cancel a manual request");
    harness.config.enabled = true;
    harness.entries.push(entry("e7", "e6", userMessage("New work continues while the summary runs.")));
    fireContext(harness, 12_100);
    const committing = harness.handlers.get("session_before_compact")!(compactEvent(harness) as never, harness.ctx as never);
    assert.equal(harness.calls.length, 1);
    harness.calls[0]!.resolve(okResult("Shared manual summary"));
    const result = await committing as { compaction?: { details?: unknown; summary: string } };
    assert.equal(result.compaction?.summary, "Shared manual summary");
    assert.deepEqual(result.compaction?.details, { varinCompactionTrace: { taskId: first.taskId, entries: [] } });
    assert.deepEqual(harness.manualReady, [first.taskId]);
    await harness.handlers.get("session_compact")!({
      type: "session_compact",
      compactionEntry: { details: result.compaction?.details },
    } as never, harness.ctx as never);
    assert.deepEqual(harness.manualCommitted, [first.taskId]);
    assert.equal(harness.calls.length, 1);
  });

  it("reports a manual source change that occurs while its worker is finishing", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    const manual = harness.extension.prepareManual();
    harness.ctx.model = { ...MODEL, id: "another-model" };
    harness.calls[0]!.resolve(okResult("Summary from the old model"));
    await waitFor(() => harness.manualFailed.length === 1);
    assert.equal(harness.extension.status().candidate, "none");
    assert.deepEqual(harness.manualFailed, [{ taskId: manual.taskId,
      message: "compaction source changed while preparation ran" }]);
  });

  it("routes a bound manual compaction through the same worker and preserves custom focus", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    const agent = {
      streamFunction: async () => { throw new Error("manual summary must not use the foreground stream"); },
      state: { systemPrompt: "You are a coding agent.", tools: [], messages: [] },
    };
    harness.extension.attach({ agent, model: harness.ctx.model,
      extensionRunner: { createContext: () => harness.ctx },
      sessionManager: harness.ctx.sessionManager,
    } as never, () => undefined);
    const work = harness.handlers.get("session_before_compact")!(compactEvent(harness, {
      reason: "manual", customInstructions: "Focus on database migration",
    }) as never, harness.ctx as never);
    await waitFor(() => harness.calls.length === 1);
    assert.equal(harness.calls[0]!.spec.customInstructions, "Focus on database migration");
    harness.calls[0]!.resolve(okResult("Manual worker summary."));
    const result = await work as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Manual worker summary.");
    const automatic = await harness.handlers.get("session_before_compact")!(compactEvent(harness) as never, harness.ctx as never);
    assert.deepEqual(automatic, { cancel: true });
  });

  it("does not reuse a B candidate after that fixed leaf leaves the active branch", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.resolve(okResult("Old branch summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");
    harness.entries = [...harness.entries.slice(0, -1),
      entry("e6-other", "e5", assistantMessage("Different tool continuation", 100))];
    const work = harness.handlers.get("session_before_compact")!(compactEvent(harness) as never, harness.ctx as never);
    await waitFor(() => harness.calls.length === 2);
    assert.equal(harness.calls[1]!.spec.fixedLeafEntryId, "e6-other");
    harness.calls[1]!.resolve(okResult("Current branch summary."));
    const result = await work as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Current branch summary.");
  });

  it("second compaction starts A at the last first-kept entry, with S0 as separate material", async () => {
    const base = branchEntries(1_300);
    const prior = { type: "compaction", id: "c1", parentId: "e4", timestamp: new Date().toISOString(),
      summary: "S0 covers e1 through e3", firstKeptEntryId: "e4", tokensBefore: 4_000 } as SessionEntry;
    const entries = [...base.slice(0, 4), prior,
      entry("e5", "c1", userMessage(pad("New request after S0", 1_000))),
      entry("e6", "e5", assistantMessage(pad("Progress after S0", 1_000), 1_300))];
    const harness = createHarness(entries, 12_000);
    const event = {
      ...compactEvent(harness),
      preparation: {
        firstKeptEntryId: "e6", messagesToSummarize: [base[3]!.type === "message" ? base[3]!.message : null,
          entries[5]!.type === "message" ? entries[5]!.message : null].filter(Boolean),
        turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12_000,
        previousSummary: "S0 covers e1 through e3",
      },
    };
    const work = harness.handlers.get("session_before_compact")!(event as never, harness.ctx as never);
    await waitFor(() => harness.calls.length === 1);
    const spec = harness.calls[0]!.spec;
    assert.equal(spec.boundaryCompactionId, "c1");
    assert.equal(spec.previousSummary, "S0 covers e1 through e3");
    assert.equal(spec.firstSummarizedEntryId, "e4");
    assert.equal(spec.lastSummarizedEntryId, "e5");
    assert.deepEqual([...spec.summarizedMessages, ...spec.turnPrefixMessages], event.preparation.messagesToSummarize);
    harness.calls[0]!.resolve(okResult("Second summary."));
    assert.equal((await work as { compaction?: { summary: string } }).compaction?.summary, "Second summary.");
  });

  it("keeps A complete and uses sourced B excerpts without orphaning a tool result", () => {
    const entries: SessionEntry[] = [
      entry("a1", null, userMessage(pad("Initial task", 1_400))),
      entry("a2", "a1", assistantMessage(pad("Planning", 1_400), 100)),
      entry("a3", "a2", userMessage(pad("Constraint", 1_400))),
      entry("a4", "a3", toolCallMessage(pad("Run inspection", 10_000))),
      entry("a5", "a4", toolResultMessage(pad("Massive output", 10_000))),
      entry("a6", "a5", assistantMessage(pad("Continue", 1_000), 100)),
    ];
    const harness = createHarness(entries, 4_000);
    harness.ctx.model = { ...MODEL, contextWindow: 4_500 };
    fireContext(harness, 4_000);
    assert.equal(harness.calls.length, 1);
    const spec = harness.calls[0]!.spec;
    assert.equal(spec.firstKeptEntryId, "a4", "the large A tail moves into retained B at a legal cut");
    assert.deepEqual([...spec.summarizedMessages, ...spec.turnPrefixMessages],
      entries.slice(0, 3).map((item) => item.type === "message" ? item.message : null));
    assert.equal(spec.keptMessages.length, 0);
    assert.deepEqual(spec.keptExcerptEntries?.map(({ entryId, role }) => [entryId, role]), [
      ["a4", "assistant"], ["a5", "toolResult"], ["a6", "assistant"],
    ]);
    assert.ok(spec.keptExcerptEntries?.some((item) => item.truncated));
    assert.equal("elidedSummarizedThroughEntryId" in spec, false);
  });

  it("preserves original history when no nonempty complete A can fit", async () => {
    const entries = [
      entry("huge", null, userMessage(pad("One unsplittable old entry", 30_000))),
      entry("tail", "huge", assistantMessage("Latest progress", 100)),
    ];
    const harness = createHarness(entries, 4_000);
    harness.ctx.model = { ...MODEL, contextWindow: 4_500 };
    fireContext(harness, 4_000);
    assert.equal(harness.calls.length, 0);
    const result = await harness.handlers.get("session_before_compact")!(compactEvent(harness) as never, harness.ctx as never);
    assert.deepEqual(result, { cancel: true });
    assert.equal(harness.calls.length, 0);
    assert.match(harness.failures.at(-1)?.[1] ?? "", /no complete replaceable range|No complete source prefix/);
  });

  it("can summarize retained raw history again when a compaction entry is the leaf", () => {
    const base = branchEntries(1_300);
    const c1 = { type: "compaction", id: "c1", parentId: "e6", timestamp: new Date().toISOString(),
      summary: "First summary", firstKeptEntryId: "e3", tokensBefore: 10_000 } as SessionEntry;
    const second = computeFixedPreparation([...base, c1], 1);
    assert.equal(second?.boundaryCompactionId, "c1");
    assert.equal(second?.previousSummary, "First summary");
    assert.equal(second?.firstSummarizedEntryId, "e3");
    assert.equal(second?.firstKeptEntryId, "e6");
    assert.equal(second?.fixedLeafEntryId, "c1");
    assert.deepEqual([...second!.messagesToSummarize, ...second!.turnPrefixMessages],
      base.slice(2, 5).map((item) => item.type === "message" ? item.message : null));

    const c2 = { type: "compaction", id: "c2", parentId: "c1", timestamp: new Date().toISOString(),
      summary: "Second summary", firstKeptEntryId: "e5", tokensBefore: 8_000 } as SessionEntry;
    const third = computeFixedPreparation([...base, c1, c2], 1);
    assert.equal(third?.boundaryCompactionId, "c2");
    assert.equal(third?.firstSummarizedEntryId, "e5");
    assert.equal(third?.firstKeptEntryId, "e6");
    assert.deepEqual([...third!.messagesToSummarize, ...third!.turnPrefixMessages],
      [base[4]!.type === "message" ? base[4]!.message : null]);
  });

  it("the context hook projects repeated native compaction entries to only the latest S1", () => {
    const base = branchEntries(1_300);
    const c1 = { type: "compaction", id: "c1", parentId: "e6", timestamp: new Date().toISOString(),
      summary: "Old S0", firstKeptEntryId: "e3", tokensBefore: 10_000 } as SessionEntry;
    const c2 = { type: "compaction", id: "c2", parentId: "c1", timestamp: new Date().toISOString(),
      summary: "Current S1", firstKeptEntryId: "e5", tokensBefore: 8_000 } as SessionEntry;
    const harness = createHarness([...base, c1, c2], 12_000);
    const native = buildSessionContext(harness.entries).messages;
    assert.deepEqual(native.flatMap((message) => message.role === "compactionSummary" ? [message.summary] : []),
      ["Current S1", "Old S0"]);
    const projected = harness.handlers.get("context")!({ type: "context", messages: native } as never,
      harness.ctx as never) as { messages: AgentMessage[] };
    assert.deepEqual(projected.messages.flatMap((message) => message.role === "compactionSummary" ? [message.summary] : []),
      ["Current S1"]);
    assert.deepEqual(projected.messages.filter((message) => message.role !== "compactionSummary"),
      native.filter((message) => message.role !== "compactionSummary"));
  });

  it("reports a prepare failure, clears the candidate, and retries on the next request", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.reject(new Error("provider offline"));
    await waitFor(() => harness.failures.length === 1);
    assert.equal(harness.failures[0]![0], "prepare");
    assert.equal(harness.extension.status().candidate, "none");

    // Next context event retries preparation rather than staying stuck.
    fireContext(harness, 12_020);
    assert.equal(harness.calls.length, 2);
  });

  it("rejects an empty worker result instead of committing it", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.resolve({ summary: "   ", queries: 0 });
    await waitFor(() => harness.failures.length === 1);
    assert.match(harness.failures[0]![1], /no summary/i);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("a failed synchronous commit cancels without a second worker task and reports the commit phase", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    harness.calls[0]!.reject(new Error("rate limited"));
    const result = await commitPromise;
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(harness.failures, [["commit", "rate limited"]]);
  });

  it("aborts the in-flight candidate on branch navigation and refuses a stale commit", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    assert.equal(harness.calls.length, 1);

    harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.equal(harness.calls[0]!.signal.aborted, true);
    assert.equal(harness.extension.status().candidate, "none");

    // A compaction on the new branch cannot reuse the discarded candidate.
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 2);
    harness.calls[1]!.resolve(okResult("Fresh branch summary."));
    const result = await commitPromise as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Fresh branch summary.");
  });

  it("a model switch discards the candidate keyed to the old model", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.calls[0]!.resolve(okResult("Old model summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    harness.handlers.get("model_select")!({ type: "model_select" } as never, harness.ctx as never);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("calibrates a matching real request once without adding cached tokens twice", () => {
    const observation = new RequestBudgetObservation();
    const context = { systemPrompt: "stable prefix", messages: convertToLlm([userMessage("hello")]) };
    const response = {
      role: "assistant",
      api: "faux",
      provider: "faux",
      model: "faux-1",
      content: [{ type: "text", text: "answer" }],
      usage: { ...usage(1_000), input: 100, cacheRead: 700, cacheWrite: 100, output: 100 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    observation.record("same-config", context, response as never);
    assert.equal(observation.estimate("same-config", context), 900);
    observation.clear();
    assert.ok(observation.estimate("same-config", context) < 100);
  });
});


describe("D-284 acceptance regressions", () => {
  it("rebinds observation retention on branch navigation without preparing a summary", async () => {
    const note: SessionEntry = { id: "kept-note", parentId: null, timestamp: new Date().toISOString(),
      type: "custom_message", customType: "varin-context", content: "observed facts", display: false,
      details: { observationRefs: ["kept-receipt"], gitObserved: true } };
    const harness = createHarness([note], 10);
    await harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.deepEqual(harness.compactions.at(-1), { retainedObservationRefs: ["kept-receipt"], retainedGit: true });
    harness.entries = [entry("other", null, userMessage("a different branch"))];
    await harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.deepEqual(harness.compactions.at(-1), { retainedObservationRefs: [], retainedGit: false });
    assert.equal(harness.calls.length, 0);
  });
  for (const failure of ["Compaction did not complete: aborted", "Compaction did not complete: length"]) {
    it(`never adopts a failed worker result (${failure})`, async () => {
      const harness = createHarness(branchEntries(1_300), 12_000);
      fireContext(harness, 12_000);
      harness.calls[0]!.reject(new Error(failure));
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.equal(harness.extension.status().candidate, "none");
      assert.equal(harness.failures.length, 1);
    });
  }

  it("cancels already-running preparation when the user disables background maintenance", () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    fireContext(harness, 12_000);
    harness.config.enabled = false;
    fireContext(harness, 12_050);
    assert.equal(harness.calls[0]!.signal.aborted, true);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("does not fall through to a second worker task after a failed explicit commit", async () => {
    const harness = createHarness(branchEntries(1_300), 12_000);
    const commit = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    harness.calls[0]!.reject(new Error("summary request failed"));
    assert.deepEqual(await commit, { cancel: true });
    assert.equal(harness.calls.length, 1);
  });
});

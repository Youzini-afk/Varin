import { fauxProvider, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { CompactionTaskSpec, JsonValue } from "@varin/protocol";
import { CompactionWorkerRuntime } from "../../src/compaction-worker.js";

const makeSpec = (
  model: ReturnType<ReturnType<typeof fauxProvider>["getModel"]>,
  overrides: Partial<CompactionTaskSpec> = {},
): CompactionTaskSpec => ({
  sessionId: "worker-session",
  projectTrusted: false,
  boundaryCompactionId: null,
  firstSummarizedEntryId: "entry-1",
  lastSummarizedEntryId: "entry-2",
  firstKeptEntryId: "entry-3",
  fixedLeafEntryId: "entry-4",
  isSplitTurn: false,
  summarizedMessages: [{ role: "user", content: "older task", timestamp: Date.now() }],
  turnPrefixMessages: [],
  keptMessages: [{ role: "user", content: "retained task", timestamp: Date.now() }],
  model: JSON.parse(JSON.stringify(model)) as JsonValue,
  options: { maxTokens: 256, cacheRetention: "none" },
  ...overrides,
});

const createWorker = async (
  faux: ReturnType<typeof fauxProvider>,
  onRequest?: (requestId: string, worker: CompactionWorkerRuntime) => void,
  options: { configureModelRuntime?: boolean } = {},
): Promise<{ worker: CompactionWorkerRuntime; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "varin-compaction-worker-"));
  const model = faux.getModel();
  const holder: { worker?: CompactionWorkerRuntime } = {};
  const worker = new CompactionWorkerRuntime({
    agentDir: root,
    emit: (event, data) => {
      if (event === "harness.request" && holder.worker) {
        onRequest?.((data as { requestId: string }).requestId, holder.worker);
      }
    },
    ...(options.configureModelRuntime === false ? {} : {
      configureModelRuntime: async (runtime: ModelRuntime) => {
        runtime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
          api: model.api,
          baseUrl: model.baseUrl,
          models: [{
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          }],
        });
        await runtime.setRuntimeApiKey(model.provider, "faux-key");
      },
    }),
  });
  holder.worker = worker;
  return { worker, root };
};

describe("compaction worker", () => {
  it("converts S0 and custom history messages before the provider request", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    const requests: Context[] = [];
    faux.setResponses([(context) => {
      requests.push({
        messages: structuredClone(context.messages),
      });
      return fauxAssistantMessage("summary");
    }]);
    const { worker, root } = await createWorker(faux);
    try {
      const result = await worker.run(makeSpec(faux.getModel(), {
        previousSummary: "S0-KEEP-ME",
        summarizedMessages: [{ role: "system", content: "PARENT-LIVE-INSTRUCTIONS",
          timestamp: 0, toolsAdded: [{ name: "write", description: "parent writer", parameters: { type: "object" } }],
        }, {
          role: "custom",
          customType: "note",
          content: "CUSTOM-HISTORY-KEEP-ME",
          display: false,
          timestamp: Date.now(),
        } as unknown as JsonValue],
      }));
      assert.equal(result.summary, "summary");
      assert.equal(requests.length, 1);
      const text = JSON.stringify(requests[0]!.messages);
      assert.match(text, /S0-KEEP-ME/);
      assert.match(text, /CUSTOM-HISTORY-KEEP-ME/);
      assert.match(text, /PARENT-LIVE-INSTRUCTIONS/);
      assert.doesNotMatch(getCurrentSystemPrompt(requests[0]!.messages), /PARENT-LIVE-INSTRUCTIONS/);
      assert.match(getCurrentSystemPrompt(requests[0]!.messages), /background compaction agent/);
      assert.deepEqual(getCurrentTools(requests[0]!.messages).map(tool => tool.name), ["history", "output", "records"]);
      assert.match(text, /conversation history before this point was compacted/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a provider request after a query makes the full context exceed capacity", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 4_000, maxTokens: 512 }] });
    const requests: Context[] = [];
    faux.setResponses([
      (context) => {
        requests.push({
          messages: structuredClone(context.messages),
        });
        return fauxAssistantMessage([fauxToolCall("history", { query: "missing" })]);
      },
      () => fauxAssistantMessage("must not be sent"),
    ]);
    const { worker, root } = await createWorker(faux, (requestId, current) => {
      current.respondHarness("worker-session", requestId, {
        ok: true,
        result: {
          content: [{ type: "text", text: "QUERY-RESULT " + "large ".repeat(2_000) }],
          details: {},
        },
      });
    });
    try {
      await assert.rejects(
        worker.run(makeSpec(faux.getModel())),
        /context window|history was retained/i,
      );
      assert.equal(requests.length, 1, "the over-capacity continuation must not reach the provider");
      assert.equal(faux.state.callCount, 1, "capacity admission happens before the second provider call");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage accumulated across every assistant provider request", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall("history", { query: "known" })]),
      () => fauxAssistantMessage("final summary with enough output to measure"),
    ]);
    const { worker, root } = await createWorker(faux, (requestId, current) => {
      current.respondHarness("worker-session", requestId, {
        ok: true,
        result: { content: [{ type: "text", text: "small result" }], details: {} },
      });
    });
    try {
      const result = await worker.run(makeSpec(faux.getModel()));
      assert.ok(result.usage && typeof result.usage === "object");
      const usage = result.usage as { output?: number };
      // The final response alone is shorter than the first tool-call response
      // plus the final response. This catches returning only lastAssistant.usage.
      assert.ok((usage.output ?? 0) > Math.ceil("final summary with enough output to measure".length / 4));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-final stop reason even when text is present", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    faux.setResponses([() => fauxAssistantMessage("partial summary", { stopReason: "toolUse" })]);
    const { worker, root } = await createWorker(faux);
    try {
      await assert.rejects(worker.run(makeSpec(faux.getModel())), /did not complete: toolUse/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads a static Pi extension provider before running the worker", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    faux.setResponses([() => fauxAssistantMessage("extension summary")]);
    const model = faux.getModel();
    const { worker, root } = await createWorker(faux, undefined, { configureModelRuntime: false });
    try {
      await mkdir(join(root, "extensions"), { recursive: true });
      await writeFile(join(root, "extensions", "worker-provider.ts"), `import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
      export default function (pi: any) {
        const fake = fauxProvider({ api: ${JSON.stringify(model.api)} });
        fake.setResponses([fauxAssistantMessage("extension summary")]);
        pi.registerProvider("worker-extension", {
          api: ${JSON.stringify(model.api)},
          streamSimple: fake.provider.streamSimple,
          apiKey: "faux-key",
          baseUrl: ${JSON.stringify(model.baseUrl)},
          models: [${JSON.stringify({
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          })}],
        });
      }
      `, "utf8");
      const extensionModel = { ...model, provider: "worker-extension" };
      const result = await worker.run(makeSpec(extensionModel));
      assert.equal(result.summary, "extension summary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not block a usable model on an unrelated extension load error", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    faux.setResponses([() => fauxAssistantMessage("usable despite diagnostic")]);
    const { worker, root } = await createWorker(faux);
    try {
      await mkdir(join(root, "extensions"), { recursive: true });
      await writeFile(join(root, "extensions", "broken-unrelated.ts"), "export default ???", "utf8");
      const result = await worker.run(makeSpec(faux.getModel()));
      assert.equal(result.summary, "usable despite diagnostic");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts the agent and in-flight bridge work", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      await held;
      return fauxAssistantMessage("never committed");
    }]);
    const { worker, root } = await createWorker(faux);
    try {
      const running = worker.run(makeSpec(faux.getModel()));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      worker.abort();
      release();
      await assert.rejects(running, /aborted/i);
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a stalled non-streaming provider request so the caller can retry", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 8_000, maxTokens: 512 }] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    faux.setResponses([async () => {
      await held;
      return fauxAssistantMessage("late summary");
    }]);
    const { worker, root } = await createWorker(faux);
    try {
      await assert.rejects(
        worker.run(makeSpec(faux.getModel(), {
          // Leave room for native SDK/auth initialization; this case exercises
          // a provider that has started and then never produces a response.
          recovery: { enabled: true, responseWaitMs: 1_000, streamIdleMs: 20, maxRetries: 1 },
        })),
        (error: { code?: string }) => error.code === "compaction_stalled",
      );
      assert.equal(faux.state.callCount, 1, "the stall must occur after the provider request starts");
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });
});

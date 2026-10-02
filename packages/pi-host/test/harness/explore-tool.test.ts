import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { HarnessRequestError, type HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createExploreTool } from "../../src/harness/explore-tool.js";
import type { ExploreToolProgress, ExploreQueryView } from "@varin/protocol";
import { runAgentLoop, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

const finishResult = {
  text: "1 excerpt(s)",
  snippets: [],
  issueCount: 0,
  notRequestedCount: 0,
  omittedCount: 0,
  partial: false,
  searched: { patterns: 1, files: 1, ms: 1, incomplete: false },
  handle: "out_test",
  details: {
    provenance: { statusCounts: {} },
    anchors: { supplied: ["createMemoryAgentExtension"], used: ["createMemoryAgentExtension"], truncated: 0 },
    byteBudget: 24576,
  },
};

describe("Host-backed explore tool", () => {
  it("keeps unavailable retrieval distinct from an empty successful result", async () => {
    const bridge = { inputContext: () => ({ source: "disk" }),
      request: async () => { throw new HarnessRequestError("unavailable", "The search source is offline"); },
    } as unknown as HostServicesBridge;
    const result = await createExploreTool(bridge, "session").execute("tool", { question: "needle" }, undefined, undefined, undefined as never);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal((result.details as { progress: ExploreToolProgress }).progress.phase, "unavailable");
    assert.equal((result.details as { errorCode: string }).errorCode, "unavailable");
  });
  it("streams versioned evidence through the existing wait loop and preserves the complete process in its result", async () => {
    const view = (id: string): ExploreQueryView => ({ viewId: id, path: `${id}.ts`, startLine: 2, endLine: 3,
      text: `private candidate body ${id}`, revision: `rev-${id}`, source: "disk", ranges: [], arrivals: [],
      assessment: "object-present", purpose: "candidate", why: "literal match" });
    let release!: () => void;
    let waiting!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { waiting = resolve; });
    let sequence = 1;
    const calls: string[] = [];
    const bridge = {
      inputContext: () => ({ source: "disk" }), cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        const sources = [{ id: "literal", family: "lexical", status: sequence === 1 ? "running" : "ready" }];
        if (method === "explore.query.start") return { queryId: "progress", deadlineAt: Date.now() + 30_000,
          parsed: { objects: ["needle"] }, vocab: {}, sources, inputSource: "disk" };
        if (method === "explore.query.views") return { views: [view("a"), ...(sequence === 2 ? [view("b")] : [])]
          .filter(item => !(params.seen as string[]).includes(item.viewId)),
          sequence, pending: sequence === 1, sources, actions: [], unevaluated: 0 };
        if (method === "explore.query.wait") { waiting(); await blocked; sequence = 2; return { sequence }; }
        if (method === "explore.query.finish") return { ...finishResult, snippets: [view("b")] };
        if (method === "explore.query.release") return { released: true };
        throw Error(method);
      },
    } as unknown as HostServicesBridge;
    const updates: ExploreToolProgress[] = [];
    const running = createExploreTool(bridge, "session").execute("tool", { question: "needle" }, undefined,
      update => updates.push((update.details as { progress: ExploreToolProgress }).progress), undefined as never);
    await entered;
    assert.equal(updates.at(-1)?.receivedSnippets, 1);
    assert.ok(updates.some(update => update.activities.some(item => item.kind === "read" && item.path === "a.ts" && item.revision === "rev-a")));
    const frozen = JSON.stringify(updates[1]);
    release();
    const result = await running;
    const progress = (result.details as { progress: ExploreToolProgress }).progress;
    assert.equal(progress.phase, "complete");
    assert.equal(progress.receivedSnippets, 2);
    assert.equal(progress.receivedFiles, 2);
    assert.equal(progress.activities.filter(item => item.kind === "read").length, 2);
    assert.equal((result.details as { snippetCount: number }).snippetCount, 1);
    assert.equal(JSON.stringify(updates[1]), frozen);
    assert.doesNotMatch(JSON.stringify(progress), /private candidate body/);
    assert.equal(calls.filter(method => method === "explore.query.wait").length, 1);
    assert.equal(calls.at(-1), "explore.query.release");
  });

  it("cancels pending retrieval and persists a cancellation result without finishing or requesting more work", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let cancelCount = 0;
    let waiting!: () => void;
    const entered = new Promise<void>(resolve => { waiting = resolve; });
    const bridge = {
      inputContext: () => ({ source: "disk" }), cancel: () => { cancelCount++; },
      request: async (method: string, _params: unknown, options: { signal?: AbortSignal }) => {
        calls.push(method);
        if (method === "explore.query.start") return { queryId: "cancelled", deadlineAt: Date.now() + 30_000,
          parsed: { objects: [] }, vocab: {}, sources: [] };
        if (method === "explore.query.views") return { views: [], sources: [], actions: [], sequence: 0, pending: true, unevaluated: 0 };
        if (method === "explore.query.wait") {
          waiting();
          return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
        }
        if (method === "explore.query.release") return { released: true };
        throw Error(method);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");
    const nativeTool: AgentTool = { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      execute: (id, args, signal, onUpdate) => tool.execute(id, args, signal, onUpdate, undefined as never) };
    let requests = 0;
    const run = runAgentLoop([{ role: "user", content: "find needle", timestamp: 0 }], { messages: [], tools: [nativeTool] }, {
      model: { provider: "test", id: "test", api: "openai-responses" } as AgentLoopConfig["model"],
      convertToLlm: messages => messages as never,
    }, async () => {}, controller.signal, (_model, _context, options) => {
      // Pi calls the adapter with the cancelled signal to produce its native
      // aborted assistant record. The adapter must not start inference then.
      const cancelled = options?.signal?.aborted === true;
      if (!cancelled) assert.equal(++requests, 1, "cancellation must not start another inference");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", provider: "test", model: "test", api: "openai-responses", timestamp: 1,
        stopReason: cancelled ? "aborted" : "toolUse", content: cancelled ? [] : [{ type: "toolCall", id: "tool", name: "explore", arguments: { question: "needle" } }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push(cancelled ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "toolUse", message });
      });
      return stream;
    });
    await entered;
    controller.abort();
    const messages = await run;
    const result = messages.find(message => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, true);
    assert.equal((result.details as unknown as { progress: ExploreToolProgress }).progress.phase, "cancelled");
    assert.ok(messages.some(message => message.role === "assistant" && message.stopReason === "aborted"));
    assert.equal(cancelCount, 1);
    assert.ok(!calls.includes("explore.query.finish"));
    assert.equal(calls.at(-1), "explore.query.release");
  });
  it("does not call the explore LLM when the user selected dedicated rerank", async () => {
    let completions = 0;
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "explore.query.start") return {
          queryId: "eq_rerank", question: params.question, deadlineAt: Date.now() + 5000,
          parsed: { objects: ["service"], relation: "unknown", domain: "unknown" },
          vocab: { objects: ["service"], anchors: [] }, sources: [], inputSource: "disk",
          decisionMode: "rerank",
        };
        if (method === "explore.query.views") return { views: [{}], sequence: 1, pending: false, actions: [], outputByteBudget: 24576, unevaluated: 0 };
        if (method === "explore.query.finish") return { ...finishResult,
          details: { ...finishResult.details, model: params.model } };
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session", { complete: async () => { completions += 1; return ""; } });
    const result = await tool.execute("call", { question: "where is service" }, undefined, undefined, undefined as never);
    assert.equal(completions, 0);
    assert.equal((result.details as { model: { select: string } }).model.select, "disabled");
  });

  it("T9: accepts anchors, forwards them, and describes conceptual mapping", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") {
          return {
            queryId: "eq_test",
            question: params.question,
            deadlineAt: Date.now() + 1000,
            parsed: { objects: [], relation: "unknown", domain: "unknown" },
            vocab: { objects: [], anchors: params.anchors ?? [] },
            sources: [],
            inputSource: "disk",
          };
        }
        if (method === "explore.query.views") {
          return {
            queryId: "eq_test",
            question: "where is the factory",
            views: [],
            sequence: 1, pending: false, actions: [], outputByteBudget: 24576, unevaluated: 0,
            sources: [],
            deadlineAt: Date.now() + 1000,
          };
        }
        if (method === "explore.query.finish") return finishResult;
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");

    assert.match(tool.description ?? "", /Locate relevant code and read the related context/);
    assert.match(tool.description ?? "", /anchors/);
    assert.match(tool.description ?? "", /conceptual names/);
    assert.doesNotMatch(tool.description ?? "", /Open question/);
    assert.doesNotMatch(tool.description ?? "", /broad questions/);
    assert.match(tool.promptSnippet ?? "", /conceptual questions/);
    assert.ok((tool.promptGuidelines ?? []).some((line) => /conceptual question and repository identifiers/i.test(line)));

    await tool.execute(
      "call",
      { question: "where is the factory", anchors: ["createMemoryAgentExtension"], paths: ["../project-a", "D:/project/project-b"], budgetMs: 300_000, limit: 3 },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls[0]?.method, "explore.query.start");
    assert.equal(calls[0]?.params.question, "where is the factory");
    assert.deepEqual(calls[0]?.params.anchors, ["createMemoryAgentExtension"]);
    assert.equal(calls[0]?.params.limit, 3);
    assert.deepEqual(calls[0]?.params.paths, ["../project-a", "D:/project/project-b"]);
    assert.ok(Number(calls[0]?.params.budgetMs) > 290_000);
    assert.ok(calls.some((call) => call.method === "explore.query.views"));
    assert.ok(calls.some((call) => call.method === "explore.query.finish"));
    assert.ok(calls.some((call) => call.method === "explore.query.release"));
  });

  it("accepts a blank anchor at the schema layer so the Host can filter it", () => {
    const tool = createExploreTool({ request: async () => ({}) } as unknown as HostServicesBridge, "session");
    // The Host drops blank anchors and reports them in details.anchors. A stricter schema here
    // would reject the whole call instead, so the two layers must accept the same input.
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", ""] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", "  "] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: [7] }), false);
  });

  it("collects completed material after the search budget expires without issuing a 1ms RPC", async (t) => {
    let now = 10_000;
    t.mock.method(Date, "now", () => now);
    const calls: Array<{ method: string; timeoutMs: number | undefined }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" }),
      cancel: () => assert.fail("budget expiration must not cancel completed query material"),
      request: async (method: string, params: Record<string, unknown>, options: { timeoutMs?: number }) => {
        calls.push({ method, timeoutMs: options.timeoutMs });
        if (method === "explore.query.start") return {
          queryId: "eq_budget", deadlineAt: now + 500,
          parsed: { objects: [] }, vocab: {}, sources: [],
        };
        if (method === "explore.query.finish") return {
          ...finishResult, details: { ...finishResult.details, model: params.model },
        };
        if (method === "explore.query.release") return { released: true };
        assert.fail(`expired query must not launch ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session", {
      complete: async () => {
        now += 501;
        return JSON.stringify({ groups: [{ expressions: ["needle"] }] });
      },
    });
    const result = await tool.execute("call", { question: "how does it work", budgetMs: 500 }, undefined, undefined, undefined as never);
    assert.equal((result as { isError?: boolean }).isError, undefined);
    assert.equal(result.content[0]?.type, "text");
    assert.equal((result.details as { handle: string }).handle, finishResult.handle);
    assert.equal((result.details as { partial: boolean }).partial, true);
    assert.match((result.details as { model: { note: string } }).model.note, /budget exhausted \(500ms\)/);
    assert.deepEqual(calls.map((call) => call.method), ["explore.query.start", "explore.query.finish", "explore.query.release"]);
    assert.ok(calls.every((call) => call.timeoutMs !== undefined && call.timeoutMs > 1));
  });

  it("keeps large omitted and unread lists behind the output reference", async () => {
    const calls: string[] = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string) => {
        calls.push(method);
        if (method === "explore.query.start") return {
          queryId: "eq_large",
          question: "needle",
          deadlineAt: Date.now() + 10_000,
          parsed: { objects: [], relation: "unknown", domain: "unknown" },
          vocab: {},
          sources: [],
          inputSource: "disk",
        };
        if (method === "explore.query.views") return {
          queryId: "eq_large",
          question: "needle",
          views: [],
          sequence: 1, pending: false, actions: [], outputByteBudget: 24576, unevaluated: 0,
          sources: [],
          deadlineAt: Date.now() + 10_000,
        };
        if (method === "explore.query.finish") return {
          ...finishResult,
          text: 'partial result; get_output("out_large") for all details',
          partial: true,
          notRequestedCount: 700,
          omittedCount: 600,
          details: {
            ...finishResult.details,
            provenance: { statusCounts: { "not-requested": 900 } },
          },
          handle: "out_large",
        };
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");
    const result = await tool.execute("call", { question: "needle" }, undefined, undefined, undefined as never);
    const serialized = JSON.stringify(result);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.handle, "out_large");
    assert.equal(details.partial, true);
    assert.equal(details.notRequestedCount, 700);
    assert.equal(details.omittedCount, 600);
    assert.equal((details.provenanceCounts as Record<string, number>)["not-requested"], 900);
    const textContent = result.content.find((block) => block.type === "text");
    assert.match(textContent?.text ?? "", /get_output\("out_large"\)/);
    assert.doesNotMatch(serialized, /unread-0\.ts|omitted-0\.ts|provenance-0\.ts/);
    assert.ok(calls.includes("explore.query.release"));
  });

  it("does not mark select as used when the Host rejects every chosen view", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") {
          return {
            queryId: "eq_test",
            question: params.question,
            deadlineAt: Date.now() + 10_000,
            parsed: { objects: [], relation: "unknown", domain: "unknown" },
            vocab: { objects: [], anchors: [] },
            sources: [],
            inputSource: "disk",
          };
        }
        if (method === "explore.query.views") {
          return {
            queryId: "eq_test",
            question: "how does reclaim work",
            views: [{
              viewId: "v1",
              path: "a.ts",
              startLine: 1,
              endLine: 1,
              text: "reclaim",
              revision: "r1",
              source: "disk",
              ranges: [{ rangeId: "v1:full", startLine: 1, endLine: 1 }],
              arrivals: [],
              assessment: "object-present",
              purpose: "candidate",
              why: "hit",
            }],
            sequence: 1, pending: false, actions: [], outputByteBudget: 24576, unevaluated: 0,
            sources: [],
            deadlineAt: Date.now() + 10_000,
          };
        }
        if (method === "explore.query.select") {
          return { queryId: "eq_test", accepted: [], selectedViews: [], rejected: [{ viewId: "v1", reason: "required group exceeds excerpt limit" }], gaps: [] };
        }
        if (method === "explore.query.finish") {
          return {
            ...finishResult,
            details: {
              ...finishResult.details,
              model: (params as { model?: { select?: string } }).model,
            },
          };
        }
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session", {
      complete: async ({ systemPrompt, user }) => {
        if (systemPrompt.includes("select complementary")) assert.match(user, /Output excerpt limit: 2/);
        return JSON.stringify({
        groups: [{ id: "sel1", purpose: "x", views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }] }],
        });
      },
    });
    const result = await tool.execute(
      "call",
      { question: "how does reclaim work", limit: 2 },
      undefined,
      undefined,
      undefined as never,
    );
    const finish = calls.find((call) => call.method === "explore.query.finish");
    assert.equal((finish?.params.model as { select?: string } | undefined)?.select, "skipped");
    assert.equal((result.details as { model?: { select?: string } }).model?.select, "skipped");
    assert.match((result.details as { model: { note: string } }).model.note, /required group exceeds excerpt limit/);
  });

  it("keeps an accepted selection when the optional incremental follow-up fails", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const view = (viewId: string, path: string) => ({
      viewId,
      path,
      startLine: 1,
      endLine: 1,
      text: "reclaim",
      revision: "r1",
      source: "disk",
      ranges: [{ rangeId: `${viewId}:full`, startLine: 1, endLine: 1 }],
      arrivals: [],
      assessment: "unverified",
      purpose: "candidate",
      why: "hit",
    });
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") return {
          queryId: "eq_test",
          question: params.question,
          deadlineAt: Date.now() + 10_000,
          parsed: { objects: [], relation: "unknown", domain: "implementation" },
          vocab: { objects: [], anchors: [] },
          sources: [],
          inputSource: "disk",
        };
        if (method === "explore.query.plan") return { queryId: "eq_test", launched: ["reclaimLease"], reused: [], sources: [] };
        if (method === "explore.query.views") return {
          queryId: "eq_test",
          question: "how does reclaim work",
          views: calls.some(call => call.method === "explore.query.followup") ? [view("v2", "b.ts")] : [view("v1", "a.ts")],
          sequence: 1, pending: false, actions: [], outputByteBudget: 24576, unevaluated: 0,
          sources: [],
          deadlineAt: Date.now() + 10_000,
        };
        if (method === "explore.query.select") return { queryId: "eq_test", accepted: [{ groupId: "sel1", viewIds: ["v1"] }], rejected: [], gaps: [], selectedViews: [view("v1", "a.ts")] };
        if (method === "explore.query.followup") return { queryId: "eq_test", launched: ["reclaimNow"], reused: [], newViews: [view("v2", "b.ts")], sources: [] };
        if (method === "explore.query.finish") return {
          ...finishResult,
          details: { ...finishResult.details, model: (params as { model?: unknown }).model },
        };
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    let completion = 0;
    const tool = createExploreTool(bridge, "session", {
      complete: async () => {
        completion += 1;
        if (completion === 1) return JSON.stringify({ behavior: "reclaim", groups: [{ id: "g1", concept: "reclaim", expressions: ["reclaimLease"] }] });
        if (completion === 2) return JSON.stringify({
          groups: [{ id: "sel1", purpose: "reclaim path", views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }] }],
          followup: { searches: [{ expression: "reclaimNow" }] },
        });
        throw new Error("incremental model failed");
      },
    });
    await tool.execute("call", { question: "how does reclaim work" }, undefined, undefined, undefined as never);
    const finish = calls.find((call) => call.method === "explore.query.finish");
    assert.deepEqual(finish?.params.model, {
      plan: "used",
      select: "used",
      followup: "failed",
      note: "Explore follow-up failed; the earlier accepted material was kept.",
    });
  });
});

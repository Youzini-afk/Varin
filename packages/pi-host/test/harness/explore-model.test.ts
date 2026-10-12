import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPLORE_PLAN_SYSTEM,
  ExploreBudgetExhausted,
  resolveExploreDuties,
  runExploreModelLoop,
  type ExploreModelComplete,
  type ExploreModelLoopPort,
  type ExploreQueryFollowupParams,
  type ExploreQuerySelectionGroup,
  type ExploreQueryStartResult,
  type ExploreQueryView,
  exploreShouldPlanWithModel,
  exploreShouldSelectWithModel,
  parseExplorePlan,
  parseExploreSelection,
  renderExploreSelectPrompt,
} from "@varin/protocol";

describe("explore model consumers", () => {
  it("skips a plan for a path-only navigation and keeps it for a mechanism question with anchors", () => {
    assert.equal(exploreShouldPlanWithModel("src/reclaim.ts", ["src/reclaim.ts"]), false);
    assert.equal(exploreShouldPlanWithModel("how does reclaimLease discard idle tokens", ["reclaimLease"]), true);
    assert.equal(exploreShouldSelectWithModel("how does reclaimLease discard idle tokens", ["reclaimLease"], false), true);
  });

  it("parses grouped plan expressions and selection range ids", () => {
    const plan = parseExplorePlan(`
      here you go
      {"behavior":"discard idle tokens","groups":[{"id":"g1","concept":"reclaim","expressions":["reclaimLease","parkedHandles"]}]}
    `);
    assert.deepEqual(plan?.groups[0]?.expressions, ["reclaimLease", "parkedHandles"]);
    const selected = parseExploreSelection(JSON.stringify({
      groups: [{
        id: "sel1",
        purpose: "reclaim implementation",
        views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }],
        gap: "no caller in this batch",
      }],
      followup: { searches: [{ expression: "parkedHandles.delete" }], locates: [{ kind: "symbol", value: "reclaimLease" }] },
    }));
    assert.equal(selected?.groups[0]?.views[0]?.viewId, "v1");
    assert.equal(selected?.followup?.searches?.[0]?.expression, "parkedHandles.delete");
  });

  it("distinguishes explicit empty selections from wholly malformed groups without rejecting mixed valid items", () => {
    assert.equal(parseExploreSelection('{"groups":[{"views":[{"viewId":17}]}]}'), undefined);
    assert.deepEqual(parseExploreSelection('{"groups":[]}')?.groups, []);
    const selection = parseExploreSelection(JSON.stringify({
      extra: "allowed", groups: [null, { views: [{ viewId: "v1", extra: true }, { viewId: 17 }] }],
    }));
    assert.equal(selection?.groups[0]?.views[0]?.viewId, "v1");
    assert.equal(selection?.groups.length, 1);
  });

  it("labels range line spans and keeps selected material in the incremental prompt", () => {
    const view = {
      viewId: "v1",
      path: "z.ts",
      startLine: 12,
      endLine: 40,
      text: "selected-evidence",
      revision: "r1",
      source: "disk" as const,
      ranges: [{ rangeId: "v1:full", startLine: 12, endLine: 40 }, { rangeId: "v1:h1", startLine: 15, endLine: 15 }],
      arrivals: [],
      assessment: "object-present" as const,
      purpose: "candidate" as const,
      why: "hit",
    };
    const added = { ...view, viewId: "v2", path: "a.ts", text: "new-evidence" };
    const prompt = renderExploreSelectPrompt("how", {
      queryId: "eq",
      question: "how",
      views: [view],
      unevaluated: 0, sequence: 1, pending: false, actions: [], outputByteBudget: 24576,
      sources: [],
      deadlineAt: 1,
    }, "incremental", { selectedViews: [view], newViews: [added] });
    assert.match(prompt, /v1:full L12-40/);
    for (const source of [view, added]) {
      assert.ok(prompt.includes(source.path));
      assert.ok(prompt.includes(source.text));
    }
  });
});

describe("shared Explore model loop", () => {
  it("resolves ready capabilities without allowing an explicit mode to cascade", () => {
    for (const llm of [false, true]) for (const fastDecision of [false, true]) for (const rerank of [false, true]) {
      const ready = { llm, fastDecision, rerank };
      assert.deepEqual(resolveExploreDuties({ mode: "auto", ...ready }), {
        actions: fastDecision ? "fast-decision" : llm ? "llm" : "source",
        selection: llm ? "llm" : fastDecision ? "fast-decision" : rerank ? "rerank" : "source",
      });
      assert.deepEqual(resolveExploreDuties({ mode: "source", ...ready }), { actions: "source", selection: "source" });
      assert.deepEqual(resolveExploreDuties({ mode: "llm", ...ready }), {
        actions: llm ? "llm" : "source", selection: llm ? "llm" : "source",
      });
      assert.deepEqual(resolveExploreDuties({ mode: "fast-decision", ...ready }), {
        actions: fastDecision ? "fast-decision" : "source", selection: fastDecision ? "fast-decision" : "source",
      });
      assert.deepEqual(resolveExploreDuties({ mode: "rerank", ...ready }), {
        actions: "source", selection: rerank ? "rerank" : "source",
      });
    }
  });

  it("keeps progressive joint selection, action context and race-free collection beyond a fixed round count", async (t) => {
    t.mock.method(AbortSignal, "timeout", () => assert.fail("an unbounded query must not create a timeout"));
    const started = startResult(Infinity);
    let wave = 1;
    let selected: ExploreQueryView[] = [];
    const selections: ExploreQuerySelectionGroup[][] = [];
    const followups: Array<Omit<ExploreQueryFollowupParams, "queryId">> = [];
    const offered: Array<{ seen?: string[]; inputBytes?: number }> = [];
    const phases: string[] = [];
    const complete: ExploreModelComplete = async ({ systemPrompt, user, signal }) => {
      assert.equal(signal?.aborted, false);
      if (systemPrompt === EXPLORE_PLAN_SYSTEM) return JSON.stringify({ groups: [{ expressions: ["reclaimLease"] }] });
      const current = `v${wave}`;
      assert.match(user, /Output excerpt limit: 2/);
      assert.ok(user.includes(`new evidence ${current}`));
      if (wave > 1) assert.ok(user.includes(`new evidence v${wave - 1}`), "the earlier accepted material participates in the next joint comparison");
      assert.match(user, /continue-search/);
      return JSON.stringify({
        groups: [{ id: "selected", purpose: "current mechanism", views: [{ viewId: current, rangeIds: [`${current}:full`], required: true }] }],
        ...(wave < 6 ? { actionIds: ["continue-search"] } : { done: true }),
      });
    };
    complete.inputBytes = 12_000;
    const port: ExploreModelLoopPort = {
      plan: async plan => {
        assert.deepEqual(plan.groups[0]?.expressions, ["reclaimLease"]);
        return { queryId: started.queryId, launched: ["plan"], reused: [], sources: [] };
      },
      views: async options => {
        offered.push(options);
        return {
          queryId: started.queryId, question: started.question, deadlineAt: Infinity,
          views: options.seen?.includes(`v${wave}`) ? [] : [sourceView(`v${wave}`)],
          actions: [{ actionId: "continue-search", kind: "symbol", target: "reclaimLease", why: "follow the supplied symbol" }],
          sequence: wave, pending: false, unevaluated: 0, sources: [], outputByteBudget: 24_576,
        };
      },
      select: async groups => {
        selections.push(groups);
        selected = groups.flatMap(group => group.views.map(view => sourceView(view.viewId)));
        return { queryId: started.queryId, accepted: [{ groupId: "selected", viewIds: selected.map(view => view.viewId) }], rejected: [], gaps: [], selectedViews: selected };
      },
      followup: async request => {
        followups.push(request);
        wave++;
        return { queryId: started.queryId, launched: [`followup-${wave}`], reused: [], actionsAccepted: ["continue-search"], sources: [] };
      },
      wait: async () => assert.fail("progress during submission must be recollected before waiting"),
    };
    const result = await runExploreModelLoop({ started, complete, port, limit: 2, progress: {
      phase: phase => phases.push(phase), observe: () => undefined,
    } });
    assert.deepEqual(result, { plan: "used", select: "used", followup: "used" });
    assert.equal(selections.length, 6);
    assert.equal(followups.length, 5);
    assert.ok(followups.every(request => request.actions?.[0]?.actionId === "continue-search"));
    assert.ok(selections.every(groups => groups[0]?.views[0]?.required === true));
    assert.deepEqual(selected.map(view => view.viewId), ["v6"]);
    assert.ok(offered.some(options => options.seen?.includes("v1") && options.inputBytes !== undefined && options.inputBytes < 12_000));
    assert.equal(phases.filter(phase => phase === "selecting").length, 6);
  });

  it("returns participation at the deadline without disguising a late retrieval failure as budget exhaustion", async (t) => {
    let now = 10_000;
    t.mock.method(Date, "now", () => now);
    const unexpected = async (): Promise<never> => assert.fail("no new query work may run");
    const port: ExploreModelLoopPort = {
      plan: unexpected, views: unexpected, select: unexpected, followup: unexpected, wait: unexpected,
    };
    const elapsed = await runExploreModelLoop({ started: startResult(now), port });
    assert.deepEqual(elapsed, { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" });
    const budget = await runExploreModelLoop({ started: startResult(now + 1), port: {
      ...port, views: async () => { now++; throw new ExploreBudgetExhausted(); },
    } });
    assert.deepEqual(budget, elapsed);
    const failure = new Error("source unavailable");
    await assert.rejects(runExploreModelLoop({ started: startResult(now + 1), port: {
      ...port, views: async () => { now++; throw failure; },
    } }), error => error === failure);
  });

  it("propagates caller cancellation during planning before any query work continues", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const complete: ExploreModelComplete = async () => {
      controller.abort(reason);
      throw reason;
    };
    const unexpected = async (): Promise<never> => assert.fail("cancelled loop must not call its query port");
    await assert.rejects(runExploreModelLoop({
      started: startResult(Infinity), complete, signal: controller.signal,
      port: { plan: unexpected, views: unexpected, select: unexpected, followup: unexpected, wait: unexpected },
    }), error => error === reason);
  });
});

function startResult(deadlineAt: number): ExploreQueryStartResult {
  return { queryId: "shared", question: "how does reclaim work", deadlineAt,
    parsed: { objects: [], relation: "unknown", domain: "implementation" },
    vocab: { objects: [], anchors: [] }, sources: [], inputSource: "disk" };
}

function sourceView(viewId: string): ExploreQueryView {
  return { viewId, path: `${viewId}.ts`, startLine: 1, endLine: 2, text: `new evidence ${viewId}`, revision: "r1",
    source: "disk", ranges: [{ rangeId: `${viewId}:full`, startLine: 1, endLine: 2 }], arrivals: [],
    assessment: "object-present", purpose: "candidate", why: "matched" };
}

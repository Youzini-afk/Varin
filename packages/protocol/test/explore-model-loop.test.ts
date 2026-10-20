import assert from "node:assert/strict";
import { it } from "node:test";
import { ExploreBudgetExhausted, runExploreModelLoop } from "../src/explore-model-loop.js";
import { EXPLORE_PLAN_SYSTEM } from "../src/explore-model.js";
import type { ExploreQueryView, ExploreQuerySelectionGroup, ExploreQueryStartResult } from "../src/harness.js";

it("a pending follow-up keeps accepted evidence; a final empty decision clears it", async () => {
  for (const done of [false, true]) {
    const started: ExploreQueryStartResult = {
      queryId: "query", question: "How are process tools registered?", deadlineAt: Infinity,
      parsed: { objects: [], relation: "register", domain: "implementation" },
      vocab: { objects: [], anchors: [] }, sources: [], inputSource: "disk", decisionMode: "llm",
    };
    const view = (id: string): ExploreQueryView => ({
      viewId: id, path: `${id}.ts`, revision: id, startLine: 1, endLine: 1, text: `register(${id});`,
      source: "disk", ranges: [{ rangeId: `${id}:full`, startLine: 1, endLine: 1 }],
      arrivals: [], assessment: "object-present", purpose: "primary", why: "registration",
    });
    const views = [view("a"), view("b")];
    let selections: ExploreQuerySelectionGroup[] = [];
    let selectionRound = 0;
    let followups = 0;
    const participation = await runExploreModelLoop({
      started,
      complete: async input => input.systemPrompt === EXPLORE_PLAN_SYSTEM
        ? JSON.stringify({ behavior: "registration", groups: [{ id: "plan", concept: "process tools", expressions: ["register"] }] })
        : JSON.stringify(++selectionRound === 1
          ? { groups: [{ id: "chosen", purpose: "registration", views: [{ viewId: "a", rangeIds: ["a:full"] }] }], done: false }
          : { groups: [], done, ...(!done ? { followup: { searches: [{ expression: "process mapping" }] } } : {}) }),
      port: {
        plan: async () => ({ queryId: "query", launched: ["register"], reused: [], sources: [] }),
        views: async ({ seen = [] }) => ({
          queryId: "query", question: started.question, views: views.filter(v => !seen.includes(v.viewId)).slice(0, 1),
          sequence: selectionRound, unevaluated: 0, pending: false, sources: [], actions: [],
          deadlineAt: Infinity,
        }),
        wait: async () => { throw new Error("No pending source"); },
        select: async groups => {
          selections = groups;
          return { queryId: "query", accepted: groups.map(g => ({ groupId: g.id, viewIds: g.views.map(v => v.viewId) })),
            rejected: [], gaps: [], selectedViews: groups.length ? [views[0]!] : [] };
        },
        followup: async () => { followups++; throw new ExploreBudgetExhausted(); },
      },
    });
    assert.equal(selectionRound, 2);
    assert.equal(followups, done ? 0 : 1);
    assert.equal(participation.select, "used");
    assert.deepEqual(selections.map(group => group.id), done ? [] : ["chosen"]);
  }
});

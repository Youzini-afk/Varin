import { describe, expect, it } from "vitest";
import type { FastDecisionAnswer } from "@varin/protocol";
import { createExploreQueryRun } from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import {
  resolveExploreFastDecision,
  runExploreFastDecisionLoop,
  type HarnessFastDecisionResultWire,
} from "./explore-fast-decision.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({
  status: "ready",
  content,
  revision,
  source: "disk",
});

const binding = {
  protocol: "pi-classifier" as const,
  providerId: "jev",
  modelId: "jev-1.13",
  configurationId: "cfg-1",
};

const neverSettle = { promise: new Promise<void>(() => {}), requested: () => false };

describe("resolveExploreFastDecision", () => {
  it("maps the described purpose status onto the frozen query state", () => {
    expect(resolveExploreFastDecision(undefined)).toEqual({ status: "unavailable" });
    expect(resolveExploreFastDecision({ status: "disabled" })).toEqual({ status: "disabled" });
    expect(resolveExploreFastDecision({ status: "unconfigured" })).toEqual({ status: "unconfigured" });
    expect(resolveExploreFastDecision({ status: "invalid", message: "bad" })).toEqual({ status: "invalid" });
    const readyStatus = resolveExploreFastDecision({ status: "ready", binding });
    expect(readyStatus).toEqual({ status: "ready", binding });
  });
});

describe("runExploreFastDecisionLoop", () => {
  // a.ts → b.ts is expanded by the ordinary seed pass; b.ts → c.ts only
  // surfaces as an action candidate the loop can choose to execute.
  const graph = {
    catalogStats: async () => ({ symbolCount: 3, fileCount: 3 }),
    searchDefinitions: async () => [],
    findLinks: async () => [],
    fileRelations: async (path: string) => {
      if (path === "a.ts") {
        return {
          connections: [],
          linksIncomplete: false,
          calls: [{
            path: "a.ts", line: 1, caller: "main", callee: "callee",
            targetPath: "b.ts", targetName: "callee", pinned: true, resolvedBy: "test",
          }],
        };
      }
      if (path === "b.ts") {
        return {
          connections: [],
          linksIncomplete: false,
          calls: [{
            path: "b.ts", line: 1, caller: "callee", callee: "inner",
            targetPath: "c.ts", targetName: "inner", pinned: true, resolvedBy: "test",
          }],
        };
      }
      return null;
    },
    findImporters: async () => ({ resolved: [] }),
  };

  const newRun = () => createExploreQueryRun({ question: "how does callee work" }, {
    rgSearch: async () => [{ path: "a.ts", line: 1, text: "callee();" }],
    readFile: async (path) => {
      if (path === "c.ts") return ready("export function inner() { return 2; }", "rev-c");
      if (path === "b.ts") return ready("export function callee() { inner(); }", "rev-b");
      return ready("callee();", "rev-a");
    },
    graph,
  });

  it("judges material, executes the chosen action inside the query, and stops on a quiet round", async () => {
    const run = newRun();
    run.start();
    const asked: string[][] = [];
    const details = await runExploreFastDecisionLoop({
      run,
      binding,
      call: async ({ questions }) => {
        asked.push(questions.map((question) => question.id));
        const answers: FastDecisionAnswer[] = questions.map((question) => ({
          id: question.id,
          kind: "judge",
          // Only the real expansion and the material are worth keeping.
          value: question.id === "a:read:c.ts" || question.id.startsWith("m:") ? 0.9 : 0.1,
        }));
        return { answers, missing: [] };
      },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      closing: neverSettle,
    });
    expect(details.status).toBe("used");
    expect(details.batches).toBe(asked.length);
    expect(details.actionsExecuted).toBe(1);
    expect(details.executed).toEqual(["read:c.ts"]);
    expect(details.viewsJudged).toBe(3);
    expect(asked[0]?.some((id) => id.startsWith("m:"))).toBe(true);
    expect(asked.flat()).toContain("a:read:c.ts");

    const views = run.viewsForModel().views;
    expect(views.some((view) => view.path === "c.ts")).toBe(true);
    run.applyFastDecision(details);
    const result = run.finish();
    expect(result.details.fastDecision?.status).toBe("used");
    expect(result.details.fastDecision?.executed).toEqual(["read:c.ts"]);
    expect(result.snippets.some((snippet) => snippet.text.includes("export function inner"))).toBe(true);
  });

  it("treats a missing answer as missing, not as a rejection", async () => {
    const run = newRun();
    run.start();
    const details = await runExploreFastDecisionLoop({
      run,
      binding,
      call: async ({ questions }) => ({
        answers: [],
        missing: questions.map((question) => question.id),
      }),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      closing: neverSettle,
    });
    expect(details.status).toBe("used");
    expect(details.missing).toBeGreaterThan(0);
    expect(details.actionsExecuted).toBe(0);
    // Missing answers selected nothing; the query still finishes on sources.
    const result = run.finish();
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it("reports a provider failure honestly and leaves source-ranked material usable", async () => {
    const run = newRun();
    run.start();
    const details = await runExploreFastDecisionLoop({
      run,
      binding,
      call: async () => {
        throw new Error("Systemone HTTP 503");
      },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      closing: neverSettle,
    });
    expect(details.status).toBe("failed");
    expect(details.note).toContain("503");
    await run.waitForViews();
    const result = run.finish();
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it("cancels with the query instead of reporting a failure", async () => {
    const run = newRun();
    run.start();
    const controller = new AbortController();
    const details = await runExploreFastDecisionLoop({
      run,
      binding,
      call: async ({ signal }) => {
        const rejected = new Promise<HarnessFastDecisionResultWire>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }, { once: true });
        });
        controller.abort();
        return rejected;
      },
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
      closing: neverSettle,
    });
    expect(details.status).toBe("cancelled");
    run.cancel();
  });

  it("rejects a stale or fabricated action id the model did not see issued", async () => {
    const run = newRun();
    run.start();
    await run.waitForViews();
    const sequence = run.collect().sequence;
    await run.actionCandidates(); // starts optional graph-fact preparation
    await run.waitForProgress(sequence);
    const issued = await run.actionCandidates();
    expect(issued.some((action) => action.actionId === "read:c.ts")).toBe(true);
    const outcome = await run.followup({
      actions: [
        { actionId: "read:c.ts", kind: "read", target: "c.ts", why: "issued" },
        { actionId: "read:secret.ts", kind: "read", target: "secret.ts", why: "fabricated" },
      ],
    });
    expect(outcome.actionsAccepted).toEqual(["read:c.ts"]);
    expect(outcome.actionsRejected).toEqual([
      { actionId: "read:secret.ts", reason: "unknown or stale action candidate" },
    ]);
    // Executing the same issued action again is a reuse, not a second read.
    const again = await run.followup({
      actions: [{ actionId: "read:c.ts", kind: "read", target: "c.ts", why: "again" }],
    });
    expect(again.actionsAccepted).toEqual([]);
    expect(again.reused).toContain("read:c.ts");
    run.cancel();
  });
});

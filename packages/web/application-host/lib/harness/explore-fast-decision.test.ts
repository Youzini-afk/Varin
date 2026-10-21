import { describe, expect, it } from "vitest";
import type { FastDecisionAnswer, FastDecisionQuestion } from "@varin/protocol";
import { createExploreQueryRun } from "./explore.js";
import type { ExploreFileSnapshot } from "./file-snapshot.js";
import {
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
  protocol: "typed-classifier" as const,
  providerId: "jev",
  modelId: "jev-1.13",
  configurationId: "cfg-1",
};


const choose = (question: FastDecisionQuestion): FastDecisionAnswer => ({
  id: question.id, kind: 'choose', choice: question.id.startsWith('m:') ? 'keep'
    : question.kind === 'choose' && question.options.some(option => option.id === 'read:c.ts') ? 'read:c.ts'
      : question.kind === 'choose' ? question.options.find(option => option.id.startsWith('wait:'))?.id ?? 'deliver' : 'deliver',
});

const neverSettle = { promise: new Promise<void>(() => {}), requested: () => false };

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
        const answers = questions.map(choose);
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
    expect(details.viewsJudged).toBeGreaterThanOrEqual(3);
    expect(asked[0]?.some((id) => id.startsWith("m:"))).toBe(true);
    expect(asked.flat()).toContain("next");

    const views = run.viewsForModel().views;
    expect(views.some((view) => view.path === "c.ts")).toBe(true);
    run.applyFastDecision(details);
    const result = run.finish();
    expect(result.details.fastDecision?.status).toBe("used");
    expect(result.details.fastDecision?.executed).toEqual(["read:c.ts"]);
    expect(result.snippets.some((snippet) => snippet.text.includes("export function inner"))).toBe(true);
  });

  it.each(['missing', 'defer'] as const)("does not promote unselected candidates when all material judgments %s", async answer => {
    const run = newRun();
    run.start();
    const details = await runExploreFastDecisionLoop({
      run,
      binding,
      call: async ({ questions }) => ({
        answers: answer === 'missing' ? [] : questions.map(question => ({
          id: question.id, kind: 'choose' as const, choice: question.id.startsWith('m:') ? 'defer' : 'deliver',
        })),
        missing: answer === 'missing' ? questions.map((question) => question.id) : [],
      }),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000,
      closing: neverSettle,
    });
    expect(details.status).toBe("used");
    if (answer === 'missing') expect(details.missing).toBeGreaterThan(0);
    expect(details.actionsExecuted).toBe(0);
    expect(run.collect().views.length).toBeGreaterThan(0);
    run.applyFastDecision(details);
    const result = run.finish();
    expect(result.snippets).toEqual([]);
  });

  it("reports a provider failure without flooding delivery with unjudged candidates", async () => {
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
    run.applyFastDecision(details);
    const result = run.finish();
    expect(result.snippets).toEqual([]);
    expect(run.deliveryReason()).toBe('failed');
  });

  it("keeps unknown usage dimensions unknown across progressive batches, including real zero", async () => {
    const run = newRun();
    run.start();
    let batches = 0;
    const details = await runExploreFastDecisionLoop({
      run, binding, signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000, closing: neverSettle,
      call: async ({ questions }) => {
        batches++;
        return { answers: questions.map(choose), missing: [],
          usage: batches === 1 ? { inputTokens: 0 } : { inputTokens: 2, outputTokens: 3 } };
      },
    });
    expect(batches).toBeGreaterThan(1);
    expect(details.usage).toEqual({ inputTokens: 2 * (batches - 1) });
    run.cancel();
  });

  it("records a failed next-step response without executing it or losing earlier selections", async () => {
    const run = newRun();
    run.start();
    let batches = 0;
    let firstSelected: string[] = [];
    const details = await runExploreFastDecisionLoop({
      run, binding, signal: new AbortController().signal,
      deadlineAt: Date.now() + 10_000, closing: neverSettle,
      call: async ({ questions }) => {
        batches++;
        const answers: FastDecisionAnswer[] = questions.map(choose);
        if (batches === 1) return { answers, missing: [], usage: { inputTokens: 0, outputTokens: 5 } };
        firstSelected = run.selectedViews().map(view => view.viewId);
        return { answers, missing: [questions[0]!.id], usage: { inputTokens: 3 },
          failure: { status: "failed", note: "Provider stopped after a partial response" } };
      },
    });
    expect(batches).toBe(2);
    expect(details).toMatchObject({ status: "failed", batches: 2, missing: 1, usage: { inputTokens: 3 } });
    expect(firstSelected.length).toBeGreaterThan(0);
    expect(run.selectedViews().map(view => view.viewId)).toEqual(firstSelected);
    run.cancel();
  });

  it.each(['batch', 'per-question'] as const)("retains selected evidence when a later %s capacity partition fails", async window => {
    const run = createExploreQueryRun({ question: "find the handlers" }, {
      rgSearch: async () => ['a.ts', 'b.ts'].map(path => ({ path, line: 1, text: 'handler();' })),
      readFile: async () => ready('handler();'),
    });
    run.start();
    let calls = 0;
    const details = await runExploreFastDecisionLoop({
      run, binding: { ...binding, contextWindowTokens: window === 'batch' ? 100 : 1000,
        ...(window === 'per-question' ? { perQuestionContextWindowTokens: 100 } : {}) }, signal: new AbortController().signal,
      countInput: async batch => ({ tokens: batch.materials.length * 60, perQuestionTokens: batch.materials.length * 60, tokenizer: 'fixture' }),
      deadlineAt: Date.now() + 10_000, closing: neverSettle,
      call: async ({ questions }) => {
        if (++calls > 1) throw new Error('Provider unavailable');
        return { answers: questions.map(choose), missing: [] };
      },
    });
    run.applyFastDecision(details);
    const packed = run.finish();
    expect(calls).toBe(2);
    expect(details.status).toBe('failed');
    expect(packed.snippets).toHaveLength(1);
    expect(packed.snippets[0]?.path).toBe('a.ts');
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

  it("compares next steps within capacity even when the query's complete evidence directory is larger", async () => {
    const paths = Array.from({ length: 48 }, (_, i) => `handlers/module-${i}.ts`);
    const run = createExploreQueryRun({ question: 'find the handlers' }, {
      rgSearch: async () => paths.map(path => ({ path, line: 1, text: 'export function handler() { return 1; }' })),
      readFile: async () => ready('export function handler() { return 1; }'),
    });
    run.start();
    while (run.collect().pending) await run.waitForProgress(run.collect().sequence);
    expect(run.collect().views).toHaveLength(paths.length);
    let comparedNext = false;
    const capacity = 6000;
    const details = await runExploreFastDecisionLoop({
      run, binding: { ...binding, contextWindowTokens: capacity },
      signal: new AbortController().signal, deadlineAt: Infinity, closing: neverSettle,
      countInput: async batch => ({ tokens: JSON.stringify(batch).length, tokenizer: 'fixture serialized units' }),
      call: async ({ signal: _signal, ...batch }) => {
        expect(JSON.stringify(batch).length + batch.questions.length).toBeLessThanOrEqual(capacity);
        if (batch.questions[0]?.id === 'next') {
          comparedNext = true;
          expect(batch.context, JSON.stringify(batch.context)).toMatchObject({ coverage: { selected: paths.length, selectedOutsideRequest: expect.any(Number) } });
          expect(batch.materials.length).toBeGreaterThan(0);
          expect(batch.materials.length).toBeLessThan(paths.length);
        }
        return { answers: batch.questions.map(question => ({ id: question.id, kind: 'choose' as const,
          choice: question.id.startsWith('m:') ? 'keep' : 'deliver' })), missing: [] };
      },
    });
    expect(details.status, details.note).toBe('used');
    expect(comparedNext).toBe(true);
    expect(run.selectedViews()).toHaveLength(paths.length);
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

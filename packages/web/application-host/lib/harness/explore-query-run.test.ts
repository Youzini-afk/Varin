import { describe, expect, it } from "vitest";
import { createExploreQueryRun, vocabFromCatalog } from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({
  status: "ready",
  content,
  revision,
  source: "disk",
});

const reclaim = [
  "export function reclaimLease(handle: string) {",
  "  parkedHandles.delete(handle);",
  "  return handle;",
  "}",
].join("\n");

describe("explore query run", () => {
  it("builds catalog vocab packages and entries from already-open paths", () => {
    const vocab = vocabFromCatalog({
      symbolCount: 12,
      fileCount: 4,
      paths: ["packages/web/package.json", "packages/web/src/index.ts", "packages/cli/main.ts", "src/util.ts"],
    });
    expect(vocab.catalog).toEqual({ symbolCount: 12, fileCount: 4 });
    expect(vocab.packages).toEqual(["packages/web", "packages/cli"]);
    expect(vocab.entries).toEqual(["packages/web/src/index.ts", "packages/cli/main.ts"]);
  });

  it("executes plan expressions as real searches and keeps a zero-overlap unit", async () => {
    const searched: string[] = [];
    const run = createExploreQueryRun({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async (pattern) => {
        searched.push(pattern);
        return pattern === "reclaimLease"
          ? [{ path: "src/reclaim.ts", line: 1, text: "export function reclaimLease(handle: string) {" }]
          : [];
      },
      readFile: async () => ready(reclaim),
    });
    run.start();
    const planned = await run.submitPlan({
      behavior: "discard idle tokens",
      groups: [{ id: "g1", concept: "reclaim", expressions: ["reclaimLease"] }],
    });
    expect(planned.launched).toEqual(["reclaimLease"]);
    await run.waitForViews();
    const views = run.viewsForModel();
    expect(views.views.some((view) => view.text.includes("reclaimLease"))).toBe(true);
    expect(searched).toContain("reclaimLease");
    const result = run.finish();
    expect(result.snippets.some((snippet) => snippet.text.includes("reclaimLease"))).toBe(true);
  });

  it("materializes arrived source while the caller is still planning", async () => {
    let resolveRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { resolveRead = resolve; });
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => {
        resolveRead();
        return ready("needle");
      },
    });
    run.start();
    await readStarted;
    expect(run.terminal()).toBe("active");
    run.cancel();
  });

  it("rejects unknown view ids and ranges the model did not see", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle\nsecond"),
    });
    run.start();
    await run.waitForViews();
    const selected = run.applySelection([
      {
        id: "sel1",
        purpose: "bad",
        views: [
          { viewId: "missing", rangeIds: ["missing:full"], required: true },
          { viewId: "v1", startLine: 99, endLine: 120, required: true },
        ],
      },
    ]);
    expect(selected.rejected.length).toBeGreaterThan(0);
    expect(selected.accepted).toEqual([]);
  });

  it("reuses a duplicate follow-up expression and does not revive a cancelled query", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async (pattern) => pattern === "needle"
        ? [{ path: "a.ts", line: 1, text: "needle" }]
        : [],
      readFile: async () => ready("needle"),
    });
    run.start();
    await run.waitForViews();
    const first = await run.followup({ searches: [{ expression: "needle" }] });
    expect(first.reused).toContain("needle");
    expect(first.launched).toEqual([]);
    run.cancel();
    expect(run.terminal()).toBe("cancelled");
    await expect(run.waitForViews()).resolves.toBeUndefined();
    expect(() => run.finish()).toThrow(/cancelled/i);
  });

  it("freezes arrived lexical views when a slow source misses the shared deadline", async () => {
    let releaseSemantic: (() => void) | undefined;
    const semanticHang = new Promise<void>((resolve) => {
      releaseSemantic = resolve;
    });
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
      semantic: {
        search: async () => {
          await semanticHang;
          return { status: "empty", coverage: "empty", lifecycle: "idle", hits: [] };
        },
      },
    }, { deadlineAt: Date.now() + 80, reserveForJudgeMs: 0 });
    run.start();
    await run.waitForViews();
    expect(run.viewsForModel().views.some((view) => view.text.includes("needle"))).toBe(true);
    expect(run.sourceStates().some((source) => source.id === "semantic-original" && source.status === "incomplete")).toBe(true);
    releaseSemantic?.();
  });

  it("keeps required complementary ranges instead of broadcasting a file score", async () => {
    const body = [
      "export function trigger() { return register(\"svc\"); }",
      "export function unusedPadding() { return 1; }",
      "export function consumer() { return request(\"svc\"); }",
    ].join("\n");
    const run = createExploreQueryRun({ question: "how is svc wired", limit: 2 }, {
      rgSearch: async (pattern) => pattern === "svc"
        ? [
          { path: "src/wire.ts", line: 1, text: "export function trigger() { return register(\"svc\"); }" },
          { path: "src/wire.ts", line: 3, text: "export function consumer() { return request(\"svc\"); }" },
        ]
        : [],
      readFile: async () => ready(body),
    });
    run.start();
    await run.waitForViews();
    const views = run.viewsForModel().views;
    expect(views.length).toBeGreaterThan(0);
    const picked = views.slice(0, Math.min(2, views.length)).map((view) => ({
      viewId: view.viewId,
      rangeIds: [view.ranges[0]!.rangeId],
      required: true,
    }));
    run.applySelection([{ id: "ends", purpose: "both ends", views: picked }]);
    const result = run.finish();
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets.every((snippet) => snippet.required === true || snippet.text.includes("svc"))).toBe(true);
  });

  it("starts original content-word search before a slow semantic source finishes", async () => {
    const events: Array<{ name: string; at: number }> = [];
    const startedAt = Date.now();
    const mark = (name: string): void => {
      events.push({ name, at: Date.now() - startedAt });
    };
    const run = createExploreQueryRun({ question: "why is this stale draft still the authority" }, {
      rgSearch: async (pattern) => {
        mark(`rg(${pattern})`);
        return pattern === "stale" || pattern === "draft" || pattern === "authority"
          ? [{ path: "notes.ts", line: 1, text: "stale draft authority" }]
          : [];
      },
      readFile: async () => ready("stale draft authority"),
      semantic: {
        search: async () => {
          mark("semantic-start");
          await new Promise((resolve) => {
            setTimeout(resolve, 250);
          });
          mark("semantic-end");
          return { status: "ready", coverage: "empty", lifecycle: "idle", hits: [] };
        },
      },
    });
    run.start();
    await run.waitForViews();
    const semanticEnd = events.find((event) => event.name === "semantic-end")?.at ?? Number.POSITIVE_INFINITY;
    const contentRg = events.filter((event) => event.name.startsWith("rg("));
    expect(contentRg.length).toBeGreaterThan(0);
    expect(contentRg.some((event) => event.at < semanticEnd - 50)).toBe(true);
  });

  it("keeps view ids stable and reports the new file as the follow-up material", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async (pattern) => {
        if (pattern === "needle") return [{ path: "z.ts", line: 1, text: "needle" }];
        if (pattern === "fresh") return [{ path: "a.ts", line: 1, text: "fresh needle" }];
        return [];
      },
      readFile: async (path) => ready(path === "a.ts" ? "fresh needle" : "needle"),
    });
    run.start();
    await run.waitForViews();
    const before = run.viewsForModel().views;
    expect(before.some((view) => view.path === "z.ts")).toBe(true);
    const zView = before.find((view) => view.path === "z.ts")!;
    const followup = await run.followup({ searches: [{ expression: "fresh" }] });
    const after = run.viewsForModel().views;
    expect(after.find((view) => view.path === "z.ts")?.viewId).toBe(zView.viewId);
    expect(followup.newViews.some((view) => view.path === "a.ts")).toBe(true);
    expect(followup.newViews.some((view) => view.path === "z.ts")).toBe(false);
  });

  it("rejects a required group that cannot fit the excerpt limit instead of silently slicing it", async () => {
    const body = [
      "export function trigger() { return register(\"svc\"); }",
      "export function unusedPadding() { return 1; }",
      "export function consumer() { return request(\"svc\"); }",
    ].join("\n");
    const run = createExploreQueryRun({ question: "how is svc wired", limit: 1 }, {
      rgSearch: async (pattern) => pattern === "svc"
        ? [
          { path: "src/wire.ts", line: 1, text: "export function trigger() { return register(\"svc\"); }" },
          { path: "src/wire.ts", line: 3, text: "export function consumer() { return request(\"svc\"); }" },
        ]
        : [],
      readFile: async () => ready(body),
    });
    run.start();
    await run.waitForViews();
    const views = run.viewsForModel().views;
    expect(views.length).toBeGreaterThanOrEqual(1);
    const view = views[0]!;
    const selected = run.applySelection([{
      id: "both",
      purpose: "pair",
      views: [
        { viewId: view.viewId, startLine: 1, endLine: 1, required: true },
        { viewId: view.viewId, startLine: 3, endLine: 3, required: true },
      ],
    }]);
    expect(selected.accepted).toEqual([]);
    expect(selected.rejected.some((item) => item.reason.includes("excerpt limit"))).toBe(true);
    const first = run.finish();
    expect(first.snippets.length).toBeLessThanOrEqual(1);
    expect(first.omitted.some((item) => item.reason.includes("excerpt limit") || item.reason.includes("cannot be presented"))).toBe(true);
    const late = run.applySelection([{
      id: "late",
      purpose: "after finish",
      views: [{ viewId: views[0]!.viewId, required: true }],
    }]);
    expect(late.accepted).toEqual([]);
    const second = run.finish();
    expect(second.snippets.map((snippet) => `${snippet.path}:${snippet.startLine}-${snippet.endLine}`)).toEqual(
      first.snippets.map((snippet) => `${snippet.path}:${snippet.startLine}-${snippet.endLine}`),
    );
    expect(first.snippets.some((snippet) => snippet.required === true)).toBe(false);
  });

  it("omits a later required group intact when the excerpt limit is already full", async () => {
    const body = [
      "export function trigger() { return register(\"svc\"); }",
      "export function unusedPadding() { return 1; }",
      "export function consumer() { return request(\"svc\"); }",
    ].join("\n");
    const run = createExploreQueryRun({ question: "how is svc wired", limit: 1 }, {
      rgSearch: async (pattern) => pattern === "svc"
        ? [
          { path: "src/wire.ts", line: 1, text: "export function trigger() { return register(\"svc\"); }" },
          { path: "src/wire.ts", line: 3, text: "export function consumer() { return request(\"svc\"); }" },
        ]
        : [],
      readFile: async () => ready(body),
    });
    run.start();
    await run.waitForViews();
    const views = run.viewsForModel().views;
    expect(views.length).toBeGreaterThanOrEqual(1);
    const view = views[0]!;
    run.applySelection([
      { id: "first", purpose: "a", views: [{ viewId: view.viewId, startLine: 1, endLine: 1, required: true }] },
      { id: "second", purpose: "b", views: [{ viewId: view.viewId, startLine: 3, endLine: 3, required: true }] },
    ]);
    const result = run.finish();
    expect(result.snippets).toHaveLength(1);
    expect(result.omitted.some((item) => (
      item.reason === "required group exceeds excerpt limit" || item.reason.includes("cannot be presented intact")
    ))).toBe(true);
  });

  it("packs every accepted required group before optional ranges", async () => {
    const body = ["first required", "first optional", "second required"].join("\n");
    const run = createExploreQueryRun({ question: "required", limit: 2 }, {
      rgSearch: async () => [
        { path: "a.ts", line: 1, text: "first required" },
        { path: "a.ts", line: 3, text: "second required" },
      ],
      readFile: async () => ready(body),
    });
    run.start();
    await run.waitForViews();
    const view = run.viewsForModel().views[0]!;
    const selected = run.applySelection([
      {
        id: "first",
        purpose: "first material",
        views: [
          { viewId: view.viewId, startLine: 1, endLine: 1, required: true },
          { viewId: view.viewId, startLine: 2, endLine: 2, required: false },
        ],
      },
      {
        id: "second",
        purpose: "second material",
        views: [{ viewId: view.viewId, startLine: 3, endLine: 3, required: true }],
      },
    ]);
    expect(selected.accepted).toHaveLength(2);
    const result = run.finish();
    expect(result.snippets.map((snippet) => snippet.text)).toEqual(["first required", "second required"]);
    expect(result.snippets.every((snippet) => snippet.required)).toBe(true);
  });

  it("launches both plan expressions when two groups reuse the same id", async () => {
    const searched: string[] = [];
    const run = createExploreQueryRun({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async (pattern) => {
        searched.push(pattern);
        return [];
      },
      readFile: async () => ready("x"),
    });
    run.start();
    const planned = await run.submitPlan({
      behavior: "discard",
      groups: [
        { id: "g1", concept: "first", expressions: ["first"] },
        { id: "g1", concept: "second", expressions: ["second"] },
      ],
    });
    expect(planned.launched).toEqual(["first", "second"]);
    await run.waitForViews();
    expect(searched).toContain("first");
    expect(searched).toContain("second");
  });

  it("keeps a pure semantic unit in the model views despite many lexical object windows", async () => {
    const pad = `${"x".repeat(3500)}\nNeedle`;
    const lexical = Array.from({ length: 14 }, (_, index) => `flood-${index}.ts`);
    const run = createExploreQueryRun({ question: "how does Needle work", anchors: ["Needle"] }, {
      rgSearch: async (pattern) => pattern === "Needle"
        ? lexical.map((path) => ({ path, line: 2, text: "Needle" }))
        : [],
      readFile: async (path) => ready(path === "semantic.ts" ? "unique mechanism body" : pad),
      semantic: {
        search: async () => ({
          status: "ready" as const,
          coverage: "complete" as const,
          lifecycle: "ready" as const,
          hits: [{
            documentId: "semantic.ts",
            blockId: "b1",
            parentUnitId: "u1",
            parentName: "mechanism",
            parentKind: "function",
            startLine: 1,
            endLine: 1,
            contentHash: "h1",
            body: "unique mechanism body",
            similarity: 0.9,
            rank: 1,
          }],
        }),
      },
    });
    run.start();
    await run.waitForViews();
    const views = run.viewsForModel();
    expect(views.views.some((view) => view.path === "semantic.ts")).toBe(true);
  });

  it("rebuilds an already-read file when a late semantic focus lands in another unit", async () => {
    const lines = Array.from({ length: 24 }, (_, index) => (
      index === 0 ? "lexical marker" : index === 19 ? "late semantic mechanism" : `padding ${index + 1}`
    ));
    const run = createExploreQueryRun({ question: "lexical" }, {
      rgSearch: async () => [{ path: "same.ts", line: 1, text: "lexical marker" }],
      readFile: async () => ready(lines.join("\n")),
      semantic: {
        search: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return {
            status: "ready" as const,
            coverage: "complete" as const,
            lifecycle: "ready" as const,
            hits: [{
              documentId: "same.ts",
              blockId: "late-block",
              parentUnitId: "late-unit",
              parentName: "lateMechanism",
              parentKind: "function",
              startLine: 20,
              endLine: 20,
              contentHash: "late-hash",
              body: "late semantic mechanism",
              similarity: 0.9,
              rank: 1,
            }],
          };
        },
      },
    });
    run.start();
    await run.waitForViews();
    expect(run.viewsForModel().views.some((view) => view.text.includes("late semantic mechanism"))).toBe(true);
  });

  it("aborts the shared controller so in-flight search sees the query cancel", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => {
        resolveEntered();
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => {
            sawAbort = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (controller.signal.aborted) fail();
          else controller.signal.addEventListener("abort", fail, { once: true });
        });
        return [];
      },
      readFile: async () => ready("needle"),
    }, { controller });
    run.start();
    await entered;
    run.cancel();
    await run.waitForViews();
    expect(sawAbort).toBe(true);
    expect(run.terminal()).toBe("cancelled");
  });

  it("keeps empty and unavailable source outcomes distinct", async () => {
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [],
      readFile: async () => ready("needle"),
      semantic: {
        search: async () => ({ status: "unavailable", coverage: "empty", lifecycle: "idle", hits: [] }),
      },
    });
    run.start();
    await run.waitForViews();
    expect(run.sourceStates()).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "lexical", status: "empty" }),
      expect.objectContaining({ family: "semantic", status: "unavailable" }),
    ]));
  });

  it("reports deadline-incomplete sources as a partial result, not a clean success", async () => {
    let releaseSemantic: (() => void) | undefined;
    const semanticHang = new Promise<void>((resolve) => {
      releaseSemantic = resolve;
    });
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
      semantic: {
        search: async () => {
          await semanticHang;
          return { status: "ready", coverage: "empty", lifecycle: "idle", hits: [] };
        },
      },
    }, { deadlineAt: Date.now() + 80, reserveForJudgeMs: 0 });
    run.start();
    await run.waitForViews();
    const result = run.finish();
    expect(result.partial).toBe(true);
    expect(result.searchIncomplete).toBe(true);
    expect(result.details.sources?.some((source) => source.id === "semantic-original" && source.status === "incomplete")).toBe(true);
    releaseSemantic?.();
  });

  it("retains acquired windows when the source deadline aborts inside a later read", async () => {
    const controller = new AbortController();
    let clock = 0;
    const run = createExploreQueryRun({ question: "needle" }, {
      rgSearch: async (pattern) => [{ path: pattern === "later" ? "later.ts" : "a.ts", line: 1, text: "needle" }],
      readFile: async (path) => {
        if (path === "later.ts") {
          // The store's source timer can abort before the pump gets another
          // loop turn to set its own deadlineStopped flag.
          clock = 100;
          controller.abort();
          controller.signal.throwIfAborted();
        }
        return ready("needle");
      },
    }, { controller, now: () => clock, deadlineAt: 100 });
    run.start();
    await run.waitForViews();
    expect(run.viewsForModel().views.some((view) => view.path === "a.ts")).toBe(true);
    await run.submitPlan({ behavior: "later evidence", groups: [{ id: "later", concept: "later", expressions: ["later"] }] });
    await expect(run.waitForViews()).resolves.toBeUndefined();
    const result = run.finish();
    expect(result.partial).toBe(true);
    expect(result.searchIncomplete).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path === "a.ts")).toBe(true);
  });

  it("retains windows when the deadline interrupts graph enrichment after the primary pump", async () => {
    const controller = new AbortController();
    let clock = 0;
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => [{ path: 'a.ts', line: 1, text: 'needle' }],
      readFile: async () => ready('needle'),
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [],
        findLinks: async () => [],
        findImporters: async () => ({ resolved: [] }),
        fileRelations: async () => {
          clock = 100;
          controller.abort();
          controller.signal.throwIfAborted();
          return null;
        },
      },
    }, { controller, now: () => clock, deadlineAt: 100 });
    await expect(run.waitForViews()).resolves.toBeUndefined();
    const result = run.finish();
    expect(result.snippets.some(snippet => snippet.path === 'a.ts')).toBe(true);
    expect(result.searchIncomplete).toBe(true);
    expect(result.partial).toBe(true);
  });

  it.each(['early-abort', 'user-cancel-after-deadline'] as const)("does not turn %s into a partial success", async (mode) => {
    const controller = new AbortController();
    let clock = 0;
    const run = createExploreQueryRun({ question: 'needle' }, {
      rgSearch: async () => [{ path: 'a.ts', line: 1, text: 'needle' }],
      readFile: async () => {
        if (mode === 'user-cancel-after-deadline') {
          clock = 100;
          run.cancel();
        } else controller.abort();
        controller.signal.throwIfAborted();
        return ready('needle');
      },
    }, { controller, now: () => clock, deadlineAt: 100 });
    await expect(run.waitForViews()).rejects.toMatchObject({ name: 'AbortError' });
    if (mode === 'user-cancel-after-deadline') expect(() => run.finish()).toThrow(/cancelled/i);
  });

  it("merges incremental selection instead of replacing the earlier windows", async () => {
    const run = createExploreQueryRun({ question: "needle", limit: 2 }, {
      rgSearch: async (pattern) => {
        if (pattern === "needle") return [{ path: "z.ts", line: 1, text: "needle" }];
        if (pattern === "fresh") return [{ path: "a.ts", line: 1, text: "fresh needle" }];
        return [];
      },
      readFile: async (path) => ready(path === "a.ts" ? "fresh needle" : "needle"),
    });
    run.start();
    await run.waitForViews();
    const firstView = run.viewsForModel().views.find((view) => view.path === "z.ts")!;
    run.applySelection([{ id: "kept", purpose: "original", views: [{ viewId: firstView.viewId, required: true }] }]);
    const followup = await run.followup({ searches: [{ expression: "fresh" }] });
    const added = followup.newViews.find((view) => view.path === "a.ts")!;
    run.applySelection([{ id: "more", purpose: "new", views: [{ viewId: added.viewId, required: true }] }], { merge: true });
    const result = run.finish();
    expect(result.snippets.some((snippet) => snippet.path === "z.ts")).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path === "a.ts")).toBe(true);
  });
});

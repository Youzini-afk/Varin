import { describe, expect, it, vi } from "vitest";
import { requestClassifier, ClassifierResponseError } from "@varin/pi-host/classifier";
import type {
  FetchResult,
  HarnessFastDecisionResult,
  HarnessFastDecisionPurposeStatus,
  ResearchDecideParams,
  RetrievalReceiptAuthority,
} from "@varin/protocol";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import {
  createResearchDecideService, executeResearchDecide, ResearchDecisionFailure,
  type ResearchDecideContext, type ResearchDecideDeps,
} from "./research-decide.js";
import { createWebFetch, type WebFetchDeps } from "./web-fetch.js";
import { createDocumentReader } from "./document-reading.js";
import type { createPdfEngine } from "./pdf-engine.js";
import { createMaterialStoreFixture } from "./web-materials.test-helper.js";

const unread = async (): Promise<FetchResult> => { throw new Error("unexpected snapshot read"); };
const serviceWith = (deps: Omit<ResearchDecideDeps, "readCandidateText"> & Partial<Pick<ResearchDecideDeps, "readCandidateText">>) =>
  createResearchDecideService({ readCandidateText: unread, ...deps });

const snapshotReader = (deps: Pick<WebFetchDeps, "materials" | "documentReader">): ResearchDecideContext["readCandidateText"] => {
  const reader = createWebFetch({ ...deps, ssrf: {
    check: async () => { throw new Error("unexpected network fetch"); }, isSameHost: () => false,
  } });
  return (request, authority, signal) => reader.fetch({
    snapshotId: request.snapshotId,
    position: { kind: "lines", startLine: request.startLine ?? 1, ...(request.endLine === undefined ? {} : { endLine: request.endLine }) },
    view: "text",
  }, { workspaceId: authority.owningWorkspaceId, authority, signal });
};

const ctx = (sessionId = "s1", signal?: AbortSignal): HarnessServiceContext => ({
  sessionId,
  workspaceId: "ws",
  signal: signal ?? new AbortController().signal,
} as HarnessServiceContext);

const binding = { protocol: "pi-classifier" as const, providerId: "typesafe", modelId: "jev-1", configurationId: "cfg-1" };
const readyStatus: HarnessFastDecisionPurposeStatus = { status: "ready", binding };

const params = (overrides: Partial<ResearchDecideParams> = {}): ResearchDecideParams => ({
  goal: "find evidence about retrieval evaluation",
  kind: "relevance",
  candidates: [
    { id: "c1", kind: "url", url: "https://a.test/", title: "Alpha", detail: "alpha snippet" },
    { id: "c2", kind: "url", url: "https://b.test/", title: "Beta", detail: "beta snippet" },
  ],
  ...overrides,
});

describe("research.decide", () => {
  it("ranks score answers by score and keeps missing candidates unevaluated", async () => {
    const calls: HarnessFastDecisionResult[] = [];
    const fastDecision: NonNullable<HarnessServiceHost["fastDecision"]> = async (input) => {
      expect(input.purpose).toBe("web");
      expect(input.settings.configurationId).toBe("cfg-1");
      expect(input.questions.map((q) => q.id)).toEqual(["c1", "c2", "c3"]);
      const result: HarnessFastDecisionResult = {
        batchId: "b1",
        providerId: "typesafe",
        modelId: "jev-1",
        answers: [
          { id: "c2", kind: "score", score: 3 },
          { id: "c1", kind: "score", score: 0 },
        ],
        missing: ["c3"],
        usage: { inputTokens: 100 },
      };
      calls.push(result);
      return result;
    };
    const service = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision,
    });
    const result = await service.handle(params({ candidates: [
      ...params().candidates, { id: "c3", kind: "query", detail: "unanswered query" },
    ] }), ctx());
    expect(result.status).toBe("ok");
    expect(result.ranked.map((item) => item.id)).toEqual(["c2", "c1", "c3"]);
    expect(result.ranked[1]!.score).toBe(0);
    expect(result.ranked[2]!.score).toBeUndefined();
    expect(result.missing).toEqual(["c3"]);
    expect(result.ranked[0]!.score).toBe(3);
    expect(result.configurationId).toBe("cfg-1");
    expect(result.usage?.inputTokens).toBe(100);
    expect(calls).toHaveLength(1);
  });

  it.each(["c2", null] as const)("next kind preserves the provider choice %s, including explicit none", async (choice) => {
    const service = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async () => ({
        batchId: "b2",
        providerId: "typesafe",
        modelId: "jev-1",
        answers: [{ id: "next", kind: "choose", choice }],
        missing: [],
      }),
    });
    const result = await service.handle(params({ kind: "next" }), ctx());
    expect(result.status).toBe("ok");
    expect(result.ranked.find((item) => item.id === "c2")?.selected).toBe(choice === "c2" ? true : undefined);
    expect(result.ranked.find((item) => item.id === "c1")?.selected).toBeUndefined();
  });

  it("falls back to caller order when the purpose is unconfigured, disabled, or unavailable", async () => {
    for (const status of [
      { status: "unconfigured" },
      { status: "disabled" },
      { status: "unavailable", message: "no provider" },
    ] as HarnessFastDecisionPurposeStatus[]) {
      let called = 0;
      const service = serviceWith({
        fastDecisionStatus: async () => status,
        fastDecision: async () => { called += 1; throw new Error("must not run"); },
      });
      const result = await service.handle(params(), ctx());
      expect(result.status).toBe(status.status === "disabled" ? "disabled" : status.status === "unconfigured" ? "unconfigured" : "unavailable");
      expect(result.fallback).toBe("order");
      expect(result.ranked.map((item) => item.id)).toEqual(["c1", "c2"]);
      expect(called).toBe(0);
    }
  });

  it("rejects snapshot candidates that are not readable under the caller's authority", async () => {
    const opened = createMaterialStoreFixture();
    const authority: RetrievalReceiptAuthority = { owningWorkspaceId: "ws", sessionId: "s1", threadId: "t1" };
    const snapshot = await opened.materials.put("ws", {
      sourceUrl: "https://s.test/", finalUrl: "https://s.test/", representation: "raw-text",
    }, Buffer.from("line one\nline two\nline three"), authority);

    const seenMaterials: string[] = [];
    const service = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async (input) => {
        for (const material of input.materials) seenMaterials.push(material.text);
        return {
          batchId: "b3",
          providerId: "typesafe",
          modelId: "jev-1",
          answers: [{ id: "snap", kind: "score", score: 2 }],
          missing: ["ghost"],
        };
      },
      readCandidateText: snapshotReader({ materials: opened.materials }),
      resolveThreadId: async () => "t1",
    });
    const result = await service.handle(params({
      candidates: [
        { id: "snap", kind: "snapshot", snapshotId: snapshot.snapshotId },
        { id: "ghost", kind: "snapshot", snapshotId: "web-snapshot:missing" },
      ],
    }), ctx("s1"));
    expect(result.status).toBe("ok");
    expect(result.rejected).toEqual([{ id: "ghost", reason: "snapshot not readable under caller authority" }]);
    expect(result.missing).toEqual(["ghost"]);
    expect(seenMaterials[0]).toContain("line one");
  });

  it("infers the scholarly purpose from paper candidates and honors explicit override", async () => {
    const purposes: string[] = [];
    const service = serviceWith({
      fastDecisionStatus: async (_ws, purpose) => { purposes.push(purpose); return readyStatus; },
      fastDecision: async () => ({ batchId: "b4", providerId: "typesafe", modelId: "jev-1", answers: [], missing: [] }),
    });
    const paper = { id: "p1", kind: "paper" as const, paper: { providerId: "openalex", providerRecordId: "W123" } };
    const inferred = await service.handle(params({ candidates: [paper] }), ctx());
    expect(inferred.purpose).toBe("scholarly");
    const explicit = await service.handle(params({ purpose: "web", candidates: [paper] }), ctx());
    expect(explicit.purpose).toBe("web");
    expect(purposes).toEqual(["scholarly", "web"]);
  });

  it("reports cancellation and provider failure without fabricating scores", async () => {
    const aborting = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async (_input) => { throw new Error("aborted"); },
    });
    const controller = new AbortController();
    const cancelledContext = ctx("s1", controller.signal);
    controller.abort();
    const cancelled = await aborting.handle(params(), cancelledContext);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.fallback).toBe("order");

    const failing = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async () => { throw new Error("provider 500"); },
    });
    const failed = await failing.handle(params(), ctx());
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("provider 500");
    expect(failed.ranked.map((item) => item.id)).toEqual(["c1", "c2"]);
  });

  it("rejects malformed candidate input before any model call", async () => {
    const service = serviceWith({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async () => { throw new Error("must not run"); },
    });
    await expect(service.handle(params({ goal: " " }), ctx())).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.handle(params({ candidates: [] }), ctx())).rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.handle(params({
      candidates: [
        { id: "x", kind: "url", url: "https://a.test/" },
        { id: "x", kind: "url", url: "https://b.test/" },
      ],
    }), ctx())).rejects.toMatchObject({ harnessCode: "invalid-params" });
    const result = await service.handle(params({
      candidates: [
        { id: "ok", kind: "url", url: "https://a.test/" },
        { id: "bad", kind: "url", url: "file:///etc/passwd" },
      ],
    }), ctx());
    expect(result.rejected).toEqual([{ id: "bad", reason: "url candidate needs an http(s) url" }]);
  });
});

const decisionResult = (overrides: Partial<HarnessFastDecisionResult> = {}): HarnessFastDecisionResult => ({
  batchId: "batch", providerId: "typesafe", modelId: "jev-1", servedModelId: "jev-1-version",
  answers: [{ id: "c1", kind: "score", score: 0 }], missing: ["c2"], usage: { inputTokens: 19, outputTokens: 2 },
  ...overrides,
});

const directContext = (overrides: Partial<ResearchDecideContext> = {}): ResearchDecideContext => ({
  signal: new AbortController().signal,
  authority: { kind: "thread", owningWorkspaceId: "ws", threadId: "native-thread" },
  readCandidateText: unread,
  fastDecisionStatus: async () => readyStatus,
  fastDecision: async () => decisionResult(),
  ...overrides,
});

const putText = (opened: ReturnType<typeof createMaterialStoreFixture>, owner: ResearchDecideContext["authority"]) =>
  opened.materials.put("ws", {
    sourceUrl: "https://s.test/", finalUrl: "https://s.test/", representation: "raw-text",
  }, Buffer.from("line one\nline two\nline three"), owner);

describe("shared research decision domain", () => {
  it("reads a native Thread's selected text through the original reader without a Pi session", async () => {
    const opened = createMaterialStoreFixture();
    const context = directContext();
    const snapshot = await putText(opened, context.authority);
    const read = vi.fn(snapshotReader({ materials: opened.materials }));
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "section", section: { snapshotId: snapshot.snapshotId, startLine: 2, endLine: 2 } },
    ] }), { ...context, readCandidateText: read, fastDecision: decide });
    expect(result.status).toBe("ok");
    expect(read).toHaveBeenCalledWith({ snapshotId: snapshot.snapshotId, startLine: 2, endLine: 2 }, context.authority, context.signal);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      materials: [expect.objectContaining({ id: "c1", text: "[section]\nline two", revision: snapshot.contentHash,
        label: `snapshot:${snapshot.snapshotId}; reader lines:2..2/3; text prefix:8/8 UTF-16 units` })], signal: context.signal,
    }));
    expect("sessionId" in context.authority).toBe(false);
  });

  it("does not dispatch inference or fabricate usage when every snapshot fails the original ACL", async () => {
    const opened = createMaterialStoreFixture();
    const snapshot = await putText(opened, { kind: "thread", owningWorkspaceId: "ws", threadId: "different-thread" });
    const status = vi.fn(async () => readyStatus);
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "snapshot", snapshotId: snapshot.snapshotId },
    ] }), directContext({ readCandidateText: snapshotReader({ materials: opened.materials }), fastDecisionStatus: status, fastDecision: decide }));
    expect(result).toMatchObject({ status: "failed", ranked: [], missing: [], fallback: "order",
      rejected: [{ id: "c1", reason: "snapshot not readable under caller authority" }] });
    expect(result.usage).toBeUndefined();
    expect(status).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects reversed section bounds before reading or dispatching an empty material", async () => {
    const read = vi.fn(unread);
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "section", section: { snapshotId: "fixed", startLine: 3, endLine: 1 } },
    ] }), directContext({ readCandidateText: read, fastDecision: decide }));
    expect(result.status).toBe("failed");
    expect(result.rejected).toEqual([{ id: "c1", reason: expect.stringContaining("endLine >= startLine") }]);
    expect(read).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps an out-of-range reader result distinct from an ACL rejection", async () => {
    const opened = createMaterialStoreFixture();
    const context = directContext();
    const snapshot = await putText(opened, context.authority);
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "section", section: { snapshotId: snapshot.snapshotId, startLine: 4 } },
    ] }), { ...context, readCandidateText: snapshotReader({ materials: opened.materials }), fastDecision: decide });
    expect(result.rejected).toEqual([{ id: "c1", reason: expect.stringContaining("position-not-found") }]);
    expect(decide).not.toHaveBeenCalled();
  });

  it("propagates a Storage failure rather than misreporting the snapshot as unreadable", async () => {
    const failure = new Error("Storage connection lost");
    const opened = createMaterialStoreFixture({ beforeObjectRead: async () => { throw failure; } });
    const context = directContext();
    const snapshot = await putText(opened, context.authority);
    const decide = vi.fn(async () => decisionResult());
    await expect(executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "snapshot", snapshotId: snapshot.snapshotId },
    ] }), { ...context, readCandidateText: snapshotReader({ materials: opened.materials }), fastDecision: decide })).rejects.toBe(failure);
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["available", "unavailable"] as const)("uses the PDF reader's %s text instead of its empty source snapshot body", async (textStatus) => {
    const opened = createMaterialStoreFixture();
    const context = directContext();
    const snapshot = await opened.materials.put("ws", {
      sourceUrl: "https://s.test/paper.pdf", finalUrl: "https://s.test/paper.pdf", representation: "pdf-source-v1",
      contentType: "application/pdf", document: { kind: "pdf", parser: "source" },
    }, Buffer.alloc(0), context.authority, { source: { bytes: Buffer.from("%PDF-source-fixture"), contentType: "application/pdf" } });
    const readPdf = vi.fn(async (): Promise<FetchResult> => ({
      status: "ok", url: snapshot.sourceUrl, finalUrl: snapshot.finalUrl, contentType: "application/pdf",
      markdown: textStatus === "available" ? "text from the PDF reader" : "", bytes: 24, fromCache: false, rendered: false,
      sourceSnapshot: snapshot, overview: { sourceHash: snapshot.document!.source!.contentHash, sourceSnapshotId: snapshot.snapshotId, textStatus },
    }));
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params({ candidates: [
      { id: "c1", kind: "snapshot", snapshotId: snapshot.snapshotId },
    ] }), { ...context, readCandidateText: snapshotReader({ materials: opened.materials,
      documentReader: { read: readPdf, ingest: vi.fn() } }), fastDecision: decide });
    expect(readPdf).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: snapshot.snapshotId, view: "text" }),
      expect.objectContaining({ authority: context.authority, signal: context.signal }));
    if (textStatus === "available") {
      expect(result.status).toBe("ok");
      expect(decide).toHaveBeenCalledWith(expect.objectContaining({ materials: [expect.objectContaining({
        text: "[snapshot]\ntext from the PDF reader",
      })] }));
    } else {
      expect(result).toMatchObject({ status: "failed", rejected: [{ id: "c1", reason: "snapshot text unavailable" }] });
      expect(decide).not.toHaveBeenCalled();
      expect(result.usage).toBeUndefined();
    }
  });

  it("pins actual derived PDF identity, reader range and budgeted text without changing the caller candidate", async () => {
    const opened = createMaterialStoreFixture();
    const context = directContext();
    const source = await opened.materials.put("ws", {
      sourceUrl: "https://s.test/paper.pdf", finalUrl: "https://s.test/paper.pdf", representation: "pdf-source-v1",
      contentType: "application/pdf", document: { kind: "pdf", parser: "source" },
    }, Buffer.alloc(0), context.authority, { source: { bytes: Buffer.from("%PDF-fixed-original"), contentType: "application/pdf" } });
    const extractedLine = "actual extracted PDF text ".repeat(120);
    const page = { page: 1, width: 100, height: 200, rotation: 0 };
    const engine = {
      probe: vi.fn(async () => ({ pageCount: 1, pages: [page], parser: "pdfjs", parserVersion: "fixture" })),
      versions: vi.fn(async () => ({ pdfjs: "fixture" })),
      extractPages: vi.fn(async () => [{ ...page, text: `heading\n${extractedLine}\nending`, lines: [],
        parser: "pdfjs", parserVersion: "fixture" }]),
    };
    // Exercise real read/analysis/material owners; only PDF decoding is a local fixture.
    const documentReader = createDocumentReader({ materials: opened.materials,
      engineFactory: (() => engine) as unknown as typeof createPdfEngine });
    const read = vi.fn(snapshotReader({ materials: opened.materials, documentReader }));
    const decide = vi.fn(async (_input: Parameters<ResearchDecideContext["fastDecision"]>[0]) => decisionResult());
    const request = params({ candidates: [{ id: "c1", kind: "section", title: "Reading candidate",
      section: { snapshotId: source.snapshotId, startLine: 2, endLine: 2, label: "Methods selected by caller" } }] });
    const original = structuredClone(request);
    const result = await executeResearchDecide(request, { ...context, readCandidateText: read, fastDecision: decide });
    expect(result.status).toBe("ok");
    const actual = await read.mock.results[0]!.value;
    expect(actual.status).toBe("ok");
    if (actual.status !== "ok") throw new Error("expected a real PDF text read");
    expect(actual.snapshot?.snapshotId).not.toBe(source.snapshotId);
    expect(actual.snapshot?.representation).toBe("pdf-native-analysis");
    expect(actual.range).toEqual({ startLine: 2, endLine: 2, totalLines: 3 });
    const material = decide.mock.calls[0]![0].materials[0]!;
    const description = "[section]\nReading candidate\n";
    const included = material.text.slice(description.length);
    expect(material.text).toHaveLength(2000);
    expect(included).toBe(extractedLine.slice(0, 2000 - description.length));
    expect(material.revision).toBe(actual.snapshot!.contentHash);
    expect(material.revision).not.toBe(source.contentHash);
    expect(material.label).toBe(`snapshot:${actual.snapshot!.snapshotId}; reader lines:2..2/3; text prefix:${included.length}/${extractedLine.length} UTF-16 units; source snapshot:${source.snapshotId}; caller label:"Methods selected by caller"`);
    expect(request).toEqual(original);
    expect(engine.extractPages).toHaveBeenCalledTimes(1);
  });

  it("retains accounted usage and missing answers from a trusted inference failure", async () => {
    const known = decisionResult({ answers: [], missing: ["c1", "c2"] });
    const result = await executeResearchDecide(params(), directContext({ fastDecision: async () => {
      throw new ResearchDecisionFailure("invalid provider answers", known);
    } }));
    expect(result).toMatchObject({ status: "failed", fallback: "order", ranked: [{ id: "c1" }, { id: "c2" }],
      usage: known.usage, providerId: known.providerId, modelId: known.modelId, servedModelId: known.servedModelId,
      configurationId: binding.configurationId, missing: ["c1", "c2"] });
  });

  it("preserves an original inference cancellation without cancelling its parent signal", async () => {
    const controller = new AbortController();
    const known = decisionResult();
    const result = await executeResearchDecide(params(), directContext({ signal: controller.signal, fastDecision: async () => {
      throw new ResearchDecisionFailure("original inference stopped", known, true);
    } }));
    expect(controller.signal.aborted).toBe(false);
    expect(result).toMatchObject({ status: "cancelled", fallback: "order", usage: known.usage,
      ranked: [{ id: "c1" }, { id: "c2" }], configurationId: binding.configurationId });
  });

  it("does not trust arbitrary error.result fields as usage evidence", async () => {
    const result = await executeResearchDecide(params(), directContext({ fastDecision: async () => {
      throw Object.assign(new Error("unknown failure"), { result: decisionResult() });
    } }));
    expect(result.status).toBe("failed");
    expect(result.usage).toBeUndefined();
    expect(result.providerId).toBeUndefined();
    expect(result.ranked).toEqual([{ id: "c1" }, { id: "c2" }]);
  });

  it.each(["resolved", "rejected"] as const)("preserves known usage after an in-flight cancellation with a %s result", async (outcome) => {
    const controller = new AbortController();
    const known = decisionResult();
    const result = await executeResearchDecide(params(), directContext({ signal: controller.signal, fastDecision: async () => {
      controller.abort();
      if (outcome === "rejected") throw new ResearchDecisionFailure("cancelled after dispatch", known);
      return known;
    } }));
    expect(result).toMatchObject({ status: "cancelled", fallback: "order", usage: known.usage,
      ranked: [{ id: "c1" }, { id: "c2" }], configurationId: binding.configurationId });
  });

  it("does not dispatch inference when cancellation arrives while resolving its binding", async () => {
    const controller = new AbortController();
    const decide = vi.fn(async () => decisionResult());
    const result = await executeResearchDecide(params(), directContext({ signal: controller.signal,
      fastDecisionStatus: async () => { controller.abort(); return readyStatus; }, fastDecision: decide }));
    expect(result.status).toBe("cancelled");
    expect(result.usage).toBeUndefined();
    expect(decide).not.toHaveBeenCalled();
  });

  it("keeps a fully missing provider response failed, ordered and accounted", async () => {
    const known = decisionResult({ answers: [], missing: ["c1", "c2"] });
    const result = await executeResearchDecide(params(), directContext({ fastDecision: async () => known }));
    expect(result).toMatchObject({ status: "failed", fallback: "order", missing: ["c1", "c2"], usage: known.usage,
      ranked: [{ id: "c1" }, { id: "c2" }] });
  });
});


it("keeps a real llama earlier score zero after the next candidate fails, with distinct target prompts", async () => {
  const prompts: string[] = [];
  const model = { type: "classifier" as const, api: "llama-cpp-classify" as const, provider: "local", id: "domain-partial",
    name: "fixture", baseUrl: "https://llama.invalid/v1", input: ["text" as const], contextWindow: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const result = await executeResearchDecide(params(), directContext({ fastDecision: async input => {
    try {
      const response = await requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
        state: { goal: input.goal, materials: input.materials }, questions: input.questions, signal: input.signal,
        fetchImpl: async (url, init) => {
          const wire = JSON.parse(String(init?.body));
          if (String(url).endsWith("/tokenize")) return Response.json({ tokens: wire.content === "\n" ? [1] : [1, 10 + Number(wire.content.trim())] });
          if (String(url).endsWith("/apply-template")) {
            const prompt = wire.messages[1].content as string;
            prompts.push(prompt);
            return Response.json({ prompt });
          }
          const target = /Evaluate only the material with candidate ID ("[^"\n]+")./gu;
          const candidate = [...String(wire.prompt).matchAll(target)].at(-1)?.[1];
          expect([JSON.stringify("c1"), JSON.stringify("c2")]).toContain(candidate);
          return Response.json({ tokens_evaluated: 17, tokens_predicted: 1,
            ...(candidate === JSON.stringify("c1") ? { completion_probabilities: [{ top_logprobs: [
              { id: 10, logprob: 0 }, { id: 11, logprob: -1e31 }, { id: 12, logprob: -1e31 }, { id: 13, logprob: -1e31 },
            ] }] } : {}) });
        } });
      return { batchId: "real-llama", providerId: model.provider, modelId: model.id, ...response };
    } catch (error) {
      expect(error).toBeInstanceOf(ClassifierResponseError);
      const partial = (error as ClassifierResponseError).result!;
      throw new ResearchDecisionFailure("later classifier response invalid", { batchId: "real-llama", providerId: model.provider, modelId: model.id, ...partial });
    }
  } }));
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).not.toBe(prompts[1]);
  expect(result).toMatchObject({ status: "failed", fallback: "order", ranked: [{ id: "c1", score: 0 }, { id: "c2" }],
    missing: ["c2"], usage: { inputTokens: 34, outputTokens: 2 } });
});

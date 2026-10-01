import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  HarnessFastDecisionResult,
  HarnessFastDecisionPurposeStatus,
  ResearchDecideParams,
  RetrievalReceiptAuthority,
} from "@varin/protocol";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createResearchDecideService } from "./research-decide.js";
import { createWebMaterialStore } from "./web-materials.js";

type TestRecord = {
  recordId: string;
  workspaceId: string;
  recordType: string;
  state: string;
  sessionId?: string;
  threadId?: string;
  payloadJson: string;
  references: Array<{ slot: string; objectHash: string }>;
};

const openStore = () => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, TestRecord>();
  const store = {
    async putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }> {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      return { hash, byteLength: bytes.byteLength };
    },
    async getObject(hash: string): Promise<Buffer | null> {
      const bytes = objects.get(hash);
      return bytes ? Buffer.from(bytes) : null;
    },
  };
  const context = {
    records: {
      async get(recordId: string): Promise<TestRecord | null> {
        return records.get(recordId) ?? null;
      },
      async list(input: { recordType?: string }): Promise<TestRecord[]> {
        return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType);
      },
      async put(input: Omit<TestRecord, "recordRevision" | "workspaceId"> & { workspaceId?: string }): Promise<TestRecord> {
        const record = { ...input, workspaceId: input.workspaceId ?? "ws", recordRevision: 1, references: [...(input.references ?? [])] };
        records.set(record.recordId, record);
        return record;
      },
      async release(_operationId: string, recordId: string): Promise<Record<string, unknown>> {
        const released = records.delete(recordId);
        return { recordId, released };
      },
    },
  };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (_workspaceId, _purpose, operation) => operation(
      store as unknown as WorkingStateRootStore,
      context as unknown as WorkingStateRootContext,
    ),
  };
  return { records, objects, materials: createWebMaterialStore(workingStates) };
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
      expect(input.questions.map((q) => q.id)).toEqual(["c1", "c2"]);
      const result: HarnessFastDecisionResult = {
        batchId: "b1",
        providerId: "typesafe",
        modelId: "jev-1",
        answers: [
          { id: "c2", kind: "score", score: 3 },
          { id: "c1", kind: "score", score: 1 },
        ],
        missing: [],
        usage: { inputTokens: 100 },
      };
      calls.push(result);
      return result;
    };
    const service = createResearchDecideService({
      fastDecisionStatus: async () => readyStatus,
      fastDecision,
    });
    const result = await service.handle(params(), ctx());
    expect(result.status).toBe("ok");
    expect(result.ranked.map((item) => item.id)).toEqual(["c2", "c1"]);
    expect(result.ranked[0]!.score).toBe(3);
    expect(result.configurationId).toBe("cfg-1");
    expect(result.usage?.inputTokens).toBe(100);
    expect(calls).toHaveLength(1);
  });

  it("next kind returns the provider's chosen candidate, including explicit none", async () => {
    const service = createResearchDecideService({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async () => ({
        batchId: "b2",
        providerId: "typesafe",
        modelId: "jev-1",
        answers: [{ id: "next", kind: "choose", choice: "c2" }],
        missing: [],
      }),
    });
    const result = await service.handle(params({ kind: "next" }), ctx());
    expect(result.status).toBe("ok");
    expect(result.ranked.find((item) => item.id === "c2")?.selected).toBe(true);
    expect(result.ranked.find((item) => item.id === "c1")?.selected).toBeUndefined();
  });

  it("falls back to caller order when the purpose is unconfigured, disabled, or unavailable", async () => {
    for (const status of [
      { status: "unconfigured" },
      { status: "disabled" },
      { status: "unavailable", message: "no provider" },
    ] as HarnessFastDecisionPurposeStatus[]) {
      let called = 0;
      const service = createResearchDecideService({
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
    const opened = openStore();
    const authority: RetrievalReceiptAuthority = { owningWorkspaceId: "ws", sessionId: "s1", threadId: "t1" };
    const snapshot = await opened.materials.put("ws", {
      sourceUrl: "https://s.test/", finalUrl: "https://s.test/", representation: "raw-text",
    }, Buffer.from("line one\nline two\nline three"), authority);

    const seenMaterials: string[] = [];
    const service = createResearchDecideService({
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
      materials: opened.materials,
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
    const service = createResearchDecideService({
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
    const aborting = createResearchDecideService({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async (_input) => { throw new Error("aborted"); },
    });
    const controller = new AbortController();
    const cancelledContext = ctx("s1", controller.signal);
    controller.abort();
    const cancelled = await aborting.handle(params(), cancelledContext);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.fallback).toBe("order");

    const failing = createResearchDecideService({
      fastDecisionStatus: async () => readyStatus,
      fastDecision: async () => { throw new Error("provider 500"); },
    });
    const failed = await failing.handle(params(), ctx());
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("provider 500");
    expect(failed.ranked.map((item) => item.id)).toEqual(["c1", "c2"]);
  });

  it("rejects malformed candidate input before any model call", async () => {
    const service = createResearchDecideService({
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

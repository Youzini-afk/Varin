import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadFactsSetService, createThreadReadService } from "./thread-services.js";
import type { HarnessActorContext } from "@varin/protocol";

const parentCtx = {
  actor: {
    authorityInstanceId: "authority-1",
    grantedCapabilities: ["control.thread" as const],
    sessionId: "parent-1",
    workerGeneration: 1,
    workerId: "worker-1",
    workspaceId: "workspace-1",
  },
  authorizedPaths: [],
  sessionId: "parent-1",
  signal: new AbortController().signal,
  workspaceId: "workspace-1",
};

const createFactsDispatch = (registry: ReturnType<typeof createThreadRegistry>, dataDir: string) => {
  const workspaceRoot = join(dataDir, "workspace");
  mkdirSync(workspaceRoot);
  return createThreadDispatchService({
    threadRegistry: registry,
    threadSpawnSession: async () => ({ sessionId: "child-1" }),
  } as never);
};

describe("thread.facts.set", () => {
  it("keeps the assistant report and partial validated facts after a failed Run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async (_actor: HarnessActorContext, path: string) => {
        if (path !== "src/auth.ts") return { status: "unavailable", message: "missing" };
        return { status: "ready", content: "export function login() {}\n", revision: "d1_auth", source: "disk" };
      },
      outputStore: { store: () => ({ ref: { durability: "ephemeral", generation: "g", handle: "out_x" }, total: 1 }) },
    } as never);
    const read = createThreadReadService({ threadRegistry: registry } as never);
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        scope: ["src"],
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      expect(thread?.preset).toBe("retrieval");
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");

      const childActor: HarnessActorContext = {
        ...parentCtx.actor,
        sessionId: "child-1",
        workspaceScope: ["src"],
      };
      const childCtx = { ...parentCtx, actor: childActor, sessionId: "child-1" };
      const submitted = await facts.handle({
        question: "Where is login?",
        facts: [
          { claim: "login is in auth.ts", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] },
          { claim: "outside", sources: [{ kind: "local", path: "pkg/other.ts", startLine: 1, endLine: 1 }] },
        ],
        unknowns: ["who calls login"],
      }, childCtx);
      expect(submitted.evidence.facts[0]?.status).toBe("source-checked");
      expect(submitted.evidence.question).toBe("Where is login?");
      expect(submitted.evidence.completion).toBe("delivered");
      expect(submitted.evidence.facts.some((fact) => fact.claim === "outside")).toBe(false);
      expect(submitted.evidence.attempted.some((item) => item.outcome === "rejected")).toBe(true);

      const parent = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(parent?.pendingEvidence?.facts[0]?.status).toBe("source-checked");

      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "failure", "worker exited after partial report", {
        conclusion: "login is exported from src/auth.ts; who calls it remains unknown.",
        changedFiles: ["src/auth.ts"],
        unresolved: [],
        deviations: ["unexpected deviation"],
        confidence: 0.9,
        transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
        blocksSnapshot: {},
      });
      const settled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(settled?.report?.changedFiles).toEqual([]);
      expect(settled?.report?.deviations).toEqual([]);
      expect(settled?.report?.evidence?.facts[0]?.status).toBe("source-checked");
      expect(settled?.report?.evidence?.question).toBe("Where is login?");
      expect(settled?.report?.conclusion).toBe("login is exported from src/auth.ts; who calls it remains unknown.");
      expect(settled?.report?.evidence?.completion).toBe("incomplete");
      expect(settled?.report?.unresolved).toContain("worker exited after partial report");
      expect(JSON.stringify(settled?.report)).not.toMatch(/unexpected deviation/i);

      const report = await read.handle({ threadId: dispatched.threadId, what: "report" }, parentCtx);
      expect(report.text).toContain("login is in auth.ts");
      expect(report.text).toContain("src/auth.ts:1-1");
      expect(report.report?.evidence?.unknowns).toContain("who calls login");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("preserves a natural-language report when no structured facts are submitted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-optional-report-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    const read = createThreadReadService({ threadRegistry: registry } as never);
    const conclusion = "The login helper is exported from src/auth.ts; callers remain unknown.";
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "success", null, {
        conclusion,
        changedFiles: [],
        unresolved: [],
        deviations: [],
        confidence: 0.5,
        transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
        blocksSnapshot: {},
      });

      const settled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(settled?.report?.conclusion).toBe(conclusion);
      expect(settled?.report?.evidence).toBeUndefined();
      expect(settled?.report?.evidenceRunId).toBeUndefined();
      expect(settled?.pendingEvidence).toBeUndefined();
      const report = await read.handle({ threadId: dispatched.threadId, what: "report" }, parentCtx);
      expect(report.text).toContain(conclusion);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("keeps submitted facts when the Run is cancelled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-cancel-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => ({
        status: "ready",
        content: "export function login() {}\n",
        revision: "d1_auth",
        source: "disk",
      }),
    } as never);
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      await facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await registry.cancelThread("workspace-1", dispatched.threadId, "killed by parent");
      const cancelled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(cancelled?.report?.evidence?.completion).toBe("cancelled");
      expect(cancelled?.report?.evidence?.facts[0]?.status).toBe("source-checked");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("keeps pending facts on lost and clears them when a new Run starts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-lost-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => ({
        status: "ready",
        content: "export function login() {}\n",
        revision: "d1_auth",
        source: "disk",
      }),
    } as never);
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      await facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "lost", "worker exited unexpectedly");
      const lost = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(lost?.lifecycle).toBe("active");
      expect(lost?.report).toBeNull();
      expect(lost?.pendingEvidence?.facts[0]?.status).toBe("source-checked");
      await registry.startRun("workspace-1", dispatched.threadId, "pi");
      const resumed = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(resumed?.pendingEvidence).toBeUndefined();
      expect(resumed?.lifecycle).toBe("active");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});

const waitUntil = async (probe: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const started = Date.now();
  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for deferred reader");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("thread.facts.set run binding", () => {
  it("rejects a late submit when the old Run settles during Documents validation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-settle-race-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    let releaseRead!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let started = false;
    let temporaryProtected = false;
    const releaseTemporary = vi.fn(async () => { temporaryProtected = false; });
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => {
        started = true;
        await gate;
        return {
          status: "ready" as const,
          content: "export function login() {}\n",
          revision: "d1_auth",
          source: "disk" as const,
        };
      },
      storeRetrievalArtifact: async (_workspaceId: string, bytes: Buffer) => {
        temporaryProtected = true;
        const hash = `sha256-${bytes.toString("hex")}`;
        return { durability: "durable" as const, hash, byteLength: bytes.byteLength, recordId: `artifact:${hash}`, recordType: "retrieval.artifact" as const, workspaceId: "workspace-1" };
      },
      releaseRetrievalTemporaryArtifacts: releaseTemporary,
    } as never);
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      const submit = facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await waitUntil(() => started);
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "success");
      releaseRead(null);
      await expect(submit).rejects.toThrow(/not active/);
      expect(releaseTemporary).toHaveBeenCalledOnce();
      expect(temporaryProtected).toBe(false);
      const settled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(settled?.pendingEvidence).toBeUndefined();
      expect(settled?.report?.evidence?.facts ?? []).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects a late submit when a lost Run is replaced before Documents returns", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-lost-race-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createFactsDispatch(registry, dataDir);
    let releaseRead!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let started = false;
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => {
        started = true;
        await gate;
        return {
          status: "ready" as const,
          content: "export function login() {}\n",
          revision: "d1_auth",
          source: "disk" as const,
        };
      },
    } as never);
    try {
      const dispatched = await dispatch.handle({
        preset: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      const submit = facts.handle({
        question: "Where is login?",
        facts: [{ claim: "old run", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await waitUntil(() => started);
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "lost", "worker exited unexpectedly");
      await registry.startRun("workspace-1", dispatched.threadId, "pi");
      releaseRead(null);
      await expect(submit).rejects.toThrow(/not active/);
      const resumed = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(resumed?.pendingEvidence).toBeUndefined();
      expect(resumed?.activeRunId).not.toBe(run!.id);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});

describe("thread.read retrieval pagination", () => {
  it("reads only requested UTF-8 artifact slices and preserves the page across registry reopen", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-read-page-"));
    const body = Buffer.from("正文🙂".repeat(30_000), "utf8");
    const artifact = {
      durability: "durable" as const,
      hash: "sha256-large-evidence",
      byteLength: body.byteLength,
      recordId: "artifact:large-evidence",
      recordType: "retrieval.artifact" as const,
      workspaceId: "workspace-1",
    };
    let registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const thread = await registry.createThread({
      scopeId: "workspace-1",
      parent: { kind: "session", id: "parent-1" },
      brief: "large evidence",
      preset: "retrieval",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "none",
      tools: ["read", "submit_facts"],
      permissions: {},
    });
    const run = await registry.startRun("workspace-1", thread.id);
    await registry.setPendingEvidence("workspace-1", thread.id, run.id, {
      question: "large evidence",
      scope: [],
      facts: [{
        claim: "large body",
        status: "source-checked",
        sources: [{ kind: "url", url: "https://example.com/large", check: "source-valid", artifact }],
      }],
      unknowns: [],
      attempted: [],
      completion: "delivered",
    });
    await registry.endRun("workspace-1", thread.id, run.id, "success");
    const reads: Array<{ offset: number; length: number }> = [];
    const hostFor = (activeRegistry: typeof registry) => ({
      threadRegistry: activeRegistry,
      readRetrievalArtifactSlice: async (_workspaceId: string, _artifact: typeof artifact, offset: number, length: number) => {
        reads.push({ offset, length });
        return body.subarray(offset, offset + length);
      },
    } as never);
    try {
      const first = await createThreadReadService(hostFor(registry)).handle({
        threadId: thread.id,
        what: "report",
        length: 257,
      }, parentCtx);
      expect(Buffer.byteLength(first.text, "utf8")).toBeLessThanOrEqual(260);
      expect(first.eof).toBe(false);
      expect(first.report?.evidence?.facts[0]?.sources[0]?.excerpt).toBeUndefined();
      expect(JSON.stringify(first.report)).not.toContain("正文🙂正文🙂");
      expect(reads.length).toBeLessThanOrEqual(1);

      await registry.dispose();
      registry = createThreadRegistry({ dataDir, hostId: "host-1" });
      const reopened = await createThreadReadService(hostFor(registry)).handle({
        threadId: thread.id,
        what: "report",
        length: 257,
      }, parentCtx);
      expect(reopened.text).toBe(first.text);
      expect(reopened.nextOffset).toBe(first.nextOffset);

      let offset = 0;
      let previous = 0;
      let pages = 0;
      do {
        const page = await createThreadReadService(hostFor(registry)).handle({
          threadId: thread.id,
          what: "report",
          offset,
          length: 4097,
        }, parentCtx);
        expect(page.nextOffset).toBeGreaterThan(previous);
        expect(page.text).not.toContain("�");
        previous = page.nextOffset!;
        offset = page.nextOffset!;
        pages += 1;
        if (page.eof) break;
      } while (pages < 100);
      expect(pages).toBeGreaterThan(1);
      expect(pages).toBeLessThan(100);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});

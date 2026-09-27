import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadReport } from "@varin/protocol";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadReadService } from "./thread-services.js";
import type { HarnessServiceHost } from "./service-host.js";
import type { HarnessServiceContext } from "./router.js";

describe("fixed Thread deliveries", () => {
  it("keeps R1 report and exact materials readable during a later Run, after its failure and after Registry reload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-fixed-delivery-"));
    let registry = createThreadRegistry({ dataDir, hostId: "test" });
    const parent = { kind: "session" as const, id: "parent" };
    const ctx: HarnessServiceContext = { sessionId: "parent", workspaceId: "workspace", authorizedPaths: [], signal: new AbortController().signal,
      actor: { authorityInstanceId: "test", sessionId: "parent", workerId: "worker", workerGeneration: 1,
        workspaceId: "workspace", grantedCapabilities: ["control.thread"] } };
    try {
      const thread = await registry.createThread({ scopeId: "workspace", parent, brief: "Deliver API", kind: "implementation",
        createdBy: "agent", concurrency: 1, autoRun: true, worktree: "isolated", tools: ["read", "write"], permissions: {} });
      const first = await registry.startRun("workspace", thread.id);
      const delivery: ThreadReport = { conclusion: "R1_PUBLIC_API\n" + "exact material\n".repeat(700), resultRevision: 1,
        changedFiles: ["api.ts"], unresolved: [], deviations: [], confidence: 0.5,
        transcriptRef: { runtimeId: "pi", sessionId: "first-session", fromEntryId: "first", toEntryId: "last" },
        blocksSnapshot: { notes: "ORIGINAL_REPORT_NOTES" } };
      await registry.endRun("workspace", thread.id, first.id, "success", null, delivery);
      const second = await registry.startRun("workspace", thread.id, "pi", { allowSettled: true, inputOrigin: "continue" });
      const read = () => createThreadReadService({ threadRegistry: registry } as unknown as HarnessServiceHost);
      expect((await read().handle({ threadId: thread.id, what: "report", resultRevision: 1 }, ctx)).report).toEqual(delivery);
      await registry.endRun("workspace", thread.id, second.id, "failure", "R2 failed", { ...delivery,
        conclusion: "LATER_FAILURE", resultRevision: 2, blocksSnapshot: { notes: "changed" } });
      expect((await registry.getThread("workspace", parent, thread.id))?.report?.conclusion).toBe("LATER_FAILURE");
      expect((await read().handle({ threadId: thread.id, what: "report", resultRevision: 1 }, ctx)).text).toContain(delivery.conclusion);
      await registry.dispose();
      registry = createThreadRegistry({ dataDir, hostId: "test" });
      expect((await read().handle({ threadId: thread.id, what: "report", runId: first.id }, ctx)).report).toEqual(delivery);
      expect((await read().handle({ threadId: thread.id, what: "blocks", runId: first.id }, ctx)).text).toContain("ORIGINAL_REPORT_NOTES");
      await expect(read().handle({ threadId: thread.id, what: "report", runId: "unrelated" }, ctx)).rejects.toMatchObject({ harnessCode: "not-found" });
      await expect(read().handle({ threadId: thread.id, what: "report", runId: first.id, resultRevision: 2 }, ctx)).rejects.toMatchObject({ harnessCode: "not-found" });
    } finally { await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
  });
});

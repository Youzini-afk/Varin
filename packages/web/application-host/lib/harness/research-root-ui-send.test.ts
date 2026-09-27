import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadSendService } from "./thread-services.js";
import type { HarnessServiceHost } from "./service-host.js";

describe("research root UI messaging", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps the authenticated UI as the user while the principal root is active or settled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-root-ui-send-"));
    roots.push(dataDir);
    const registry = createThreadRegistry({ dataDir, hostId: "host" });
    const workspaceId = "workspace";
    const sessionId = "user-session";
    const root = await registry.createThread({
      scopeId: workspaceId,
      parent: { kind: "session", id: sessionId },
      brief: "research question",
      kind: "discussion",
      purpose: "research-root",
      createdBy: "user",
      concurrency: 12,
      worktree: "none",
      tools: ["read"],
      workFocus: "research",
      permissions: {},
      autoRun: false,
      hidden: true,
    });
    const rootRun = (await registry.admitRun(workspaceId, root.id, "pi", {
      sessionOwner: "attached-root",
    })).run;
    await registry.markRunRunning(workspaceId, root.id, rootRun.id, sessionId);
    const branch = await registry.createThread({
      scopeId: workspaceId,
      parent: { kind: "thread", id: root.id },
      brief: "bounded branch",
      kind: "discussion",
      createdBy: "agent",
      concurrency: 12,
      worktree: "none",
      tools: ["read"],
      permissions: {},
      autoRun: false,
    });
    const branchRun = await registry.startRun(workspaceId, branch.id);
    await registry.markRunRunning(workspaceId, branch.id, branchRun.id, "branch-session");

    const delivered = vi.fn(async () => undefined);
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: delivered,
    } as unknown as HarnessServiceHost);
    const context = {
      actor: {
        authorityInstanceId: "ui",
        sessionId,
        workerId: "ui",
        workerGeneration: 0,
        workspaceId,
        grantedCapabilities: [],
      },
      authorizedPaths: [],
      requestSource: "user" as const,
      sessionId,
      signal: new AbortController().signal,
      workspaceId,
    };

    await service.handle({ threadId: branch.id, message: "first", kind: "inform", from: "user" }, context);
    expect(delivered).toHaveBeenLastCalledWith(
      "branch-session",
      "first",
      expect.objectContaining({ from: "the user" }),
    );

    await registry.endRun(workspaceId, root.id, rootRun.id, "success", null);
    await registry.unbindRunSession(sessionId, { retainHistorical: false });
    await service.handle({ threadId: branch.id, message: "second", kind: "inform", from: "user" }, context);
    expect(delivered).toHaveBeenLastCalledWith(
      "branch-session",
      "second",
      expect.objectContaining({ from: "the user" }),
    );
    await registry.dispose();
  });
});

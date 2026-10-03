import { describe, expect, it } from "vitest";
import {
  bindCommandsToPublishedResult,
  cwdUnderRoot,
  inputChangedDuringCommand,
  projectThreadVerification,
  relateCommandToPublish,
} from "./verification-records.js";
import type { CommandVerificationRecord } from "./types.js";

const actor = { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1, runId: "run-1" };

describe("verification records", () => {
  it("requires an exact observed boundary identity before binding a command", () => {
    expect(cwdUnderRoot("D:\\ws\\thread\\src", "D:\\ws\\thread")).toBe(true);
    expect(relateCommandToPublish(
      { cwd: "D:\\ws\\thread", runId: "run-1", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20, startTreeHash: "tree", endTreeHash: "tree", resultTreeHash: "tree" },
    )).toBe("same-run-matching-result");
    expect(relateCommandToPublish(
      { cwd: "D:\\other", runId: "run-1", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20, startTreeHash: "tree", endTreeHash: "tree", resultTreeHash: "tree" },
    )).toBe("unbound");
    expect(relateCommandToPublish(
      { cwd: "D:\\ws\\thread", runId: "run-1", endedAt: 10 },
      { worktreePath: "D:\\ws\\thread", runId: "run-1", publishedAt: 20, startTreeHash: "old", endTreeHash: "new", resultTreeHash: "new" },
    )).toBe("uncertain");
  });

  it("records input change only from actual observed tree identities", () => {
    expect(inputChangedDuringCommand({ startTreeHash: "tree-1", endTreeHash: "tree-1" })).toBe(false);
    expect(inputChangedDuringCommand({ startTreeHash: "tree-1", endTreeHash: "tree-2" })).toBe(true);
    expect(inputChangedDuringCommand({})).toBeNull();
  });

  it("binds only the command whose observed input is the fixed result", () => {
    const command: Omit<CommandVerificationRecord, "relationToPublished" | "inputChangedDuringRun"> = {
      id: "cmd-1", runId: "run-1", command: "bun test", cwd: "/ws/thread", startedAt: 10, endedAt: 20,
      exitCode: 0, cancelled: false, actor, bindingGeneration: 1,
      inputIdentity: { kind: "tree", root: "/ws/thread", branchId: "thread-1", startTreeHash: "tree", endTreeHash: "tree" },
    };
    const bundle = bindCommandsToPublishedResult({
      branchId: "thread-1", resultRevision: 2, runId: "run-1", worktreePath: "/ws/thread",
      publishedAt: 50, resultTreeHash: "tree", commands: [command],
    });
    expect(bundle.binding).toBe("bound");
    expect(bundle.checks[0]?.relationToPublished).toBe("same-run-matching-result");
    expect(bundle.bindingReason).toMatch(/observed command start\/end and publish boundaries/);
    const projection = projectThreadVerification({ currentResultRevision: 2, child: bundle });
    expect(projection.childChecks?.allExitedZero).toBe(true);
    expect(projection.review?.status).toBe("none");
  });

});

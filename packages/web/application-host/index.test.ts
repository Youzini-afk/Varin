import { describe, expect, it } from "vitest";
import {
  mergeSessionSnapshotForKnowledgeOwner,
  resolveKnowledgeScopeOwner,
} from "./index.js";

describe("application-host knowledge ownership helpers", () => {
  it("keeps a known root-session owner when later snapshots omit workspace fields", () => {
    const original = {
      name: "root",
      workspace: { kind: "workspace", authorityId: "owning-workspace", id: "owning-workspace" },
    };
    expect(mergeSessionSnapshotForKnowledgeOwner(original, { name: "root" })).toEqual(original);
    expect(mergeSessionSnapshotForKnowledgeOwner(original, {
      workspace: { kind: "workspace" },
      isStreaming: true,
    })).toEqual({
      name: "root",
      workspace: { kind: "workspace", authorityId: "owning-workspace", id: "owning-workspace" },
      isStreaming: true,
    });
    expect(mergeSessionSnapshotForKnowledgeOwner(original, {
      workspace: { kind: "workspace", authorityId: "", id: "" },
    }).workspace).toEqual(original.workspace);
    expect(mergeSessionSnapshotForKnowledgeOwner(original, {
      workspace: { kind: "workspace", id: "new-owner" },
    }).workspace).toEqual({ kind: "workspace", id: "new-owner" });
  });

  it("does not use an execution or snapshot fallback when durable catalog lookup fails", async () => {
    await expect(resolveKnowledgeScopeOwner(
      async () => { throw new Error("thread catalog read failed"); },
      "execution-workspace",
      "snapshot-workspace",
    )).rejects.toThrow("thread catalog read failed");
  });
});

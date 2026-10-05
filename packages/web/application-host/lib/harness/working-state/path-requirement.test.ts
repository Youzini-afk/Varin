import { describe, expect, it } from "vitest";
import { runNeedsMaterializedDirectory } from "./path-requirement.js";

describe("runNeedsMaterializedDirectory", () => {
  it("uses actual tool names rather than role labels", () => {
    expect(runNeedsMaterializedDirectory(["read", "grep", "find", "ls", "explore"])).toBe(false);
    expect(runNeedsMaterializedDirectory(["read", "edit", "write", "apply_patch"])).toBe(false);
    expect(runNeedsMaterializedDirectory(["bash"])).toBe(true);
    expect(runNeedsMaterializedDirectory(["symbols"])).toBe(true);
    expect(runNeedsMaterializedDirectory(["worker"])).toBe(false);
  });
});

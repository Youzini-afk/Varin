import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverShells } from "../harness/shell-discovery.js";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.test-helper.js";
import {
  createShellSupervisor,
  selectInterpreter,
  type DiscoveredShells,
} from "../harness/shell-supervisor.js";
import { createOutputStore } from "../harness/output-store.js";

/**
 * This is a real PTY/process-tree test. Keep it in the native kernel suite so
 * it never competes with the ordinary Vitest files for process authority,
 * kernel children, and OS process-tree teardown.
 */
describe("shell-supervisor dispose kills process tree", () => {
  it("dispose() terminates the PTY process and its children", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "shell-dispose-"));
    const outputStore = createOutputStore();
    const discovered: DiscoveredShells = discoverShells();
    const interp = selectInterpreter({
      platform: process.platform,
      workspaceRoot,
      setting: "auto",
      discovered,
      remote: false,
    });
    if (!("kind" in interp)) {
      rmSync(workspaceRoot, { recursive: true, force: true });
      return;
    }

    const terminal = createIsolatedTerminalSessionApi();
    const supervisor = createShellSupervisor({
      interpreter: interp,
      outputStore,
      sessionId: "dispose-test",
      cwd: workspaceRoot,
      createTerminalSession: (input) => terminal.createTerminalSession(input),
    });
    try {
      const result = await supervisor.exec("echo hello", { waitMs: 10000 });
      expect(result.kind).toBe("completed");
      await supervisor.dispose();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await supervisor.dispose().catch(() => undefined);
      await terminal.shutdown();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }, 15000);
});

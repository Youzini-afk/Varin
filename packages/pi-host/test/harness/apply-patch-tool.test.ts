import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createApplyPatchTool } from "../../src/harness/apply-patch-tool.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(root?: string, lockBatches?: string[][]): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "fs.lock" && params.action === "acquire") {
        const paths = params.paths as string[];
        lockBatches?.push(paths);
        return { held: true, leaseIds: paths.map((_, index) => `lease-${index}`) };
      }
      if (method === "fs.lock" && params.action === "release") return { held: false, released: true };
      if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
      if (method === "document.branchWrite") return { status: "disk" };
      if (method === "document.surfaceWrite") {
        if (!root) return { status: "disk" };
        const changes = params.changes as Array<{ path: string; action: "write" | "delete"; content?: string }>;
        for (const change of changes) {
          const target = join(root, change.path);
          if (change.action === "delete") rmSync(target, { force: true });
          else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, change.content ?? "", "utf8");
          }
        }
        return {
          status: "applied",
          results: changes.map((change) => ({ path: change.path, target: "disk", status: "applied" })),
        };
      }
      if (method === "document.readSource") {
        const inputPath = String(params.path);
        const filePath = root && !inputPath.startsWith(root) ? join(root, inputPath) : inputPath;
        if (!existsSync(filePath)) throw new Error("file not found");
        return { source: "disk", base64: readFileSync(filePath).toString("base64") };
      }
      throw new Error(`unexpected method: ${method}`);
    },
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executePatch(tool: ReturnType<typeof createApplyPatchTool>, patch: string): Promise<string> {
  const result = await tool.execute("call-1", { patch } as never, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("apply_patch (Codex syntax)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a simple update patch", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3\n");
    const bridge = createFakeBridge(tmpDir);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });

    const patch = `*** Begin Patch
*** Update File: test.txt
@@ line1
-line2
+line2 modified
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    const content = readFileSync(join(tmpDir, "test.txt"), "utf8");
    assert.equal(content, "line1\nline2 modified\nline3\n");
  });

  it("uses the Host disk snapshot for patch context and its conditional hash", async () => {
    const file = join(tmpDir, "remote.txt");
    writeFileSync(file, "local decoy\n");
    const hostText = "host original\n";
    const expectedHash = `sha256-${createHash("sha256").update(hostText, "utf8").digest("hex")}`;
    let surfaceContent = "";
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "document.branchWrite") return { status: "disk" };
        if (method === "document.readSource") {
          return { source: "disk", base64: Buffer.from(hostText).toString("base64") };
        }
        if (method === "document.surfaceWrite") {
          const change = (params.changes as Array<{ content?: string; expectedHash?: string }>)[0];
          assert.equal(change?.expectedHash, expectedHash);
          surfaceContent = change?.content ?? "";
          return { status: "applied", results: [{ path: "remote.txt", target: "disk", status: "applied" }] };
        }
        if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createApplyPatchTool(bridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const result = await executePatch(tool, `*** Begin Patch
*** Update File: remote.txt
@@
-host original
+host updated
*** End Patch`);
    assert.match(result, /applied successfully/);
    assert.equal(surfaceContent, "host updated\n");
    assert.equal(readFileSync(file, "utf8"), "local decoy\n");
  });

  it("adds a new file", async () => {
    const bridge = createFakeBridge(tmpDir);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });

    const patch = `*** Begin Patch
*** Add File: new.txt
+hello world
+line2
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    const content = readFileSync(join(tmpDir, "new.txt"), "utf8");
    assert.equal(content, "hello world\nline2\n");
  });

  it("deletes a file", async () => {
    writeFileSync(join(tmpDir, "delete-me.txt"), "content");
    const bridge = createFakeBridge(tmpDir);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });

    const patch = `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    assert.equal(existsSync(join(tmpDir, "delete-me.txt")), false);
  });

  it("preserves interleaved context and Windows newlines instead of moving context before changes", async () => {
    const path = join(tmpDir, "ordered.txt");
    writeFileSync(path, "header\r\nold one\r\nmiddle\r\nold two\r\ntail\r\n");
    const tool = createApplyPatchTool(createFakeBridge(tmpDir) as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, [
      "*** Begin Patch", "*** Update File: ordered.txt", "@@", " header", "-old one", "+new one",
      " middle", "-old two", "+new two", " tail", "*** End of File", "*** End Patch",
    ].join("\r\n"));
    assert.match(text, /applied successfully/);
    assert.equal(readFileSync(path, "utf8"), "header\r\nnew one\r\nmiddle\r\nnew two\r\ntail\r\n");
  });

  it("keeps literal plus signs in added content and rejects incomplete patches without a write", async () => {
    const tool = createApplyPatchTool(createFakeBridge(tmpDir) as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    await executePatch(tool, "*** Begin Patch\n*** Add File: plus.txt\n++literal\n+\n+last\n*** End Patch");
    assert.equal(readFileSync(join(tmpDir, "plus.txt"), "utf8"), "+literal\n\nlast\n");
    const text = await executePatch(tool, "*** Begin Patch\n*** Add File: unfinished.txt\n+partial");
    assert.match(text, /must end with/);
    assert.equal(existsSync(join(tmpDir, "unfinished.txt")), false);
  });

  it("handles multiple files in one patch", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "aaa\n");
    writeFileSync(join(tmpDir, "b.txt"), "bbb\n");
    const lockBatches: string[][] = [];
    const bridge = createFakeBridge(tmpDir, lockBatches);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });

    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-aaa
+AAA
*** Add File: c.txt
+ccc
*** Update File: b.txt
@@
-bbb
+BBB
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    assert.equal(readFileSync(join(tmpDir, "a.txt"), "utf8"), "AAA\n");
    assert.equal(readFileSync(join(tmpDir, "b.txt"), "utf8"), "BBB\n");
    assert.equal(readFileSync(join(tmpDir, "c.txt"), "utf8"), "ccc\n");
    assert.equal(lockBatches.length, 0, "Host surface mutations own the kernel gate and must not nest fs.lock");
  });

  it("reports error on missing *** Begin Patch", async () => {
    const bridge = createFakeBridge(tmpDir);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, "just some text");
    assert.match(text, /parse error/);
    assert.match(text, /Begin Patch/);
  });

  it("reports error when context not found", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3\n");
    const bridge = createFakeBridge(tmpDir);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir, undefined, { surfaceWrite: true });

    const patch = `*** Begin Patch
*** Update File: test.txt
@@ nonexistent_context
-line2
+modified
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /Context not found/);
  });

  it("matches a surface draft and writes the buffer instead of disk", async () => {
    writeFileSync(join(tmpDir, "draft.txt"), "A\n");
    const calls: string[] = [];
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        if (method === "fs.lock") {
          return params.action === "acquire"
            ? { held: true, leaseIds: ["lease-1"] }
            : { held: false, released: true };
        }
        if (method === "document.branchWrite") return { status: "disk" };
        if (method === "document.readSource") {
          return {
            source: "surface-draft",
            revision: "surface-draft:fixed:1",
            base64: Buffer.from("B unique-on-draft\n").toString("base64"),
          };
        }
        if (method === "document.surfaceWrite") {
          const changes = params.changes as Array<{
            path: string;
            content?: string;
            expectedRevision?: string;
            expectedHash?: string;
          }>;
          assert.equal(changes[0]?.path, "draft.txt");
          assert.match(changes[0]?.content ?? "", /C unique-on-draft/);
          assert.equal(changes[0]?.expectedRevision, "surface-draft:fixed:1");
          assert.match(changes[0]?.expectedHash ?? "", /^sha256-[0-9a-f]{64}$/);
          return {
            status: "applied",
            operationId: "op-1",
            results: [{ path: "draft.txt", target: "surface", status: "applied" }],
          };
        }
        if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createApplyPatchTool(bridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, `*** Begin Patch
*** Update File: draft.txt
@@
-B unique-on-draft
+C unique-on-draft
*** End Patch`);
    assert.match(text, /applied successfully/);
    assert.equal(readFileSync(join(tmpDir, "draft.txt"), "utf8"), "A\n");
    assert.ok(calls.includes("document.surfaceWrite"));
  });

  it("returns honest per-path status for a mixed surface/disk failure", async () => {
    writeFileSync(join(tmpDir, "disk.txt"), "disk\n");
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "fs.lock") {
          return params.action === "acquire"
            ? { held: true, leaseIds: ["lease-a", "lease-b"] }
            : { held: false, released: true };
        }
        if (method === "document.branchWrite") return { status: "disk" };
        if (method === "document.readSource") {
          const path = String(params.path);
          if (path.endsWith("draft.txt") || path === "draft.txt") {
            return {
              source: "surface-draft",
              revision: "surface-draft:fixed:1",
              base64: Buffer.from("B\n").toString("base64"),
            };
          }
          return { source: "disk", base64: Buffer.from("disk\n").toString("base64") };
        }
        if (method === "document.surfaceWrite") {
          return {
            status: "partial",
            message: "compensated draft.txt (surface)\nunavailable disk.txt (disk)",
            results: [
              { path: "draft.txt", target: "surface", status: "compensated" },
              { path: "disk.txt", target: "disk", status: "unavailable", message: "later path failed" },
            ],
          };
        }
        if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createApplyPatchTool(bridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, `*** Begin Patch
*** Update File: draft.txt
@@
-B
+C
*** Update File: disk.txt
@@
-disk
+DISK
*** End Patch`);
    assert.match(text, /compensated/);
    assert.match(text, /unavailable/);
    assert.match(text, /draft\.txt/);
    assert.match(text, /disk\.txt/);
    assert.equal(readFileSync(join(tmpDir, "disk.txt"), "utf8"), "disk\n");
  });

  it("stops when readSource is unavailable even if disk already matches the patch", async () => {
    writeFileSync(join(tmpDir, "draft.txt"), "B unique-on-draft\n");
    const calls: string[] = [];
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        if (method === "fs.lock") {
          return params.action === "acquire"
            ? { held: true, leaseIds: ["lease-1"] }
            : { held: false, released: true };
        }
        if (method === "document.readSource") {
          throw new Error("document source is unavailable");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createApplyPatchTool(bridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, `*** Begin Patch
*** Update File: draft.txt
@@
-B unique-on-draft
+C unique-on-draft
*** End Patch`);
    assert.match(text, /unavailable/);
    assert.equal(readFileSync(join(tmpDir, "draft.txt"), "utf8"), "B unique-on-draft\n");
    assert.equal(calls.includes("document.surfaceWrite"), false);
    assert.equal(calls.includes("document.branchWrite"), false);
  });

  it("carries the disk patch source identity into surfaceWrite after a concurrent edit", async () => {
    writeFileSync(join(tmpDir, "stale.txt"), "before\n");
    let expectedHash = "";
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "fs.lock") {
          return params.action === "acquire"
            ? { held: true, leaseIds: ["lease-1"] }
            : { held: false, released: true };
        }
        if (method === "document.readSource") {
          return { source: "disk", base64: Buffer.from("before\n").toString("base64") };
        }
        if (method === "document.branchWrite") {
          // The patch is computed from `before`; a concurrent writer wins
          // before the Host receives the conditional surface mutation.
          writeFileSync(join(tmpDir, "stale.txt"), "before\r\n");
          return { status: "disk" };
        }
        if (method === "document.surfaceWrite") {
          const changes = params.changes as Array<{ expectedHash?: string }>;
          expectedHash = changes[0]?.expectedHash ?? "";
          return {
            status: "conflict",
            message: "disk source changed",
            results: [{ path: "stale.txt", target: "disk", status: "conflict" }],
          };
        }
        if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createApplyPatchTool(bridge, "s1", tmpDir, undefined, { surfaceWrite: true });
    const text = await executePatch(tool, `*** Begin Patch
*** Update File: stale.txt
@@
-before
+updated
*** End Patch`);
    assert.match(text, /conflict/);
    assert.match(expectedHash, /^sha256-[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(tmpDir, "stale.txt"), "utf8"), "before\r\n");
  });
});

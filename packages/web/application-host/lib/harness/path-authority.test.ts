import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HarnessActorContext } from "@varin/protocol";
import { createHarnessPathAuthority } from "./path-authority.js";

const actor = (workspaceId = "workspace-1"): HarnessActorContext => ({
  authorityInstanceId: "broker-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId,
  grantedCapabilities: ["write.document"],
});

describe("harness path authority", () => {
  it("returns a canonical resource identity only for paths inside the actor workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-path-"));
    const file = join(root, "file.ts");
    writeFileSync(file, "x");
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    try {
      const relative = await authority.resolve(actor(), "file.ts", { allowMissing: false });
      const absolute = await authority.resolve(actor(), file, { allowMissing: false });
      expect(relative?.canonicalResourceId).toBe(absolute?.canonicalResourceId);
      expect(relative).toMatchObject({ authorityId: "host-1", workspaceId: "workspace-1", inputPath: "file.ts" });
      expect(await authority.resolve(actor(), join(root, "..", "outside.ts"), { allowMissing: true })).toBeNull();
      expect(await authority.resolve(actor(), "../outside.ts", { allowMissing: true })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("folds Windows dot segments and case through the shared Documents identity rules", async () => {
    const pathModule = path.win32 as unknown as typeof path;
    let openedPath = "";
    const fakeFs = {
      realpath: async (value: string) => path.win32.normalize(value).replace(/^d:\\workspace/i, "D:\\Workspace"),
      stat: async () => ({ isDirectory: () => false }),
    };
    const fakeReadFs = {
      open: async (value: string) => {
        openedPath = value;
        return {
          stat: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
          readFile: async () => Buffer.from(value.endsWith("File.ts") ? "upper" : "lower"),
          close: async () => undefined,
        };
      },
      stat: async () => ({ isFile: () => true, dev: 1n, ino: 2n }),
    } as unknown as Pick<typeof fs.promises, "open" | "stat">;
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root: "D:\\Workspace" }) },
      fsPromises: fakeFs,
      readFsPromises: fakeReadFs,
      pathModule,
      platform: "win32",
    });
    const first = await authority.resolve(actor(), "D:\\A\\..\\Workspace\\File.ts", { allowMissing: false });
    const second = await authority.resolve(actor(), "d:\\workspace\\file.TS", { allowMissing: false });
    expect(first?.canonicalResourceId).toBe("d:\\workspace\\file.ts");
    expect(second?.canonicalResourceId).toBe(first?.canonicalResourceId);
    expect(first?.resolvedPath).toBe("D:\\Workspace\\File.ts");
    expect(second?.resolvedPath).toBe("D:\\Workspace\\file.TS");
    expect(await authority.readAuthorizedFile(actor(), first!)).toEqual(Buffer.from("upper"));
    expect(openedPath).toBe("D:\\Workspace\\File.ts");
  });

  it("does not convert document authority failures into an outside-workspace answer", async () => {
    const failure = Object.assign(new Error("registry unreadable"), { code: "EACCES" });
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => { throw failure; } },
      fsPromises: fs.promises,
    });
    await expect(authority.resolve(actor(), "file.ts", { allowMissing: false })).rejects.toBe(failure);
  });

  it("restricts a child actor to its broker-pinned workspace scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-scope-"));
    const allowed = join(root, "packages", "web");
    fs.mkdirSync(allowed, { recursive: true });
    writeFileSync(join(allowed, "inside.ts"), "inside");
    writeFileSync(join(root, "outside.ts"), "outside");
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    const scoped = { ...actor(), workspaceScope: ["packages/web"] };
    try {
      await expect(authority.resolve(scoped, "packages/web/inside.ts", { allowMissing: false })).resolves.not.toBeNull();
      await expect(authority.resolve(scoped, "outside.ts", { allowMissing: false })).resolves.toBeNull();
      await expect(authority.resolve(scoped, "packages/ui/new.ts", { allowMissing: true })).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("anchors relative paths at the actor operation dir, not the workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-opdir-"));
    const project = join(root, "packages", "web");
    fs.mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "inside.ts"), "inside");
    writeFileSync(join(root, "root-only.ts"), "root");
    const authority = createHarnessPathAuthority({
      authorityId: "host-1",
      documents: { inspectWorkspace: async () => ({ root }) },
    });
    const anchored = { ...actor(), operationDir: "packages/web" };
    try {
      // A relative path resolves against the operation dir.
      const resolved = await authority.resolve(anchored, "inside.ts", { allowMissing: false });
      expect(resolved).not.toBeNull();
      expect(resolved?.resourceId).toBe("packages/web/inside.ts");
      // The same relative name does not fall back to a same-named root file —
      // it is simply missing under the operation dir (ENOENT like any miss).
      await expect(authority.resolve(anchored, "root-only.ts", { allowMissing: false }))
        .rejects.toMatchObject({ code: "ENOENT" });
      // With allowMissing the miss resolves as an authorized future path.
      expect((await authority.resolve(anchored, "root-only.ts", { allowMissing: true }))?.resourceId)
        .toBe("packages/web/root-only.ts");
      // `..` is valid for another path inside the authorized workspace, but
      // cannot climb past its root even when the destination does not exist.
      expect((await authority.resolve(anchored, "../../root-only.ts", { allowMissing: false }))?.resourceId)
        .toBe("root-only.ts");
      expect(await authority.resolve(anchored, "../../../outside.ts", { allowMissing: true })).toBeNull();
      // Absolute and scope authorization still apply unchanged.
      const scoped = { ...anchored, workspaceScope: ["packages/web"] };
      await expect(authority.resolve(scoped, "inside.ts", { allowMissing: false })).resolves.not.toBeNull();
      await expect(authority.resolve(scoped, join(root, "root-only.ts"), { allowMissing: false })).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

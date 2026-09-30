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
    const anchored = { ...actor(), cwd: join(root, "packages", "web") };
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

  describe("HR0 resource roots", () => {
    const resourceRoots = (entries: Array<{ canonicalPath: string; kind: "directory" | "file" }>) => {
      const roots = new Map<string, { workspaceId: string; canonicalPath: string; kind: "directory" | "file" }>(entries.map((entry, index) => {
        const canonicalPath = fs.realpathSync(entry.canonicalPath);
        return [canonicalPath, { workspaceId: `root-${index}`, canonicalPath, kind: entry.kind }] as const;
      }));
      const registered: Array<{ canonicalPath: string; kind: string }> = [];
      const norm = (value: string) => path.resolve(value);
      return {
        registered,
        inspectWorkspace: async () => { throw new Error("no project workspace"); },
        findExactResourceRoot: async (canonicalPath: string, kind?: "directory" | "file") => {
          const hit = roots.get(norm(canonicalPath));
          return hit && (!kind || hit.kind === kind) ? hit : null;
        },
        findContainingResourceRoot: async (canonicalPath: string) => {
          const needle = norm(canonicalPath);
          let best: { workspaceId: string; canonicalPath: string; kind: "directory" | "file" } | null = null;
          for (const root of roots.values()) {
            if (root.kind !== "directory") continue;
            const relative = path.relative(root.canonicalPath, needle);
            if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
              if (!best || root.canonicalPath.length > best.canonicalPath.length) best = root;
            }
          }
          return best;
        },
        ensureResourceRoot: async (canonicalPath: string, kind: "directory" | "file") => {
          const root = { workspaceId: `root-${roots.size}`, canonicalPath: norm(canonicalPath), kind };
          roots.set(root.canonicalPath, root);
          registered.push({ canonicalPath: root.canonicalPath, kind });
          return root;
        },
      };
    };
    const unbound = (authorityRoot: string): HarnessActorContext => ({
      authorityInstanceId: "broker-1",
      sessionId: "session-1",
      workerId: "worker-1",
      workerGeneration: 1,
      workspaceId: null,
      authorityRoot,
      grantedCapabilities: ["write.document"],
    });

    it("reads an external file through one stable directory root for a no-project session", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      const external = mkdtempSync(join(tmpdir(), "harness-external-"));
      const target = join(external, "paper.pdf");
      writeFileSync(target, "bytes");
      const documents = resourceRoots([{ canonicalPath: target, kind: "file" }]);
      const authority = createHarnessPathAuthority({ authorityId: "host-1", documents });
      try {
        const resolved = await authority.resolve(unbound(launch), target, { allowMissing: false });
        expect(resolved).toMatchObject({ workspaceId: "root-1", resourceId: "paper.pdf", resolvedPath: fs.realpathSync(target) });
        expect(await authority.readAuthorizedFile(unbound(launch), resolved!)).toEqual(Buffer.from("bytes"));
      } finally {
        rmSync(launch, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it("resolves a relative path through the session authority root under a directory resource root", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      writeFileSync(join(launch, "notes.md"), "note");
      const documents = resourceRoots([{ canonicalPath: launch, kind: "directory" }]);
      const authority = createHarnessPathAuthority({ authorityId: "host-1", documents });
      try {
        const resolved = await authority.resolve(unbound(launch), "notes.md", { allowMissing: false });
        expect(resolved).toMatchObject({ workspaceId: "root-0", resourceId: "notes.md" });
      } finally {
        rmSync(launch, { recursive: true, force: true });
      }
    });

    it("resolves a missing write target inside an admitted directory root without registering anything", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      const target = join(launch, "out", "result.txt");
      const documents = resourceRoots([{ canonicalPath: launch, kind: "directory" }]);
      const authority = createHarnessPathAuthority({ authorityId: "host-1", documents });
      try {
        const write = await authority.resolve(unbound(launch), target, { allowMissing: true });
        expect(write).toMatchObject({ resourceId: "out/result.txt" });
        expect(documents.registered).toEqual([]);
        await expect(authority.resolve(unbound(launch), target, { allowMissing: false }))
          .rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        rmSync(launch, { recursive: true, force: true });
      }
    });

    it("addresses external writes below an existing directory, including files with an older exact root", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      const external = mkdtempSync(join(tmpdir(), "harness-external-"));
      const existing = join(external, "existing.txt");
      const nested = join(external, "new", "note.txt");
      writeFileSync(existing, "old");
      const documents = resourceRoots([{ canonicalPath: existing, kind: "file" }]);
      const authority = createHarnessPathAuthority({ authorityId: "host-1", documents });
      try {
        expect(await authority.resolve(unbound(launch), existing, { allowMissing: false }))
          .toMatchObject({ workspaceId: "root-1", resourceId: "existing.txt" });
        expect(await authority.resolve(unbound(launch), existing, { allowMissing: true }))
          .toMatchObject({ workspaceId: "root-1", resourceId: "existing.txt" });
        expect(await authority.resolve(unbound(launch), nested, { allowMissing: true }))
          .toMatchObject({ workspaceId: "root-1", resourceId: "new/note.txt" });
        expect(documents.registered).toEqual([{ canonicalPath: fs.realpathSync(external), kind: "directory" }]);
      } finally {
        rmSync(launch, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it("returns null outside admitted roots when no resource registration is wired", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      const external = mkdtempSync(join(tmpdir(), "harness-external-"));
      const authority = createHarnessPathAuthority({
        authorityId: "host-1",
        documents: { inspectWorkspace: async () => { throw new Error("none"); } },
      });
      try {
        writeFileSync(join(external, "x.txt"), "x");
        expect(await authority.resolve(unbound(launch), join(external, "x.txt"), { allowMissing: false })).toBeNull();
      } finally {
        rmSync(launch, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });

    it("keeps workspaceScope as an absolute gate over resource-rooted targets", async () => {
      const launch = mkdtempSync(join(tmpdir(), "harness-launch-"));
      const inside = join(launch, "inside.txt");
      const external = mkdtempSync(join(tmpdir(), "harness-external-"));
      const outside = join(external, "outside.txt");
      writeFileSync(inside, "in");
      writeFileSync(outside, "out");
      const documents = resourceRoots([
        { canonicalPath: launch, kind: "directory" },
        { canonicalPath: external, kind: "directory" },
      ]);
      const authority = createHarnessPathAuthority({ authorityId: "host-1", documents });
      const scoped = { ...unbound(launch), workspaceScope: [launch] };
      try {
        expect(await authority.resolve(scoped, inside, { allowMissing: false })).not.toBeNull();
        expect(await authority.resolve(scoped, outside, { allowMissing: false })).toBeNull();
      } finally {
        rmSync(launch, { recursive: true, force: true });
        rmSync(external, { recursive: true, force: true });
      }
    });
  });
});

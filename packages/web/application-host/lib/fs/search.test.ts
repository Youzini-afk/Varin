import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { KernelComputeResult } from "../kernel/compute-runner.js";
import type { KernelComputeService } from "../kernel/compute-service.js";
import { createFsSearchRuntime } from "./search.js";

const result = (
  records: KernelComputeResult["records"],
  status: KernelComputeResult["status"] = "ready",
): KernelComputeResult => ({
  kernelEpoch: "epoch",
  workspaceId: "workspace",
  jobId: "job",
  status,
  root: null,
  records,
  nextCursor: records.length,
  endCursor: records.length,
  scannedFiles: records.length,
  message: null,
});

const entry = (relativePath: string, revision = `rev:${relativePath}`) => ({
  kind: "entry",
  path: relativePath,
  revision,
  data: { kind: "file" },
});

const runtimeWith = (directory: KernelComputeService["directory"]) => createFsSearchRuntime({
  compute: { directory },
  path,
});

describe("native filesystem search projection", () => {
  it('retains native Git filtering diagnostics on an empty result', async () => {
    const runtime = runtimeWith(async (_root, _input, options) => {
      const records = [{ kind: 'inventory', path: '', revision: '', data: { strategy: 'git-visible', gitRoot: '/parent', selectedRootIgnored: true } }];
      await options?.onRecords?.(records);
      return result(records);
    });
    const files = await runtime.searchFilesystemFiles('/parent/ignored', { query: '' });
    expect(files).toHaveLength(0);
    expect(files.enumerationInfo).toEqual({ strategy: 'git-visible', gitRoot: '/parent', selectedRootIgnored: true });
  });

  it("requests one native inventory and keeps the native revision on file candidates", async () => {
    const directory = vi.fn(async (_root, input, runOptions) => {
      const records = [entry("src/app.ts", "sha256-app"), entry("src/deep/nested.ts", "sha256-nested")];
      await runOptions?.onRecords?.(records);
      return result(records);
    });
    const runtime = runtimeWith(directory);

    const files = await runtime.searchFilesystemFiles("/repo", { query: "", respectGitignore: true, includeRevisions: true });

    expect(directory).toHaveBeenCalledTimes(1);
    expect(directory.mock.calls[0]?.[1]).toMatchObject({
      operation: "list",
      lane: "background",
      includeTracked: true,
      respectGitignore: true,
    });
    expect(files.map((file) => [file.relativePath, file.revision])).toEqual([
      ["src/app.ts", "sha256-app"],
      ["src/deep/nested.ts", "sha256-nested"],
    ]);
    expect(files.enumerationStatus).toBe("complete");
  });

  it("projects lightweight metadata without requesting content revisions", async () => {
    const directory = vi.fn(async (_root, input, runOptions) => {
      const records = [{
        ...entry("src/app.ts", ""),
        data: { kind: "file", metadata: { byteLength: "128", modifiedTimeNs: "123456789" } },
      }];
      await runOptions?.onRecords?.(records);
      return result(records);
    });
    const runtime = runtimeWith(directory);

    const files = await runtime.searchFilesystemFiles("/repo", { query: "" });

    expect(directory.mock.calls[0]?.[1]).not.toHaveProperty("includeRevisions");
    expect(files).toMatchObject([{ relativePath: "src/app.ts", metadata: { byteLength: "128", modifiedTimeNs: "123456789" } }]);
    expect(files[0]?.revision).toBeUndefined();
  });

  it("does fuzzy ranking after native membership filtering", async () => {
    const directory = vi.fn(async (_root, _input, runOptions) => {
      const records = [entry("src/nest.ts"), entry("src/deep/nested.ts"), entry("unrelated.ts")];
      await runOptions?.onRecords?.(records);
      return result(records);
    });
    const runtime = runtimeWith(directory);

    const files = await runtime.searchFilesystemFiles("/repo", { query: "nested", limit: 1 });

    expect(files.map((file) => file.relativePath)).toEqual(["src/deep/nested.ts"]);
    expect(files.enumerationStatus).toBe("complete");
    expect(directory.mock.calls[0]?.[1]).toMatchObject({ lane: "foreground" });
  });

  it("keeps incomplete native traversal distinct from a successful empty inventory", async () => {
    const partial = runtimeWith(async () => result([], "partial"));
    const empty = runtimeWith(async () => result([], "empty"));

    expect((await partial.searchFilesystemFiles("/repo", { query: "" })).enumerationStatus).toBe("incomplete");
    expect((await empty.searchFilesystemFiles("/repo", { query: "" })).enumerationStatus).toBe("complete");
  });

  it("checks one exact path through the same native ignore/membership authority", async () => {
    const directory = vi.fn(async (_root, input, runOptions) => {
      const requested = input.files?.[0]?.path;
      const records = requested === "src/app.ts" ? [entry("src/app.ts")] : [];
      await runOptions?.onRecords?.(records);
      return result(records, records.length ? "ready" : "empty");
    });
    const runtime = runtimeWith(directory);

    await expect(runtime.isSearchableFile("/repo", "src/app.ts")).resolves.toBe(true);
    await expect(runtime.isSearchableFile("/repo", "ignored/generated.ts")).resolves.toBe(false);
    await expect(runtime.isSearchableFile("/repo", "../outside.ts")).resolves.toBe(false);
    expect(directory).toHaveBeenCalledTimes(2);
    expect(directory.mock.calls[0]?.[1]).toMatchObject({
      operation: "list",
      lane: "background",
      includeTracked: true,
      files: [{ path: "src/app.ts" }],
      paths: ["src/app.ts"],
    });
  });

  it("propagates cancellation/failure instead of returning an authoritative empty list", async () => {
    const failed = runtimeWith(async () => result([], "failed"));
    await expect(failed.searchFilesystemFiles("/repo", { query: "" })).rejects.toThrow(/enumeration failed/i);

    const controller = new AbortController();
    controller.abort();
    const cancelled = runtimeWith(async (_root, _input, options) => {
      options?.signal?.throwIfAborted();
      return result([], "cancelled");
    });
    await expect(cancelled.searchFilesystemFiles("/repo", { query: "", signal: controller.signal })).rejects.toThrow();
  });
});

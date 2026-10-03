import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  WorkspaceAPI,
  WorkspaceEntry,
  WorkspaceListResult,
  WorkspaceRootInfo,
} from "@varin/application-client";

const calls: Array<{ name: string; path?: string; payload?: unknown }> = [];

const makeEntry = (name: string, relativePath: string, type: WorkspaceEntry["type"] = "directory"): WorkspaceEntry => ({
  name,
  path: `/workspace/${relativePath}`.replace(/\/$/, ""),
  relativePath,
  type,
  size: 0,
  modifiedAt: "2026-05-03T00:00:00.000Z",
  mtimeMs: 1,
  ...(type === "directory" && !relativePath.includes("/") ? { isProject: true } : {}),
});

const rootInfo: WorkspaceRootInfo = {
  root: "/workspace",
  relativeRoot: "",
  exists: true,
  mtimeMs: 1,
  limits: { maxReadBytes: 2 * 1024 * 1024, maxUploadBytes: 100 * 1024 * 1024 },
  features: { lockdown: true, trash: true, customCommands: false },
  separator: "/",
};

const lists = new Map<string, WorkspaceListResult>();

const workspaceApi: WorkspaceAPI = {
  async getRoot() {
    calls.push({ name: "getRoot" });
    return rootInfo;
  },
  async list(path = "") {
    const normalized = path.replace(/^\/+|\/+$/g, "");
    calls.push({ name: "list", path: normalized });
    return lists.get(normalized) ?? { path: `/workspace/${normalized}`, relativePath: normalized, entries: [] };
  },
  async tree(path = "") {
    return this.list(path);
  },
  async entry(path) {
    return makeEntry(path.split("/").pop() || path, path);
  },
  async createFolder(path) {
    calls.push({ name: "createFolder", path });
    return { success: true, entry: makeEntry(path.split("/").pop() || path, path) };
  },
  async createFile(path) {
    calls.push({ name: "createFile", path });
    return { success: true, entry: makeEntry(path.split("/").pop() || path, path, "file") };
  },
  async move(from, to) {
    calls.push({ name: "move", payload: { from, to } });
    return { success: true, entry: makeEntry(to.split("/").pop() || to, to) };
  },
  async deleteEntry(path, options) {
    calls.push({ name: "deleteEntry", path, payload: options });
    return { success: true, trashed: options?.permanent ? false : true };
  },
  async upload(path) {
    calls.push({ name: "upload", path });
    return { success: true, entries: [] };
  },
  async download() {},
  async previewArchive(path) {
    calls.push({ name: "previewArchive", path });
    return {
      archive: makeEntry(path.split("/").pop() || path, path, "file"),
      format: "zip",
      entries: [{ path: "README.md", type: "file", size: 12 }],
      totalFiles: 1,
      totalDirectories: 0,
      totalBytes: 12,
      truncated: false,
    };
  },
  async extractArchive(request) {
    calls.push({ name: "extractArchive", path: request.path, payload: request });
    return {
      success: true,
      destination: request.destination,
      destinationEntry: makeEntry(request.destination.split("/").pop() || request.destination, request.destination),
      filesCreated: 1,
      directoriesCreated: 0,
      bytesWritten: 12,
      conflictsRenamed: 0,
      conflictsSkipped: 0,
      deletedArchive: request.deleteArchive === true,
    };
  },
  async openProject(path) {
    calls.push({ name: "openProject", path });
    return {
      success: true,
      project: { id: "project-demo", path: `/workspace/${path}`, label: path || "workspace" },
      settings: { projects: [{ id: "project-demo", path: `/workspace/${path}`, label: path || "workspace" }], activeProjectId: "project-demo" },
    };
  },
  async gitStatus(path) {
    calls.push({ name: "gitStatus", path });
    return { isGitRepository: false, files: [], current: "", tracking: null, ahead: 0, behind: 0, isClean: true };
  },
  async gitFetch(path) {
    calls.push({ name: "gitFetch", path });
    return { success: true };
  },
  async gitClone(path, options) {
    calls.push({ name: "gitClone", path, payload: options });
    return { success: true, directoryName: options.directoryName ?? null };
  },
  async gitPull(path) {
    calls.push({ name: "gitPull", path });
    return { success: true, summary: { changes: 0, insertions: 0, deletions: 0 }, files: [], insertions: 0, deletions: 0 };
  },
  async gitPush(path) {
    calls.push({ name: "gitPush", path });
    return { success: true, pushed: [], repo: path, ref: null };
  },
  async gitCheckout(path, branch) {
    calls.push({ name: "gitCheckout", path, payload: branch });
    return { success: true, branch };
  },
  async gitCommit(path, message, options) {
    calls.push({ name: "gitCommit", path, payload: { message, options } });
    return { success: true, commit: "abc123", branch: "main", summary: { changes: 0, insertions: 0, deletions: 0 } };
  },
  async gitLog() {
    return { all: [], latest: null, total: 0 };
  },
  async gitRemotes() {
    return [];
  },
};

vi.doMock("@/lib/workspaceApi", () => ({
  getWorkspaceAPI: () => workspaceApi,
}));

vi.doMock("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      synchronizeFromSettings: () => {},
    }),
  },
}));

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    calls.length = 0;
    lists.clear();
    lists.set("", {
      path: "/workspace",
      relativePath: "",
      entries: [makeEntry("demo", "demo")],
    });
    lists.set("demo", {
      path: "/workspace/demo",
      relativePath: "demo",
      entries: [makeEntry("src", "demo/src")],
    });
  });

  test("refreshes the parent directory after creating a folder", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    await useWorkspaceStore.getState().refreshWorkspace();
    calls.length = 0;
    await useWorkspaceStore.getState().createFolder("demo/new-folder");

    expect(calls.some((call) => call.name === "createFolder" && call.path === "demo/new-folder")).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "demo")).toBe(true);
  });

  test("stores terminal dialog cwd as workspacePath instead of an absolute path", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    useWorkspaceStore.getState().openTerminal("");
    expect({
      open: useWorkspaceStore.getState().terminalDialog.open,
      workspacePath: useWorkspaceStore.getState().terminalDialog.workspacePath,
      title: useWorkspaceStore.getState().terminalDialog.title,
    }).toEqual({
      open: true,
      workspacePath: "",
      title: "Terminal - /workspace",
    });

    useWorkspaceStore.getState().openTerminal("demo");
    expect({
      open: useWorkspaceStore.getState().terminalDialog.open,
      workspacePath: useWorkspaceStore.getState().terminalDialog.workspacePath,
      title: useWorkspaceStore.getState().terminalDialog.title,
    }).toEqual({
      open: true,
      workspacePath: "demo",
      title: "Terminal - /workspace/demo",
    });
  });

  test("drops stale child caches after deleting or moving entries", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    await useWorkspaceStore.getState().loadDirectory("demo");
    expect(useWorkspaceStore.getState().entriesByPath.demo).toHaveLength(1);

    await useWorkspaceStore.getState().deleteEntry("demo");
    expect(useWorkspaceStore.getState().entriesByPath.demo).toBe(undefined);

    await useWorkspaceStore.getState().loadDirectory("demo");
    await useWorkspaceStore.getState().moveEntry("demo/src", "renamed/src");
    expect(useWorkspaceStore.getState().entriesByPath["demo/src"]).toBe(undefined);
    expect(calls.some((call) => call.name === "list" && call.path === "demo")).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "renamed")).toBe(true);
  });

  test("renames an entry within its parent directory and refreshes that parent", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    const renamed = await useWorkspaceStore.getState().renameEntry("demo/src", "source");

    expect(renamed?.relativePath).toBe("demo/source");
    expect(calls.some((call) => (
      call.name === "move"
      && JSON.stringify(call.payload) === JSON.stringify({ from: "demo/src", to: "demo/source" })
    ))).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "demo")).toBe(true);
  });

  test("permanently deletes trash entries and refreshes the trash directory", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    const deleted = await useWorkspaceStore.getState().deleteEntry(".trash/123-demo", { permanent: true });

    expect(deleted).toBe(true);
    expect(calls.some((call) => (
      call.name === "deleteEntry"
      && call.path === ".trash/123-demo"
      && JSON.stringify(call.payload) === JSON.stringify({ permanent: true })
    ))).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === ".trash")).toBe(true);
  });

  test("extracts archives and refreshes affected directories", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    const preview = await useWorkspaceStore.getState().previewArchive("demo/archive.zip");
    expect(preview?.totalFiles).toBe(1);

    const result = await useWorkspaceStore.getState().extractArchive({
      path: "demo/archive.zip",
      destination: "demo/archive",
      mode: "new-folder",
      conflict: "rename",
    });

    expect(result?.destination).toBe("demo/archive");
    expect(calls.some((call) => call.name === "previewArchive" && call.path === "demo/archive.zip")).toBe(true);
    expect(calls.some((call) => call.name === "extractArchive" && call.path === "demo/archive.zip")).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "demo")).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "demo/archive")).toBe(true);
  });

  test("clones into the selected directory and refreshes that directory", async () => {
    const { useWorkspaceStore } = await import("./useWorkspaceStore");
    useWorkspaceStore.getState().resetForTests();

    const result = await useWorkspaceStore.getState().gitClone("demo", {
      url: "https://example.com/repo.git",
      branch: "main",
      directoryName: "repo",
    });

    expect(result?.success).toBe(true);
    expect(calls.some((call) => (
      call.name === "gitClone"
      && call.path === "demo"
      && JSON.stringify(call.payload) === JSON.stringify({
        url: "https://example.com/repo.git",
        branch: "main",
        directoryName: "repo",
      })
    ))).toBe(true);
    expect(calls.some((call) => call.name === "list" && call.path === "demo")).toBe(true);
  });
});

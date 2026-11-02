import { describe, expect, it, vi } from "vitest";
import { createGitStatusObserver } from "./git-status-runtime.js";

describe("Git status observer adapter", () => {
  it("resolves the containing Documents workspace before publishing", async () => {
    const observe = vi.fn();
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async (scope) => scope === "/workspace/repo" ? "workspace-1" : null,
      observe,
    });
    observer("/workspace/repo", { current: "main", files: [{ path: "a.ts" }] });
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", branch: "main", changed: 1, branchChanged: false, sampleId: expect.any(String), observedAt: expect.any(Number) }));

    observer("/outside", { current: "main", files: [] });
    observer("/workspace/repo", { isGitRepository: false, files: [] });
    await Promise.resolve();
    await observer.close();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("reports workspace-resolution failures without throwing into the route", async () => {
    const onError = vi.fn();
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async () => { throw new Error("registry unavailable"); },
      observe: vi.fn(),
      onError,
    });
    expect(() => observer("/workspace", { current: "main", files: [] })).not.toThrow();
    await observer.close();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "registry unavailable" }));
  });
  it("bounds pre-resolution work and closes the original samples before their sink is stopped", async () => {
    let release!: (workspace: string) => void;
    const held = new Promise<string>(resolve => { release = resolve; });
    const observe = vi.fn(), onError = vi.fn();
    const observer = createGitStatusObserver({resolveWorkspaceId: () => held, observe, onError});
    const before = Date.now();
    for (let index = 0; index < 1025; index += 1) observer("/workspace", {current: `branch-${index}`, files: []});
    let settled = false;
    const closing = observer.close().then(result => { settled = true; return result; });
    await Promise.resolve(); expect(settled).toBe(false); expect(observe).not.toHaveBeenCalled();
    release("workspace");
    const result = await closing;
    expect(observe).toHaveBeenCalledTimes(1024);
    expect(new Set(observe.mock.calls.map(([event]) => event.sampleId)).size).toBe(1024);
    expect(observe.mock.calls[0]![0].observedAt).toBeGreaterThanOrEqual(before);
    expect(result.gaps?.count).toBe(1); expect(onError).toHaveBeenCalledOnce();
  });

  it("freezes branch transitions and sample time before asynchronous root resolution", async () => {
    const resolves: Array<(workspace: string) => void> = [];
    const observe = vi.fn();
    const observer = createGitStatusObserver({
      resolveWorkspaceId: () => new Promise(resolve => { resolves.push(resolve); }), observe,
    });
    observer("/workspace", {current: "main", files: []});
    observer("/workspace", {current: "feature", files: []});
    await Promise.resolve();
    resolves[1]!("workspace"); await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    resolves[0]!("workspace"); await observer.close();
    expect(observe.mock.calls.map(([sample]) => [sample.branch, sample.branchChanged])).toEqual([["feature", true], ["main", false]]);
    expect(observe.mock.calls[0]![0].sampleId).not.toBe(observe.mock.calls[1]![0].sampleId);
  });

});

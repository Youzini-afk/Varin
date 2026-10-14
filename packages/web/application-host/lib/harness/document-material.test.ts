import { describe, expect, it, vi } from "vitest";
import type { FetchResult } from "@varin/protocol";
import { readDocumentMaterial } from "./document-material.js";
const result: FetchResult = { status: "ok", url: "file:///repo/paper.pdf", finalUrl: "file:///repo/paper.pdf", contentType: "application/pdf", markdown: "", bytes: 0, fromCache: false, rendered: false };
describe("original document material reader", () => {
  it("shared artifact reading waits for its actual page and iterator cleanup after cancellation", async () => {
    const controller = new AbortController();
    let pageReady!: () => void, pageEntered!: () => void, drained = false, settled = false;
    const held = new Promise<void>(resolve => { pageReady = resolve; });
    const entered = new Promise<void>(resolve => { pageEntered = resolve; });
    const ingest = vi.fn(async () => result);
    const reading = readDocumentMaterial({ ingest, read: vi.fn() }, { artifact: { attemptId: "attempt", artifactId: "artifact" } }, {
      workspaceId: "thread-materials:root", authority: { kind: "thread", owningWorkspaceId: "thread-materials:root", threadId: "thread" }, signal: controller.signal,
    }, { readArtifact: async () => ({ name: "plot.pdf", chunks: (async function* () {
      try { pageEntered(); await held; yield Buffer.from("%PDF-1.7\noriginal page"); }
      finally { drained = true; }
    })() }) }).catch(error => { settled = true; return error; });
    await entered;
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    pageReady();
    expect(await reading).toBe(controller.signal.reason);
    expect(drained).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("leaves an unresolved source error with its original runtime adapter instead of fabricating a material result", async () => {
    const failure = new Error("Original source reply is unavailable");
    const ingest = vi.fn(async () => result);
    await expect(readDocumentMaterial({ ingest, read: vi.fn() }, { path: "paper.pdf" }, {
      workspaceId: "thread-materials:root", authority: { kind: "thread", owningWorkspaceId: "thread-materials:root", threadId: "thread" },
    }, { readPath: async () => { throw failure; } })).rejects.toBe(failure);
    expect(ingest).not.toHaveBeenCalled();
  });
});

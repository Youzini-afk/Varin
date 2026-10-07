import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FetchResult, HarnessRequestData } from "@varin/protocol";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createDocumentReadTool } from "../../src/harness/document-read-tool.js";

const pageResult: FetchResult = {
  status: "ok", url: "file:///repo/paper.pdf", finalUrl: "file:///repo/paper.pdf", contentType: "application/pdf",
  markdown: "", bytes: 3, fromCache: false, rendered: false,
  snapshot: { snapshotId: "snap-current", sourceUrl: "file:///repo/paper.pdf", finalUrl: "file:///repo/paper.pdf", contentHash: "sha256-text", fetchedAt: 1, representation: "pdf-source-v1", byteLength: 0 },
  overview: { sourceHash: "sha256-original", sourceSnapshotId: "snap-old", pageCount: 8, textStatus: "not-requested" },
  pageImages: [{ page: 3, mimeType: "image/png", data: "cG5n", byteLength: 3, width: 200, height: 100, sourceHash: "sha256-original", region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } }],
};

describe("document_read tool", () => {
  it("keeps page arrays intact and maps the explicit all-pages flag at the Host boundary", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ sessionId: "s", emit: (_event, data) => { emitted.push(data); } });
    try {
      for (const [params, pages] of [[{ pages: [2, 3] }, [2, 3]], [{ all: true }, "all"]] as const) {
        const task = createDocumentReadTool(bridge).execute("read", { path: "paper.pdf", view: "text", ...params } as never, undefined, undefined, undefined as never);
        const request = emitted.at(-1)!;
        assert.deepEqual(request.params, { path: "paper.pdf", view: "text", pages });
        bridge.respond("s", request.requestId, { ok: true, result: pageResult });
        await task;
      }
      const conflict = await createDocumentReadTool(bridge).execute("read", { path: "paper.pdf", all: true, page: 2 } as never, undefined, undefined, undefined as never);
      assert.equal(conflict.isError, true);
      assert.equal(emitted.length, 2);
    } finally { bridge.dispose(); }
  });

  it("keeps long reads cancellable without a zero-ms timeout and delivers image pixels with a live reference", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ sessionId: "s", emit: (_event, data) => { emitted.push(data); } });
    try {
      const task = createDocumentReadTool(bridge).execute("read", { snapshot_id: "snap-current", view: "page-image", page: 3, region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } } as never, undefined, undefined, undefined as never);
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(emitted[0]?.method, "materials.read");
      assert.equal(emitted[0]?.timeoutMs, 0);
      bridge.respond("s", emitted[0]!.requestId, { ok: true, result: pageResult });
      const result = await task;
      assert.deepEqual(result.content.find((item) => item.type === "image"), { type: "image", data: "cG5n", mimeType: "image/png" });
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      assert.match(text, /varin-material:\/\/snap-current\?page=3/);
      assert.match(text, /sourceHash=sha256-original/);
      assert.doesNotMatch(text, /varin-material:\/\/snap-old/);
    } finally { bridge.dispose(); }
  });

  it("uses native text search on a saved material and returns location links without copying a full body", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({ sessionId: "s", emit: (_event, data) => { emitted.push(data); } });
    try {
      const task = createDocumentReadTool(bridge).execute("search", { snapshot_id: "snap-current", find: "learning rate" } as never, undefined, undefined, undefined as never);
      assert.deepEqual(emitted[0]?.params, { snapshotId: "snap-current", view: "text", pages: "all", find: "learning rate" });
      const { pageImages: _images, ...base } = pageResult;
      bridge.respond("s", emitted[0]!.requestId, { ok: true, result: { ...base, markdown: "whole document unrelated text", findHits: [{ page: 5, snippet: "learning rate is 0.01", start: 4, end: 17 }] } });
      const result = await task;
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      assert.match(text, /page=5/);
      assert.match(text, /learning rate is 0.01/);
      assert.doesNotMatch(text, /whole document unrelated text/);
    } finally { bridge.dispose(); }
  });
});

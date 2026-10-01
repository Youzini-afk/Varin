import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import type { HarnessRequestData } from "@varin/protocol";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createSurfaceAwareReadTool } from "../../src/harness/read-tool.js";

const context = undefined as never;

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (kind: string, body: Buffer): Buffer => {
  const type = Buffer.from(kind, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([length, type, body, checksum]);
};

const pixelPng = (): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([
    0, 255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

describe("surface-aware native read", () => {
  it('passes page bounds to the Host and renders continuation without full source bytes', async () => {
    const bridge = { request: async (method: string, params: { page: { offset: number; limit: number; maxBytes: number } }) => {
      assert.equal(method, 'document.readSource');
      assert.deepEqual(params.page, { offset: 10, limit: 2, maxBytes: 50 * 1024 });
      return { source: 'disk', revision: 'disk-page:v1', page: { kind: 'text', text: 'ten\neleven',
        startLine: 10, lineCount: 2, eof: false, nextOffset: 12, truncatedBy: 'lines' } };
    } } as unknown as HostServicesBridge;
    const result = await createSurfaceAwareReadTool(bridge, '/tmp').execute('page', { path: 'large.ts', offset: 10, limit: 2 }, undefined, undefined, context);
    assert.match((result.content[0] as { text: string }).text, /ten\neleven.*offset=12/s);
    assert.equal((result.details as { revision: string }).revision, 'disk-page:v1');
  });

  it("anchors a relative path at the session cwd for Host authorization", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-admission-"));
    const first = join(root, "first");
    await mkdir(first);
    await writeFile(join(first, "same.txt"), "first");
    const bridge = { request: async (_method: string, params: { path: string }) => {
      assert.equal(params.path, join(first, "same.txt"));
      return { source: "disk" as const, base64: Buffer.from("first").toString("base64") };
    } } as unknown as HostServicesBridge;
    try {
      const result = await createSurfaceAwareReadTool(bridge, first)
        .execute("call-frozen", { path: "same.txt" }, undefined, undefined, context);
      assert.equal((result.content[0] as { text: string }).text, "first");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reads the fixed surface bytes and preserves native offset/limit handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-tool-"));
    const file = join(root, "draft.ts");
    await writeFile(file, "current disk\n", "utf8");
    const emitted: HarnessRequestData[] = [];
    const bridge = {
      request: async (_method: "document.readSource", _params: { path: string }, options?: { signal?: AbortSignal }) => {
        assert.equal(options?.signal, undefined);
        return {
          base64: Buffer.from("fixed one\nfixed two\n", "utf8").toString("base64"),
          revision: "surface-draft:fixed",
          source: "surface-draft" as const,
        };
      },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute(
        "call-1",
        { path: file, offset: 2, limit: 1 },
        undefined,
        undefined,
        context,
      );
      assert.deepEqual(result.content, [{
        type: "text",
        text: "fixed two\n\n[1 more lines in file. Use offset=3 to continue.]",
      }]);
      assert.deepEqual(result.details, {
        revision: "surface-draft:fixed",
        source: "surface-draft",
      });
      assert.equal(emitted.length, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads a dirty-only file whose disk path does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-dirty-only-"));
    const bridge = {
      request: async () => ({
        base64: Buffer.from("unsaved new file\n", "utf8").toString("base64"),
        revision: "surface-draft:new",
        source: "surface-draft" as const,
      }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute("call-new", { path: "new.ts" }, undefined, undefined, context);
      assert.equal(result.content[0]?.type, "text");
      assert.equal((result.content[0] as { text: string }).text, "unsaved new file\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("passes the execution abort signal to the Host source lookup", async () => {
    let observedSignal: AbortSignal | undefined;
    const bridge = {
      request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        throw new Error("aborted");
      },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, "/tmp");
    const controller = new AbortController();
    await assert.rejects(
      tool.execute("call-2", { path: "draft.ts" }, controller.signal, undefined, context),
      /aborted/,
    );
    assert.equal(observedSignal, controller.signal);
  });

  it("reads working-branch bytes and reports provenance without touching disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-branch-"));
    await writeFile(join(root, "kept.txt"), "parent live\n", "utf8");
    const bridge = {
      request: async () => ({
        source: "working-branch" as const,
        revision: "working-branch:thread-1@0:base",
        provenance: { branchId: "thread-1", revision: 0, origin: "base" as const },
        base64: Buffer.from("fixed base\n", "utf8").toString("base64"),
      }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute("call-branch", { path: "kept.txt" }, undefined, undefined, context);
      assert.equal((result.content[0] as { text: string }).text, "fixed base\n");
      assert.deepEqual(result.details, {
        revision: "working-branch:thread-1@0:base",
        source: "working-branch",
        provenance: { branchId: "thread-1", revision: 0, origin: "base" },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps native offset and limit handling for authorized disk bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-disk-"));
    const file = join(root, "disk.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const bridge = {
      request: async () => ({ source: "disk" as const, base64: Buffer.from("one\ntwo\nthree\n").toString("base64") }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute(
        "call-3",
        { path: file, offset: 2, limit: 1 },
        undefined,
        undefined,
        context,
      );
      assert.deepEqual(result.content, [{
        type: "text",
        text: "two\n\n[2 more lines in file. Use offset=3 to continue.]",
      }]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not fall back to disk when the fixed surface source is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-unavailable-"));
    await writeFile(join(root, "draft.ts"), "must not leak\n", "utf8");
    const bridge = {
      request: async () => { throw new Error("fixed snapshot expired"); },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      await assert.rejects(
        tool.execute("call-unavailable", { path: "draft.ts" }, undefined, undefined, context),
        /fixed snapshot expired/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves native image processing for authorized disk bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-image-"));
    const file = join(root, "pixel.png");
    await writeFile(file, pixelPng());
    const bridge = {
      request: async () => ({ source: "disk" as const, revision: 'image-page:v1',
        page: { kind: 'image' as const, base64: await readFile(file).then((bytes) => bytes.toString("base64")) } }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute("call-image", { path: file }, undefined, undefined, context);
      assert.ok(result.content.some((part) => part.type === "image" && part.mimeType === "image/png"), JSON.stringify(result));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses Host bytes for a large text file while keeping native offsets and truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-read-host-large-"));
    const file = join(root, "large.txt");
    await writeFile(file, "local decoy\n", "utf8");
    const lines = Array.from({ length: 5_000 }, (_value, index) => `host-line-${index + 1}`);
    const bridge = {
      request: async () => ({ source: "disk" as const, base64: Buffer.from(lines.join("\n")).toString("base64") }),
    } as unknown as HostServicesBridge;
    try {
      const result = await createSurfaceAwareReadTool(bridge, root)
        .execute("call-large", { path: file, offset: 4_500, limit: 2 }, undefined, undefined, context);
      assert.equal((result.content[0] as { text: string }).text, "host-line-4500\nhost-line-4501\n\n[499 more lines in file. Use offset=4502 to continue.]");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

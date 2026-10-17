import { describe, expect, it } from "vitest";
import type { ThreadMaterialAuthority } from "./web-materials.js";
import { createMaterialCollections } from "./material-collections.js";
import { createMaterialStoreFixture as openStore } from "./web-materials.test-helper.js";

const authority = (threadId: string): ThreadMaterialAuthority => ({
  kind: "thread", owningWorkspaceId: "ws", threadId,
});

const draft = (finalUrl: string) => ({
  sourceUrl: finalUrl,
  finalUrl,
  contentType: "text/plain",
  representation: "raw-text",
});

describe("web material snapshots", () => {
  it("rejects unbound or session-only access before reading or storing material", async () => {
    const opened = openStore();
    const ref = await opened.materials.put("ws", draft("https://example.com/private"), Buffer.from("private"), authority("owner"));
    for (const invalid of [undefined, { owningWorkspaceId: "ws", sessionId: "owner" },
      { kind: "thread", owningWorkspaceId: "ws", threadId: "" }]) {
      await expect(opened.materials.read("ws", ref.snapshotId, invalid as never)).rejects.toThrow("admitted Thread");
      await expect(opened.materials.put("ws", draft("https://example.com/new"), Buffer.from("new"), invalid as never)).rejects.toThrow("admitted Thread");
    }
    expect(opened.records.size).toBe(1);
    expect(opened.objects.size).toBe(1);
  });

  it("pins fetched content and reads it back by snapshotId across reopen", async () => {
    const opened = openStore();
    const ref = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("page body"), authority("s1"));

    const found = await opened.materials.read("ws", ref.snapshotId, authority("s1"));
    expect(found?.ref).toEqual(ref);
    expect(found?.body.toString()).toBe("page body");

    // Durable records resolve again after a restart-equivalent reopen.
    const reopened = await opened.reopen().read("ws", ref.snapshotId, authority("s1"));
    expect(reopened?.body.toString()).toBe("page body");
    expect(await opened.materials.read("ws", "snap-missing", authority("s1"))).toBeNull();
    expect(await opened.materials.read("other-ws", ref.snapshotId, { ...authority("s1"), owningWorkspaceId: "other-ws" })).toBeNull();
  });

  it("keeps original PDF bytes beside the readable text and loads them on demand", async () => {
    const opened = openStore();
    const source = Buffer.from("%PDF-original-bytes");
    const ref = await opened.materials.put("ws", {
      ...draft("https://example.com/paper.pdf"),
      contentType: "application/pdf",
      document: { kind: "pdf", pageCount: 3, parser: "pdf-text-layout-v1" },
    }, Buffer.from("page one text\n\npage two text"), authority("s1"), {
      source: { bytes: source, contentType: "application/pdf" },
    });

    expect(ref.document?.kind).toBe("pdf");
    expect(ref.document?.pageCount).toBe(3);
    expect(ref.document?.source?.byteLength).toBe(source.byteLength);
    const withoutSource = await opened.materials.read("ws", ref.snapshotId, authority("s1"));
    expect(withoutSource?.source).toBeUndefined();
    const withSource = await opened.materials.read("ws", ref.snapshotId, authority("s1"), { includeSource: true });
    expect(withSource?.source?.contentType).toBe("application/pdf");
    expect(withSource?.source?.bytes).toEqual(source);
  });

  it("uses original PDF bytes as the retention key, not every source snapshot's empty text body", async () => {
    const opened = openStore();
    const firstOwner = authority("thread-a");
    const otherOwner = authority("thread-b");
    const firstBytes = Buffer.from("%PDF-first");
    const otherBytes = Buffer.from("%PDF-other");
    const first = await opened.materials.put("ws", {
      sourceUrl: "https://example.com/first.pdf", finalUrl: "https://example.com/first.pdf",
      contentType: "application/pdf", representation: "pdf-source-v1", document: { kind: "pdf", parser: "source" },
    }, Buffer.alloc(0), firstOwner, { source: { bytes: firstBytes, contentType: "application/pdf" } });
    const other = await opened.materials.put("ws", {
      sourceUrl: "https://example.com/other.pdf", finalUrl: "https://example.com/other.pdf",
      contentType: "application/pdf", representation: "pdf-source-v1", document: { kind: "pdf", parser: "source" },
    }, Buffer.alloc(0), otherOwner, { source: { bytes: otherBytes, contentType: "application/pdf" } });

    await opened.lifecycle.releaseThreadMaterials("ws", firstOwner.threadId);
    expect(await opened.materials.read("ws", first.snapshotId, firstOwner)).toBeNull();
    expect(await opened.materials.read("ws", other.snapshotId, otherOwner)).not.toBeNull();

    const retained = await opened.materials.put("ws", {
      sourceUrl: "https://example.com/derived.pdf", finalUrl: "https://example.com/derived.pdf",
      contentType: "application/pdf", representation: "pdf-native-analysis",
      document: { kind: "pdf", parser: "native", sourceSnapshotId: other.snapshotId,
        analysis: { id: "analysis", parser: "native", version: "v1", configHash: "config",
          toolVersions: { pdfjs: "4.10.38" }, sourceHash: other.document!.source!.contentHash,
          pages: [1], ocr: false, status: "ok" } },
    }, Buffer.from("parsed text"), authority("thread-b"),
    { source: { bytes: otherBytes, contentType: "application/pdf" } });
    const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials });
    const collectionId = (await collections.execute({ action: "create", persist: true }, { authority: otherOwner })).result.collection!.collectionId;
    await collections.execute({ action: "add", collectionId, member: { kind: "snapshot", snapshotId: retained.snapshotId } }, { authority: otherOwner });
    await opened.lifecycle.releaseThreadMaterials("ws", otherOwner.threadId);
    expect(await opened.materials.read("ws", other.snapshotId, otherOwner)).not.toBeNull();
    expect(await opened.materials.read("ws", retained.snapshotId, otherOwner)).not.toBeNull();
    expect((await opened.materials.findAnalysisConfig("ws", other.document!.source!.contentHash, "config",
      { pdfjs: "4.10.38" }, otherOwner, other.snapshotId))?.ref.snapshotId).toBe(retained.snapshotId);
    expect(await opened.materials.findAnalysisConfig("ws", other.document!.source!.contentHash, "config",
      { pdfjs: "5.0" }, otherOwner, other.snapshotId)).toBeNull();
    expect(await opened.materials.findAnalysisConfig("ws", other.document!.source!.contentHash, "config",
      { pdfjs: "4.10.38" }, firstOwner, other.snapshotId)).toBeNull();
  });

  it("dedupes identical content within one authority and keeps snapshots separate across threads", async () => {
    const opened = openStore();
    const owner = authority("thread-a");
    const first = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    const same = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    expect(same.snapshotId).toBe(first.snapshotId);

    const other = authority("thread-b");
    const separate = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), other);
    expect(separate.snapshotId).not.toBe(first.snapshotId);
    expect(await opened.materials.read("ws", separate.snapshotId, owner)).toBeNull();
    expect((await opened.materials.read("ws", separate.snapshotId, other))?.body.toString()).toBe("v1");

    const refreshed = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v2 changed"), owner, { forceNew: true });
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
    expect((await opened.materials.read("ws", first.snapshotId, owner))?.body.toString()).toBe("v1");
    expect((await opened.materials.read("ws", refreshed.snapshotId, owner))?.body.toString()).toBe("v2 changed");
  });

  it("keeps native Thread reads scoped and checks fixed revisions before reading bytes", async () => {
    let reads = 0;
    const opened = openStore({ beforeObjectRead: async () => { reads++; } });
    const ref = await opened.materials.put("ws", draft("https://example.com/thread"), Buffer.from("fixed body"), authority("thread-a"));
    const native = { kind: "thread" as const, owningWorkspaceId: "ws", threadId: "thread-a" };
    expect((await opened.materials.read("ws", ref.snapshotId, native, {
      byteRange: { offset: 6, length: 4 }, expectedContentHash: ref.contentHash,
    }))?.body.toString()).toBe("body");
    expect(await opened.materials.read("ws", ref.snapshotId, { ...native, threadId: "foreign" })).toBeNull();
    await expect(opened.materials.read("ws", ref.snapshotId, { ...native, owningWorkspaceId: "other" })).rejects.toThrow("authority");
    await expect(opened.materials.read("ws", ref.snapshotId, native, {
      expectedContentHash: `sha256-${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(opened.materials.read("ws", ref.snapshotId, native, {
      byteRange: { offset: 11, length: 1 },
    })).rejects.toMatchObject({ code: "invalid-range" });
    expect(reads).toBe(1);

    // Same length is insufficient evidence of the fixed content revision.
    opened.objects.set(ref.contentHash, Buffer.from("other body"));
    await expect(opened.materials.read("ws", ref.snapshotId, native)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("passes exact ranges and cancellation to the existing kernel blob owner", async () => {
    const controller = new AbortController();
    const calls: Array<{ hash: string; source: { recordId: string; slot: string }; options: unknown }> = [];
    const body = Buffer.from("a large fixed body");
    const opened = openStore({ client: { getBlob: async (hash, source, options) => {
      calls.push({ hash, source, options });
      const chunk = body.subarray(options!.offset!, options!.offset! + options!.length!);
      const nextOffset = options!.offset! + chunk.length;
      return { byteLength: body.length, bytesBase64: chunk.toString("base64"), nextOffset, eof: nextOffset === body.length };
    } } });
    const ref = await opened.materials.put("ws", draft("https://example.com/range"), body, authority("thread"));
    const found = await opened.materials.read("ws", ref.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "thread",
    }, { byteRange: { offset: 8, length: 5 }, signal: controller.signal });
    expect(found?.body.toString()).toBe("fixed");
    expect(calls).toEqual([{ hash: ref.contentHash, source: { recordId: `web.snapshot:${ref.snapshotId}`, slot: "body" },
      options: { offset: 8, length: 5, signal: controller.signal } }]);
  });

  it("pages retained source and body bytes under the same record proof and rejects incomplete pages", async () => {
    const body = Buffer.alloc(512 * 1024 + 19, "body");
    const source = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(512 * 1024, 23)]);
    const reads: Array<{ slot: string; recordId: string; offset: number; length: number }> = [];
    let truncate = false;
    const opened = openStore({ client: { getBlob: async (hash, proof, range) => {
      const bytes = opened.objects.get(hash)!;
      const offset = range!.offset!, length = range!.length!;
      expect(length).toBeLessThanOrEqual(256 * 1024);
      reads.push({ ...proof, offset, length });
      const chunk = bytes.subarray(offset, offset + length - (truncate ? 1 : 0));
      const nextOffset = offset + chunk.length;
      return { byteLength: bytes.length, bytesBase64: chunk.toString("base64"), nextOffset, eof: nextOffset === bytes.length };
    } } });
    const ref = await opened.materials.put("ws", { ...draft("file:///paper.pdf"), document: { kind: "pdf", parser: "source" } }, body,
      authority("thread"), { source: { bytes: source, contentType: "application/pdf" } });
    const found = await opened.materials.read("ws", ref.snapshotId, authority("thread"), { includeSource: true });
    expect(found?.body).toEqual(body);
    expect(found?.source?.bytes).toEqual(source);
    expect(reads.map(read => [read.slot, read.offset])).toEqual([
      ["body", 0], ["body", 256 * 1024], ["body", 512 * 1024],
      ["source", 0], ["source", 256 * 1024], ["source", 512 * 1024],
    ]);
    expect(reads.every(read => read.recordId === `web.snapshot:${ref.snapshotId}`)).toBe(true);
    truncate = true;
    await expect(opened.materials.read("ws", ref.snapshotId, authority("thread"))).rejects.toMatchObject({ code: "corrupt" });
  });

  it("waits for an in-flight retained source page on cancellation and reads no later page", async () => {
    const controller = new AbortController();
    let enter!: () => void, finish!: () => void, settled = false;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const source = Buffer.alloc(768 * 1024, 29);
    const sourceOffsets: number[] = [];
    const opened = openStore({ client: { getBlob: async (hash, proof, range) => {
      const bytes = opened.objects.get(hash)!;
      if (proof.slot === "source") {
        sourceOffsets.push(range!.offset!);
        expect(range!.signal).toBe(controller.signal);
        if (range!.offset === 256 * 1024) { enter(); await held; }
      }
      const chunk = bytes.subarray(range!.offset!, range!.offset! + range!.length!);
      const nextOffset = range!.offset! + chunk.length;
      return { byteLength: bytes.length, bytesBase64: chunk.toString("base64"), nextOffset, eof: nextOffset === bytes.length };
    } } });
    const ref = await opened.materials.put("ws", { ...draft("file:///paper.pdf"), document: { kind: "pdf", parser: "source" } }, Buffer.alloc(0),
      authority("thread"), { source: { bytes: source, contentType: "application/pdf" } });
    const reading = opened.materials.read("ws", ref.snapshotId, authority("thread"), { includeSource: true, signal: controller.signal })
      .catch(error => { settled = true; return error; });
    await entered;
    controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await reading).toBe(controller.signal.reason);
    expect(sourceOffsets).toEqual([0, 256 * 1024]);
  });

  it("retains explicitly pinned material while releasing an owner's unreferenced snapshots", async () => {
    const opened = openStore();
    const owner = authority("thread-a"), receiver = authority("thread-b");
    const cited = await opened.materials.put("ws", draft("https://example.com/cited"), Buffer.from("cited body"), owner);
    const uncited = await opened.materials.put("ws", draft("https://example.com/uncited"), Buffer.from("dropped"), owner);
    const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials });
    await collections.execute({ action: "share", snapshotId: cited.snapshotId, targetThreadId: receiver.threadId },
      { authority: owner, threadsRelated: async () => true });
    const collectionId = (await collections.execute({ action: "create", persist: true }, { authority: receiver })).result.collection!.collectionId;
    await collections.execute({ action: "add", collectionId, member: { kind: "snapshot", snapshotId: cited.snapshotId } }, { authority: receiver });
    await opened.lifecycle.releaseThreadMaterials("ws", owner.threadId);
    expect((await opened.reopen().read("ws", cited.snapshotId, authority("thread-c")))?.body.toString()).toBe("cited body");
    expect(await opened.materials.read("ws", uncited.snapshotId, owner)).toBeNull();
  });

  it("keeps snapshots across reopened Thread callers until their exact original owner releases them", async () => {
    const opened = openStore();
    const owner = authority("thread-a"), sibling = authority("thread-ab");
    const ref = await opened.materials.put("ws", draft("https://example.com/retained"), Buffer.from("retained body"), owner);
    const other = await opened.materials.put("ws", draft("https://example.com/sibling"), Buffer.from("sibling body"), sibling);
    expect((await opened.reopen().read("ws", ref.snapshotId, authority("thread-a")))?.body.toString()).toBe("retained body");
    await opened.lifecycle.releaseThreadMaterials("ws", owner.threadId);
    expect(await opened.materials.read("ws", ref.snapshotId, owner)).toBeNull();
    expect((await opened.materials.read("ws", other.snapshotId, sibling))?.body.toString()).toBe("sibling body");
  });
});

import { describe, expect, it } from "vitest";
import type { RetrievalArtifactRef, RetrievalEvidence, RetrievalReceiptAuthority, Thread } from "@varin/protocol";
import { createMaterialStoreFixture as openStore } from "./web-materials.test-helper.js";

const authority = (sessionId: string, threadId?: string, runId?: string): RetrievalReceiptAuthority => ({
  owningWorkspaceId: "ws",
  sessionId,
  ...(threadId ? { threadId } : {}),
  ...(runId ? { runId } : {}),
});

const draft = (finalUrl: string) => ({
  sourceUrl: finalUrl,
  finalUrl,
  contentType: "text/plain",
  representation: "raw-text",
});

const retrievalThread = (id: string, lifecycle: "active" | "settled", activeRunId: string | null): Thread => ({
  id,
  workspaceId: "ws",
  lifecycle,
  activeRunId,
  report: null,
} as never);

const evidenceFor = (artifact: RetrievalArtifactRef): RetrievalEvidence => ({
  question: "fact",
  scope: [],
  facts: [{
    claim: "cited body",
    status: "source-checked",
    sources: [{ kind: "output" as const, check: "source-valid" as const, artifact }],
  }],
  unknowns: [],
  attempted: [],
  completion: "delivered",
});

describe("web material snapshots", () => {
  it("pins fetched content and reads it back by snapshotId across reopen", async () => {
    const opened = openStore();
    const ref = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("page body"), authority("s1"));

    const found = await opened.materials.read("ws", ref.snapshotId);
    expect(found?.ref).toEqual(ref);
    expect(found?.body.toString()).toBe("page body");

    // Durable records resolve again after a restart-equivalent reopen.
    const reopened = await opened.reopen().read("ws", ref.snapshotId);
    expect(reopened?.body.toString()).toBe("page body");
    expect(await opened.materials.read("ws", "snap-missing")).toBeNull();
    expect(await opened.materials.read("other-ws", ref.snapshotId)).toBeNull();
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
    const firstOwner = authority("session-a", "thread-a", "run-a");
    const otherOwner = authority("session-b", "thread-b", "run-b");
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

    await opened.retrieval.releaseTemporaryArtifacts("ws", firstOwner);
    expect(await opened.materials.read("ws", first.snapshotId)).toBeNull();
    expect(await opened.materials.read("ws", other.snapshotId, otherOwner)).not.toBeNull();

    const retained = await opened.materials.put("ws", {
      sourceUrl: "https://example.com/derived.pdf", finalUrl: "https://example.com/derived.pdf",
      contentType: "application/pdf", representation: "pdf-native-analysis",
      document: { kind: "pdf", parser: "native", sourceSnapshotId: other.snapshotId,
        analysis: { id: "analysis", parser: "native", version: "v1", configHash: "config",
          toolVersions: { pdfjs: "4.10.38" }, sourceHash: other.document!.source!.contentHash,
          pages: [1], ocr: false, status: "ok" } },
    }, Buffer.from("parsed text"), authority("session-b", "thread-b", "run-next"),
    { source: { bytes: otherBytes, contentType: "application/pdf" } });
    await opened.retrieval.releaseTemporaryArtifacts("ws", otherOwner);
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
    const owner = authority("s1", "thread-a", "run-a");
    const first = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    const same = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), owner);
    expect(same.snapshotId).toBe(first.snapshotId);

    const other = authority("s2", "thread-b", "run-b");
    const separate = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v1"), other);
    expect(separate.snapshotId).not.toBe(first.snapshotId);
    expect(await opened.materials.read("ws", separate.snapshotId, owner)).toBeNull();
    expect((await opened.materials.read("ws", separate.snapshotId, other))?.body.toString()).toBe("v1");

    const refreshed = await opened.materials.put("ws", draft("https://example.com/a"), Buffer.from("v2 changed"), owner, { forceNew: true });
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
    expect((await opened.materials.read("ws", first.snapshotId))?.body.toString()).toBe("v1");
    expect((await opened.materials.read("ws", refreshed.snapshotId))?.body.toString()).toBe("v2 changed");
  });

  it("keeps native Thread reads scoped and checks fixed revisions before reading bytes", async () => {
    let reads = 0;
    const opened = openStore({ beforeObjectRead: async () => { reads++; } });
    const ref = await opened.materials.put("ws", draft("https://example.com/thread"), Buffer.from("fixed body"), authority("pi", "thread-a"));
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
      return { byteLength: body.length, bytesBase64: body.subarray(options!.offset!, options!.offset! + options!.length!).toString("base64") };
    } } });
    const ref = await opened.materials.put("ws", draft("https://example.com/range"), body, authority("pi", "thread"));
    const found = await opened.materials.read("ws", ref.snapshotId, {
      kind: "thread", owningWorkspaceId: "ws", threadId: "thread",
    }, { byteRange: { offset: 8, length: 5 }, signal: controller.signal });
    expect(found?.body.toString()).toBe("fixed");
    expect(calls).toEqual([{ hash: ref.contentHash, source: { recordId: `web.snapshot:${ref.snapshotId}`, slot: "body" },
      options: { offset: 8, length: 5, signal: controller.signal } }]);
  });

  it("keeps a snapshot whose body is cited by another run while releasing unreferenced ones", async () => {
    const opened = openStore();
    const owner = authority("session-a", "thread-a", "run-a");
    const sharedBody = Buffer.from("shared body");
    const cited = await opened.materials.put("ws", draft("https://example.com/cited"), sharedBody, owner);
    const uncited = await opened.materials.put("ws", draft("https://example.com/uncited"), Buffer.from("dropped"), owner);

    // A different run mints its own receipt over the same body bytes.
    const other = authority("session-b", "thread-b", "run-b");
    const otherArtifact = await opened.retrieval.storeArtifact("ws", sharedBody, other);
    expect(otherArtifact.hash).toBe(cited.contentHash);

    await opened.retrieval.releaseTemporaryArtifacts("ws", owner);

    expect(await opened.materials.read("ws", cited.snapshotId)).not.toBeNull();
    expect(await opened.materials.read("ws", uncited.snapshotId)).toBeNull();
  });

  it("keeps a snapshot cited by promoted evidence when its run settles", async () => {
    const opened = openStore();
    const owner = authority("session-a", "thread-a", "run-a");
    const ref = await opened.materials.put("ws", draft("https://example.com/cited"), Buffer.from("cited body"), owner);
    const artifactRef: RetrievalArtifactRef = {
      durability: "durable",
      hash: ref.contentHash,
      byteLength: ref.byteLength,
      recordId: `web.snapshot:${ref.snapshotId}`,
      recordType: "web.snapshot" as never,
      workspaceId: "ws",
      sessionId: owner.sessionId,
      ...(owner.threadId ? { threadId: owner.threadId } : {}),
      ...(owner.runId ? { runId: owner.runId } : {}),
    };
    await opened.retrieval.promotePendingEvidence({
      workspaceId: "ws",
      threadId: "thread-a",
      runId: "run-a",
      evidence: evidenceFor(artifactRef),
      receiptAuthority: owner,
    });

    expect(await opened.materials.read("ws", ref.snapshotId)).not.toBeNull();
    expect(opened.records.get(`retrieval-evidence:pending:thread-a:run-a`)?.references.map((r) => r.objectHash)).toEqual([ref.contentHash]);
  });

  it("releases session-scoped snapshots on authority release and orphans on reconcile", async () => {
    const opened = openStore();
    const sessionRef = await opened.materials.put("ws", draft("https://example.com/session"), Buffer.from("session body"), authority("s1"));
    const runRef = await opened.materials.put("ws", draft("https://example.com/run"), Buffer.from("run body"), authority("s2", "thread-gone", "run-gone"));
    const liveRef = await opened.materials.put("ws", draft("https://example.com/live"), Buffer.from("live body"), authority("s3", "thread-live", "run-live"));

    await opened.retrieval.releaseReceiptAuthority("ws", authority("s1"));
    expect(await opened.materials.read("ws", sessionRef.snapshotId)).toBeNull();

    await opened.retrieval.reconcileWorkspaceEvidence("ws", [retrievalThread("thread-live", "active", "run-live")]);
    expect(await opened.materials.read("ws", runRef.snapshotId)).toBeNull();
    expect((await opened.materials.read("ws", liveRef.snapshotId))?.body.toString()).toBe("live body");
  });

  it("keeps a thread snapshot across Run reconciliation and releases it when the thread disappears", async () => {
    const opened = openStore();
    const ref = await opened.materials.put(
      "ws",
      draft("https://example.com/thread-retained"),
      Buffer.from("retained body"),
      authority("session-a", "thread-a", "run-a"),
    );

    await opened.retrieval.syncThreadEvidence("ws", retrievalThread("thread-a", "active", "run-b"));
    expect((await opened.materials.read("ws", ref.snapshotId, authority("session-new", "thread-a", "run-b")))?.body.toString())
      .toBe("retained body");

    await opened.retrieval.reconcileWorkspaceEvidence("ws", [retrievalThread("thread-a", "active", "run-b")]);
    expect(await opened.materials.read("ws", ref.snapshotId, authority("session-new", "thread-a", "run-b"))).not.toBeNull();

    await opened.retrieval.reconcileWorkspaceEvidence("ws", []);
    expect(await opened.materials.read("ws", ref.snapshotId)).toBeNull();
  });
});

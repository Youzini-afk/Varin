import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RetrievalReceiptAuthority, WebSnapshotRef } from "@varin/protocol";
import { createDocumentReader } from "./document-reading.js";
import type { WebSnapshotDraft, WebMaterialStore } from "./web-materials.js";
import type { createPdfEngine } from "./pdf-engine.js";

const hash = (bytes: Buffer): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const authority = (sessionId: string): RetrievalReceiptAuthority => ({ owningWorkspaceId: "ws", sessionId });

const fixture = (failText = false) => {
  const entries = new Map<string, { ref: WebSnapshotRef; body: Buffer; source?: Buffer; sessionId: string }>();
  let serial = 0;
  const materials = {
    put: vi.fn(async (_workspaceId: string, draft: WebSnapshotDraft, body: Buffer, owner: RetrievalReceiptAuthority,
      options: { forceNew?: boolean; source?: { bytes: Buffer; contentType: string } } = {}) => {
      const sourceHash = options.source && hash(options.source.bytes);
      const prior = !options.forceNew && [...entries.values()].find((entry) => entry.sessionId === owner.sessionId
        && entry.ref.sourceUrl === draft.sourceUrl && entry.ref.representation === draft.representation
        && entry.ref.contentHash === hash(body) && entry.ref.document?.source?.contentHash === sourceHash
        && entry.ref.document?.analysis?.id === draft.document?.analysis?.id);
      if (prior) return prior.ref;
      const ref: WebSnapshotRef = {
        snapshotId: `snap-${++serial}`, sourceUrl: draft.sourceUrl, finalUrl: draft.finalUrl,
        contentHash: hash(body), byteLength: body.byteLength, fetchedAt: serial,
        representation: draft.representation, ...(draft.contentType ? { contentType: draft.contentType } : {}),
        ...(draft.structure ? { structure: draft.structure } : {}),
        ...(draft.document ? { document: { ...draft.document,
          ...(options.source ? { source: { contentHash: sourceHash!, byteLength: options.source.bytes.byteLength,
            contentType: options.source.contentType } } : {}) } } : {}),
      };
      entries.set(ref.snapshotId, { ref, body: Buffer.from(body), ...(options.source ? { source: Buffer.from(options.source.bytes) } : {}), sessionId: owner.sessionId });
      return ref;
    }),
    read: vi.fn(async (_workspaceId: string, snapshotId: string, owner: RetrievalReceiptAuthority, options?: { includeSource?: boolean }) => {
      const entry = entries.get(snapshotId);
      return entry && entry.sessionId === owner.sessionId
        ? { ref: entry.ref, body: Buffer.from(entry.body), ...(options?.includeSource && entry.source
          ? { source: { bytes: Buffer.from(entry.source), contentType: "application/pdf" } } : {}) }
        : null;
    }),
    findAnalysis: vi.fn(async (_workspaceId: string, sourceHash: string, analysisId: string,
      owner: RetrievalReceiptAuthority, sourceSnapshotId?: string) => {
      const entry = [...entries.values()].find((item) => item.sessionId === owner.sessionId
        && item.ref.document?.source?.contentHash === sourceHash
        && item.ref.document.analysis?.id === analysisId
        && item.ref.document.sourceSnapshotId === sourceSnapshotId);
      return entry ? { ref: entry.ref, body: Buffer.from(entry.body) } : null;
    }),
    findAnalysisConfig: vi.fn(async (_workspaceId: string, sourceHash: string, configHash: string,
      toolVersions: unknown, owner: RetrievalReceiptAuthority, sourceSnapshotId: string) => {
      const entry = [...entries.values()].find((item) => item.sessionId === owner.sessionId
        && item.ref.document?.source?.contentHash === sourceHash
        && item.ref.document.analysis?.configHash === configHash
        && JSON.stringify(item.ref.document.analysis.toolVersions) === JSON.stringify(toolVersions)
        && item.ref.document.sourceSnapshotId === sourceSnapshotId);
      return entry ? { ref: entry.ref, body: Buffer.from(entry.body) } : null;
    }),
  };
  const probe = vi.fn(async () => ({ pageCount: 2, pages: [
    { page: 1, width: 100, height: 200, rotation: 0 },
    { page: 2, width: 100, height: 200, rotation: 0 },
  ], parser: "pdfjs" as const, parserVersion: "4.10.38" }));
  const extractPage = vi.fn(async ({ page }: { page: number }) => {
    if (failText) throw new Error("text extraction failed");
    return { page, width: 100, height: 200, rotation: 0, text: `native page ${page}`,
      parser: "pdfjs", parserVersion: "4.10.38",
      lines: [{ text: `native page ${page}`, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
        segments: [], readingIndex: 0 }] };
  });
  const extractPages = vi.fn(async ({ pages }: { pages: number[] }) => Promise.all(pages.map((page) => extractPage({ page }))));
  const renderPage = vi.fn(async ({ page }: { page: number; signal?: AbortSignal }) => ({ data: Buffer.from(`png-${page}`), mimeType: "image/png" as const,
    width: 200, height: 400, pageWidth: 100, pageHeight: 200, parser: "pdfjs", parserVersion: "4.10.38" }));
  const ocrPage = vi.fn(async ({ page }: { page: number }) => ({ status: "ok" as const, text: `OCR page ${page}`,
    engine: "tesseract", engineVersion: "5.0", lines: [{ text: `OCR page ${page}`,
      region: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 }, segments: [], readingIndex: 0 }] }));
  const engine = { identity: "fixture-engine", probe, extractPage, extractPages, renderPage, ocrPage,
    versions: vi.fn(async ({ parser, ocr }: { parser?: "native" | "docling"; ocr?: boolean }) => ({ pdfjs: "4.10.38",
      ...(parser === "docling" ? { docling: "2.130.0" } : ocr ? { tesseract: "5.0" } : {}) })),
    parseStructure: vi.fn(async (_input: unknown) => ({ status: "unavailable" as const, reason: "not configured" })) };
  const reader = createDocumentReader({ materials: materials as unknown as WebMaterialStore,
    engineFactory: (() => engine) as unknown as typeof createPdfEngine });
  const source = Buffer.from("%PDF-fixed-original");
  const ctx = (sessionId = "owner", signal?: AbortSignal) => ({ workspaceId: "ws", authority: authority(sessionId), ...(signal ? { signal } : {}) });
  return { reader, materials, engine, source, ctx, entries };
};

describe("independent document reading", () => {
  it("pins original bytes before parsing; text failure still leaves page rendering available", async () => {
    const f = fixture(true);
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/paper.pdf" }, f.ctx());
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;
    const sourceId = opened.snapshot!.snapshotId;
    expect(opened.snapshot?.representation).toBe("pdf-source-v1");
    expect(opened.overview?.sourceHash).toBe(hash(f.source));
    expect(f.engine.extractPage).not.toHaveBeenCalled();

    const text = await f.reader.read({ snapshotId: sourceId, view: "text" }, f.ctx());
    expect(text.status).toBe("ok");
    if (text.status === "ok") expect(text.overview?.textStatus).toBe("unavailable");
    const page = await f.reader.read({ snapshotId: sourceId, view: "page-image", page: 2 }, f.ctx());
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect(page.pageImage).toMatchObject({ page: 2, sourceHash: hash(f.source),
      data: Buffer.from("png-2").toString("base64") });
  });

  it("can render a page after a separate overview probe fails", async () => {
    const f = fixture();
    f.engine.probe.mockRejectedValue(new Error("probe failed"));
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/probe.pdf" }, f.ctx());
    expect(opened.status).toBe("ok");
    if (opened.status !== "ok") return;
    expect(opened.snapshot?.document?.source?.contentHash).toBe(hash(f.source));
    const image = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "page-image", page: 1 }, f.ctx());
    expect(image.status).toBe("ok");
    expect(f.engine.renderPage).toHaveBeenCalledTimes(1);
  });

  it("derives selected pages and OCR from a snapshot without downloading; old analysis stays fixed", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "file:///workspace/paper.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const sourceId = opened.snapshot!.snapshotId;
    const native = await f.reader.read({ snapshotId: sourceId, view: "text", pages: [2] }, f.ctx());
    expect(native.status).toBe("ok");
    if (native.status !== "ok") return;
    expect(native.markdown).toBe("native page 2");
    expect(native.analysis?.pages).toEqual([2]);
    expect(f.engine.extractPage).toHaveBeenCalledTimes(1);

    const ocr = await f.reader.read({ snapshotId: sourceId, view: "text", pages: [2], ocr: true, find: "OCR" }, f.ctx());
    expect(ocr.status).toBe("ok");
    if (ocr.status === "ok") {
      expect(ocr.markdown).toBe("OCR page 2");
      expect(ocr.ocr?.pages).toEqual([2]);
      expect(ocr.analysis?.id).not.toBe(native.analysis?.id);
      expect(ocr.findHits?.[0]?.region).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.1 });
    }
    expect(f.engine.ocrPage).toHaveBeenCalledTimes(1);
    const pinned = await f.reader.read({ snapshotId: native.snapshot!.snapshotId, view: "text" }, f.ctx());
    expect(pinned.status === "ok" && pinned.markdown).toBe("native page 2");
    const overview = await f.reader.read({ snapshotId: native.snapshot!.snapshotId, view: "overview" }, f.ctx());
    expect(overview.status === "ok" && overview.markdown).toBe("");
    const image = await f.reader.read({ snapshotId: native.snapshot!.snapshotId, view: "page-image", page: 2 }, f.ctx());
    expect(image.status === "ok" && image.markdown).toBe("native page 2");
    expect(f.engine.extractPages).toHaveBeenCalledTimes(1);
    expect(f.engine.extractPage).toHaveBeenCalledTimes(1); // fixture's batch delegates one selected page
  });

  it("extracts a full native text request in one engine batch", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/full.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const result = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "text" }, f.ctx());
    expect(result.status === "ok" && result.markdown).toBe("native page 1\n\nnative page 2");
    expect(f.engine.extractPages).toHaveBeenCalledTimes(1);
    expect(f.engine.extractPages).toHaveBeenCalledWith(expect.objectContaining({ pages: [1, 2] }));
  });

  it("expands a partial snapshot only when pages: all is explicit", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/search.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const partial = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "text", pages: [2] }, f.ctx());
    if (partial.status !== "ok") throw new Error("partial text unavailable");
    const fixed = await f.reader.read({ snapshotId: partial.snapshot!.snapshotId, view: "text", find: "native page 1" }, f.ctx());
    expect(fixed.status === "ok" && fixed.findHits).toEqual([]);
    const full = await f.reader.read({ snapshotId: partial.snapshot!.snapshotId, view: "text", pages: "all", find: "native page 1" }, f.ctx());
    expect(full.status === "ok" && full.markdown).toContain("native page 1");
    if (full.status === "ok") expect(full.findHits?.[0]?.page).toBe(1);
    expect(full.status === "ok" && full.snapshot?.snapshotId).not.toBe(partial.snapshot?.snapshotId);
    const before = f.engine.extractPages.mock.calls.length;
    const same = await f.reader.read({ snapshotId: full.status === "ok" ? full.snapshot!.snapshotId : "", view: "text", pages: "all" }, f.ctx());
    expect(same.status === "ok" && same.snapshot?.snapshotId).toBe(full.status === "ok" ? full.snapshot?.snapshotId : undefined);
    expect(f.engine.extractPages.mock.calls.length).toBe(before);
  });

  it("checks authority before rendering or sharing work", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/paper.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const denied = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "page-image", page: 1 }, f.ctx("other"));
    expect(denied).toEqual({ status: "snapshot-missing", snapshotId: opened.snapshot!.snapshotId });
    expect(f.engine.renderPage).not.toHaveBeenCalled();
    f.materials.read.mockRejectedValueOnce(new Error("kernel connection failed"));
    await expect(f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "overview" }, f.ctx()))
      .rejects.toThrow("kernel connection failed");
  });

  it("reports unavailable Docling structure without presenting native text as Docling output", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/structure.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const result = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "structure" }, f.ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.analysis).toMatchObject({ parser: "docling", status: "unavailable" });
    expect(result.markdown).toBe("");
    expect(result.snapshot?.snapshotId).toBe(opened.snapshot?.snapshotId);
    expect(f.engine.extractPage).not.toHaveBeenCalled();
  });

  it("does not mistake a native text snapshot for a Docling structure snapshot", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/native.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const native = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "text" }, f.ctx());
    if (native.status !== "ok") throw new Error("native text unavailable");
    const structure = await f.reader.read({ snapshotId: native.snapshot!.snapshotId, view: "structure" }, f.ctx());
    expect(structure.status).toBe("ok");
    if (structure.status !== "ok") return;
    expect(structure.analysis).toMatchObject({ parser: "docling", status: "unavailable" });
    expect(structure.markdown).toBe("");
    expect(f.engine.parseStructure).toHaveBeenCalledTimes(1);
  });

  it("reports a successful empty text layer without labelling extraction as failed", async () => {
    const f = fixture();
    f.engine.extractPage.mockResolvedValue({ page: 1, width: 100, height: 200, rotation: 0,
      text: "", lines: [], parser: "pdfjs", parserVersion: "4.10.38" });
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/scanned.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const result = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "text", pages: [1] }, f.ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.overview?.textStatus).toBe("unavailable");
      expect(result.analysis?.failedPages).toBeUndefined();
    }
  });

  it("uses Docling body order and true element line anchors across one continuous page range", async () => {
    const f = fixture();
    f.engine.parseStructure.mockResolvedValue({
      status: "ok", parser: "docling", parserVersion: "2.130.0", schemaVersion: "1.10.0",
      text: "Opening paragraph\nSection on page two\nA\tB",
      blocks: [
        { id: "p1", kind: "paragraph", page: 1, text: "Opening paragraph", startLine: 1, endLine: 1,
          regions: [{ page: 1, region: { x: 0.1, y: 0.1, width: 0.7, height: 0.1 } }] },
        { id: "h2", kind: "section", page: 2, text: "Section on page two", startLine: 2, endLine: 2,
          regions: [{ page: 2, region: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 } }] },
        { id: "t2", kind: "table", page: 2, text: "A\tB", startLine: 3, endLine: 3,
          regions: [{ page: 2, region: { x: 0.2, y: 0.4, width: 0.5, height: 0.2 } }] },
      ],
      elements: [
        { id: "h2", kind: "section", page: 2, text: "Section on page two", level: 2,
          startLine: 2, endLine: 2, captions: [],
          regions: [{ page: 2, region: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 } }] },
        { id: "t2", kind: "table", page: 2, text: "A\tB", startLine: 3, endLine: 3, captions: [],
          regions: [{ page: 2, region: { x: 0.2, y: 0.4, width: 0.5, height: 0.2 } }],
          cells: [{ text: "A", row: 0, column: 0, columnHeader: true,
            regions: [{ page: 2, region: { x: 0.2, y: 0.4, width: 0.2, height: 0.1 } }] },
          { text: "B", row: 0, column: 1,
            regions: [{ page: 2, region: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } }] }] },
        { id: "f2", kind: "figure", page: 2, captions: [{ id: "cap", text: "Figure caption", regions: [] }],
          regions: [{ page: 2, region: { x: 0.2, y: 0.7, width: 0.5, height: 0.2 } }] },
      ],
    } as never);
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/doc.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const result = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "structure" }, f.ctx());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.markdown).toBe("Opening paragraph\nSection on page two\nA\tB");
    expect(f.engine.parseStructure).toHaveBeenCalledTimes(1);
    expect(f.engine.parseStructure).toHaveBeenCalledWith(expect.objectContaining({ pageRange: { start: 1, end: 2 } }));
    expect(f.engine.extractPage).not.toHaveBeenCalled();
    expect(result.structure?.headings?.[0]?.line).toBe(2);
    expect(result.structure?.tables?.[0]?.startLine).toBe(3);
    expect(result.structure?.elements?.find((entry) => entry.id === "t2")?.cells?.[0]).toMatchObject({ text: "A", columnHeader: true });
    expect(result.structure?.figures).toBeUndefined(); // no invented line for unanchored figure
    const figure = await f.reader.read({ snapshotId: result.snapshot!.snapshotId, view: "text",
      position: { kind: "element", element: "figure", index: 1 } }, f.ctx());
    expect(figure.status === "ok" && figure.markdown).toBe("Figure caption");

    f.engine.parseStructure.mockClear();
    const forced = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "structure", ocr: true }, f.ctx());
    expect(forced.status === "ok" && forced.markdown).toBe(result.markdown);
    if (forced.status === "ok") {
      expect(forced.structure?.tables?.[0]?.cells?.[0]?.text).toBe("A");
      expect(forced.structure?.headings?.[0]?.line).toBe(2);
      expect(forced.analysis).toMatchObject({ parser: "docling", ocr: true, toolVersions: { docling: "2.130.0" } });
      expect(forced.analysis?.toolVersions?.tesseract).toBeUndefined();
      expect(forced.ocr).toBeUndefined();
    }
    expect(f.engine.parseStructure).toHaveBeenCalledTimes(1);
    expect(f.engine.parseStructure).toHaveBeenCalledWith(expect.objectContaining({
      pageRange: { start: 1, end: 2 }, ocr: true,
    }));
    expect(f.engine.ocrPage).not.toHaveBeenCalled();
    expect(f.engine.extractPages).not.toHaveBeenCalled();
    const changedUnusedTesseract = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "structure", ocr: true }, {
      ...f.ctx(), engineOptions: { tesseractCommand: "different-unused-binary" },
    });
    expect(changedUnusedTesseract.status === "ok" && changedUnusedTesseract.snapshot?.snapshotId)
      .toBe(forced.status === "ok" ? forced.snapshot?.snapshotId : undefined);
    expect(f.engine.parseStructure).toHaveBeenCalledTimes(1);
  });

  it("groups disjoint Docling page selections into continuous ranges", async () => {
    const f = fixture();
    f.engine.probe.mockResolvedValue({ pageCount: 4, pages: [1, 2, 3, 4].map((page) => ({ page,
      width: 100, height: 200, rotation: 0 })), parser: "pdfjs", parserVersion: "4.10.38" });
    f.engine.parseStructure.mockImplementation(async (input: unknown) => {
      const range = (input as { pageRange: { start: number; end: number } }).pageRange;
      const text = `pages ${range.start}-${range.end}`;
      return { status: "ok", parser: "docling", parserVersion: "2.130.0", schemaVersion: "1.10.0",
        text, blocks: [{ id: `block-${range.start}`, kind: "text", page: range.start, text,
          startLine: 1, endLine: 1, regions: [] }], elements: [] } as never;
    });
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/disjoint.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const result = await f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "structure", pages: [4, 1, 2] }, f.ctx());
    expect(result.status === "ok" && result.markdown).toBe("pages 1-2\npages 4-4");
    expect(f.engine.parseStructure.mock.calls.map(([input]) => (input as { pageRange: unknown }).pageRange))
      .toEqual([{ start: 1, end: 2 }, { start: 4, end: 4 }]);
  });

  it("reuses a matching versioned analysis and derives a new one after OCR engine upgrade", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/version.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    const request = { snapshotId: opened.snapshot!.snapshotId, view: "text" as const, pages: [1], ocr: true };
    const first = await f.reader.read(request, f.ctx());
    const same = await f.reader.read(request, f.ctx());
    expect(first.status === "ok" && same.status === "ok" && same.snapshot?.snapshotId).toBe(first.status === "ok" ? first.snapshot?.snapshotId : undefined);
    expect(f.engine.ocrPage).toHaveBeenCalledTimes(1);

    f.engine.versions.mockResolvedValue({ pdfjs: "4.10.38", tesseract: "6.0" });
    f.engine.ocrPage.mockResolvedValue({ status: "ok", text: "OCR upgraded", engine: "tesseract", engineVersion: "6.0",
      lines: [{ text: "OCR upgraded", region: { x: 0.2, y: 0.3, width: 0.4, height: 0.1 }, segments: [], readingIndex: 0 }] });
    const upgraded = await f.reader.read(request, f.ctx());
    expect(upgraded.status).toBe("ok");
    if (first.status === "ok" && upgraded.status === "ok") {
      expect(upgraded.analysis?.id).not.toBe(first.analysis?.id);
      expect(upgraded.markdown).toBe("OCR upgraded");
      const old = await f.reader.read({ snapshotId: first.snapshot!.snapshotId, view: "text" }, f.ctx());
      expect(old.status === "ok" && old.markdown).toBe("OCR page 1");
    }
    expect(f.engine.ocrPage).toHaveBeenCalledTimes(2);
  });

  it("shares rendering while cancelling one waiter and rejects a preview after its snapshot is released", async () => {
    const f = fixture();
    const opened = await f.reader.ingest({ source: f.source, sourceUrl: "https://example.com/preview.pdf" }, f.ctx());
    if (opened.status !== "ok") throw new Error("source unavailable");
    let resolveRender!: (value: Awaited<ReturnType<typeof f.engine.renderPage>>) => void;
    f.engine.renderPage.mockImplementation(() => new Promise((resolve) => { resolveRender = resolve; }));
    const first = new AbortController();
    const a = f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "page-image", page: 1 }, f.ctx("owner", first.signal));
    const b = f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "page-image", page: 1 }, f.ctx());
    await vi.waitFor(() => expect(f.engine.renderPage).toHaveBeenCalledTimes(1));
    first.abort(new DOMException("cancelled", "AbortError"));
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(f.engine.renderPage.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    resolveRender({ data: Buffer.from("png-1"), mimeType: "image/png", width: 200, height: 400,
      pageWidth: 100, pageHeight: 200, parser: "pdfjs", parserVersion: "4.10.38" });
    const image = await b;
    expect(image.status).toBe("ok");

    // A fresh render starts, then its material authority disappears before
    // completion. Rechecking prevents a stale preview from leaking bytes.
    const stalePending = f.reader.read({ snapshotId: opened.snapshot!.snapshotId, view: "page-image", page: 2 }, f.ctx());
    await vi.waitFor(() => expect(f.engine.renderPage).toHaveBeenCalledTimes(2));
    f.entries.delete(opened.snapshot!.snapshotId);
    resolveRender({ data: Buffer.from("png-2"), mimeType: "image/png", width: 200, height: 400,
      pageWidth: 100, pageHeight: 200, parser: "pdfjs", parserVersion: "4.10.38" });
    const stale = await stalePending;
    expect(stale).toEqual({ status: "snapshot-missing", snapshotId: opened.snapshot!.snapshotId });
  });
});

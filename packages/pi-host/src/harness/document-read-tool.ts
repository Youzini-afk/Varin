import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DocumentReadRequest, FetchResult, WebDocumentRegion } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

const DocumentReadParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Local PDF in this session's workspace. Supply path or snapshot_id." })),
  snapshot_id: Type.Optional(Type.String({ description: "Fixed material from webfetch or an earlier document_read." })),
  artifact: Type.Optional(Type.Object({ attemptId: Type.String({ minLength: 1 }), artifactId: Type.String({ minLength: 1 }) },
    { description: "A PDF experiment artifact. Uses the same research access as experiment artifact reads; supply this instead of path/snapshot_id." })),
  view: Type.Optional(Type.Union([Type.Literal("overview"), Type.Literal("text"), Type.Literal("page-image"), Type.Literal("structure")],
    { description: "Overview opens the original without parsing its full text. Text, page images and structure are independent views." })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  pages: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }),
    { minItems: 1, description: "Selected one-based page numbers. Supply page, pages, or all — only one." })),
  all: Type.Optional(Type.Boolean({ description: "Read all pages of the original document. Cannot be combined with page or pages." })),
  region: Type.Optional(Type.Object({
    x: Type.Number({ minimum: 0, maximum: 1 }), y: Type.Number({ minimum: 0, maximum: 1 }),
    width: Type.Number({ exclusiveMinimum: 0, maximum: 1 }), height: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
  }, { description: "Crop as proportions of the displayed page: origin top left, x/y/width/height in 0..1. Independent of image resolution." })),
  scale: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Rendering scale (1 = 72 DPI). Increase to inspect small labels; the region stays fixed." })),
  find: Type.Optional(Type.String({ minLength: 1, description: "Find literal text and return page/region references. Searches selected pages, or all pages when omitted." })),
  ocr: Type.Optional(Type.Boolean({ description: "Explicitly OCR the selected pages, including pages with an incomplete native text layer. Uses the configured optional OCR component." })),
  parser: Type.Optional(Type.Union([Type.Literal("native"), Type.Literal("docling")], { description: "Use docling for structured layout/table extraction when installed. Ordinary text and images use the bundled engine." })),
  section: Type.Optional(Type.String()),
  element: Type.Optional(Type.Union([Type.Literal("table"), Type.Literal("figure"), Type.Literal("formula")])),
  element_index: Type.Optional(Type.Integer({ minimum: 1 })),
  start_line: Type.Optional(Type.Integer({ minimum: 1 })),
  end_line: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const materialPageLink = (snapshotId: string, page: number, sourceHash?: string, region?: WebDocumentRegion): string => {
  const query = new URLSearchParams({ page: String(page) });
  if (sourceHash) query.set("sourceHash", sourceHash);
  if (region) for (const [key, value] of Object.entries(region)) query.set(key, String(value));
  return `varin-material://${encodeURIComponent(snapshotId)}?${query}`;
};

export function createDocumentReadTool(bridge: HostServicesBridge): ToolDefinition {
  return defineTool({
    name: "document_read",
    label: "Document Read",
    description: "Open a local or stored PDF, find passages, read selected pages, inspect actual page/crop images, or extract structured tables. Preserves the original and fixed references across reads.",
    promptSnippet: "document_read: read, search or visually inspect local and pinned PDFs",
    promptGuidelines: [
      "Page images are available independently of text extraction, OCR, and structured parsing. Returned page links identify positions in the fixed original PDF.",
    ],
    parameters: DocumentReadParams,
    executionMode: "parallel",
    execute: async (_id, params, signal): Promise<{
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      details: Record<string, unknown>;
      isError?: boolean;
    }> => {
      if (params.all && (params.page !== undefined || params.pages !== undefined)) {
        return { content: [{ type: "text", text: "Supply only one of page, pages, or all:true." }], details: { kind: "document_read", status: "failed" }, isError: true };
      }
      const position: DocumentReadRequest["position"] = params.section !== undefined
        ? { kind: "section", title: params.section }
        : params.element !== undefined
          ? { kind: "element", element: params.element, index: params.element_index ?? 1 }
          : params.start_line !== undefined || params.end_line !== undefined
            ? { kind: "lines", startLine: params.start_line ?? 1, ...(params.end_line === undefined ? {} : { endLine: params.end_line }) }
            : undefined;
      const request: DocumentReadRequest = {
        ...(params.path ? { path: params.path } : {}),
        ...(params.snapshot_id ? { snapshotId: params.snapshot_id } : {}),
        ...(params.artifact ? { artifact: params.artifact } : {}),
        view: params.view ?? (params.find || params.ocr || position ? "text" : params.parser === "docling" ? "structure" : "overview"),
        ...(params.page === undefined ? {} : { page: params.page }),
        ...(params.all ? { pages: "all" as const } : params.pages ? { pages: params.pages } : params.find && params.page === undefined ? { pages: "all" as const } : {}),
        ...(params.region ? { region: params.region } : {}),
        ...(params.scale === undefined ? {} : { scale: params.scale }),
        ...(params.find === undefined ? {} : { find: params.find }),
        ...(params.ocr === undefined ? {} : { ocr: params.ocr }),
        ...(params.parser ? { parser: params.parser } : {}),
        ...(position ? { position } : {}),
      };
      let result: FetchResult;
      try {
        result = await bridge.request("materials.read", request, { ...(signal ? { signal } : {}), timeoutMs: 0 });
      } catch (error) {
        if (signal?.aborted) throw error;
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Document reading failed" }], details: { kind: "document_read", status: "failed" }, isError: true };
      }
      if (result.status !== "ok") {
        const detail = "reason" in result ? result.reason : "detail" in result ? result.detail : "";
        return { content: [{ type: "text", text: `${result.status}${detail ? `: ${detail}` : ""}` }], details: { kind: "document_read", status: result.status }, isError: true };
      }
      const snapshot = result.snapshot;
      const sourceHash = result.overview?.sourceHash ?? snapshot?.document?.source?.contentHash;
      const lines = [`Document: ${result.title ?? result.finalUrl}`];
      if (snapshot) lines.push(`snapshot_id: ${snapshot.snapshotId}`);
      if (result.overview) lines.push(`Pages: ${result.overview.pageCount ?? "unknown"}; text: ${result.overview.textStatus}`);
      if (result.analysis) lines.push(`Analysis: ${result.analysis.parser} ${result.analysis.version}; ${result.analysis.status}; pages ${result.analysis.pages.join(", ")}`);
      if (result.ocr) lines.push(`OCR: ${result.ocr.status}${result.ocr.detail ? ` — ${result.ocr.detail}` : ""}`);
      if (result.findHits) {
        lines.push(`${result.findHits.length} text matches:`);
        for (const hit of result.findHits) {
          const location = snapshot ? `[Page ${hit.page}](${materialPageLink(snapshot.snapshotId, hit.page, sourceHash, hit.region)})` : `Page ${hit.page}`;
          lines.push(`${location}: ${hit.snippet}`);
        }
      } else if ((request.view === "text" || request.view === "structure") && result.markdown) lines.push(result.markdown);
      if (request.view === "structure" && result.structure) lines.push(JSON.stringify(result.structure));
      const images = result.pageImages ?? (result.pageImage ? [result.pageImage] : []);
      const imagePages = new Set(images.map((image) => image.page));
      if (snapshot && images.length === 0) {
        for (const page of result.analysis?.pages ?? (params.page ? [params.page] : [1])) {
          lines.push(`[Page ${page}](${materialPageLink(snapshot.snapshotId, page, sourceHash, params.region)})`);
        }
      }
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: lines.join("\n\n") }];
      for (const image of images) {
        if (snapshot) content.push({ type: "text", text: `[Page ${image.page}](${materialPageLink(snapshot.snapshotId, image.page, sourceHash, image.region)})` });
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      return {
        content,
        details: {
          kind: "document_read", status: "ok", pages: [...imagePages],
          sources: [{ url: result.finalUrl, title: result.title ?? result.finalUrl,
            ...(snapshot ? { snapshotId: snapshot.snapshotId, contentHash: snapshot.contentHash, ...(snapshot.document ? { document: snapshot.document } : {}) } : {}),
          }],
          ...(result.analysis ? { analysis: result.analysis } : {}),
          ...(result.receipt ? { receipt: result.receipt } : {}),
        },
      };
    },
  });
}

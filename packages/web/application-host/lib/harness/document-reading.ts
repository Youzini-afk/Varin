import { createHash } from "node:crypto";
import type {
  DocumentAnalysis, DocumentFindHit, DocumentOverview, DocumentPageImage, DocumentReadRequest,
  FetchResult, HarnessWebDomainPolicy, RetrievalReceiptAuthority, WebDocumentRegion,
  WebReadPosition, WebSnapshotRef, WebSnapshotStructure,
} from "@varin/protocol";
import { createPdfEngine, PDF_ENGINE_VERSION, type PdfEngineOptions, type PdfPageText } from "./pdf-engine.js";
import type { WebMaterialStore, WebSnapshotContent } from "./web-materials.js";

type Ok = Extract<FetchResult, { status: "ok" }>;
type Materials = Pick<WebMaterialStore, "put" | "read"> & Partial<Pick<WebMaterialStore, "findAnalysis" | "findAnalysisConfig">>;

export interface DocumentReaderContext {
  workspaceId: string;
  authority: RetrievalReceiptAuthority;
  signal?: AbortSignal;
  /** Current Host policy, checked again for each HTTP(S) snapshot read. */
  domainPolicy?: HarnessWebDomainPolicy;
  /** Trusted Host settings; never populated from tool request fields. */
  engineOptions?: PdfEngineOptions;
}

export interface DocumentIngestInput {
  source: Buffer;
  sourceUrl: string;
  finalUrl?: string;
  contentType?: string;
  title?: string;
  forceNew?: boolean;
}

interface SharedJob<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  done: boolean;
}

const hash = (bytes: Buffer | string): string => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
const cancelled = (signal?: AbortSignal): unknown => signal?.reason ?? new DOMException("Document reading aborted", "AbortError");
const checkAbort = (signal?: AbortSignal): void => { if (signal?.aborted) throw cancelled(signal); };
const isPage = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const validRegion = (value: WebDocumentRegion): boolean => [value.x, value.y, value.width, value.height].every(Number.isFinite)
  && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
  && value.x + value.width <= 1 + Number.EPSILON && value.y + value.height <= 1 + Number.EPSILON;

const validateRequest = (request: DocumentReadRequest): string | null => {
  if (!request || typeof request !== "object" || Array.isArray(request)) return "document request must be an object";
  if (request.snapshotId !== undefined && (typeof request.snapshotId !== "string" || !request.snapshotId.trim())) return "snapshotId must be a non-empty string";
  if (request.path !== undefined && (typeof request.path !== "string" || !request.path.trim())) return "path must be a non-empty string";
  if (request.artifact !== undefined && (!request.artifact || typeof request.artifact !== "object"
    || typeof request.artifact.attemptId !== "string" || !request.artifact.attemptId.trim()
    || typeof request.artifact.artifactId !== "string" || !request.artifact.artifactId.trim())) return "invalid artifact identity";
  if ([request.snapshotId, request.path, request.artifact].filter(Boolean).length > 1) return "use exactly one document source";
  if (request.view !== undefined && !["overview", "text", "page-image", "structure"].includes(request.view)) return "unsupported document view";
  if (request.page !== undefined && !isPage(request.page)) return "page must be a positive one-based integer";
  if (request.pages !== undefined && request.pages !== "all"
    && (!Array.isArray(request.pages) || request.pages.length === 0 || !request.pages.every(isPage))) return "pages must be all or contain positive one-based integers";
  if (request.page !== undefined && request.pages !== undefined) return "use page or pages, not both";
  if (request.region !== undefined && (!request.region || !validRegion(request.region))) return "region must be a normalized rectangle within the page";
  if (request.scale !== undefined && (!Number.isFinite(request.scale) || request.scale <= 0)) return "scale must be positive";
  if (request.ocr !== undefined && typeof request.ocr !== "boolean") return "ocr must be boolean";
  if (request.parser !== undefined && request.parser !== "native" && request.parser !== "docling") return "unsupported parser";
  if (request.find !== undefined && typeof request.find !== "string") return "find must be a string";
  const position = request.position;
  if (position !== undefined) {
    if (!position || typeof position !== "object" || Array.isArray(position)) return "invalid position";
    switch (position.kind) {
      case "lines":
        if (!isPage(position.startLine) || (position.endLine !== undefined && (!isPage(position.endLine) || position.endLine < position.startLine))) return "invalid line position";
        break;
      case "page": if (!isPage(position.page)) return "invalid page position"; break;
      case "section": if (typeof position.title !== "string" || !position.title.trim()) return "invalid section position"; break;
      case "element": if (!["table", "figure", "formula"].includes(position.element) || !isPage(position.index)) return "invalid element position"; break;
      case "appendix": break;
      default: return "invalid position kind";
    }
  }
  return null;
};

const domainBlocked = (url: string, policy?: HarnessWebDomainPolicy): boolean => {
  if (!policy) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  const matches = (domain: string): boolean => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`);
  return policy.block.some(matches) || (policy.allow !== undefined && !policy.allow.some(matches));
};

const joinJob = <T>(job: SharedJob<T>, signal?: AbortSignal): Promise<T> => {
  job.waiters += 1;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    job.waiters -= 1;
    if (job.waiters === 0 && !job.done) job.controller.abort();
  };
  if (!signal) return job.promise.finally(leave);
  if (signal.aborted) { leave(); return Promise.reject(cancelled(signal)); }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { leave(); reject(cancelled(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    job.promise.then(
      (value) => { leave(); resolve(value); },
      (error) => { leave(); reject(error); },
    ).finally(() => signal.removeEventListener("abort", abort));
  });
};

const pageRanges = (pages: Array<{ page: number; text: string }>): NonNullable<WebSnapshotStructure["pages"]> => {
  let cursor = 1;
  return pages.map(({ page, text }) => {
    const count = text.split("\n").length;
    const range = { page, startLine: cursor, endLine: cursor + count - 1 };
    cursor += count + 1;
    return range;
  });
};

const contiguousPageGroups = (pages: number[]): Array<{ start: number; end: number }> => {
  const groups: Array<{ start: number; end: number }> = [];
  for (const page of pages) {
    const last = groups.at(-1);
    if (last && page === last.end + 1) last.end = page;
    else groups.push({ start: page, end: page });
  }
  return groups;
};

const findInPages = (pages: Array<{ page: number; text: string }>, needle: string, structure?: WebSnapshotStructure): DocumentFindHit[] => {
  if (!needle) return [];
  const lower = needle.toLocaleLowerCase();
  const hits: DocumentFindHit[] = [];
  for (const entry of pages) {
    const haystack = entry.text.toLocaleLowerCase();
    const layout = structure?.layouts?.find((item) => item.page === entry.page);
    const alignedLines = layout?.lines.map((line) => line.text).join("\n") === entry.text ? layout.lines : undefined;
    const blocks = structure?.blocks?.filter((block) => block.page === entry.page);
    const alignedBlocks = blocks?.map((block) => block.text).join("\n") === entry.text ? blocks : undefined;
    let from = 0;
    while (from < haystack.length) {
      const start = haystack.indexOf(lower, from);
      if (start < 0) break;
      const end = start + lower.length;
      let region: WebDocumentRegion | undefined;
      let pageCandidates: number[] | undefined;
      if (alignedLines) {
        let cursor = 0;
        for (const line of alignedLines) {
          const lineEnd = cursor + line.text.length;
          if (start < lineEnd && end > cursor) {
            region = line.region;
            break;
          }
          cursor = lineEnd + 1;
        }
      }
      if (!region && alignedBlocks) {
        let cursor = 0;
        for (const block of alignedBlocks) {
          const blockEnd = cursor + block.text.length;
          if (start < blockEnd && end > cursor) {
            const locatedPages = [...new Set(block.regions.map((place) => place.page))];
            if (locatedPages.length === 1 && locatedPages[0] === entry.page) {
              region = block.regions[0]?.region;
            } else if (locatedPages.length > 1) pageCandidates = locatedPages;
            break;
          }
          cursor = blockEnd + 1;
        }
      }
      hits.push({ page: entry.page, start, end, snippet: entry.text.slice(Math.max(0, start - 80), Math.min(entry.text.length, end + 80)),
        ...(region ? { region } : {}), ...(pageCandidates ? { pageCandidates } : {}) });
      from = Math.max(end, start + 1);
    }
  }
  return hits;
};

const slicePosition = (
  body: string,
  structure: WebSnapshotStructure | undefined,
  position: WebReadPosition,
  snapshotId: string,
): { markdown: string; range?: NonNullable<Ok["range"]> } | FetchResult => {
  const lines = body.split("\n");
  const totalLines = lines.length;
  const take = (start: number, end: number) => ({ markdown: lines.slice(start - 1, end).join("\n"), range: { startLine: start, endLine: Math.min(end, totalLines), totalLines } });
  const unavailable = (kind: string): FetchResult => ({ status: "structure-unsupported", snapshotId, kind });
  const absent = (detail: string): FetchResult => ({ status: "position-not-found", snapshotId, detail });
  if (position.kind === "lines") return position.startLine <= totalLines ? take(position.startLine, position.endLine ?? totalLines) : absent("line outside document");
  if (position.kind === "page") {
    if (!structure?.pages?.length) {
      const blocks = structure?.blocks?.filter((block) => block.page === position.page);
      return blocks?.length ? { markdown: blocks.map((block) => block.text).join("\n") } : unavailable("pages");
    }
    const range = structure.pages.find((entry) => entry.page === position.page);
    return range ? take(range.startLine, range.endLine) : absent("page outside analysis");
  }
  if (position.kind === "section" || position.kind === "appendix") {
    if (!structure?.headings?.length) return unavailable("headings");
    const heading = structure.headings.find((entry) => position.kind === "appendix"
      ? /^(appendix|appendices|supplementary\b|supplement\b|annex\b|附录)/iu.test(entry.title.trim())
      : entry.title.toLocaleLowerCase().includes(position.title.toLocaleLowerCase()));
    if (!heading) return absent("section not found");
    const next = structure.headings.find((entry) => entry.line > heading.line && entry.level <= heading.level);
    return take(heading.line, (next?.line ?? totalLines + 1) - 1);
  }
  const parserElements = structure?.elements?.filter((entry) => entry.kind === position.element);
  if (parserElements?.length) {
    const element = parserElements[position.index - 1];
    if (!element) return absent("element outside analysis");
    const text = element.text ?? (element.kind === "table" ? element.cells?.map((cell) => cell.text).join("\t")
      : element.kind === "figure" ? element.captions?.map((caption) => caption.text).join("\n") : undefined);
    return text ? { markdown: text } : unavailable(`${position.element} text`);
  }
  const list = position.element === "table" ? structure?.tables : position.element === "figure" ? structure?.figures : structure?.formulas;
  if (!list?.length) return unavailable(`${position.element}s`);
  const entry = list[position.index - 1];
  if (!entry) return absent("element outside analysis");
  if ("analysisId" in entry && entry.analysisId) {
    const parserText = "text" in entry ? entry.text : "title" in entry ? entry.title : undefined;
    if (parserText) return { markdown: parserText };
  }
  const start = "startLine" in entry ? entry.startLine : entry.line;
  const end = "endLine" in entry ? entry.endLine : entry.line;
  return take(start, end);
};

export const createDocumentReader = (deps: { materials: Materials; engineFactory?: typeof createPdfEngine }) => {
  const engineFactory = deps.engineFactory ?? createPdfEngine;
  const jobs = new Map<string, SharedJob<unknown>>();
  const probeCache = new Map<string, Awaited<ReturnType<ReturnType<typeof createPdfEngine>["probe"]>>>();
  const imageCache = new Map<string, { data: WeakRef<Buffer>; width: number; height: number }>();
  const analysisIndex = new Map<string, string>();

  const shared = <T>(key: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    let job = jobs.get(key) as SharedJob<T> | undefined;
    if (!job || job.done || job.controller.signal.aborted) {
      const controller = new AbortController();
      const current: SharedJob<T> = { controller, waiters: 0, done: false, promise: Promise.resolve(undefined as T) };
      current.promise = operation(controller.signal).finally(() => {
        current.done = true;
        if (jobs.get(key) === current) jobs.delete(key);
      });
      job = current;
      jobs.set(key, current as SharedJob<unknown>);
    }
    return joinJob(job, signal);
  };

  const ingest = async (
    input: DocumentIngestInput,
    ctx: DocumentReaderContext,
    request: DocumentReadRequest = { view: "overview" },
  ): Promise<FetchResult> => {
    checkAbort(ctx.signal);
    const invalid = validateRequest(request);
    if (invalid || request.snapshotId || request.path || request.artifact) return { status: "failed", url: input.sourceUrl, reason: invalid ?? "ingest request cannot name an existing source" };
    const contentType = input.contentType ?? "application/pdf";
    let sourceRef: WebSnapshotRef;
    try {
      sourceRef = await deps.materials.put(ctx.workspaceId, {
        sourceUrl: input.sourceUrl,
        finalUrl: input.finalUrl ?? input.sourceUrl,
        contentType,
        ...(input.title ? { title: input.title } : {}),
        representation: "pdf-source-v1",
        document: { kind: "pdf", parser: "source" },
      }, Buffer.alloc(0), ctx.authority, {
        ...(input.forceNew ? { forceNew: true } : {}),
        source: { bytes: input.source, contentType },
      });
    } catch (error) {
      return { status: "failed", url: input.sourceUrl, reason: error instanceof Error ? error.message : "PDF source persistence failed" };
    }
    checkAbort(ctx.signal);
    return read({ ...request, snapshotId: sourceRef.snapshotId }, ctx);
  };

  const read = async (request: DocumentReadRequest, ctx: DocumentReaderContext): Promise<FetchResult> => {
    const invalid = validateRequest(request);
    if (invalid) return { status: "failed", url: "", reason: invalid };
    if (request.path || request.artifact) return { status: "failed", url: "", reason: "Host must authorize the source and pass its bytes to ingest" };
    const snapshotId = request.snapshotId?.trim();
    if (!snapshotId) return { status: "failed", url: "", reason: "snapshotId is required" };
    checkAbort(ctx.signal);
    const found = await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority, { includeSource: true });
    if (!found) return { status: "snapshot-missing", snapshotId };
    if (domainBlocked(found.ref.finalUrl, ctx.domainPolicy)) return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    if (found.ref.document?.kind !== "pdf" || !found.source) return { status: "failed", url: found.ref.finalUrl, reason: "snapshot has no original PDF" };
    const sourceHash = found.ref.document.source?.contentHash ?? hash(found.source.bytes);
    const sourceSnapshotId = found.ref.document.sourceSnapshotId ?? found.ref.snapshotId;
    const sourceRef = sourceSnapshotId === found.ref.snapshotId ? found.ref
      : (await deps.materials.read(ctx.workspaceId, sourceSnapshotId, ctx.authority))?.ref;
    const options = ctx.engineOptions ?? {};
    const engine = engineFactory(options);
    const source = found.source.bytes;
    const base = (snapshot: WebSnapshotRef = found.ref, markdown = found.body.toString("utf8")): Ok => ({
      status: "ok", url: snapshot.sourceUrl, finalUrl: snapshot.finalUrl,
      contentType: snapshot.contentType ?? "application/pdf", ...(snapshot.title ? { title: snapshot.title } : {}),
      markdown, bytes: Buffer.byteLength(markdown), fromCache: false, rendered: false, snapshot,
      ...(sourceRef ? { sourceSnapshot: sourceRef } : {}),
      ...(snapshot.structure ? { structure: snapshot.structure } : {}),
    });
    const recheck = async (): Promise<boolean> => {
      checkAbort(ctx.signal);
      const current = await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority);
      return !!current && current.ref.document?.source?.contentHash === sourceHash && !domainBlocked(current.ref.finalUrl, ctx.domainPolicy);
    };
    const overview = (probe?: Awaited<ReturnType<typeof engine.probe>>, textStatus: DocumentOverview["textStatus"] = "not-requested"): DocumentOverview => ({
      sourceHash, sourceSnapshotId,
      ...(probe ? { pageCount: probe.pageCount, pages: probe.pages }
        : found.ref.document?.pageCount !== undefined ? { pageCount: found.ref.document.pageCount,
          ...(found.ref.document.pages ? { pages: found.ref.document.pages } : {}) } : {}),
      textStatus,
    });
    const presentAnalysis = (material: WebSnapshotContent, probed?: Awaited<ReturnType<typeof engine.probe>>): FetchResult => {
      let markdown = material.body.toString("utf8");
      let range: Ok["range"];
      if (request.position) {
        const sliced = slicePosition(markdown, material.ref.structure, request.position, material.ref.snapshotId);
        if (!("markdown" in sliced)) return sliced;
        markdown = sliced.markdown;
        range = sliced.range;
      }
      const bodyLines = material.body.toString("utf8").split("\n");
      const pageText = material.ref.structure?.pages?.map((entry) => ({ page: entry.page,
        text: bodyLines.slice(entry.startLine - 1, entry.endLine).join("\n") }))
        ?? [...new Set(material.ref.structure?.blocks?.map((block) => block.page) ?? [])].map((page) => ({ page,
          text: material.ref.structure!.blocks!.filter((block) => block.page === page).map((block) => block.text).join("\n") }));
      const storedOcr = material.ref.document?.ocr;
      const ocr: Ok["ocr"] | undefined = storedOcr?.status === "unavailable"
        ? { status: "unavailable", ...(storedOcr.engine ? { engine: storedOcr.engine } : {}),
          ...(storedOcr.pages ? { pages: storedOcr.pages } : {}), detail: "OCR adapter unavailable or returned no text" }
        : storedOcr?.status === "used" || storedOcr?.status === "not-needed"
          ? { status: storedOcr.status, ...(storedOcr.engine ? { engine: storedOcr.engine } : {}),
            ...(storedOcr.pages ? { pages: storedOcr.pages } : {}) }
          : undefined;
      return { ...base(material.ref, markdown), overview: overview(probed,
        material.body.toString("utf8").trim() ? "available" : "unavailable"),
        ...(material.ref.document?.analysis ? { analysis: material.ref.document.analysis } : {}),
        ...(range ? { range } : {}),
        ...(request.find !== undefined ? { findHits: findInPages(pageText, request.find, material.ref.structure) } : {}),
        ...(ocr ? { ocr } : {}),
      };
    };
    const probeKey = `probe:${sourceHash}:${PDF_ENGINE_VERSION}`;
    const probe = async () => {
      const cached = probeCache.get(probeKey);
      if (cached) return cached;
      const result = await shared(probeKey, ctx.signal, (signal) => engine.probe({ source, signal }));
      probeCache.set(probeKey, result);
      return result;
    };
    const view = request.view ?? "text";
    let probed: Awaited<ReturnType<typeof engine.probe>> | undefined;
    if (view !== "page-image" || request.pages === "all") {
      try { probed = await probe(); } catch (error) {
        if (ctx.signal?.aborted) throw cancelled(ctx.signal);
        if (view !== "overview" && view !== "text") return { status: "failed", url: found.ref.finalUrl, reason: error instanceof Error ? error.message : "PDF probe failed" };
      }
    }
    if (!(await recheck())) return { status: "snapshot-missing", snapshotId };
    if (view === "overview") return { ...base(found.ref, ""), overview: overview(probed,
      found.ref.document.analysis ? found.body.toString("utf8").trim() ? "available" : "unavailable" : "not-requested") };
    const pinnedCoversAll = request.pages === "all" && !!probed
      && found.ref.document.analysis?.pages.length === probed.pageCount
      && found.ref.document.analysis.pages.every((page, index) => page === index + 1);
    if (found.ref.document.analysis && (view === "text"
      || (view === "structure" && (found.ref.document.analysis.parser === "docling" || !!found.ref.structure?.elements?.length)))
      && request.page === undefined && (request.pages === undefined || pinnedCoversAll)
      && request.parser === undefined && request.ocr === undefined) {
      return presentAnalysis(found, probed);
    }

    const pages = request.page !== undefined ? [request.page]
      : Array.isArray(request.pages) ? [...new Set(request.pages)].sort((a, b) => a - b)
        : request.pages === "all" || view !== "page-image"
          ? probed ? Array.from({ length: probed.pageCount }, (_, i) => i + 1) : [] : [];
    if (view === "page-image" && !pages.length) return { status: "page-image-unavailable", snapshotId, reason: "a one-based page is required" };
    if (probed && pages.some((page) => page > probed.pageCount)) return view === "page-image"
      ? { status: "page-image-unavailable", snapshotId, page: pages.find((page) => page > probed.pageCount)!, reason: `page outside 1..${probed.pageCount}` }
      : { status: "position-not-found", snapshotId, detail: `page outside 1..${probed.pageCount}` };

    if (view === "page-image") {
      const images: DocumentPageImage[] = [];
      for (const page of pages) {
        const imageKey = `render:${sourceHash}:${PDF_ENGINE_VERSION}:${page}:${JSON.stringify(request.region ?? null)}:${request.scale ?? 2}`;
        let image = imageCache.get(imageKey);
        let bytes = image?.data.deref();
        if (!bytes) {
          try {
            const rendered = await shared(imageKey, ctx.signal, (signal) => engine.renderPage({ source, page, ...(request.region ? { region: request.region } : {}), ...(request.scale ? { scale: request.scale } : {}), signal }));
            bytes = rendered.data;
            image = { data: new WeakRef(bytes), width: rendered.width, height: rendered.height };
            imageCache.set(imageKey, image);
          } catch (error) {
            if (ctx.signal?.aborted) throw cancelled(ctx.signal);
            return { status: "page-image-unavailable", snapshotId, page, reason: error instanceof Error ? error.message : "PDF render failed" };
          }
        }
        images.push({ page, mimeType: "image/png", data: bytes.toString("base64"), byteLength: bytes.byteLength,
          width: image!.width, height: image!.height, sourceHash, ...(request.region ? { region: request.region } : {}) });
      }
      if (!(await recheck())) return { status: "snapshot-missing", snapshotId };
      const bodyLines = found.body.toString("utf8").split("\n");
      const pageText = found.ref.document.analysis ? pages.map((page) => {
        const lineRange = found.ref.structure?.pages?.find((entry) => entry.page === page);
        if (lineRange) return bodyLines.slice(lineRange.startLine - 1, lineRange.endLine).join("\n");
        return found.ref.structure?.blocks?.filter((block) => block.page === page).map((block) => block.text).join("\n") ?? "";
      }).join("\n\n") : "";
      return { ...base(found.ref, pageText), overview: overview(probed), pageImage: images[0]!, pageImages: images };
    }

    if (!probed) return { ...base(), overview: overview(undefined, "unavailable") };
    const parser = request.parser ?? (view === "structure" ? "docling" : "native");
    const toolVersions: NonNullable<DocumentAnalysis["toolVersions"]> = typeof engine.versions === "function"
      ? await engine.versions({ parser, ocr: request.ocr === true,
        ...(ctx.signal ? { signal: ctx.signal } : {}) }).catch(() => ({ pdfjs: probed.parserVersion }))
      : { pdfjs: probed.parserVersion };
    if (!(await recheck())) return { status: "snapshot-missing", snapshotId };
    const engineConfig = parser === "docling"
      ? { engine: PDF_ENGINE_VERSION, doclingCommand: ctx.engineOptions?.doclingCommand ?? null }
      : request.ocr === true
        ? { engine: PDF_ENGINE_VERSION, tesseractCommand: ctx.engineOptions?.tesseractCommand ?? "tesseract",
          ocrLanguage: ctx.engineOptions?.ocrLanguage ?? "eng" }
        : { engine: PDF_ENGINE_VERSION };
    const configHash = hash(JSON.stringify({ parser, pages, ocr: request.ocr === true, engineConfig }));
    const nativeVersion = `${PDF_ENGINE_VERSION}/pdfjs:${probed.parserVersion}`;
    const versionKey = `${nativeVersion}${parser === "docling" ? `/docling:${toolVersions.docling ?? "unavailable"}` : ""}${parser === "native" && request.ocr === true ? `/ocr:${toolVersions.tesseract ?? "unavailable"}` : ""}`;
    const analysisId = hash(`${sourceHash}:${configHash}:${versionKey}`);
    const cacheKey = `${ctx.workspaceId}:${sourceSnapshotId}:${analysisId}:${ctx.authority.threadId ?? `session:${ctx.authority.sessionId}`}`;
    let derived: WebSnapshotContent | null = null;
    if (deps.materials.findAnalysisConfig) {
      derived = await deps.materials.findAnalysisConfig(ctx.workspaceId, sourceHash, configHash, toolVersions, ctx.authority, sourceSnapshotId);
    } else if (parser === "native" && request.ocr !== true && deps.materials.findAnalysis) {
      derived = await deps.materials.findAnalysis(ctx.workspaceId, sourceHash, analysisId, ctx.authority, sourceSnapshotId);
    }
    if (!derived) {
      const indexedId = analysisIndex.get(cacheKey);
      if (indexedId) derived = await deps.materials.read(ctx.workspaceId, indexedId, ctx.authority);
    }
    if (!derived) {
      const analyze = async (signal: AbortSignal) => {
        const ocrPages: number[] = [];
        const failedPages: number[] = [];
        let ocrUnavailable = false;
        let ocrEngine: string | undefined;
        let ocrEngineVersion: string | undefined;
        let doclingVersion: string | undefined;
        let schemaVersion: string | undefined;
        let markdown = "";
        const structure: WebSnapshotStructure = {};
        if (parser === "docling") {
          const blocks: NonNullable<WebSnapshotStructure["blocks"]> = [];
          const elements: NonNullable<WebSnapshotStructure["elements"]> = [];
          const bodyParts: string[] = [];
          let lineOffset = 0;
          for (const group of contiguousPageGroups(pages)) {
            const part = await engine.parseStructure({ source, pageRange: group, ocr: request.ocr === true, signal });
            if (part.status !== "ok") return { unavailableReason: part.reason };
            doclingVersion = part.parserVersion;
            schemaVersion = part.schemaVersion;
            for (const block of part.blocks) blocks.push({ ...block,
              startLine: block.startLine + lineOffset, endLine: block.endLine + lineOffset });
            for (const element of part.elements) elements.push({
              id: element.id, kind: element.kind, page: element.page, regions: element.regions,
              ...(element.text !== undefined ? { text: element.text } : {}),
              ...(element.level !== undefined ? { level: element.level } : {}),
              ...(element.captions.length ? { captions: element.captions } : {}),
              ...(element.cells ? { cells: element.cells } : {}),
              ...(element.startLine !== undefined ? { startLine: element.startLine + lineOffset } : {}),
              ...(element.endLine !== undefined ? { endLine: element.endLine + lineOffset } : {}),
            });
            if (part.text) {
              bodyParts.push(part.text);
              lineOffset += part.text.split("\n").length;
            }
          }
          markdown = bodyParts.join("\n");
          structure.blocks = blocks;
          structure.elements = elements;

          // Project only elements with a real position in Docling's own body.
          // Every element, including unanchored figures and tables, remains in
          // `elements` with its actual text and page geometry.
          const headings: NonNullable<WebSnapshotStructure["headings"]> = [];
          const tables: NonNullable<WebSnapshotStructure["tables"]> = [];
          const figures: NonNullable<WebSnapshotStructure["figures"]> = [];
          const formulas: NonNullable<WebSnapshotStructure["formulas"]> = [];
          for (const element of elements) {
            if (element.startLine === undefined) continue;
            const line = element.startLine;
            if (element.kind === "section") headings.push({ title: element.text ?? "", level: element.level ?? 1,
              line, analysisId, elementId: element.id, regions: element.regions });
            if (element.kind === "table") tables.push({ startLine: line, endLine: element.endLine ?? line,
              page: element.page, text: element.text ?? element.cells?.map((cell) => cell.text).join("\t") ?? "",
              analysisId, elementId: element.id, regions: element.regions,
              ...(element.cells ? { cells: element.cells } : {}) });
            if (element.kind === "figure") figures.push({ line, page: element.page,
              ...(element.captions?.[0]?.text ? { title: element.captions[0].text } : {}),
              ...(element.text ? { text: element.text } : {}), analysisId, elementId: element.id,
              regions: element.regions, ...(element.captions ? { captions: element.captions } : {}) });
            if (element.kind === "formula") formulas.push({ line, text: element.text ?? "", confidence: "candidate",
              analysisId, elementId: element.id, regions: element.regions });
          }
          if (headings.length) structure.headings = headings;
          if (tables.length) structure.tables = tables;
          if (figures.length) structure.figures = figures;
          if (formulas.length) structure.formulas = formulas;

          // The line-range page selector is valid only if the parser's body
          // does not return to an earlier page after entering another one.
          const pageOrder = blocks.map((block) => block.page).filter((page, index, list) => index === 0 || page !== list[index - 1]);
          if (new Set(pageOrder).size === pageOrder.length) {
            structure.pages = pageOrder.map((page) => {
              const onPage = blocks.filter((block) => block.page === page);
              return { page, startLine: onPage[0]!.startLine!, endLine: onPage.at(-1)!.endLine! };
            });
          }
        }
        if (parser === "native") {
          const selected: Array<{ page: number; text: string; native?: PdfPageText; lines?: PdfPageText["lines"] }> = [];
          const ocrByPage = new Map<number, Extract<Awaited<ReturnType<typeof engine.ocrPage>>, { status: "ok" }>>();
          const fallbackPages: number[] = [];
          if (request.ocr === true) {
            for (const page of pages) {
              signal.throwIfAborted();
              try {
                const ocr = await engine.ocrPage({ source, page, signal });
                if (ocr.status === "ok") {
                  ocrByPage.set(page, ocr);
                  ocrPages.push(page);
                  ocrEngine ??= ocr.engine;
                  ocrEngineVersion ??= ocr.engineVersion;
                } else { ocrUnavailable = true; fallbackPages.push(page); }
              } catch { if (signal.aborted) throw cancelled(signal); ocrUnavailable = true; fallbackPages.push(page); }
            }
          } else fallbackPages.push(...pages);

          const nativeByPage = new Map<number, PdfPageText>();
          const nativeFailures = new Set<number>();
          if (parser === "native" && fallbackPages.length) {
            try {
              for (const pageText of await engine.extractPages({ source, pages: fallbackPages, signal })) {
                nativeByPage.set(pageText.page, pageText);
              }
            } catch {
              if (signal.aborted) throw cancelled(signal);
              // A batch failure need not discard healthy pages. Retry only in
              // this exceptional path to identify the pages that truly failed.
              for (const page of fallbackPages) {
                try { nativeByPage.set(page, await engine.extractPage({ source, page, signal })); }
                catch { if (signal.aborted) throw cancelled(signal); nativeFailures.add(page); }
              }
            }
          }
          for (const page of pages) {
            signal.throwIfAborted();
            const native = nativeByPage.get(page);
            const ocr = ocrByPage.get(page);
            const text = ocr?.text ?? native?.text ?? "";
            const lines = ocr?.lines ?? native?.lines;
            if (nativeFailures.has(page)) failedPages.push(page);
            selected.push({ page, text, ...(native ? { native } : {}), ...(lines ? { lines } : {}) });
          }
          markdown = selected.map((entry) => entry.text).join("\n\n");
          structure.pages = pageRanges(selected);
          structure.layouts = selected.filter((entry) => entry.lines).map((entry) => ({
            page: entry.page, width: entry.native?.width ?? probed.pages[entry.page - 1]!.width,
            height: entry.native?.height ?? probed.pages[entry.page - 1]!.height, analysisId,
            lines: entry.lines!.map((line) => ({ text: line.text,
              x: line.region.x, y: line.region.y, width: line.region.width, height: line.region.height,
              region: line.region, readingIndex: line.readingIndex,
              segments: line.segments.map((segment) => ({ text: segment.text, x: segment.region.x, width: segment.region.width })),
            })),
          }));
        }
        return { markdown, structure, ocrPages, ocrUnavailable, ocrEngine, ocrEngineVersion,
          failedPages, doclingVersion, schemaVersion };
      };
      const analyzed = await shared(`analysis:${sourceHash}:${analysisId}`, ctx.signal, analyze).catch(() => {
        if (ctx.signal?.aborted) throw cancelled(ctx.signal);
        return null;
      });
      if (!(await recheck())) return { status: "snapshot-missing", snapshotId };
      if (!analyzed || "unavailableReason" in analyzed) {
        return { ...base(found.ref, ""), overview: overview(probed, "unavailable"),
          analysis: { id: analysisId, parser, version: versionKey, configHash, toolVersions,
            sourceHash, pages, ocr: request.ocr === true, status: "unavailable" },
          structure: { unparsed: [analyzed && "unavailableReason" in analyzed ? analyzed.unavailableReason : "document analysis failed"] } };
      }
      const actualToolVersions = { pdfjs: probed.parserVersion,
        ...(parser === "docling" && analyzed.doclingVersion ? { docling: analyzed.doclingVersion } : {}),
        ...(parser === "native" && request.ocr === true && analyzed.ocrEngineVersion ? { tesseract: analyzed.ocrEngineVersion } : {}),
      };
      const finalVersion = [nativeVersion,
        ...(parser === "docling" ? [`docling:${analyzed.doclingVersion ?? "unavailable"}/schema:${analyzed.schemaVersion ?? "unknown"}`] : []),
        ...(parser === "native" && request.ocr === true ? [`ocr:${analyzed.ocrEngineVersion ?? "unavailable"}`] : []),
      ].join("/");
      const finalId = hash(`${sourceHash}:${configHash}:${finalVersion}`);
      const replaceAnalysisId = (structure: WebSnapshotStructure): void => {
        for (const entry of structure.layouts ?? []) entry.analysisId = finalId;
        for (const entry of structure.headings ?? []) entry.analysisId = finalId;
        for (const entry of structure.tables ?? []) entry.analysisId = finalId;
        for (const entry of structure.figures ?? []) entry.analysisId = finalId;
        for (const entry of structure.formulas ?? []) entry.analysisId = finalId;
        for (const entry of structure.blocks ?? []) entry.analysisId = finalId;
        for (const entry of structure.elements ?? []) entry.analysisId = finalId;
      };
      replaceAnalysisId(analyzed.structure);
      const analysis: DocumentAnalysis = { id: finalId, parser, version: finalVersion,
        configHash, toolVersions: actualToolVersions, sourceHash, pages, ocr: request.ocr === true,
        ...(analyzed.failedPages.length ? { failedPages: analyzed.failedPages } : {}),
        status: !analyzed.markdown.trim() && !analyzed.structure.elements?.length ? "unavailable"
          : analyzed.failedPages.length || (parser === "native" && request.ocr === true && analyzed.ocrUnavailable) ? "partial" : "ok" };
      const ref = await deps.materials.put(ctx.workspaceId, {
        sourceUrl: found.ref.sourceUrl, finalUrl: found.ref.finalUrl,
        ...(found.ref.contentType ? { contentType: found.ref.contentType } : {}), ...(found.ref.title ? { title: found.ref.title } : {}),
        representation: `pdf-${parser}-analysis`, structure: analyzed.structure,
        document: { kind: "pdf", parser, pageCount: probed.pageCount, pages: probed.pages, sourceSnapshotId,
          analysis, ...(parser === "native" ? { ocr: request.ocr === true
            ? { status: analyzed.ocrPages.length ? "used" : analyzed.ocrUnavailable ? "unavailable" : "not-needed",
              ...(analyzed.ocrEngine ? { engine: analyzed.ocrEngine } : {}), pages: analyzed.ocrPages }
            : { status: "not-requested" } } : {}) },
      }, Buffer.from(analyzed.markdown, "utf8"), ctx.authority, { source: { bytes: source, contentType: found.source.contentType } });
      analysisIndex.set(cacheKey, ref.snapshotId);
      derived = { ref, body: Buffer.from(analyzed.markdown, "utf8"), source: found.source };
    }
    if (!(await recheck())) return { status: "snapshot-missing", snapshotId };
    return presentAnalysis(derived, probed);
  };

  return { ingest, read };
};

export type DocumentReader = ReturnType<typeof createDocumentReader>;

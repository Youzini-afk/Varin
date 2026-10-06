import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { launchOwnedProcess, managedExitConfirmed, terminateOwnedProcess, waitForManagedExit,
  type ManagedProcessOwner, type ManagedSpawn } from "../process/types.js";

/** Every region uses the final, rotated page with a top-left origin. */
export interface PdfRegion { x: number; y: number; width: number; height: number }
export interface PdfPageInfo { page: number; width: number; height: number; rotation: number }
export interface PdfTextSegment { text: string; region: PdfRegion }
export interface PdfTextLine extends PdfTextSegment { segments: PdfTextSegment[]; readingIndex: number }
export interface PdfPageText extends PdfPageInfo { text: string; lines: PdfTextLine[]; parser: string; parserVersion: string }
export interface PdfPageImage {
  data: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
  /** Pixel-aligned crop, expressed in whole-page normalized coordinates. */
  region: PdfRegion;
  parser: string;
  parserVersion: string;
}
export interface PdfOcrLine extends PdfTextLine { confidence?: number }
export type PdfOcrResult =
  | { status: "ok"; text: string; lines: PdfOcrLine[]; engine: string; engineVersion: string }
  | { status: "unavailable"; reason: string };

export interface PdfStructureLocation { page: number; region: PdfRegion }
export interface PdfStructureCaption { id: string; text: string; regions: PdfStructureLocation[] }
export interface PdfTableCell {
  text: string;
  row: number;
  column: number;
  rowSpan?: number;
  columnSpan?: number;
  columnHeader?: boolean;
  rowHeader?: boolean;
  rowSection?: boolean;
  regions: PdfStructureLocation[];
}
export interface PdfStructureElement {
  id: string;
  kind: "section" | "table" | "figure" | "formula";
  page: number;
  region?: PdfRegion;
  regions: PdfStructureLocation[];
  text?: string;
  level?: number;
  startLine?: number;
  endLine?: number;
  captions: PdfStructureCaption[];
  cells?: PdfTableCell[];
}
export interface PdfReadingBlock {
  id: string;
  kind: "paragraph" | "section" | "table" | "figure" | "formula" | "caption" | "text";
  page: number;
  regions: PdfStructureLocation[];
  text: string;
  startLine: number;
  endLine: number;
}
export type PdfStructureResult =
  | { status: "ok"; parser: "docling"; parserVersion: string; schemaVersion: string; text: string; blocks: PdfReadingBlock[]; elements: PdfStructureElement[] }
  | { status: "unavailable"; reason: string };

export interface PdfEngineOptions {
  /** Trusted Host configuration. The adapter never invokes a shell. */
  doclingCommand?: string;
  tesseractCommand?: string;
  ocrLanguage?: string;
}
export interface PdfEngineRuntime {
  /** The Host's kernel-backed process service; no native process fallback is used. */
  spawn?: ManagedSpawn;
  /** A Host-owned, registered root in which temporary PDFs and PNGs can be staged. */
  temporaryRoot?: string;
}
export interface PdfInput { source: Buffer; signal?: AbortSignal }
export interface PdfPageInput extends PdfInput { page: number }
export interface PdfRenderInput extends PdfPageInput { region?: PdfRegion; scale?: number }
export interface PdfStructureInput extends PdfInput { pageRange?: { start: number; end: number }; ocr?: boolean }
export interface PdfVersionInput { parser?: "native" | "docling"; ocr?: boolean; signal?: AbortSignal }

const aborted = (signal?: AbortSignal): unknown => signal?.reason ?? new DOMException("PDF operation aborted", "AbortError");
const throwIfAborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw aborted(signal); };

const awaitWithAbort = <T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(aborted(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { onAbort?.(); reject(aborted(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};

const pdfAssets = (): { cMapUrl: string; standardFontDataUrl: string; wasmUrl: string; iccUrl: string } => {
  const require = createRequire(import.meta.url);
  const packageRoot = join(dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")), "..", "..");
  const unpackedRoot = packageRoot.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  const root = existsSync(join(unpackedRoot, "standard_fonts")) ? unpackedRoot : packageRoot;
  const assetUrl = (directory: string) => pathToFileURL(join(root, directory) + sep).href;
  return { cMapUrl: assetUrl("cmaps"), standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"), iccUrl: assetUrl("iccs") };
};

const withDocument = async <T>(input: PdfInput, action: (doc: PDFDocumentProxy, version: string) => Promise<T>): Promise<T> => {
  throwIfAborted(input.signal);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  throwIfAborted(input.signal);
  // PDF.js may transfer the supplied data to its worker. Never expose the caller's Buffer to that transfer.
  const loading = pdfjs.getDocument({ data: Uint8Array.from(input.source), ...pdfAssets(), cMapPacked: true });
  let destruction: Promise<void> | undefined;
  const destroy = (): void => { destruction ??= loading.destroy(); };
  try {
    const doc = await awaitWithAbort(loading.promise, input.signal, destroy);
    return await action(doc, pdfjs.version);
  } finally {
    destroy();
    await destruction?.catch(() => undefined);
  }
};

const checkedPage = async (doc: PDFDocumentProxy, pageNumber: number, signal?: AbortSignal): Promise<PDFPageProxy> => {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
    throw new RangeError(`PDF page ${pageNumber} is outside 1..${doc.numPages}`);
  }
  throwIfAborted(signal);
  return await awaitWithAbort(doc.getPage(pageNumber), signal);
};

const pageInfo = (page: PDFPageProxy, pageNumber: number): PdfPageInfo => {
  const viewport = page.getViewport({ scale: 1 });
  return { page: pageNumber, width: viewport.width, height: viewport.height, rotation: ((page.rotate % 360) + 360) % 360 };
};

const normalizeBox = (points: Array<[number, number]>, viewport: PageViewport): PdfRegion => {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const left = Math.max(0, Math.min(viewport.width, Math.min(...xs)));
  const top = Math.max(0, Math.min(viewport.height, Math.min(...ys)));
  const right = Math.max(left, Math.min(viewport.width, Math.max(...xs)));
  const bottom = Math.max(top, Math.min(viewport.height, Math.max(...ys)));
  return { x: left / viewport.width, y: top / viewport.height, width: (right - left) / viewport.width, height: (bottom - top) / viewport.height };
};

const textItemBox = (item: TextItem, viewport: PageViewport): PdfRegion => {
  const [a, b, c, d, x, y] = item.transform;
  const horizontalLength = Math.hypot(a ?? 0, b ?? 0) || 1;
  const verticalLength = Math.hypot(c ?? 0, d ?? 0) || 1;
  const hx = ((a ?? 0) / horizontalLength) * Math.max(0, item.width);
  const hy = ((b ?? 0) / horizontalLength) * Math.max(0, item.width);
  const vx = ((c ?? 0) / verticalLength) * Math.max(0, item.height);
  const vy = ((d ?? 0) / verticalLength) * Math.max(0, item.height);
  const px = x ?? 0;
  const py = y ?? 0;
  const point = (atX: number, atY: number): [number, number] => {
    const [screenX, screenY] = viewport.convertToViewportPoint(atX, atY);
    return [screenX, screenY];
  };
  return normalizeBox([
    point(px, py),
    point(px + hx, py + hy),
    point(px + vx, py + vy),
    point(px + hx + vx, py + hy + vy),
  ], viewport);
};

const unionRegions = (regions: PdfRegion[]): PdfRegion => {
  const x = Math.min(...regions.map((region) => region.x));
  const y = Math.min(...regions.map((region) => region.y));
  return {
    x, y,
    width: Math.max(...regions.map((region) => region.x + region.width)) - x,
    height: Math.max(...regions.map((region) => region.y + region.height)) - y,
  };
};

const extractPageFromDoc = async (doc: PDFDocumentProxy, pageNumber: number, version: string, signal?: AbortSignal): Promise<PdfPageText> => {
  const page = await checkedPage(doc, pageNumber, signal);
  const viewport = page.getViewport({ scale: 1 });
  const content = await awaitWithAbort(page.getTextContent(), signal);
  const lines: PdfTextLine[] = [];
  let current: PdfTextSegment[] = [];
  const flush = (): void => {
    if (!current.length) return;
    lines.push({ text: current.map((segment) => segment.text).join(" ").trim(), region: unionRegions(current.map((segment) => segment.region)), segments: current, readingIndex: lines.length });
    current = [];
  };
  for (const raw of content.items) {
    if (!("str" in raw) || typeof raw.str !== "string" || !raw.str.trim() || !Array.isArray(raw.transform)) continue;
    const item = raw as TextItem;
    const segment = { text: item.str, region: textItemBox(item, viewport) };
    const last = current.at(-1);
    if (last) {
      const baselineDistance = Math.abs(last.region.y + last.region.height - segment.region.y - segment.region.height);
      const typicalHeight = Math.max(last.region.height, segment.region.height);
      const gap = segment.region.x - last.region.x - last.region.width;
      // Follow the PDF content stream only while fragments are adjacent on one visual line.
      // A large same-y jump (notably into a second column) begins a distinct line.
      if (baselineDistance > typicalHeight * 0.5 || gap < -typicalHeight || gap > typicalHeight * 2) flush();
    }
    current.push(segment);
    if (item.hasEOL) flush();
  }
  flush();
  return { ...pageInfo(page, pageNumber), text: lines.map((line) => line.text).join("\n"), lines, parser: "pdfjs", parserVersion: version };
};

const validateRegion = (region?: PdfRegion): PdfRegion => {
  const value = region ?? { x: 0, y: 0, width: 1, height: 1 };
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)
      || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
      || value.x + value.width > 1 + Number.EPSILON || value.y + value.height > 1 + Number.EPSILON) {
    throw new RangeError("PDF region must be a non-empty rectangle within the normalized page");
  }
  return value;
};

const renderPageFromDoc = async (doc: PDFDocumentProxy, input: PdfRenderInput, version: string): Promise<PdfPageImage> => {
  const page = await checkedPage(doc, input.page, input.signal);
  const scale = input.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("PDF render scale must be positive");
  const region = validateRegion(input.region);
  const full = page.getViewport({ scale });
  const left = Math.floor(region.x * full.width);
  const top = Math.floor(region.y * full.height);
  const right = Math.ceil((region.x + region.width) * full.width);
  const bottom = Math.ceil((region.y + region.height) * full.height);
  const width = right - left;
  const height = bottom - top;
  const canvasFactory = doc.canvasFactory as {
    create(width: number, height: number): { canvas: NonNullable<Parameters<PDFPageProxy["render"]>[0]["canvas"]> & { toBuffer(mimeType: "image/png"): Buffer }; context: Parameters<PDFPageProxy["render"]>[0]["canvasContext"] };
    destroy(value: { canvas: unknown; context: unknown }): void;
  };
  const canvasAndContext = canvasFactory.create(width, height);
  try {
    const viewport = page.getViewport({ scale, offsetX: -left, offsetY: -top });
    const task = page.render({ canvas: canvasAndContext.canvas, canvasContext: canvasAndContext.context, viewport, background: "#ffffff" });
    try {
      await awaitWithAbort(task.promise, input.signal, () => task.cancel());
    } catch (error) {
      // PDF.js releases its canvas/render state when the task settles.
      await task.promise.catch(() => undefined);
      throw error;
    }
    throwIfAborted(input.signal);
    const data = canvasAndContext.canvas.toBuffer("image/png");
    const pageSize = page.getViewport({ scale: 1 });
    return { data, mimeType: "image/png", width, height, pageWidth: pageSize.width, pageHeight: pageSize.height,
      region: { x: left / full.width, y: top / full.height, width: width / full.width, height: height / full.height },
      parser: "pdfjs", parserVersion: version };
  } finally {
    canvasFactory.destroy(canvasAndContext);
  }
};

const executableExists = async (command: string): Promise<boolean> => {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const names = process.platform === "win32" && !extensions.some((extension) => command.toLowerCase().endsWith(extension.toLowerCase()))
    ? [command, ...extensions.map((extension) => command + extension)] : [command];
  const directories = isAbsolute(command) || command.includes(sep) || command.includes("/") ? [""] : (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  for (const directory of directories) {
    for (const name of names) {
      try {
        const file = await stat(directory ? join(directory, name) : name);
        if (file.isFile() && (process.platform === "win32" || (file.mode & 0o111) !== 0)) return true;
      } catch { /* continue along PATH */ }
    }
  }
  return false;
};

interface ProcessDirectoryState { safeToRemove: boolean }

const runCommand = async (
  spawn: ManagedSpawn, command: string, args: string[], cwd: string,
  signal?: AbortSignal, directoryState?: ProcessDirectoryState,
): Promise<{ stdout: string; stderr: string }> => {
  throwIfAborted(signal);
  const owner: ManagedProcessOwner = { child: null };
  let aborting: Promise<void> | undefined;
  const onAbort = (): void => { aborting ??= terminateOwnedProcess(owner, true); void aborting.catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const child = await launchOwnedProcess(owner, (launchSignal) => spawn(command, args, {
      cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal: launchSignal,
    }));
    if (directoryState) directoryState.safeToRemove = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    if (!child.stdout || !child.stderr) throw new Error("Managed process did not provide piped output");
    if (signal?.aborted) onAbort();
    await waitForManagedExit(child);
    if (directoryState) directoryState.safeToRemove = managedExitConfirmed(child);
    if (signal?.aborted) { await aborting; throw aborted(signal); }
    if (child.exitCode !== 0 || child.signalCode) {
      throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with ${child.signalCode ?? child.exitCode ?? "unknown"}`);
    }
    return { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } catch (error) {
    if (signal?.aborted) {
      await (aborting ?? terminateOwnedProcess(owner, true));
      if (directoryState) directoryState.safeToRemove = managedExitConfirmed(owner.child);
      throw aborted(signal);
    }
    if (directoryState) directoryState.safeToRemove = managedExitConfirmed(owner.child);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

export const parseTesseractTsv = (tsv: string, rendered: Pick<PdfPageImage, "width" | "height">, crop: PdfRegion): PdfOcrLine[] => {
  const [header, ...rows] = tsv.replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  if (!header) throw new Error("Tesseract returned no TSV header");
  const fields = header.split("\t");
  const index = (name: string): number => {
    const found = fields.indexOf(name);
    if (found < 0) throw new Error(`Tesseract TSV missing ${name}`);
    return found;
  };
  const columns = Object.fromEntries(["level", "page_num", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text"].map((name) => [name, index(name)])) as Record<string, number>;
  const lines: PdfOcrLine[] = [];
  let key = "";
  let words: PdfTextSegment[] = [];
  let confidence: number[] = [];
  const flush = (): void => {
    if (!words.length) return;
    lines.push({ text: words.map((word) => word.text).join(" "), region: unionRegions(words.map((word) => word.region)), segments: words, readingIndex: lines.length, confidence: confidence.reduce((sum, value) => sum + value, 0) / confidence.length });
    words = [];
    confidence = [];
  };
  for (const row of rows) {
    const values = row.split("\t");
    if (values[columns.level!] !== "5") continue;
    const word = values.slice(columns.text!).join("\t").trim();
    if (!word) continue;
    const nextKey = [values[columns.page_num!], values[columns.block_num!], values[columns.par_num!], values[columns.line_num!]].join(":");
    if (key && key !== nextKey) flush();
    key = nextKey;
    const left = Number(values[columns.left!]);
    const top = Number(values[columns.top!]);
    const width = Number(values[columns.width!]);
    const height = Number(values[columns.height!]);
    const conf = Number(values[columns.conf!]);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const x = crop.x + (left / rendered.width) * crop.width;
    const y = crop.y + (top / rendered.height) * crop.height;
    words.push({ text: word, region: {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      width: Math.max(0, Math.min(1, x + (width / rendered.width) * crop.width) - Math.max(0, Math.min(1, x))),
      height: Math.max(0, Math.min(1, y + (height / rendered.height) * crop.height) - Math.max(0, Math.min(1, y))),
    } });
    confidence.push(Number.isFinite(conf) ? conf : 0);
  }
  flush();
  return lines;
};

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

const doclingRegion = (provenance: JsonObject, pageSizes: Map<number, { width: number; height: number }>): PdfRegion | undefined => {
  const page = finite(provenance.page_no);
  const size = page === undefined ? undefined : pageSizes.get(page);
  const box = object(provenance.bbox);
  if (!size || !box) return undefined;
  const l = finite(box.l);
  const r = finite(box.r);
  const t = finite(box.t);
  const b = finite(box.b);
  if (l === undefined || r === undefined || t === undefined || b === undefined) return undefined;
  const left = Math.max(0, Math.min(size.width, Math.min(l, r)));
  const right = Math.max(left, Math.min(size.width, Math.max(l, r)));
  const top = box.coord_origin === "BOTTOMLEFT" ? size.height - Math.max(t, b) : Math.min(t, b);
  const bottom = box.coord_origin === "BOTTOMLEFT" ? size.height - Math.min(t, b) : Math.max(t, b);
  const clippedTop = Math.max(0, Math.min(size.height, top));
  const clippedBottom = Math.max(clippedTop, Math.min(size.height, bottom));
  return { x: left / size.width, y: clippedTop / size.height, width: (right - left) / size.width, height: (clippedBottom - clippedTop) / size.height };
};

const doclingRef = (value: unknown): string | undefined => string(object(value)?.$ref) ?? string(object(value)?.cref);

/** Map Docling's exported DoclingDocument JSON, retaining only identified structure. */
export const mapDoclingDocument = (raw: unknown, targetPages?: PdfPageInfo[]): {
  schemaVersion: string; text: string; blocks: PdfReadingBlock[]; elements: PdfStructureElement[]
} => {
  const document = object(raw);
  if (!document) throw new Error("Docling JSON is not a document object");
  const schemaVersion = string(document.version);
  if (!schemaVersion) throw new Error("Docling JSON has no schema version");
  const pages = object(document.pages);
  if (!pages) throw new Error("Docling JSON has no page geometry");
  const pageSizes = new Map<number, { width: number; height: number }>();
  for (const [number, value] of Object.entries(pages)) {
    const size = object(object(value)?.size);
    const width = finite(size?.width);
    const height = finite(size?.height);
    if (Number.isSafeInteger(Number(number)) && width && height) pageSizes.set(Number(number), { width, height });
  }
  const targets = targetPages ? new Map(targetPages.map((page) => [page.page, page])) : undefined;
  const alignLocations = (values: PdfStructureLocation[]): PdfStructureLocation[] => values.flatMap(({ page, region }) => {
    if (!targets) return [{ page, region }];
    const source = pageSizes.get(page);
    const target = targets.get(page);
    if (!source || !target) return [];
    const sourceRatio = source.width / source.height;
    const targetRatio = target.width / target.height;
    if (Math.abs(sourceRatio - targetRatio) < 0.01) return [{ page, region }];
    if (Math.abs(1 / sourceRatio - targetRatio) >= 0.01) return [];
    if (target.rotation === 90) return [{ page, region: { x: 1 - region.y - region.height, y: region.x, width: region.height, height: region.width } }];
    if (target.rotation === 270) return [{ page, region: { x: region.y, y: 1 - region.x - region.width, width: region.height, height: region.width } }];
    return [];
  });
  const texts = array(document.texts).map(object).filter((item): item is JsonObject => !!item);
  const refs = new Map<string, JsonObject>();
  for (const item of [...texts, ...array(document.tables).map(object), ...array(document.pictures).map(object), ...array(document.groups).map(object)]) {
    const ref = string(item?.self_ref);
    if (ref && item) refs.set(ref, item);
  }
  const locations = (item: JsonObject): PdfStructureLocation[] => alignLocations(array(item.prov).flatMap((rawProv) => {
    const prov = object(rawProv);
    const page = finite(prov?.page_no);
    const region = prov ? doclingRegion(prov, pageSizes) : undefined;
    return page !== undefined && region ? [{ page, region }] : [];
  }));
  const captionsFor = (item: JsonObject): PdfStructureCaption[] => {
    const linked = new Set<string>([
      ...array(item.captions).map(doclingRef),
      ...array(item.children).map(doclingRef),
    ].filter((ref): ref is string => !!ref));
    const self = string(item.self_ref);
    for (const caption of texts) if (caption.label === "caption" && doclingRef(caption.parent) === self) {
      const ref = string(caption.self_ref);
      if (ref) linked.add(ref);
    }
    return [...linked].flatMap((ref) => {
      const caption = refs.get(ref);
      const text = string(caption?.text);
      return caption?.label === "caption" && text ? [{ id: ref, text, regions: locations(caption) }] : [];
    });
  };
  const elements: PdfStructureElement[] = [];
  const add = (item: JsonObject, kind: PdfStructureElement["kind"]): void => {
    const id = string(item.self_ref);
    const provenance = array(item.prov).map(object).filter((entry): entry is JsonObject => !!entry);
    const page = provenance.map((entry) => finite(entry.page_no)).find((value) => value !== undefined);
    if (!id || page === undefined) return;
    const regions = locations(item);
    const text = string(item.text);
    const captions = kind === "table" || kind === "figure" ? captionsFor(item) : [];
    const entry: PdfStructureElement = { id, kind, page, regions, captions,
      ...(regions[0] ? { region: regions[0].region } : {}), ...(text ? { text } : {}) };
    const level = finite(item.level);
    if (kind === "section" && level !== undefined) entry.level = level;
    if (kind === "table") {
      const data = object(item.data);
      const tableCells = array(data?.table_cells).map(object).filter((cell): cell is JsonObject => !!cell);
      const gridCells = array(data?.grid).flatMap((row, rowIndex) => array(row).map((cell, columnIndex) => ({ cell: object(cell), rowIndex, columnIndex })));
      const sourceCells = tableCells.length ? tableCells.map((cell) => ({ cell, rowIndex: finite(cell.start_row_offset_idx), columnIndex: finite(cell.start_col_offset_idx) })) : gridCells;
      const seen = new Set<string>();
      entry.cells = sourceCells.flatMap(({ cell, rowIndex, columnIndex }) => {
        if (!cell) return [];
        const row = finite(cell.start_row_offset_idx) ?? rowIndex;
        const column = finite(cell.start_col_offset_idx) ?? columnIndex;
        if (row === undefined || column === undefined) return [];
        const key = `${row}:${column}:${string(cell.text) ?? ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        const cellRegions = locations(cell);
        const box = object(cell.bbox);
        if (!cellRegions.length && box && new Set(provenance.map((prov) => prov.page_no)).size === 1) {
          const region = doclingRegion({ page_no: page, bbox: box }, pageSizes);
          if (region) cellRegions.push(...alignLocations([{ page, region }]));
        }
        const rowSpan = finite(cell.row_span);
        const columnSpan = finite(cell.col_span);
        return [{ text: string(cell.text) ?? "", row, column, regions: cellRegions,
          ...(rowSpan !== undefined ? { rowSpan } : {}), ...(columnSpan !== undefined ? { columnSpan } : {}),
          ...(typeof cell.column_header === "boolean" ? { columnHeader: cell.column_header } : {}),
          ...(typeof cell.row_header === "boolean" ? { rowHeader: cell.row_header } : {}),
          ...(typeof cell.row_section === "boolean" ? { rowSection: cell.row_section } : {}),
        }];
      });
    }
    elements.push(entry);
  };
  for (const item of texts) {
    if (["section_header", "title"].includes(String(item.label))) add(item, "section");
    else if (item.label === "formula") add(item, "formula");
  }
  for (const item of array(document.tables).map(object)) if (item) add(item, "table");
  for (const item of array(document.pictures).map(object)) if (item) add(item, "figure");
  const byId = new Map(elements.map((element) => [element.id, element]));
  const blocks: PdfReadingBlock[] = [];
  const visited = new Set<string>();
  let line = 1;
  const walk = (ref: string): void => {
    if (visited.has(ref)) return;
    visited.add(ref);
    const item = refs.get(ref);
    if (!item) return;
    if (ref.startsWith("#/groups/")) {
      for (const child of array(item.children)) {
        const childRef = doclingRef(child);
        if (childRef) walk(childRef);
      }
      return;
    }
    const element = byId.get(ref);
    const label = string(item.label) ?? "";
    const kind: PdfReadingBlock["kind"] = element?.kind ?? (label === "caption" ? "caption" : label === "paragraph" ? "paragraph" : "text");
    let text = string(item.text) ?? "";
    let regions = locations(item);
    if (element?.kind === "table") {
      const rowGroups = new Map<number, PdfTableCell[]>();
      for (const cell of element.cells ?? []) rowGroups.set(cell.row, [...(rowGroups.get(cell.row) ?? []), cell]);
      const tableRows = [...rowGroups].sort(([left], [right]) => left - right)
        .map(([, cells]) => cells.sort((left, right) => left.column - right.column).map((cell) => cell.text).join("\t"));
      text = [...element.captions.map((caption) => caption.text), ...tableRows].join("\n");
      regions = [...element.regions, ...element.captions.flatMap((caption) => caption.regions)];
    } else if (element?.kind === "figure") {
      // Picture children often contain OCR of labels inside the drawing. Only linked captions
      // are prose; the visual figure remains separately addressable through its region.
      text = element.captions.map((caption) => caption.text).join("\n");
      regions = element.captions.flatMap((caption) => caption.regions);
    }
    text = text.trim();
    const page = element?.page ?? array(item.prov).map(object).map((prov) => finite(prov?.page_no)).find((value) => value !== undefined);
    if (text && page !== undefined) {
      const count = text.split("\n").length;
      const block: PdfReadingBlock = { id: ref, kind, page, regions, text, startLine: line, endLine: line + count - 1 };
      blocks.push(block);
      if (element) { element.startLine = block.startLine; element.endLine = block.endLine; }
      line += count;
    }
  };
  for (const child of array(object(document.body)?.children)) {
    const ref = doclingRef(child);
    if (ref) walk(ref);
  }
  return { schemaVersion, text: blocks.map((block) => block.text).join("\n"), blocks, elements };
};

/** Also used by the material cache before loading an individual PDF. */
export const PDF_ENGINE_VERSION = "pdfjs:6.4.299/adapter:3";

export const createPdfEngine = (options: PdfEngineOptions = {}, runtime: PdfEngineRuntime = {}) => {
  const identity = JSON.stringify({
    engine: PDF_ENGINE_VERSION,
    doclingCommand: options.doclingCommand ?? null,
    tesseractCommand: options.tesseractCommand ?? "tesseract",
    ocrLanguage: options.ocrLanguage ?? "eng",
  });
  const versions = async (input: PdfVersionInput = {}): Promise<{ pdfjs: string; docling?: string; tesseract?: string }> => {
    throwIfAborted(input.signal);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    throwIfAborted(input.signal);
    const result: { pdfjs: string; docling?: string; tesseract?: string } = { pdfjs: pdfjs.version };
    if (input.parser === "docling" && options.doclingCommand && runtime.spawn) {
      const available = await executableExists(options.doclingCommand);
      throwIfAborted(input.signal);
      if (available) {
        const release = await runCommand(runtime.spawn, options.doclingCommand, ["--version"], runtime.temporaryRoot ?? tmpdir(), input.signal);
        const output = (release.stdout + "\n" + release.stderr).trim();
        result.docling = /^Docling version:\s*([^\s]+)/im.exec(output)?.[1] ?? output.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown";
      }
    }
    if (input.ocr === true && input.parser !== "docling" && runtime.spawn) {
      const command = options.tesseractCommand ?? "tesseract";
      const available = await executableExists(command);
      throwIfAborted(input.signal);
      if (available) {
        const release = await runCommand(runtime.spawn, command, ["--version"], runtime.temporaryRoot ?? tmpdir(), input.signal);
        const output = (release.stdout + "\n" + release.stderr).trim();
        result.tesseract = /^tesseract\s+([^\s]+)/im.exec(output)?.[1] ?? output.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown";
      }
    }
    return result;
  };
  const probe = async (input: PdfInput): Promise<{ pageCount: number; pages: PdfPageInfo[]; parser: "pdfjs"; parserVersion: string }> =>
    await withDocument(input, async (doc, parserVersion) => {
      const pages: PdfPageInfo[] = [];
      for (let number = 1; number <= doc.numPages; number++) {
        const page = await checkedPage(doc, number, input.signal);
        pages.push(pageInfo(page, number));
      }
      return { pageCount: doc.numPages, pages, parser: "pdfjs", parserVersion };
    });

  const extractPage = async (input: PdfPageInput): Promise<PdfPageText> =>
    await withDocument(input, async (doc, version) => await extractPageFromDoc(doc, input.page, version, input.signal));

  const extractPages = async (input: PdfInput & { pages: number[] }): Promise<PdfPageText[]> =>
    await withDocument(input, async (doc, version) => {
      const output: PdfPageText[] = [];
      for (const number of input.pages) output.push(await extractPageFromDoc(doc, number, version, input.signal));
      return output;
    });

  const renderPage = async (input: PdfRenderInput): Promise<PdfPageImage> =>
    await withDocument(input, async (doc, version) => await renderPageFromDoc(doc, input, version));

  const ocrPage = async (input: PdfRenderInput): Promise<PdfOcrResult> => {
    throwIfAborted(input.signal);
    if (!runtime.spawn) return { status: "unavailable", reason: "Managed process runner is unavailable" };
    const command = options.tesseractCommand ?? "tesseract";
    const language = options.ocrLanguage ?? "eng";
    const available = await executableExists(command);
    throwIfAborted(input.signal);
    if (!available) return { status: "unavailable", reason: `Tesseract executable is unavailable: ${command}` };
    const root = await mkdtemp(join(runtime.temporaryRoot ?? tmpdir(), "varin-pdf-ocr-"));
    const directoryState: ProcessDirectoryState = { safeToRemove: true };
    try {
      throwIfAborted(input.signal);
      const release = await runCommand(runtime.spawn, command, ["--version"], root, input.signal, directoryState);
      const releaseText = release.stdout + "\n" + release.stderr;
      const version = /^tesseract\s+([^\s]+)/im.exec(releaseText)?.[1] ?? releaseText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
      if (!version) throw new Error("Tesseract did not report its version");
      const rendered = await renderPage(input);
      const path = join(root, "page.png");
      await writeFile(path, rendered.data);
      const result = await runCommand(runtime.spawn, command, [path, "stdout", "-l", language, "--psm", "3", "tsv"], root, input.signal, directoryState);
      const lines = parseTesseractTsv(result.stdout, rendered, rendered.region);
      return { status: "ok", text: lines.map((line) => line.text).join("\n"), lines, engine: `tesseract:${language}`, engineVersion: version };
    } finally {
      if (directoryState.safeToRemove) await rm(root, { recursive: true, force: true });
    }
  };

  const parseStructure = async (input: PdfStructureInput): Promise<PdfStructureResult> => {
    throwIfAborted(input.signal);
    if (!options.doclingCommand) return { status: "unavailable", reason: "Docling executable is not configured" };
    if (!runtime.spawn) return { status: "unavailable", reason: "Managed process runner is unavailable" };
    const available = await executableExists(options.doclingCommand);
    throwIfAborted(input.signal);
    if (!available) return { status: "unavailable", reason: `Docling executable is unavailable: ${options.doclingCommand}` };
    const pageRange = input.pageRange ?? { start: 1, end: (await probe(input)).pageCount };
    if (!Number.isSafeInteger(pageRange.start) || !Number.isSafeInteger(pageRange.end)
        || pageRange.start < 1 || pageRange.end < pageRange.start) {
      throw new RangeError("Docling page range must be a one-based contiguous range");
    }
    const root = await mkdtemp(join(runtime.temporaryRoot ?? tmpdir(), "varin-pdf-docling-"));
    const directoryState: ProcessDirectoryState = { safeToRemove: true };
    try {
      throwIfAborted(input.signal);
      const release = await runCommand(runtime.spawn, options.doclingCommand, ["--version"], root, input.signal, directoryState);
      const releaseText = (release.stdout + "\n" + release.stderr).trim();
      const parserVersion = /^Docling version:\s*([^\s]+)/im.exec(releaseText)?.[1] ?? releaseText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "unknown";
      const source = join(root, "source.pdf");
      await writeFile(source, input.source);
      await runCommand(runtime.spawn, options.doclingCommand, [
        "convert", source, "--from", "pdf", "--to", "json", "--output", root,
        "--page-range", `${pageRange.start}-${pageRange.end}`, "--image-export-mode", "placeholder",
        ...(input.ocr === true ? ["--ocr-mode", "full_page"] : []),
      ], root, input.signal, directoryState);
      throwIfAborted(input.signal);
      const document = JSON.parse(await readFile(join(root, "source.json"), "utf8")) as unknown;
      const metadata = await probe(input);
      const mapped = mapDoclingDocument(document, metadata.pages);
      return { status: "ok", parser: "docling", parserVersion, schemaVersion: mapped.schemaVersion,
        text: mapped.text, blocks: mapped.blocks, elements: mapped.elements };
    } finally {
      if (directoryState.safeToRemove) await rm(root, { recursive: true, force: true });
    }
  };

  return { identity, versions, probe, extractPage, extractPages, renderPage, ocrPage, parseStructure };
};

export type PdfEngine = ReturnType<typeof createPdfEngine>;

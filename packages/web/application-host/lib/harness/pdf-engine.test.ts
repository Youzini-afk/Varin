import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ManagedSpawn } from "../process/types.js";
import { createPdfEngine, mapDoclingDocument, parseTesseractTsv } from "./pdf-engine.js";

import { makePdf } from "./pdf-test-fixture.js";
const pdfjsVersion = (await import("pdfjs-dist/legacy/build/pdf.mjs")).version;

describe("PDF engine", () => {
  it("extracts separate same-baseline columns and renders a cropped rotated page", async () => {
    const engine = createPdfEngine();
    const source = makePdf(90);
    const probe = await engine.probe({ source });
    expect(probe).toMatchObject({ pageCount: 1, parser: "pdfjs", pages: [{ page: 1, width: 100, height: 200, rotation: 90 }] });
    const text = await engine.extractPage({ source, page: 1 });
    expect(text.lines.map((line) => line.text)).toEqual(["LEFT", "RIGHT"]);
    expect(text.lines[0]?.region.y).toBeLessThan(text.lines[1]!.region.y);
    expect(text.lines.every((line) => line.region.x >= 0 && line.region.x + line.region.width <= 1)).toBe(true);
    const image = await engine.renderPage({ source, page: 1, region: { x: 0.5, y: 0, width: 0.5, height: 0.5 }, scale: 2 });
    expect(image).toMatchObject({ mimeType: "image/png", width: 100, height: 200, pageWidth: 100, pageHeight: 200 });
    expect(image.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(image.data.readUInt32BE(16)).toBe(100);
    expect(image.data.readUInt32BE(20)).toBe(200);
  });

  it("renders only the requested normalized crop with the right page pixels", async () => {
    const image = await createPdfEngine().renderPage({ source: makePdf(), page: 1, scale: 2,
      region: { x: 0, y: 0.6, width: 0.5, height: 0.4 } });
    expect([image.width, image.height]).toEqual([200, 80]);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(await loadImage(image.data), 0, 0);
    expect([...context.getImageData(40, 20, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(180, 20, 1, 1).data]).toEqual([255, 255, 255, 255]);
  });

  it("honors cancellation and reports absent optional components", async () => {
    const engine = createPdfEngine({ doclingCommand: "does-not-exist-docling", tesseractCommand: "does-not-exist-tesseract" });
    const source = makePdf();
    await expect(engine.versions({ parser: "native", ocr: false })).resolves.toEqual({ pdfjs: pdfjsVersion });
    const controller = new AbortController();
    controller.abort();
    await expect(engine.renderPage({ source, page: 1, signal: controller.signal })).rejects.toBeTruthy();
    await expect(engine.ocrPage({ source, page: 1, signal: controller.signal })).rejects.toBeTruthy();
    await expect(engine.parseStructure({ source, signal: controller.signal })).rejects.toBeTruthy();
    const running = new AbortController();
    const pending = engine.extractPage({ source, page: 1, signal: running.signal });
    running.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(engine.extractPage({ source, page: 2 })).rejects.toThrow(RangeError);
    await expect(engine.ocrPage({ source, page: 1 })).resolves.toMatchObject({ status: "unavailable" });
    await expect(engine.parseStructure({ source, pageRange: { start: 1, end: 1 } })).resolves.toMatchObject({ status: "unavailable" });
  });

  it("maps Docling document structure, bottom-left boxes and linked captions", () => {
    const mapped = mapDoclingDocument({
      version: "1.8.0",
      pages: { "1": { size: { width: 200, height: 100 } }, "2": { size: { width: 200, height: 100 } } },
      body: { children: [{ $ref: "#/texts/3" }, { $ref: "#/groups/0" }, { $ref: "#/tables/0" }, { $ref: "#/pictures/0" }] },
      groups: [{ self_ref: "#/groups/0", children: [{ $ref: "#/texts/0" }, { $ref: "#/texts/2" }] }],
      texts: [
        { self_ref: "#/texts/0", label: "section_header", text: "Methods", prov: [{ page_no: 1, bbox: { l: 10, r: 80, t: 90, b: 80, coord_origin: "BOTTOMLEFT" } }] },
        { self_ref: "#/texts/1", label: "caption", text: "Figure 1. Result", parent: { $ref: "#/pictures/0" }, prov: [{ page_no: 1, bbox: { l: 20, r: 180, t: 20, b: 10, coord_origin: "BOTTOMLEFT" } }] },
        { self_ref: "#/texts/2", label: "formula", text: "a=b", prov: [{ page_no: 1, bbox: { l: 20, r: 70, t: 70, b: 60, coord_origin: "BOTTOMLEFT" } }] },
        { self_ref: "#/texts/3", label: "text", text: "Opening paragraph", prov: [{ page_no: 1, bbox: { l: 10, r: 140, t: 95, b: 90, coord_origin: "BOTTOMLEFT" } }] },
      ],
      tables: [{ self_ref: "#/tables/0", prov: [
        { page_no: 1, bbox: { l: 10, r: 100, t: 50, b: 30, coord_origin: "BOTTOMLEFT" } },
        { page_no: 2, bbox: { l: 10, r: 100, t: 80, b: 60, coord_origin: "BOTTOMLEFT" } },
      ], data: { table_cells: [
        { text: "A", start_row_offset_idx: 0, start_col_offset_idx: 0, row_span: 2, col_span: 1, column_header: true, row_header: false, row_section: false },
        { text: "B", start_row_offset_idx: 0, start_col_offset_idx: 1, row_span: 1, col_span: 1, column_header: true, row_header: false, row_section: false },
      ] } }],
      pictures: [{ self_ref: "#/pictures/0", prov: [{ page_no: 1, bbox: { l: 20, r: 180, t: 75, b: 25, coord_origin: "BOTTOMLEFT" } }], children: [{ $ref: "#/texts/1" }] }],
    });
    expect(mapped.schemaVersion).toBe("1.8.0");
    expect(mapped.elements.map((item) => item.kind)).toEqual(["section", "formula", "table", "figure"]);
    expect(mapped.elements[0]?.region).toEqual({ x: 0.05, y: 0.1, width: 0.35, height: 0.1 });
    expect(mapped.elements[3]?.captions[0]?.text).toBe("Figure 1. Result");
    expect(mapped.elements[2]?.cells?.map((cell) => cell.text)).toEqual(["A", "B"]);
    expect(mapped.elements[2]?.cells?.[0]).toMatchObject({ row: 0, column: 0, rowSpan: 2, columnSpan: 1, columnHeader: true });
    expect(mapped.elements[0]?.startLine).toBe(2);
    expect(mapped.blocks.map((block) => block.id)).toEqual(["#/texts/3", "#/texts/0", "#/texts/2", "#/tables/0", "#/pictures/0"]);
    expect(mapped.elements[2]?.regions.map((region) => region.page)).toEqual([1, 2]);
    expect(mapped.text).toContain("Opening paragraph\nMethods\na=b");
  });

  it("aligns unrotated Docling page boxes with PDF.js rotated page coordinates", () => {
    const mapped = mapDoclingDocument({
      version: "1.8.0", pages: { "1": { size: { width: 200, height: 100 } } },
      texts: [{ self_ref: "#/texts/0", label: "formula", text: "x=1",
        prov: [{ page_no: 1, bbox: { l: 20, r: 60, t: 10, b: 30, coord_origin: "TOPLEFT" } }] }],
    }, [{ page: 1, width: 100, height: 200, rotation: 90 }]);
    expect(mapped.elements[0]?.region?.x).toBeCloseTo(0.7);
    expect(mapped.elements[0]?.region?.y).toBeCloseTo(0.1);
    expect(mapped.elements[0]?.region?.width).toBeCloseTo(0.2);
    expect(mapped.elements[0]?.region?.height).toBeCloseTo(0.2);
  });

  it("keeps Tesseract word boxes in whole-page coordinates after OCR of a crop", () => {
    const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    const lines = parseTesseractTsv([
      header,
      "5\t1\t1\t1\t1\t1\t10\t20\t30\t10\t95\tHello",
      "5\t1\t1\t1\t1\t2\t50\t20\t20\t10\t90\tworld",
    ].join("\n"), { width: 100, height: 100 }, { x: 0.25, y: 0.5, width: 0.5, height: 0.5 });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("Hello world");
    expect(lines[0]?.segments[0]?.region.x).toBeCloseTo(0.3);
    expect(lines[0]?.segments[0]?.region.y).toBeCloseTo(0.6);
    expect(lines[0]?.segments[0]?.region.width).toBeCloseTo(0.15);
    expect(lines[0]?.segments[0]?.region.height).toBeCloseTo(0.05);
  });

  it("uses Docling's full-page OCR mode without probing Tesseract", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "varin-pdf-engine-test-"));
    const commands: string[][] = [];
    const spawn: ManagedSpawn = async (_command, args, options) => {
      commands.push([...args]);
      if (args[0] === "convert") await writeFile(join(String(options.cwd), "source.json"), JSON.stringify({
        version: "1.10.0", pages: { "1": { size: { width: 200, height: 100 } } },
        body: { children: [{ $ref: "#/texts/0" }] },
        texts: [{ self_ref: "#/texts/0", label: "text", text: "OCR body", prov: [{ page_no: 1,
          bbox: { l: 10, t: 10, r: 80, b: 30, coord_origin: "TOPLEFT" } }] }],
      }));
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const completion = new Promise<void>((resolve) => setImmediate(() => {
        stdout.end(args[0] === "--version" ? "Docling version: 2.130.0\n" : "");
        stderr.end();
        resolve();
      }));
      return Object.assign(new EventEmitter(), { stdout, stderr, stdin: null, exitCode: 0,
        signalCode: null, killed: false, exitConfirmed: true, completion, kill: () => false });
    };
    try {
      const engine = createPdfEngine({ doclingCommand: process.execPath, tesseractCommand: process.execPath }, { spawn, temporaryRoot });
      expect(await engine.versions({ parser: "docling", ocr: true })).toEqual({ pdfjs: pdfjsVersion, docling: "2.130.0" });
      expect(commands).toEqual([["--version"]]);
      const source = makePdf();
      const forced = await engine.parseStructure({ source, pageRange: { start: 1, end: 1 }, ocr: true });
      expect(forced).toMatchObject({ status: "ok", text: "OCR body", parserVersion: "2.130.0" });
      expect(commands.find((args) => args[0] === "convert")).toEqual(expect.arrayContaining(["--ocr-mode", "full_page"]));
      const regular = await engine.parseStructure({ source, pageRange: { start: 1, end: 1 }, ocr: false });
      expect(regular.status).toBe("ok");
      expect(commands.filter((args) => args[0] === "convert")[1]).not.toContain("--ocr-mode");
      expect(await readdir(temporaryRoot)).toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

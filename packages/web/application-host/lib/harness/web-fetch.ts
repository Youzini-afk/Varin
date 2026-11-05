import { TextDecoder } from "node:util";
import { selectWebPageText, rankWebPagePassages, validateWebPassageRanges, webPageBlocks, webPageEndLine } from "@varin/protocol";
import type { FetchResult, HarnessWebDomainPolicy, WebFetchRequest, WebReadPosition, WebSnapshotStructure, WebAcquisition, WebTextRange, WebPageSelection, WebPassageCandidate, WebPassageRange, WebSnapshotRef, BrowserRenderRequest, BrowserRenderResult } from "@varin/protocol";
import { isSameHost } from "./ssrf-policy.js";
import { EGRESS_TIMEOUT, EgressError, type EgressRuntime } from "./egress.js";
import type { WebMaterialStore, WebMaterialAuthority } from "./web-materials.js";
import type { AlternateDocumentReader } from "./document-material.js";
import { createDocumentReader, type DocumentReader, type DocumentReaderContext } from "./document-reading.js";

export interface SsrfPolicy {
  check(url: string): Promise<{ blocked: boolean; reason?: "private-network" | "scheme" | "special-purpose" }>;
  isSameHost(url1: string, url2: string): boolean;
}

export type DomainPolicy = HarnessWebDomainPolicy;

export type WebPassageSelectionResult = WebPassageRange[] | null | {
  ranges?: WebPassageRange[];
  reason?: string;
  assistance?: WebPageSelection["assistance"];
};
export type WebPassageSelector = (input: {
  question: string;
  markdown: string;
  structure?: WebSnapshotStructure;
  candidates: WebPassageCandidate[];
  source?: Pick<WebSnapshotRef, "snapshotId" | "contentHash" | "sourceUrl" | "title">;
  signal?: AbortSignal;
}) => Promise<WebPassageSelectionResult>;

export interface WebFetchDeps {
  ssrf: SsrfPolicy;
  /** Outbound egress authority; absent keeps the legacy bare-fetch path. */
  egress?: EgressRuntime;
  domainPolicy?: (workspaceId: string) => DomainPolicy;
  renderer?: (request: BrowserRenderRequest) => Promise<BrowserRenderResult>;
  rendererId?: string;
  selectPassages?: WebPassageSelector;
  alternateDocumentReader?: AlternateDocumentReader;
  cacheTtlMs?: number;
  maxBytes?: number;
  /** Durable snapshot store; when absent fetches still deliver content but mint no snapshotId. */
  materials?: Pick<WebMaterialStore, "put" | "read"> & Partial<Pick<WebMaterialStore, "findAnalysis">>;
  /** Shared with the independent document-reading Host service. */
  documentReader?: DocumentReader;
}

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
  /** Raw PDF bytes remain available for a later authority rebind. */
  sourceBytes?: Buffer;
}

export interface FetchContext {
  workspaceId: string;
  authority: WebMaterialAuthority;
  render?: boolean;
  /** Frozen trusted Host configuration, never inferred from renderer presence. */
  allowRenderFallback?: boolean;
  selectPassages?: WebPassageSelector;
  alternateDocumentReader?: AlternateDocumentReader;
  domainPolicy?: DomainPolicy;
  signal?: AbortSignal;
  /** A caller-requested refresh must create a new snapshot record even when
   * the fetched bytes are unchanged. */
  forceNewSnapshot?: boolean;
  engineOptions?: DocumentReaderContext["engineOptions"];
}

interface SharedFetch {
  controller: AbortController;
  promise: Promise<FetchResult>;
  waiters: number;
  done: boolean;
}

const DEFAULT_CACHE_TTL_MS = 900_000; // 15 minutes
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_REDIRECTS = 5;

export function createWebFetch(deps: WebFetchDeps) {
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive byte limit");
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new Error("cacheTtlMs must be non-negative");
  const cache = new Map<string, CacheEntry>();
  let disposed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const pruneCache = (): void => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    if (disposed || !cache.size) return;
    const next = Math.min(...[...cache.values()].map(entry => entry.expiresAt));
    expiryTimer = setTimeout(pruneCache, Math.max(1, next - now));
    expiryTimer.unref?.();
  };
  const cacheResult = (key: string, entry: CacheEntry): void => {
    if (disposed || cacheTtlMs <= 0) return;
    cache.set(key, entry);
    pruneCache();
  };
  /** Ties in-flight delivery to the exact response, even if another request
   * overwrites the URL cache before this caller resumes. */
  const sourceBytesForResult = new WeakMap<Extract<FetchResult, { status: "ok" }>, Buffer>();
  const documentReader = deps.documentReader ?? (deps.materials ? createDocumentReader({ materials: deps.materials }) : undefined);
  const documentContext = (ctx: FetchContext): DocumentReaderContext => {
    const domainPolicy = ctx.domainPolicy ?? deps.domainPolicy?.(ctx.workspaceId);
    return {
      workspaceId: ctx.workspaceId, authority: ctx.authority,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(domainPolicy ? { domainPolicy } : {}),
      ...(ctx.engineOptions ? { engineOptions: ctx.engineOptions } : {}),
    };
  };
  const checkDomainPolicy = (
    url: string,
    workspaceId: string,
    override?: DomainPolicy,
  ): { blocked: boolean; reason?: "domain-blocked" } => {
    const policy = override ?? deps.domainPolicy?.(workspaceId) ?? { block: [] };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { blocked: true };
    }
    const hostname = parsed.hostname.toLowerCase();

    // Block list
    if (policy.block.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
      return { blocked: true, reason: "domain-blocked" };
    }

    // Allow list (whitelist mode if non-empty)
    if (policy.allow !== undefined) {
      if (!policy.allow.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
        return { blocked: true, reason: "domain-blocked" };
      }
    }

    return { blocked: false };
  };

  const extractContent = async (html: string, contentType: string): Promise<{ markdown: string; title?: string; extraction: WebAcquisition["extraction"] }> => {
    // For text/* content, pass through directly
    if (contentType.startsWith("text/plain") || contentType.startsWith("text/csv") || contentType.startsWith("text/yaml")) {
      return { markdown: html, extraction: { status: "complete" } };
    }

    // For HTML, use readability + turndown
    if (contentType.startsWith("text/html") || contentType.includes("xml")) {
      return await extractHtmlContent(html);
    }

    // For other content types, return raw
    return { markdown: html, extraction: { status: "complete" } };
  };

  const extractHtmlContent = async (html: string): Promise<{ markdown: string; title?: string; extraction: WebAcquisition["extraction"] }> => {
    try {
      // linkedom provides a DOM implementation compatible with @mozilla/readability
      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);
      const pageTitle = document.querySelector("title")?.textContent?.trim();
      // Executable and presentation text is not page content. Keep the body
      // before Readability mutates the DOM so short/non-article pages retain
      // their text, links and headings through the same Markdown converter.
      for (const node of document.querySelectorAll("script, style, template")) node.remove();
      const bodyHtml = document.querySelector("body")?.innerHTML ?? document.toString();
      const structured = document.querySelector("main, article")?.innerHTML;
      const technical = Boolean(document.querySelector("pre, table"));

      const { Readability } = await import("@mozilla/readability");
      const Turndown = (await import("turndown")).default;

      const reader = new Readability(document);
      const article = reader.parse();

      const turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
      // Keep simple tables as GFM and complex spanning-cell tables as HTML so
      // their relationships are not silently flattened into unrelated text.
      turndown.addRule("source-table", {
        filter: "table",
        replacement: (_content, node) => {
          const table = node as unknown as { outerHTML: string; querySelectorAll(selector: string): ArrayLike<{ querySelectorAll(selector: string): ArrayLike<{ textContent: string | null; innerHTML: string; tagName: string; getAttribute(name: string): string | null }> }> };
          const rows = Array.from(table.querySelectorAll("tr")).map(row => Array.from(row.querySelectorAll("th, td")));
          if (!rows.length) return "";
          if (rows.some(row => row.some(cell => Number(cell.getAttribute("colspan") ?? 1) > 1 || Number(cell.getAttribute("rowspan") ?? 1) > 1))) return `\n\n${table.outerHTML}\n\n`;
          const width = Math.max(...rows.map(row => row.length));
          const textRows = rows.map(row => `| ${Array.from({ length: width }, (_, index) => (row[index] ? turndown.turndown(row[index]!.innerHTML) : "").trim().replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br> ")).join(" | ")} |`);
          if (!rows[0]!.some(cell => cell.tagName.toLowerCase() === "th")) textRows.unshift(`| ${Array(width).fill("").join(" | ")} |`);
          textRows.splice(1, 0, `| ${Array(width).fill("---").join(" | ")} |`);
          return `\n\n${textRows.join("\n")}\n\n`;
        },
      });
      const markdown = turndown.turndown(technical ? structured || bodyHtml : article?.content || bodyHtml);
      const title = article?.title || pageTitle;
      return { markdown, extraction: { status: "unknown", detail: "HTML main-content extraction; coverage outside the retained representation is not guaranteed." }, ...(title !== undefined ? { title } : {}) };
    } catch {
      // Fallback: strip HTML tags
      const text = html.replace(/<(head|script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<[^>]*>/g, "").trim();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch?.[1]?.trim();
      return { markdown: text, extraction: { status: "partial", detail: "HTML parser failed; fallback text may omit structure and content." }, ...(title !== undefined ? { title } : {}) };
    }
  };

  // Cancellation asks the original producer to stop. Its actual return is the
  // drain evidence; a rejected observer race cannot release its last holder.
  const awaitAbortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    const value = await promise;
    signal.throwIfAborted();
    return value;
  };

  // Markdown structure belongs to this HTML/text path. PDF structure is produced only by the document engine.
  const detectStructure = (markdown: string): WebSnapshotStructure => {
    const lines = markdown.split("\n");
    const headings: NonNullable<WebSnapshotStructure["headings"]> = [];
    const tables: NonNullable<WebSnapshotStructure["tables"]> = [];
    const figures: NonNullable<WebSnapshotStructure["figures"]> = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      const fence = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        index += 1;
        while (index < lines.length) {
          const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[index]!);
          index += 1;
          if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) break;
        }
        continue;
      }
      if (/^\s*<table(?:\s|>)/i.test(line)) {
        const startLine = index + 1;
        while (index < lines.length && !/<\/table>/i.test(lines[index]!)) index += 1;
        tables.push({ startLine, endLine: Math.min(lines.length, index + 1) });
        index += 1;
        continue;
      }
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading?.[1] && heading[2]) headings.push({ title: heading[2], level: heading[1].length, line: index + 1 });
      const image = /!\[([^\]]*)\]\([^)]*\)/.exec(line);
      if (image) figures.push(image[1] ? { line: index + 1, title: image[1] } : { line: index + 1 });
      if (line.trim().startsWith("|") && index + 1 < lines.length && /^\|?\s*:?-{2,}/.test((lines[index + 1] ?? "").trim())) {
        let end = index + 1;
        while (end + 1 < lines.length && (lines[end + 1] ?? "").trim().startsWith("|")) end += 1;
        tables.push({ startLine: index + 1, endLine: end + 1 });
        index = end + 1;
        continue;
      }
      index += 1;
    }
    return {
      ...(headings.length ? { headings } : {}),
      ...(tables.length ? { tables } : {}),
      ...(figures.length ? { figures } : {}),
      unparsed: ["pages"],
    };
  };

  const SECTION_END_LEVEL = (level: number): number => level;

  const resolvePosition = (
    markdown: string,
    structure: WebSnapshotStructure | undefined,
    position: WebReadPosition,
    snapshotId: string,
  ): { body: string; range: { startLine: number; endLine: number; totalLines: number } } | FetchResult => {
    const lines = markdown.split("\n");
    const totalLines = lines.length;
    const notFound = (detail: string): FetchResult => ({ status: "position-not-found", snapshotId, detail });
    const unsupported = (kind: string): FetchResult => ({ status: "structure-unsupported", snapshotId, kind });
    const slice = (startLine: number, endLine: number): { body: string; range: { startLine: number; endLine: number; totalLines: number } } => ({
      body: lines.slice(startLine - 1, Math.min(endLine, totalLines)).join("\n"),
      range: { startLine, endLine: Math.min(endLine, totalLines), totalLines },
    });
    switch (position.kind) {
      case "lines": {
        if (position.startLine < 1 || position.startLine > totalLines) {
          return notFound(`lines ${position.startLine}.. outside 1..${totalLines}`);
        }
        return slice(position.startLine, position.endLine ?? totalLines);
      }
      case "page": {
        if (!structure?.pages?.length) return unsupported("pages");
        const page = structure.pages.find((entry) => entry.page === position.page);
        if (!page) return notFound(`page ${position.page} outside 1..${structure.pages.length}`);
        return slice(page.startLine, page.endLine);
      }
      case "section": {
        if (!structure?.headings?.length) return unsupported("headings");
        const needle = position.title.trim().toLowerCase();
        const heading = structure.headings.find((entry) => entry.title.toLowerCase().includes(needle));
        if (!heading) return notFound(`no section matching "${position.title}"`);
        const next = structure.headings.find(
          (entry) => entry.line > heading.line && entry.level <= SECTION_END_LEVEL(heading.level),
        );
        return slice(heading.line, (next?.line ?? totalLines + 1) - 1);
      }
      case "appendix": {
        if (!structure?.headings?.length) return unsupported("headings");
        const heading = structure.headings.find((entry) =>
          /^(appendix|appendices|supplementary\b|supplement\b|annex\b|附录)/i.test(entry.title.trim()));
        if (!heading) return notFound("no appendix/supplementary section");
        const next = structure.headings.find(
          (entry) => entry.line > heading.line && entry.level <= heading.level,
        );
        return slice(heading.line, (next?.line ?? totalLines + 1) - 1);
      }
      case "element": {
        const list = position.element === "table"
          ? structure?.tables
          : position.element === "figure" ? structure?.figures : structure?.formulas;
        if (!list?.length) return unsupported(`${position.element}s`);
        const entry = list[position.index - 1];
        if (!entry) return notFound(`${position.element} ${position.index} outside 1..${list.length}`);
        const startLine = "startLine" in entry ? entry.startLine : entry.line;
        const endLine = "endLine" in entry ? entry.endLine : entry.line;
        return slice(startLine, endLine);
      }
    }
  };

  type Selection = {
    body: string;
    range?: WebTextRange;
    ranges: WebTextRange[];
    selection: WebPageSelection;
    nextRead?: WebFetchRequest;
  };
  const selectText = async (markdown: string, structure: WebSnapshotStructure | undefined, request: WebFetchRequest, snapshotId: string, ctx: FetchContext, source?: WebSnapshotRef): Promise<Selection | FetchResult> => {
    const lines = markdown.split("\n");
    const totalLines = lines.length;
    const maxLines = request.maxLines ?? 160;
    const wholeRange = { startLine: 1, endLine: totalLines, totalLines };
    const selected = request.position ? resolvePosition(markdown, structure, request.position, snapshotId) : { body: markdown, range: wholeRange };
    if (!("body" in selected)) return selected;
    const range = selected.range;
    if (request.find !== undefined) {
      const matching = new Set<number>();
      for (let index = range.startLine - 1; index < range.endLine; index += 1) {
        if (!lines[index]!.toLowerCase().includes(request.find.toLowerCase())) continue;
        for (let context = Math.max(range.startLine, index - 2); context <= Math.min(range.endLine, index + 4); context += 1) matching.add(context);
      }
      const ranges = validateWebPassageRanges([...matching].map(line => ({ startLine: line, endLine: line })), totalLines) ?? [];
      return { body: selectWebPageText(markdown, { find: request.find, start_line: range.startLine, end_line: range.endLine }),
        ...(request.position ? { range } : {}), ranges: ranges.map(value => ({ ...value, totalLines })),
        selection: { method: "literal", matched: ranges.length > 0, searchedRange: range } };
    }
    if (request.question?.trim() && !request.position) {
      // If the original page already fits the requested display, selecting it
      // again adds latency and can hide the answer (especially across languages).
      if (totalLines <= maxLines && markdown.length <= 24_000) {
        return { body: markdown, range: wholeRange, ranges: [wholeRange],
          selection: { method: "page", question: request.question, matched: true } };
      }
      const candidates = rankWebPagePassages(markdown, request.question);
      const blocks = webPageBlocks(markdown);
      const chosen: WebPassageRange[] = [];
      let usedLines = 0;
      let usedCharacters = 0;
      for (const candidate of candidates) {
        // Defaults are an output budget, not a relevance threshold or a refusal.
        if (chosen.length && (chosen.length >= 6 || usedLines + candidate.endLine - candidate.startLine + 1 > maxLines || usedCharacters + candidate.text.length > 24_000)) continue;
        chosen.push(candidate);
        usedLines += candidate.endLine - candidate.startLine + 1;
        usedCharacters += candidate.text.length;
      }
      let ranges = validateWebPassageRanges(chosen, totalLines) ?? [];
      let method: WebPageSelection["method"] = "question";
      let detail: string | undefined;
      let assistance: WebPageSelection["assistance"];
      const helper = ctx.selectPassages ?? deps.selectPassages;
      if (helper) {
        try {
          ctx.signal?.throwIfAborted();
          const proposed = await helper({ question: request.question, markdown, ...(structure ? { structure } : {}),
            candidates, ...(source ? { source: { snapshotId: source.snapshotId, contentHash: source.contentHash, sourceUrl: source.sourceUrl, ...(source.title ? { title: source.title } : {}) } } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
          ctx.signal?.throwIfAborted();
          const response = proposed && !Array.isArray(proposed) ? proposed : undefined;
          const proposedRanges = response ? response.ranges : proposed;
          const validated = Array.isArray(proposedRanges) && proposedRanges.length === 0 ? [] : validateWebPassageRanges(proposedRanges, totalLines);
          assistance = response?.assistance;
          detail = response?.reason;
          if (validated) { ranges = validated; method = "helper"; }
          else {
            detail ??= "Reading assistance supplied no valid source ranges; deterministic passage selection was used.";
            if (assistance) assistance = { ...assistance, status: "fallback" };
          }
        } catch (error) {
          if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
          if (error && typeof error === "object" && "code" in error && error.code === "web-assistance-indeterminate") throw error;
          detail = "Reading assistance was unavailable; deterministic passage selection was used.";
        }
      }
      // Expand to paragraph/table/code boundaries and include the nearest heading.
      // Explanations stay outside these original ranges.
      const expanded: WebPassageRange[] = [];
      for (const range of ranges) {
        const first = blocks.find(block => block.startLine <= range.startLine && block.endLine >= range.startLine);
        const last = blocks.find(block => block.startLine <= range.endLine && block.endLine >= range.endLine);
        expanded.push({ startLine: first?.startLine ?? range.startLine, endLine: last?.endLine ?? range.endLine });
        const headingPath: NonNullable<WebSnapshotStructure["headings"]> = [];
        for (const heading of structure?.headings ?? []) {
          if (heading.line > range.startLine) break;
          while (headingPath.length && headingPath.at(-1)!.level >= heading.level) headingPath.pop();
          headingPath.push(heading);
        }
        for (const heading of headingPath) expanded.push({ startLine: heading.line, endLine: heading.line });
        const firstIndex = blocks.indexOf(first!);
        const lastIndex = blocks.indexOf(last!);
        for (const neighbor of [blocks[firstIndex - 1], blocks[lastIndex + 1]]) {
          if (!neighbor) continue;
          const text = lines.slice(neighbor.startLine - 1, neighbor.endLine).join("\n");
          if (/^\s*(?:[>*-]\s*)?(?:(?:only|unless|if|except|note|warning|caution|required|do not)\b|仅|只有|除非|如果|注意|警告|限制|前提|条件|不适用|不要|不应|不得)/i.test(text)) expanded.push(neighbor);
        }
      }
      const bounded: WebPassageRange[] = [];
      let count = 0;
      for (const range of validateWebPassageRanges(expanded, totalLines) ?? []) {
        if (count >= maxLines) break;
        const endLine = webPageEndLine(markdown, range.startLine, maxLines - count, range.endLine);
        bounded.push({ startLine: range.startLine, endLine });
        count += endLine - range.startLine + 1;
      }
      ranges = bounded;
      return { body: ranges.length ? ranges.map(value => lines.slice(value.startLine - 1, value.endLine).join("\n")).join("\n\n…\n\n")
        : `No relevant passages found in lines 1–${totalLines}. Inspect the headings or continue reading the retained source.`,
        ranges: ranges.map(value => ({ ...value, totalLines })),
        selection: { method, question: request.question, matched: ranges.length > 0, searchedRange: wholeRange, ...(detail ? { detail } : {}), ...(assistance ? { assistance } : {}) },
        ...(snapshotId ? { nextRead: { snapshotId, position: { kind: "lines", startLine: 1 }, maxLines } as WebFetchRequest } : {}) };
    }
    const endLine = webPageEndLine(markdown, range.startLine, maxLines, range.endLine);
    const shown = { ...range, endLine };
    return { body: lines.slice(shown.startLine - 1, endLine).join("\n"), range: shown, ranges: [shown],
      selection: { method: request.position ? "range" : "page", matched: true },
      ...(snapshotId && endLine < range.endLine ? { nextRead: { snapshotId,
        position: { kind: "lines", startLine: endLine + 1, ...(request.position ? { endLine: range.endLine } : {}) }, maxLines } as WebFetchRequest } : {}) };
  };

  const projectSelection = (result: Extract<FetchResult, { status: "ok" }>, selected: Selection): Extract<FetchResult, { status: "ok" }> => {
    const { range: _range, ranges: _ranges, nextRead: _nextRead, ...rest } = result;
    const totalLines = result.markdown.split("\n").length;
    const acquisition = result.completeness ?? result.snapshot?.acquisition ?? {
      download: { status: "unknown" as const, receivedBytes: result.bytes, retainedBytes: result.bytes },
      extraction: { status: "unknown" as const },
    };
    return { ...rest, markdown: selected.body, ranges: selected.ranges, selection: selected.selection,
      ...(selected.range ? { range: selected.range } : {}), ...(selected.nextRead ? { nextRead: selected.nextRead } : {}),
      completeness: { download: acquisition.download, extraction: acquisition.extraction, display: { totalLines, ranges: selected.ranges,
        status: selected.ranges.length === 1 && selected.ranges[0]!.startLine === 1 && selected.ranges[0]!.endLine === totalLines ? "complete" : "partial" } } };
  };

  const detectEmptyShell = (html: string, markdown: string, render: boolean): boolean => {
    if (render) return false;
    // Length cannot tell an app shell from a legitimate short page. Only
    // suggest rendering when extraction found no body content at all.
    return markdown.trim().length === 0 && /<script(?:\s|>)/i.test(html);
  };

  const representationFor = (contentType: string, rendered: boolean): string => (
    rendered ? "rendered-readability-markdown"
      : contentType.startsWith("text/html") || contentType.includes("xml") ? "readability-markdown" : "raw-text"
  );

  const attachSnapshot = async (
    content: Extract<FetchResult, { status: "ok" }>,
    ctx: FetchContext,
  ): Promise<Extract<FetchResult, { status: "ok" }>> => {
    ctx.signal?.throwIfAborted();
    const representation = representationFor(content.contentType, content.rendered);
    const structure = content.structure ?? detectStructure(content.markdown);
    const withStructure = { ...content, structure };
    if (!deps.materials) return withStructure;
    try {
      const snapshot = await deps.materials.put(
        ctx.workspaceId,
        {
          sourceUrl: content.url,
          finalUrl: content.finalUrl,
          ...(content.contentType ? { contentType: content.contentType } : {}),
          ...(content.title ? { title: content.title } : {}),
          representation,
          ...(content.rendered ? { rendered: true } : {}),
          structure,
          ...(content.completeness ? { acquisition: { download: content.completeness.download, extraction: content.completeness.extraction } } : {}),
        },
        Buffer.from(content.markdown, "utf8"),
        ctx.authority,
        { ...(ctx.forceNewSnapshot ? { forceNew: true } : {}) },
      );
      return { ...withStructure, snapshot };
    } catch (error) {
      // Keep fetched bytes, but never present a persistence failure as a pinned
      // snapshot. The caller's real commit promise has already settled here.
      return { ...withStructure, snapshotError: {
        message: error instanceof Error ? error.message : "Snapshot persistence failed",
        ...(error && typeof error === "object" && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
      } };
    }
  };

  // One in-flight fetch per (url, render, policy) key. Each caller waits with
  // its own cancellation; when the last waiter leaves before the task
  // settles, the underlying request is aborted.
  const inflight = new Map<string, SharedFetch>();

  const joinShared = (shared: SharedFetch, signal: AbortSignal | undefined): Promise<FetchResult> => {
    shared.waiters += 1;
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      shared.waiters -= 1;
      if (shared.waiters === 0 && !shared.done) shared.controller.abort();
    };
    if (!signal) return shared.promise.finally(leave);
    return new Promise<FetchResult>((resolve, reject) => {
      const onAbort = (): void => {
        leave();
        const finish = () => reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
        // Other live callers retain a shared producer. The last caller retains
        // its drain; no cancelled caller ever enters its own material commit.
        if (shared.waiters === 0 && !shared.done) void shared.promise.then(finish, finish);
        else finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        value => { leave(); if (signal.aborted) onAbort(); else resolve(value); },
        error => { leave(); reject(signal.aborted ? signal.reason ?? error : error); },
      ).finally(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    });
  };

  /** Read bounded transport bytes for every content type. Chunk boundaries and
   * Content-Length cannot turn byte limits into character limits. */
  const readBytes = async (response: Response, signal: AbortSignal, expectBody = true,
    budget?: { remaining: number; receivedBytes: number; retainedBytes: number }): Promise<{ bytes: Buffer; download: WebAcquisition["download"] }> => {
    const header = response.headers.get("content-length");
    const expectedBytes = expectBody && header !== null && /^\d+$/.test(header) ? Number(header) : undefined;
    let receivedBytes = 0;
    let retainedBytes = 0;
    let complete = true;
    const chunks: Buffer[] = [];
    const accept = (chunk: Uint8Array): void => {
      receivedBytes += chunk.byteLength;
      const keep = Math.min(chunk.byteLength, Math.max(0, maxBytes - retainedBytes), budget?.remaining ?? Infinity);
      if (budget) { budget.receivedBytes += chunk.byteLength; budget.retainedBytes += keep; budget.remaining -= keep; }
      if (keep) chunks.push(Buffer.from(chunk.subarray(0, keep)));
      retainedBytes += keep;
      if (keep < chunk.byteLength) complete = false;
    };
    if (response.body) {
      const reader = response.body.getReader();
      let cancel: Promise<void> | undefined;
      const stop = (): void => { cancel ??= reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        while (complete) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          if (value) accept(value);
        }
        if (!complete) { cancel ??= reader.cancel().catch(() => undefined); await cancel; }
      } finally {
        signal.removeEventListener("abort", stop);
        if (signal.aborted) stop();
        if (cancel) await cancel;
        reader.releaseLock();
      }
    } else {
      // Some host transports expose only a complete body. Counting and slicing
      // still use bytes, never UTF-16 string length.
      const bytes = typeof response.arrayBuffer === "function"
        ? Buffer.from(await awaitAbortable(response.arrayBuffer(), signal))
        : Buffer.from(await awaitAbortable(response.text(), signal), "utf8");
      accept(bytes);
    }
    if (expectedBytes !== undefined && !response.headers.get("content-encoding") && receivedBytes < expectedBytes) complete = false;
    return { bytes: Buffer.concat(chunks, retainedBytes), download: { status: complete ? "complete" : "partial",
      receivedBytes, retainedBytes, limitBytes: maxBytes, ...(expectedBytes !== undefined ? { expectedBytes } : {}) } };
  };
  const decodeText = (bytes: Buffer, contentType: string, complete: boolean): { text: string; lossy: boolean } => {
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
    let decoder: TextDecoder;
    let lossy = false;
    try { decoder = new TextDecoder(charset, { fatal: true }); }
    catch { decoder = new TextDecoder("utf-8", { fatal: true }); lossy = true; }
    // Streaming decode deliberately does not flush a partial trailing multibyte
    // character. Invalid internal bytes remain an explicit extraction failure.
    try { return { text: decoder.decode(bytes, { stream: !complete }), lossy }; }
    catch {
      let fallback: TextDecoder;
      try { fallback = new TextDecoder(charset); } catch { fallback = new TextDecoder("utf-8"); }
      return { text: fallback.decode(bytes, { stream: !complete }), lossy: true };
    }
  };
  const documentType = (contentType: string, url: string): "pdf" | "office" | null => {
    const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (mime === "application/pdf") return "pdf";
    if (["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.presentationml.presentation"].includes(mime)) return "office";
    if (mime === "application/octet-stream") {
      const path = new URL(url).pathname;
      if (/\.pdf$/i.test(path)) return "pdf";
      if (/\.(docx|xlsx|pptx)$/i.test(path)) return "office";
    }
    return null;
  };
  const completeDisplay = (markdown: string) => {
    const totalLines = markdown.split("\n").length;
    return { status: "complete" as const, totalLines, ranges: [{ startLine: 1, endLine: totalLines, totalLines }] };
  };

  const performFetch = async (
    url: string, ctx: FetchContext, cacheKey: string,
    outbound?: Awaited<ReturnType<EgressRuntime['prepare']>>,
  ): Promise<FetchResult> => {
    const finishOk = async (content: Extract<FetchResult, { status: "ok" }>): Promise<FetchResult> => {
      // Shared producers cache content only. Material ownership belongs to each
      // live caller's delivery, never to the first caller captured by this job.
      ctx.signal?.throwIfAborted();
      cacheResult(cacheKey, { result: content, expiresAt: Date.now() + cacheTtlMs });
      return content;
    };

    // Fetch with redirect handling
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < MAX_REDIRECTS) {
      const redirectDomainCheck = checkDomainPolicy(currentUrl, ctx.workspaceId, ctx.domainPolicy);
      if (redirectDomainCheck.blocked) return { status: "blocked", url: currentUrl, reason: "domain-blocked" };
      const redirectSsrfCheck = await deps.ssrf.check(currentUrl);
      if (redirectSsrfCheck.blocked) {
        return { status: "blocked", url: currentUrl, reason: redirectSsrfCheck.reason ?? "private-network" };
      }
      let response: Response;
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) controller.abort(ctx.signal.reason);
      else ctx.signal?.addEventListener("abort", abortFromCaller, { once: true });
      // Distinct abort reason so a deadline is classified "timeout", not "cancelled".
      const timeout = setTimeout(() => controller.abort(EGRESS_TIMEOUT), 20_000);
      const finishRequest = (): void => {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", abortFromCaller);
      };
      try {
        response = outbound
          ? await outbound.fetch(currentUrl, {
            signal: controller.signal,
            redirect: "manual", // Handle redirects manually for cross-host detection
            headers: { "User-Agent": "Varin-Agent/1.0" },
          })
          : await fetch(currentUrl, {
            signal: controller.signal,
            redirect: "manual", // Handle redirects manually for cross-host detection
            headers: { "User-Agent": "Varin-Agent/1.0" },
          });
      } catch (error) {
        if (ctx.signal?.aborted) {
          finishRequest();
          throw ctx.signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
        }
        if (controller.signal.aborted && controller.signal.reason === EGRESS_TIMEOUT) {
          const result: FetchResult = { status: "failed", url, reason: "request timed out", errorClass: "timeout" };
          cacheResult(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
          finishRequest();
          return result;
        }
        if (error instanceof EgressError) {
          finishRequest();
          if (error.kind === "private-network" || error.kind === "special-purpose") {
            return { status: "blocked", url, reason: error.kind };
          }
          if (error.kind === "scheme-denied") {
            return { status: "blocked", url, reason: "scheme" };
          }
          const result: FetchResult = { status: "failed", url, reason: error.message, errorClass: error.kind };
          cacheResult(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
          return result;
        }
        const result: FetchResult = {
          status: "failed",
          url,
          reason: error instanceof Error ? error.message : "fetch failed",
          errorClass: "unknown",
        };
        if (!ctx.signal?.aborted) cacheResult(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      try {
      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) {
          finishRequest();
          return { status: "failed", url, reason: "redirect without location" };
        }
        const redirectUrl = new URL(location, currentUrl).href;
        if (!isSameHost(currentUrl, redirectUrl)) {
          // Cross-host redirect — don't follow, return metadata
          finishRequest();
          return {
            status: "redirect-cross-host",
            url,
            location: redirectUrl,
            statusCode: response.status,
          };
        }
        // Same-host redirect — follow
        currentUrl = redirectUrl;
        redirectCount++;
        finishRequest();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        const result: FetchResult = {
          status: "failed",
          url,
          reason: `HTTP ${response.status}`,
          errorClass: response.status === 407 ? "proxy-auth" : "http",
        };
        cacheResult(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      const contentType = response.headers.get("content-type") ?? "text/plain";
      const documentKind = documentType(contentType, currentUrl);
      const renderPage = async (): Promise<FetchResult> => {
        if (!deps.renderer) return { status: "renderer-unavailable", url, reason: "unsupported" };
        const budget = { remaining: maxBytes, receivedBytes: 0, retainedBytes: 0 };
        let incomplete = false;
        const rendered = await awaitAbortable(deps.renderer({ url: currentUrl, threadId: ctx.authority.threadId, maxBytes,
          signal: controller.signal,
          fetch: async (request, ownerSignal) => {
            if (budget.remaining === 0 && request.method !== "HEAD") { incomplete = true; throw new Error("Rendered page reached its aggregate download budget"); }
            const target = request.url;
            if (checkDomainPolicy(target, ctx.workspaceId, ctx.domainPolicy).blocked) throw new Error("Rendered request denied by the domain policy");
            const check = await deps.ssrf.check(target);
            if (check.blocked) throw new Error(`Rendered request blocked: ${check.reason ?? "private-network"}`);
            const signal = AbortSignal.any([controller.signal, ownerSignal]);
            signal.throwIfAborted();
            // The original route is frozen for every resource and redirect.
            const fetched = outbound ? await outbound.fetch(target, { method: request.method, headers: request.headers, signal, redirect: "manual" })
              : await fetch(target, { method: request.method, headers: request.headers, signal, redirect: "manual" });
            const body = await readBytes(fetched, signal, request.method !== "HEAD", budget);
            if (body.download.status !== "complete") { incomplete = true; throw new Error("Rendered resource exceeded the configured download limit or ended early"); }
            const headers: Record<string, string | string[]> = Object.fromEntries(fetched.headers);
            // Fetch already decoded the representation. Do not ask Chromium to
            // decode it twice or trust the encoded Content-Length.
            delete headers["content-encoding"];
            delete headers["content-length"];
            delete headers["transfer-encoding"];
            const cookies = fetched.headers.getSetCookie?.();
            if (cookies?.length) headers["set-cookie"] = cookies;
            return { status: fetched.status, headers, body: body.bytes };
          },
        }), controller.signal);
        const finalCheck = await deps.ssrf.check(rendered.finalUrl);
        if (finalCheck.blocked) return { status: "blocked", url: rendered.finalUrl, reason: finalCheck.reason ?? "private-network" };
        if (checkDomainPolicy(rendered.finalUrl, ctx.workspaceId, ctx.domainPolicy).blocked) return { status: "blocked", url: rendered.finalUrl, reason: "domain-blocked" };
        const htmlBytes = Buffer.from(rendered.html, "utf8");
        const truncated = rendered.truncated || htmlBytes.length > maxBytes;
        const html = decodeText(htmlBytes.subarray(0, maxBytes), "text/html;charset=utf-8", !truncated).text;
        const { markdown, title, extraction } = await extractContent(html, "text/html");
        controller.signal.throwIfAborted();
        const partial = incomplete || truncated || rendered.blockedRequests > 0;
        return finishOk({ status: "ok", url, finalUrl: rendered.finalUrl, contentType: "text/html", markdown,
          bytes: Math.min(htmlBytes.length, maxBytes), fromCache: false, rendered: true,
          ...(title ? { title } : {}), completeness: {
            download: { status: incomplete || rendered.blockedRequests ? "partial" : "complete", receivedBytes: budget.receivedBytes, retainedBytes: budget.retainedBytes, limitBytes: maxBytes },
            extraction: partial ? { status: "partial", detail: "The read-only renderer omitted blocked/failed resources or reached its aggregate download/DOM size limit. Browser Use is available for interactive pages." }
              : { ...extraction, detail: "DOM captured by the actual BrowserOwner through Host egress. Workers, frames, non-GET requests and direct browser network access are disabled." },
            display: completeDisplay(markdown),
          } });
      };
      if (ctx.render && !documentKind) {
        await response.body?.cancel();
        return await renderPage();
      }
      const acquired = await readBytes(response, controller.signal);
      if (documentKind) {
        if (acquired.download.status !== "complete") return { status: "failed", url,
          reason: acquired.download.receivedBytes > maxBytes
            ? `Document exceeds the configured download limit (${maxBytes} bytes); incomplete bytes were not sent to the document parser.`
            : "Document transfer ended before its declared length; incomplete bytes were not sent to the document parser." };
        // The network producer retains bytes only. Each live caller separately
        // authorizes its original material and invokes the existing reader.
        const result: Extract<FetchResult, { status: "ok" }> = {
          status: "ok", url, finalUrl: currentUrl, contentType, markdown: "",
          bytes: acquired.bytes.byteLength, fromCache: false, rendered: false,
          completeness: { download: acquired.download, extraction: { status: "unknown", detail: "Document analysis has not run." }, display: completeDisplay("") },
        };
        sourceBytesForResult.set(result, acquired.bytes);
        cacheResult(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs, sourceBytes: acquired.bytes });
        return result;
      }
      const decoded = decodeText(acquired.bytes, contentType, acquired.download.status === "complete");
      const text = decoded.text;
      const { markdown, title, extraction } = await extractContent(text, contentType);
      controller.signal.throwIfAborted();
      if (detectEmptyShell(text, markdown, ctx.render ?? false)) {
        if (ctx.allowRenderFallback && deps.renderer) return await renderPage();
        return { status: "empty-shell", url,
          hint: ctx.allowRenderFallback
            ? "JavaScript rendering is enabled, but this Host has no BrowserOwner. Continue on a Host with a configured renderer."
            : "The HTML contains scripts but no readable body content. Enable web rendering on this Host to use its BrowserOwner." };
      }
      return finishOk({ status: "ok", url, finalUrl: currentUrl, contentType, markdown,
        bytes: acquired.download.retainedBytes, fromCache: false, rendered: false,
        ...(title ? { title } : {}), completeness: { download: acquired.download,
          extraction: acquired.download.status === "partial" ? { status: "partial", detail: "The configured download limit truncated the input; missing content cannot be recovered by display pagination." }
            : decoded.lossy ? { status: "partial", detail: "The response had invalid bytes or an unsupported charset; decoded text may contain replacement characters." } : extraction,
          display: completeDisplay(markdown) } });
      } catch (error) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? error;
        return { status: "failed", url,
          reason: controller.signal.reason === EGRESS_TIMEOUT ? "request timed out" : error instanceof Error ? error.message : "content reading failed",
          errorClass: controller.signal.reason === EGRESS_TIMEOUT ? "timeout" : "unknown" };
      } finally {
        finishRequest();
      }
    }

    // Too many redirects
    return { status: "failed", url, reason: "too many redirects" };
  };

  const policyKeyFor = (workspaceId: string, override?: DomainPolicy): string => {
    const policy = override ?? deps.domainPolicy?.(workspaceId) ?? { block: [] };
    return JSON.stringify({ allow: policy.allow ?? null, block: [...policy.block].sort() });
  };

  const readSnapshot = async (snapshotId: string, request: WebFetchRequest, ctx: FetchContext): Promise<FetchResult> => {
    const found = deps.materials
      ? await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority, ctx.signal ? { signal: ctx.signal } : {})
      : null;
    if (!found) return { status: "snapshot-missing", snapshotId };
    const policyCheck = checkDomainPolicy(found.ref.finalUrl, ctx.workspaceId, ctx.domainPolicy);
    if (policyCheck.blocked) return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    if (found.ref.document && found.ref.document.kind !== "pdf") {
      const reader = ctx.alternateDocumentReader ?? deps.alternateDocumentReader;
      const result = await reader?.({ ...request, snapshotId }, documentContext(ctx));
      return result ?? { status: "failed", url: found.ref.finalUrl, reason: "The Office document reader is unavailable" };
    }
    if (found.ref.document?.kind === "pdf") {
      if (!documentReader) return { status: "failed", url: found.ref.finalUrl, reason: "PDF reader is unavailable" };
      const result = await documentReader.read({ ...request, snapshotId }, documentContext(ctx));
      if (result.status !== "ok") return result;
      if (request.question && !request.position && request.find === undefined && result.markdown) {
        const selected = await selectText(result.markdown, result.structure ?? result.snapshot?.structure, request, result.snapshot?.snapshotId ?? snapshotId, ctx, result.snapshot);
        if ("body" in selected) return projectSelection({ ...result, fromCache: true }, selected);
      }
      return { ...result, fromCache: true };
    }
    if (request.view === "page-image") return { status: "page-image-unavailable", snapshotId,
      ...(request.page !== undefined ? { page: request.page } : {}), reason: "snapshot is not a PDF" };
    const selected = await selectText(found.body.toString("utf8"), found.ref.structure, request, snapshotId, ctx, found.ref);
    if (!("body" in selected)) return selected;
    return projectSelection({
      status: "ok", url: found.ref.sourceUrl, finalUrl: found.ref.finalUrl,
      contentType: found.ref.contentType ?? "text/markdown",
      ...(found.ref.title ? { title: found.ref.title } : {}),
      markdown: found.body.toString("utf8"), bytes: found.ref.acquisition?.download.retainedBytes ?? found.body.byteLength, fromCache: true, rendered: found.ref.rendered === true,
      snapshot: found.ref, ...(found.ref.structure ? { structure: found.ref.structure } : {}),
    }, selected);
  };

  const fetchUrl = async (input: WebFetchRequest | string, ctx: FetchContext): Promise<FetchResult> => {
    const request: WebFetchRequest = typeof input === "string" ? { url: input } : input;
    ctx.signal?.throwIfAborted();
    pruneCache();
    if (request.maxLines !== undefined && (!Number.isSafeInteger(request.maxLines) || request.maxLines < 1)) return { status: "failed", url: request.url ?? "", reason: "maxLines must be a positive integer" };
    if (request.question !== undefined && (typeof request.question !== "string" || !request.question.trim())) return { status: "failed", url: request.url ?? "", reason: "question must be a non-empty string" };
    ctx = { ...ctx, ...(request.render !== undefined ? { render: request.render } : {}),
      ...(request.render === false ? { allowRenderFallback: false } : {}) };
    if (request.position?.kind === "lines" && (!Number.isSafeInteger(request.position.startLine) || request.position.startLine < 1
      || request.position.endLine !== undefined && (!Number.isSafeInteger(request.position.endLine) || request.position.endLine < 1))) {
      return { status: "failed", url: request.url ?? "", reason: "Line positions must be positive integers" };
    }
    if (request.position?.kind === "lines" && request.position.endLine !== undefined
      && request.position.endLine < request.position.startLine) {
      return { status: "failed", url: request.url ?? "", reason: "endLine must be greater than or equal to startLine" };
    }
    const snapshotId = request.snapshotId?.trim();
    if (snapshotId) return readSnapshot(snapshotId, request, ctx);
    const url = request.url?.trim() ?? "";
    if (!url) return { status: "failed", url: "", reason: "url or snapshotId is required" };
    try { new URL(url); }
    catch { return { status: "failed", url, reason: "invalid_url" }; }

    // Check domain policy
    const domainCheck = checkDomainPolicy(url, ctx.workspaceId, ctx.domainPolicy);
    if (domainCheck.blocked) {
      return { status: "blocked", url, reason: "domain-blocked" };
    }

    // Check SSRF
    const ssrfCheck = await deps.ssrf.check(url);
    if (ssrfCheck.blocked) {
      return { status: "blocked", url, reason: ssrfCheck.reason ?? "private-network" };
    }

    const positionSlice = async (result: FetchResult): Promise<FetchResult> => {
      if (result.status !== "ok") return result;
      const sliced = await selectText(
        result.markdown,
        result.structure ?? result.snapshot?.structure,
        request,
        result.snapshot?.snapshotId ?? "",
        ctx,
        result.snapshot,
      );
      if (!("body" in sliced)) return sliced;
      return projectSelection(result, sliced);
    };

    const applyView = (result: FetchResult): FetchResult => request.view === "page-image" && result.status === "ok"
      ? { status: "page-image-unavailable", snapshotId: result.snapshot?.snapshotId ?? "",
        ...(request.page !== undefined ? { page: request.page } : {}), reason: "snapshot is not a PDF" }
      : result;

    const documentRequest = { ...request, view: request.view ?? "text" } as const;
    const deliverDocument = async (result: Extract<FetchResult, { status: "ok" }>, sourceBytes: Buffer, forceNew: boolean, fromCache: boolean): Promise<FetchResult> => {
      const captured = { source: sourceBytes, sourceUrl: url, finalUrl: result.finalUrl,
        contentType: result.contentType, ...(forceNew ? { forceNew: true } : {}) };
      const kind = documentType(result.contentType, result.finalUrl);
      const resolved = kind === "pdf"
        ? await documentReader?.ingest(captured, documentContext(ctx), documentRequest)
        : await (ctx.alternateDocumentReader ?? deps.alternateDocumentReader)?.(documentRequest, documentContext(ctx), captured);
      if (!resolved) return { status: "failed", url, reason: kind === "pdf" ? "PDF reader is unavailable" : "The Office document reader is unavailable" };
      if (resolved.status !== "ok") return resolved;
      const analysis = resolved.analysis ?? resolved.snapshot?.document?.analysis;
      const complete = { ...resolved, fromCache, completeness: {
        download: result.completeness!.download,
        extraction: { status: analysis?.status === "partial" || analysis?.status === "unavailable" ? "partial" as const : "unknown" as const,
          detail: "Document extraction coverage is described by its retained analysis, page scope and unparsed structure." },
        display: resolved.completeness?.display ?? completeDisplay(resolved.markdown),
      } };
      if (request.question && !request.position && request.find === undefined && resolved.markdown && kind === "pdf") {
        const selected = await selectText(resolved.markdown, resolved.structure ?? resolved.snapshot?.structure, request, resolved.snapshot?.snapshotId ?? "", ctx, resolved.snapshot);
        return "body" in selected ? projectSelection(complete, selected) : selected;
      }
      return complete;
    };

    // Cached bytes are reusable only after this workspace and request have
    // independently passed their current authorization policies. The egress
    // fingerprint is frozen for this request — a proxy↔direct policy change
    // must not serve bytes fetched through the other path.
    const outbound = await deps.egress?.prepare(url);
    // A browser can carry authentication even when the URL is public. Never
    // implicitly transfer its rendered observation through another Thread's
    // transient cache. Public anonymous network bytes can still be shared.
    const browserScope = ctx.render || ctx.allowRenderFallback
      ? `${ctx.authority.owningWorkspaceId}:${ctx.authority.threadId}` : "public";
    const cacheKey = JSON.stringify([url, ctx.render ?? false, ctx.allowRenderFallback ?? false, browserScope, deps.rendererId ?? "none", outbound?.policy.fingerprint ?? "legacy"]);
    if (!request.refresh && !ctx.render && !ctx.allowRenderFallback) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.result.status === "ok") {
          const cachedPolicyCheck = checkDomainPolicy(cached.result.finalUrl, ctx.workspaceId, ctx.domainPolicy);
          if (cachedPolicyCheck.blocked) {
            return { status: "blocked", url: cached.result.finalUrl, reason: "domain-blocked" };
          }
          if (cached.sourceBytes) return deliverDocument(cached.result, cached.sourceBytes, false, true);
          const rebound = await attachSnapshot({ ...cached.result, fromCache: true }, { ...ctx, forceNewSnapshot: false });
          return applyView(await positionSlice(rebound));
        }
        return cached.result;
      }
    }

    const deliver = async (result: FetchResult, forceNewSnapshot = false): Promise<FetchResult> => {
      ctx.signal?.throwIfAborted();
      if (result.status !== "ok") return result;
      // The in-flight/cache result may have been produced under another
      // Thread. Rebind the content snapshot to this caller's
      // authority while reusing the content-addressed body.
      const sourceBytes = sourceBytesForResult.get(result);
      if (sourceBytes) return deliverDocument(result, sourceBytes, forceNewSnapshot, false);
      const rebound = await attachSnapshot(result, { ...ctx, forceNewSnapshot });
      return applyView(await positionSlice(rebound));
    };

    // A refresh is intentionally a fresh request: it bypasses both the
    // response cache and in-flight sharing so it can mint a new snapshot.
    if (request.refresh) {
      return deliver(await performFetch(url, ctx, cacheKey, outbound), true);
    }

    const sharedKey = `${cacheKey}|${policyKeyFor(ctx.workspaceId, ctx.domainPolicy)}`;
    let shared = inflight.get(sharedKey);
    if (!shared || shared.done || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const entry: SharedFetch = { controller, waiters: 0, done: false, promise: Promise.resolve({ status: "failed", url, reason: "unset" }) };
      entry.promise = performFetch(url, { ...ctx, signal: controller.signal }, cacheKey, outbound)
        .finally(() => {
          entry.done = true;
          if (inflight.get(sharedKey) === entry) inflight.delete(sharedKey);
        });
      shared = entry;
      inflight.set(sharedKey, shared);
    }
    return deliver(await joinShared(shared, ctx.signal));
  };

  const operations = new Set<{ controller: AbortController; promise: Promise<FetchResult> }>();
  return {
    fetch(input: WebFetchRequest | string, ctx: FetchContext): Promise<FetchResult> {
      if (disposed) return Promise.resolve({ status: "failed", url: typeof input === "string" ? input : input.url ?? "", reason: "Web fetch service is closed" });
      const controller = new AbortController();
      const abort = () => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) abort();
      else ctx.signal?.addEventListener("abort", abort, { once: true });
      const operation = { controller, promise: Promise.resolve(null as unknown as FetchResult) };
      operation.promise = fetchUrl(input, { ...ctx, signal: controller.signal }).finally(() => {
        ctx.signal?.removeEventListener("abort", abort);
        operations.delete(operation);
      });
      operations.add(operation);
      return operation.promise;
    },
    /** Abort original producers and retain ownership until body readers,
     * optional helpers and material commits have actually settled. */
    async dispose(): Promise<void> {
      disposed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      for (const operation of operations) operation.controller.abort(new DOMException("Web fetch service closed", "AbortError"));
      await Promise.allSettled([...operations].map(operation => operation.promise));
      cache.clear();
    },
    cache,
    inflight,
  };
}

import type { FetchResult, HarnessWebDomainPolicy, RetrievalReceiptAuthority, RetrievalUrlReceipt, WebFetchRequest, WebReadPosition, WebSnapshotStructure } from "@varin/protocol";
import { isSameHost } from "./ssrf-policy.js";
import { EGRESS_TIMEOUT, EgressError, type EgressRuntime } from "./egress.js";
import { mintWebFetchReceipt, type WebFetchReceiptDraft } from "./web-fetch-receipt.js";
import type { WebMaterialStore } from "./web-materials.js";
import { createDocumentReader, type DocumentReader, type DocumentReaderContext } from "./document-reading.js";

export interface SsrfPolicy {
  check(url: string): Promise<{ blocked: boolean; reason?: "private-network" | "scheme" | "special-purpose" }>;
  isSameHost(url1: string, url2: string): boolean;
}

export type DomainPolicy = HarnessWebDomainPolicy;

export interface WebFetchDeps {
  ssrf: SsrfPolicy;
  /** Outbound egress authority; absent keeps the legacy bare-fetch path. */
  egress?: EgressRuntime;
  domainPolicy?: (workspaceId: string) => DomainPolicy;
  renderer?: (url: string, signal?: AbortSignal) => Promise<string>;
  cacheTtlMs?: number;
  maxBytes?: number;
  persistReceipt?: (workspaceId: string, receipt: WebFetchReceiptDraft, markdown: string) => Promise<RetrievalUrlReceipt>;
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

interface FetchContext {
  workspaceId: string;
  authority: RetrievalReceiptAuthority;
  render?: boolean;
  domainPolicy?: DomainPolicy;
  signal?: AbortSignal;
  issueReceipt?: boolean;
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
  const cache = new Map<string, CacheEntry>();
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
  const withReceipt = async (
    result: Extract<FetchResult, { status: "ok" }>,
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
    issueReceipt: boolean,
  ): Promise<Extract<FetchResult, { status: "ok" }>> => {
    if (!issueReceipt || !deps.persistReceipt || !result.markdown) return result;
    const draft = mintWebFetchReceipt(result.finalUrl, result.markdown, authority);
    try {
      const receipt = await deps.persistReceipt(workspaceId, draft, result.markdown);
      return { ...result, receipt };
    } catch {
      // Fetching content succeeded, but an unpersisted token must never become
      // source-check authority.
      return result;
    }
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

  const extractContent = async (html: string, contentType: string): Promise<{ markdown: string; title?: string }> => {
    // For text/* content, pass through directly
    if (contentType.startsWith("text/plain") || contentType.startsWith("text/csv") || contentType.startsWith("text/yaml")) {
      return { markdown: html };
    }

    // For HTML, use readability + turndown
    if (contentType.startsWith("text/html") || contentType.includes("xml")) {
      return await extractHtmlContent(html);
    }

    // For other content types, return raw
    return { markdown: html };
  };

  const extractHtmlContent = async (html: string): Promise<{ markdown: string; title?: string }> => {
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

      const { Readability } = await import("@mozilla/readability");
      const Turndown = (await import("turndown")).default;

      const reader = new Readability(document);
      const article = reader.parse();

      const turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
      const markdown = turndown.turndown(article?.content || bodyHtml);
      const title = article?.title || pageTitle;
      return { markdown, ...(title !== undefined ? { title } : {}) };
    } catch {
      // Fallback: strip HTML tags
      const text = html.replace(/<(head|script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<[^>]*>/g, "").trim();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch?.[1]?.trim();
      return { markdown: text, ...(title !== undefined ? { title } : {}) };
    }
  };

  const awaitAbortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
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
        },
        Buffer.from(content.markdown, "utf8"),
        ctx.authority,
        { ...(ctx.forceNewSnapshot ? { forceNew: true } : {}) },
      );
      return { ...withStructure, snapshot };
    } catch {
      // Snapshot persistence must never fail a body that was fetched
      // successfully; the result is delivered without a snapshotId.
      return withStructure;
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
      if (shared.waiters <= 0 && !shared.done) shared.controller.abort();
    };
    if (!signal) return shared.promise.finally(leave);
    if (signal.aborted) {
      leave();
      return Promise.reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
    }
    return new Promise<FetchResult>((resolve, reject) => {
      const onAbort = (): void => {
        leave();
        reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => { leave(); resolve(value); },
        (error) => { leave(); reject(error); },
      ).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  const performFetch = async (
    url: string, ctx: FetchContext, cacheKey: string,
    outbound?: Awaited<ReturnType<EgressRuntime['prepare']>>,
  ): Promise<FetchResult> => {
    const finishOk = async (content: Extract<FetchResult, { status: "ok" }>): Promise<FetchResult> => {
      const result = await attachSnapshot(content, ctx);
      cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
      return result;
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
          cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
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
          cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
          return result;
        }
        const result: FetchResult = {
          status: "failed",
          url,
          reason: error instanceof Error ? error.message : "fetch failed",
          errorClass: "unknown",
        };
        if (!ctx.signal?.aborted) cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      try {
      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
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
        const result: FetchResult = {
          status: "failed",
          url,
          reason: `HTTP ${response.status}`,
          errorClass: response.status === 407 ? "proxy-auth" : "http",
        };
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      // Success — extract content
      const contentType = response.headers.get("content-type") ?? "text/plain";
      const contentLength = Number(response.headers.get("content-length") ?? 0);

      if (ctx.render && !deps.renderer && !contentType.includes("application/pdf")) {
        finishRequest();
        return { status: "renderer-unavailable", url, reason: "unsupported" };
      }

      // If render requested, use renderer
      if (ctx.render && deps.renderer && !contentType.includes("application/pdf")) {
        try {
          const html = await awaitAbortable(deps.renderer(currentUrl, controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          const { markdown, title } = await extractContent(html, "text/html");
          const content: Extract<FetchResult, { status: "ok" }> = {
            status: "ok",
            url,
            finalUrl: currentUrl,
            contentType,
            markdown,
            bytes: markdown.length,
            fromCache: false,
            rendered: true,
            ...(title ? { title } : {}),
          };
          finishRequest();
          return finishOk(content);
        } catch (error) {
          finishRequest();
          if (ctx.signal?.aborted) {
            throw ctx.signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
          }
          return {
            status: "failed",
            url,
            reason: `renderer failed: ${error instanceof Error ? error.message : "unknown"}`,
          };
        }
      }

      // Check content type for PDF
      if (contentType.includes("application/pdf")) {
        const arrayBuffer = await awaitAbortable(response.arrayBuffer(), controller.signal);
        if (arrayBuffer.byteLength > maxBytes) {
          finishRequest();
          return {
            status: "failed",
            url,
            reason: `PDF exceeds max size (${arrayBuffer.byteLength} > ${maxBytes})`,
          };
        }
        const sourceBytes = Buffer.from(arrayBuffer);
        // The shared network operation owns bytes only. Each authorized waiter
        // pins its source record before any document analysis begins.
        const result: Extract<FetchResult, { status: "ok" }> = {
          status: "ok", url, finalUrl: currentUrl, contentType, markdown: "",
          bytes: sourceBytes.byteLength, fromCache: false, rendered: false,
        };
        sourceBytesForResult.set(result, sourceBytes);
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs, sourceBytes });
        finishRequest();
        return result;
      }

      // Read body with size limit
      let text: string;
      if (contentLength > maxBytes) {
        // Read only up to maxBytes
        const reader = response.body?.getReader();
        if (!reader) {
          finishRequest();
          return { status: "failed", url, reason: "no response body" };
        }
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (totalSize < maxBytes) {
          controller.signal.throwIfAborted();
          const { done, value } = await awaitAbortable(reader.read(), controller.signal);
          if (done) break;
          if (value) {
            chunks.push(value);
            totalSize += value.length;
          }
        }
        reader.cancel();
        const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        text = buffer.toString("utf-8");
      } else {
        text = await awaitAbortable(response.text(), controller.signal);
        if (text.length > maxBytes) {
          text = text.slice(0, maxBytes);
        }
      }

      // Extract content
      const { markdown, title } = await extractContent(text, contentType);
      controller.signal.throwIfAborted();

      // Check for empty shell
      if (detectEmptyShell(text, markdown, ctx.render ?? false)) {
        finishRequest();
        return {
          status: "empty-shell",
          url,
          hint: "The HTML contains scripts but no readable body content. If content requires JavaScript, retry with render: true on a Host with web rendering enabled.",
        };
      }

      const content: Extract<FetchResult, { status: "ok" }> = {
        status: "ok",
        url,
        finalUrl: currentUrl,
        contentType,
        markdown,
        bytes: markdown.length,
        fromCache: false,
        rendered: false,
        ...(title ? { title } : {}),
      };
      finishRequest();
      return finishOk(content);
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
      ? await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority)
      : null;
    if (!found) return { status: "snapshot-missing", snapshotId };
    const policyCheck = checkDomainPolicy(found.ref.finalUrl, ctx.workspaceId, ctx.domainPolicy);
    if (policyCheck.blocked) return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    if (found.ref.document?.kind === "pdf") {
      if (!documentReader) return { status: "failed", url: found.ref.finalUrl, reason: "PDF reader is unavailable" };
      const result = await documentReader.read({ ...request, snapshotId }, documentContext(ctx));
      return result.status === "ok" ? withReceipt(result, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true) : result;
    }
    if (request.view === "page-image") return { status: "page-image-unavailable", snapshotId,
      ...(request.page !== undefined ? { page: request.page } : {}), reason: "snapshot is not a PDF" };
    let markdown = found.body.toString("utf8");
    let range: { startLine: number; endLine: number; totalLines: number } | undefined;
    if (request.position) {
      const sliced = resolvePosition(markdown, found.ref.structure, request.position, snapshotId);
      if (!("body" in sliced)) return sliced;
      markdown = sliced.body;
      range = sliced.range;
    }
    return withReceipt({
      status: "ok", url: found.ref.sourceUrl, finalUrl: found.ref.finalUrl,
      contentType: found.ref.contentType ?? "text/markdown",
      ...(found.ref.title ? { title: found.ref.title } : {}),
      markdown, bytes: found.body.byteLength, fromCache: false, rendered: found.ref.rendered === true,
      snapshot: found.ref, ...(found.ref.structure ? { structure: found.ref.structure } : {}),
      ...(range ? { range } : {}),
    }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true);
  };

  const fetchUrl = async (input: WebFetchRequest | string, ctx: FetchContext): Promise<FetchResult> => {
    const request: WebFetchRequest = typeof input === "string" ? { url: input } : input;
    const snapshotId = request.snapshotId?.trim();
    if (snapshotId) return readSnapshot(snapshotId, request, ctx);
    const url = request.url?.trim() ?? "";
    if (!url) return { status: "failed", url: "", reason: "url or snapshotId is required" };

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

    const positionSlice = (result: FetchResult): FetchResult => {
      if (!request.position || result.status !== "ok") return result;
      const sliced = resolvePosition(
        result.markdown,
        result.structure ?? result.snapshot?.structure,
        request.position,
        result.snapshot?.snapshotId ?? "",
      );
      if (!("body" in sliced)) return sliced;
      const { range: _replacedRange, ...rest } = result;
      return { ...rest, markdown: sliced.body, bytes: sliced.body.length, range: sliced.range };
    };

    const applyView = (result: FetchResult): FetchResult => request.view === "page-image" && result.status === "ok"
      ? { status: "page-image-unavailable", snapshotId: result.snapshot?.snapshotId ?? "",
        ...(request.page !== undefined ? { page: request.page } : {}), reason: "snapshot is not a PDF" }
      : result;

    const pdfRequest = { ...request, view: request.view ?? "text" } as const;
    const deliverPdf = async (result: Extract<FetchResult, { status: "ok" }>, sourceBytes: Buffer, forceNew: boolean, fromCache: boolean): Promise<FetchResult> => {
      if (!documentReader) return { status: "failed", url, reason: "PDF reader is unavailable" };
      const resolved = await documentReader.ingest({ source: sourceBytes, sourceUrl: url, finalUrl: result.finalUrl,
        contentType: result.contentType, ...(forceNew ? { forceNew: true } : {}) }, documentContext(ctx), pdfRequest);
      return resolved.status === "ok"
        ? withReceipt({ ...resolved, fromCache }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true)
        : resolved;
    };

    // Cached bytes are reusable only after this workspace and request have
    // independently passed their current authorization policies. The egress
    // fingerprint is frozen for this request — a proxy↔direct policy change
    // must not serve bytes fetched through the other path.
    const outbound = await deps.egress?.prepare(url);
    const cacheKey = `${url}:${ctx.render ?? false}:${outbound?.policy.fingerprint ?? "legacy"}`;
    if (!request.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.result.status === "ok") {
          const cachedPolicyCheck = checkDomainPolicy(cached.result.finalUrl, ctx.workspaceId, ctx.domainPolicy);
          if (cachedPolicyCheck.blocked) {
            return { status: "blocked", url: cached.result.finalUrl, reason: "domain-blocked" };
          }
          if (cached.sourceBytes) return deliverPdf(cached.result, cached.sourceBytes, false, true);
          const { receipt: _oldReceipt, ...content } = cached.result;
          const rebound = await attachSnapshot({ ...content, fromCache: true }, { ...ctx, forceNewSnapshot: false });
          return applyView(positionSlice(await withReceipt(rebound, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true)));
        }
        return cached.result;
      }
    }

    const deliver = async (result: FetchResult, rebindSnapshot = true): Promise<FetchResult> => {
      if (result.status !== "ok") return result;
      // The in-flight/cache result may have been produced under another
      // session or thread. Rebind the content snapshot to this caller's
      // authority while reusing the content-addressed body.
      const sourceBytes = sourceBytesForResult.get(result);
      if (sourceBytes) return deliverPdf(result, sourceBytes, !rebindSnapshot, false);
      const rebound = rebindSnapshot ? await attachSnapshot(result, { ...ctx, forceNewSnapshot: false }) : result;
      return applyView(positionSlice(await withReceipt(rebound, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true)));
    };

    // A refresh is intentionally a fresh request: it bypasses both the
    // response cache and in-flight sharing so it can mint a new snapshot.
    if (request.refresh) {
      return deliver(await performFetch(url, { ...ctx, forceNewSnapshot: true }, cacheKey, outbound), false);
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

  return {
    fetch: fetchUrl,
    cache,
    inflight,
  };
}

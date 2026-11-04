import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetch } from "./web-fetch.js";
import type { SsrfPolicy, DomainPolicy } from "./web-fetch.js";
import { createMaterialStoreFixture } from "./web-materials.test-helper.js";

// Minimal SSRF mock that blocks known private addresses
const createMockSsrf = (): SsrfPolicy => ({
  check: async (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { blocked: true, reason: "scheme" };
      }
      const host = parsed.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "10.0.0.1" || host === "169.254.169.254") {
        return { blocked: true, reason: "private-network" };
      }
      return { blocked: false };
    } catch {
      return { blocked: true, reason: "scheme" };
    }
  },
  isSameHost: (url1: string, url2: string) => {
    try {
      return new URL(url1).hostname === new URL(url2).hostname;
    } catch {
      return false;
    }
  },
});

const noDomainPolicy = (): DomainPolicy => ({ block: [] });
const fetchContext = {
  workspaceId: "ws",
  authority: { kind: "thread" as const, owningWorkspaceId: "ws", threadId: "session-1" },
};
describe("web-fetch service", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks private network addresses", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("http://127.0.0.1:8080/", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("private-network");
    }
  });

  it("blocks non-http schemes", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("file:///etc/passwd", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("scheme");
    }
  });

  it("blocks domain-blocked URLs", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: [], block: ["evil.com"] }),
    });
    const result = await service.fetch("https://evil.com/page", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("domain-blocked");
    }
  });

  it("enforces allow-list (whitelist mode)", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: ["allowed.com"], block: [] }),
    });
    const blocked = await service.fetch("https://other.com/page", fetchContext);
    expect(blocked.status).toBe("blocked");
  });

  it("treats an explicit empty allow list as deny-all", async () => {
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: () => ({ allow: [], block: [] }) });
    const result = await service.fetch("https://example.com/page", fetchContext);
    expect(result).toMatchObject({ status: "blocked", reason: "domain-blocked" });
  });

  it("returns renderer-unavailable when render requested but no renderer", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200,
      headers: new Headers({ "content-type": "text/html" }) }) as never;
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", { ...fetchContext, render: true });
    expect(result).toMatchObject({ status: "renderer-unavailable", reason: "unsupported" });
  });

  it("fetches and extracts HTML content", async () => {
    // Use text/plain to avoid linkedom/readability heavy DOM parsing in test
    const text = "This is a test page with enough content to pass the empty shell threshold check. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
      text: async () => text,
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", fetchContext);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.contentType).toContain("text/plain");
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.rendered).toBe(false);
      expect(result.fromCache).toBe(false);
    }
  });

  it("keeps short static content and distinguishes a genuinely empty script shell", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('<html><head><title>Example</title><script>window.TRACKING_SECRET = "not body text";</script></head><body><h1>Example Domain</h1><p>Short static page.</p><a href="https://iana.org/domains/example">Learn more</a></body></html>', { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response('<html><head><title>App</title><script>window.APP_SECRET = "not body text";</script></head><body><div id="root"></div></body></html>', { headers: { "content-type": "text/html" } }));
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const page = await service.fetch("https://example.com/", fetchContext);
    expect(page).toMatchObject({ status: "ok", rendered: false, title: "Example" });
    if (page.status !== "ok") throw new Error(page.status);
    expect(page.markdown).toContain("Short static page.");
    expect(page.markdown).toContain("https://iana.org/domains/example");
    expect(page.markdown).not.toContain("TRACKING_SECRET");
    expect(await service.fetch("https://example.com/app", fetchContext)).toMatchObject({ status: "empty-shell" });
  });

  it("serves from cache on second request", async () => {
    const text = "This is a cached page with enough content to pass the threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => text,
    });
    globalThis.fetch = mockFetch as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
      cacheTtlMs: 60_000,
    });
    const r1 = await service.fetch("https://example.com/", fetchContext);
    const r2 = await service.fetch("https://example.com/", fetchContext);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.fromCache).toBe(true);
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks workspace policy before serving bytes cached by another workspace", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "workspace A content",
    });
    globalThis.fetch = mockFetch as never;
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: (workspaceId) => workspaceId === "blocked"
        ? { allow: [], block: ["example.com"] }
        : noDomainPolicy(),
      cacheTtlMs: 60_000,
    });
    const allowed = await service.fetch("https://example.com/", fetchContext);
    expect(allowed.status).toBe("ok");
    const blocked = await service.fetch("https://example.com/", {
      workspaceId: "blocked",
      authority: { kind: "thread" as const, owningWorkspaceId: "blocked", threadId: "session-b" },
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "domain-blocked" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts while reading the response body and does not cache the cancellation", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const controller = new AbortController();
    const pending = service.fetch("https://example.com/slow-body", {
      workspaceId: "ws",
      authority: { kind: "thread" as const, owningWorkspaceId: "ws", threadId: "session-abort" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    let settled = false;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }).then(() => { settled = true; });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(service.cache.size).toBe(0);
    resolveBody("late body");
    await rejected;
    expect(service.cache.size).toBe(0);
  });

  it("returns redirect-cross-host for cross-domain redirects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://other.com/redirected" }),
      text: async () => "",
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", fetchContext);
    expect(result.status).toBe("redirect-cross-host");
    if (result.status === "redirect-cross-host") {
      expect(result.location).toBe("https://other.com/redirected");
      expect(result.statusCode).toBe(302);
    }
  });

  it("returns failed for HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "Not Found",
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/missing", fetchContext);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("404");
    }
  });

  it("pins fetched content as a snapshot and reads it back by snapshotId", async () => {
    const text = "snapshot body with enough content to be a real page. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => text,
    }) as never;
    const objects = new Map<string, Buffer>();
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    const materials = {
      put: async (_ws: string, draft: { sourceUrl: string; finalUrl: string }, body: Buffer) => {
        const ref = {
          snapshotId: "snap-1",
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: 1,
          contentHash: `sha256-stored`,
          representation: "raw-text",
          byteLength: body.byteLength,
        };
        objects.set(ref.contentHash, body);
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_ws: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });
    const result = await service.fetch({ url: "https://example.com/pinned" }, fetchContext);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot?.snapshotId).toBe("snap-1");

    const reread = await service.fetch({ snapshotId: "snap-1" }, fetchContext);
    expect(reread.status).toBe("ok");
    if (reread.status === "ok") {
      expect(reread.markdown).toBe(text);
      expect(reread.snapshot?.contentHash).toBe("sha256-stored");
    }
  });

  it("delegates PDF snapshot page views to the independent document reader", async () => {
    const source = Buffer.from("original-pdf");
    const ref = {
      snapshotId: "snap-pdf", sourceUrl: "https://example.com/paper.pdf", finalUrl: "https://example.com/paper.pdf",
      fetchedAt: 1, contentHash: "sha256-text", representation: "pdf-source-v1", byteLength: 0,
      contentType: "application/pdf",
      document: { kind: "pdf" as const, parser: "source", source: { contentHash: "sha256-source", byteLength: source.byteLength, contentType: "application/pdf" } },
    };
    const materials = {
      put: async () => ref,
      read: async (_workspaceId: string, snapshotId: string) => snapshotId === ref.snapshotId
        ? { ref, body: Buffer.alloc(0), source: { bytes: source, contentType: "application/pdf" } } : null,
    };
    const pageImage = { page: 2, mimeType: "image/png" as const, data: Buffer.from("png-page-2").toString("base64"),
      byteLength: 10, width: 100, height: 200, sourceHash: "sha256-source" };
    const read = vi.fn(async () => ({ status: "ok" as const, url: ref.sourceUrl, finalUrl: ref.finalUrl,
      contentType: "application/pdf", markdown: "", bytes: 0, fromCache: false, rendered: false, snapshot: ref, pageImage }));
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials,
      documentReader: { read, ingest: vi.fn() } as unknown as import("./document-reading.js").DocumentReader });
    const result = await service.fetch({ snapshotId: ref.snapshotId, view: "page-image", page: 2 }, fetchContext);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.pageImage).toEqual(pageImage);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: ref.snapshotId, page: 2, view: "page-image" }),
      expect.objectContaining({ workspaceId: "ws", authority: fetchContext.authority }));
  });

  it("shares downloaded PDF bytes but pins each caller's own source before analysis", async () => {
    const source = Buffer.from("%PDF-shared");
    const download = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) }));
    globalThis.fetch = download as never;
    const ingest = vi.fn(async (_input: unknown, ctx: { authority: { threadId: string } }, request: { ocr?: boolean }) => ({
      status: "ok" as const, url: "https://example.com/shared.pdf", finalUrl: "https://example.com/shared.pdf",
      contentType: "application/pdf", markdown: request.ocr ? "OCR" : "native", bytes: 6,
      fromCache: false, rendered: false,
      snapshot: { snapshotId: `source-${ctx.authority.threadId}`, sourceUrl: "https://example.com/shared.pdf",
        finalUrl: "https://example.com/shared.pdf", fetchedAt: 1, contentHash: "sha256-text",
        representation: "pdf-native-analysis", byteLength: 6 },
    }));
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy,
      documentReader: { ingest, read: vi.fn() } as unknown as import("./document-reading.js").DocumentReader });
    const a = await service.fetch({ url: "https://example.com/shared.pdf" }, fetchContext);
    const b = await service.fetch({ url: "https://example.com/shared.pdf", ocr: true }, {
      ...fetchContext, authority: { ...fetchContext.authority, threadId: "session-2" },
    });
    expect(download).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(a.status === "ok" && a.snapshot?.snapshotId).toBe("source-session-1");
    expect(b.status === "ok" && b.snapshot?.snapshotId).toBe("source-session-2");
    expect(b.status === "ok" && b.markdown).toBe("OCR");
  });

  it("preserves PDF source bytes when HTML rendering is requested", async () => {
    const source = Buffer.from("%PDF-visual");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: async () => source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) })) as never;
    const renderer = vi.fn(async () => ({ html: "<html>not the PDF</html>", finalUrl: "https://example.com/visual.pdf", blockedRequests: 0 }));
    const ingest = vi.fn(async (input: { source: Buffer; sourceUrl: string }) => ({
      status: "ok" as const, url: input.sourceUrl, finalUrl: input.sourceUrl,
      contentType: "application/pdf", markdown: "PDF text", bytes: 8, fromCache: false, rendered: false,
    }));
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy,
      renderer, documentReader: { ingest, read: vi.fn() } as unknown as import("./document-reading.js").DocumentReader });
    const result = await service.fetch("https://example.com/visual.pdf", { ...fetchContext, render: true });
    expect(result.status).toBe("ok");
    expect(renderer).not.toHaveBeenCalled();
    expect(ingest.mock.calls[0]?.[0].source).toEqual(source);
  });

  it("delivers each overlapping PDF response's own bytes when refresh overwrites the URL cache", async () => {
    const pending: Array<(bytes: ArrayBuffer) => void> = [];
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { pending.push(resolve); }) })) as never;
    const ingest = vi.fn(async (input: { source: Buffer; sourceUrl: string; forceNew?: boolean }) => {
      const text = input.source.toString("utf8");
      return { status: "ok" as const, url: input.sourceUrl, finalUrl: input.sourceUrl,
        contentType: "application/pdf", markdown: text, bytes: text.length, fromCache: false, rendered: false,
        snapshot: { snapshotId: `snap-${text}`, sourceUrl: input.sourceUrl, finalUrl: input.sourceUrl,
          fetchedAt: 1, contentHash: `source-${text}`, representation: "pdf-source-v1", byteLength: 0 },
      };
    });
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy,
      documentReader: { ingest, read: vi.fn() } as unknown as import("./document-reading.js").DocumentReader });
    const url = "https://example.com/race.pdf";
    const normal = service.fetch({ url }, fetchContext);
    const refresh = service.fetch({ url, refresh: true }, fetchContext);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    for (const [index, resolve] of pending.entries()) {
      const bytes = Buffer.from(index === 0 ? "first" : "second");
      resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    const [normalResult, refreshedResult] = await Promise.all([normal, refresh]);
    expect(normalResult.status === "ok" && normalResult.snapshot?.snapshotId).toBe("snap-first");
    expect(refreshedResult.status === "ok" && refreshedResult.snapshot?.snapshotId).toBe("snap-second");
    expect(ingest.mock.calls.find(([input]) => input.source.toString("utf8") === "second")?.[0].forceNew).toBe(true);
  });

  it("reports snapshot-missing for released or foreign snapshots and re-checks domain policy", async () => {
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const missing = await service.fetch({ snapshotId: "snap-gone" }, fetchContext);
    expect(missing).toEqual({ status: "snapshot-missing", snapshotId: "snap-gone" });

    const materials = {
      put: async () => { throw new Error("unused"); },
      read: async () => ({
        ref: {
          snapshotId: "snap-blocked",
          sourceUrl: "https://evil.com/x",
          finalUrl: "https://evil.com/x",
          fetchedAt: 1,
          contentHash: "sha256-x",
          representation: "raw-text",
          byteLength: 4,
        },
        body: Buffer.from("body"),
      }),
    };
    const guarded = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: [], block: ["evil.com"] }),
      materials,
    });
    const blocked = await guarded.fetch({ snapshotId: "snap-blocked" }, {
      workspaceId: "ws",
      authority: { kind: "thread" as const, owningWorkspaceId: "ws", threadId: "s" },
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "domain-blocked" });
  });

  it("shares one in-flight fetch and lets a single waiter's cancel leave others running", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    });
    globalThis.fetch = mockFetch as never;
    const opened = createMaterialStoreFixture();
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials: opened.materials });
    const ctx = (threadId: string, signal?: AbortSignal) => ({
      workspaceId: "ws",
      authority: { kind: "thread" as const, owningWorkspaceId: "ws", threadId },
      ...(signal ? { signal } : {}),
    });

    const first = new AbortController();
    const pendingA = service.fetch({ url: "https://example.com/shared" }, ctx("session-a", first.signal));
    const pendingB = service.fetch({ url: "https://example.com/shared" }, ctx("session-b"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    first.abort(new DOMException("cancelled", "AbortError"));
    await expect(pendingA).rejects.toMatchObject({ name: "AbortError" });

    resolveBody("shared page body long enough to matter. Lorem ipsum dolor sit amet.");
    const resultB = await pendingB;
    expect(resultB.status).toBe("ok");
    if (resultB.status === "ok") expect(resultB.markdown).toContain("shared page body");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect([...opened.records.values()].map(record => record.threadId)).toEqual(["session-b"]);
  });

  it("aborts the shared request when the last waiter leaves", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    });
    globalThis.fetch = mockFetch as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const controller = new AbortController();
    const pending = service.fetch({ url: "https://example.com/last" }, {
      workspaceId: "ws",
      authority: { kind: "thread" as const, owningWorkspaceId: "ws", threadId: "session-only" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    let settled = false;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }).then(() => { settled = true; });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(service.inflight.size).toBe(1);
    resolveBody("late");
    await rejected;
    expect(service.inflight.size).toBe(0);
  });

  it("keeps its own snapshot commit alive through cancellation and reports persistence failures", async () => {
    globalThis.fetch = vi.fn(async () => new Response("original body", { headers: { "content-type": "text/plain" } }));
    const opened = createMaterialStoreFixture();
    let start!: () => void;
    const entered = new Promise<void>(resolve => { start = resolve; });
    let finish!: () => void;
    const release = new Promise<void>(resolve => { finish = resolve; });
    const put = vi.fn(async (...args: Parameters<typeof opened.materials.put>) => {
      start(); await release; return opened.materials.put(...args);
    });
    const service = createWebFetch({ ssrf: createMockSsrf(), materials: { ...opened.materials, put } });
    const controller = new AbortController();
    let settled = false;
    const pending = service.fetch({ url: "https://example.com/commit" }, { ...fetchContext, signal: controller.signal })
      .then(value => { settled = true; return value; });
    await entered;
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    const result = await pending;
    expect(result.status === "ok" && result.snapshot?.snapshotId).toBeTruthy();
    expect(put).toHaveBeenCalledOnce();
    const failed = createWebFetch({ ssrf: createMockSsrf(), materials: {
      ...opened.materials, put: async () => { throw Object.assign(new Error("original record writer failed"), { code: "storage-unavailable" }); },
    } });
    const unpinned = await failed.fetch({ url: "https://example.com/failure" }, fetchContext);
    expect(unpinned).toMatchObject({ status: "ok", markdown: "original body",
      snapshotError: { message: "original record writer failed", code: "storage-unavailable" } });
    expect(unpinned.status === "ok" && unpinned.snapshot).toBeUndefined();
  });

  it("refresh bypasses the cache and the in-flight share", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: async () => `page version ${calls} with enough body content to pass checks.`,
      };
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, cacheTtlMs: 60_000 });
    const first = await service.fetch({ url: "https://example.com/refresh" }, fetchContext);
    const cached = await service.fetch({ url: "https://example.com/refresh" }, fetchContext);
    const refreshed = await service.fetch({ url: "https://example.com/refresh", refresh: true }, fetchContext);
    expect(first.status).toBe("ok");
    expect(cached.status === "ok" && cached.fromCache).toBe(true);
    expect(refreshed.status === "ok" && refreshed.fromCache).toBe(false);
    if (refreshed.status === "ok") expect(refreshed.markdown).toContain("version 2");
    expect(calls).toBe(2);
  });

  it("refresh mints a new snapshot even when the fetched bytes are unchanged", async () => {
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    let sequence = 0;
    const materials = {
      put: async (
        _workspaceId: string,
        draft: { sourceUrl: string; finalUrl: string; representation: string },
        body: Buffer,
        _authority: unknown,
        options?: { forceNew?: boolean },
      ) => {
        if (!options?.forceNew) {
          const existing = [...snapshots.values()].find((entry) => entry.ref.contentHash === "sha256-same");
          if (existing) return existing.ref;
        }
        sequence += 1;
        const ref = {
          snapshotId: `snap-refresh-${sequence}`,
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: sequence,
          contentHash: "sha256-same",
          representation: draft.representation,
          byteLength: body.byteLength,
        };
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_workspaceId: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "unchanged body with enough content to be retained",
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });

    const first = await service.fetch({ url: "https://example.com/unchanged" }, fetchContext);
    const refreshed = await service.fetch({ url: "https://example.com/unchanged", refresh: true }, fetchContext);
    expect(first.status).toBe("ok");
    expect(refreshed.status).toBe("ok");
    if (first.status === "ok" && refreshed.status === "ok") {
      expect(refreshed.snapshot?.snapshotId).not.toBe(first.snapshot?.snapshotId);
      expect(refreshed.snapshot?.contentHash).toBe(first.snapshot?.contentHash);
    }
  });
});

describe("structured reading (D-315 L3)", () => {
  const structuredMarkdown = [
    "# Title",
    "",
    "## Intro",
    "Intro body line one.",
    "Intro body line two.",
    "",
    "## Methods",
    "Methods body.",
    "",
    "| col | val |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "![Figure 1](fig1.png)",
    "",
    "## Appendix A",
    "Appendix body.",
  ].join("\n");

  const openMaterialService = () => {
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    let sequence = 0;
    const materials = {
      put: async (_ws: string, draft: import("./web-materials.js").WebSnapshotDraft, body: Buffer) => {
        sequence += 1;
        const ref: import("@varin/protocol").WebSnapshotRef = {
          snapshotId: `snap-${sequence}`,
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: sequence,
          contentHash: "sha256-x",
          representation: draft.representation,
          byteLength: body.byteLength,
          ...(draft.structure ? { structure: draft.structure } : {}),
        };
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_ws: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => structuredMarkdown,
    }) as never;
    return createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });
  };

  it("detects headings/tables/figures and reads positions from a snapshot", async () => {
    const service = openMaterialService();
    const fetched = await service.fetch({ url: "https://example.com/doc" }, fetchContext);
    expect(fetched.status).toBe("ok");
    if (fetched.status !== "ok") return;
    expect(fetched.structure?.headings?.map((h) => h.title)).toEqual(["Title", "Intro", "Methods", "Appendix A"]);
    expect(fetched.structure?.tables).toEqual([{ startLine: 10, endLine: 12 }]);
    expect(fetched.structure?.figures).toEqual([{ line: 14, title: "Figure 1" }]);
    expect(fetched.snapshot?.structure?.headings?.length).toBe(4);

    const section = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "section", title: "methods" } }, fetchContext);
    expect(section.status).toBe("ok");
    if (section.status === "ok") {
      expect(section.markdown).toContain("Methods body.");
      expect(section.markdown).toContain("col");
      expect(section.markdown).not.toContain("Intro body");
      expect(section.range?.startLine).toBe(7);
    }

    const appendix = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "appendix" } }, fetchContext);
    expect(appendix.status).toBe("ok");
    if (appendix.status === "ok") {
      expect(appendix.markdown).toContain("Appendix body.");
      expect(appendix.markdown).not.toContain("Methods body.");
    }

    const table = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "element", element: "table", index: 1 } }, fetchContext);
    expect(table.status).toBe("ok");
    if (table.status === "ok") {
      expect(table.markdown).toContain("| a | 1 |");
      expect(table.markdown).not.toContain("Methods body.");
    }
  });

  it("distinguishes unsupported structure from missing positions", async () => {
    const service = openMaterialService();
    const fetched = await service.fetch({ url: "https://example.com/doc2" }, fetchContext);
    if (fetched.status !== "ok") throw new Error("fetch failed");
    const snapshotId = fetched.snapshot!.snapshotId;

    const page = await service.fetch({ snapshotId, position: { kind: "page", page: 1 } }, fetchContext);
    expect(page).toMatchObject({ status: "structure-unsupported", kind: "pages" });

    const missing = await service.fetch({ snapshotId, position: { kind: "section", title: "nonexistent" } }, fetchContext);
    expect(missing.status).toBe("position-not-found");

    const badTable = await service.fetch({ snapshotId, position: { kind: "element", element: "table", index: 9 } }, fetchContext);
    expect(badTable.status).toBe("position-not-found");
  });

  it("finds literal webpage passages through URL, cache and fixed snapshots without changing the pinned body", async () => {
    const { materials } = createMaterialStoreFixture();
    globalThis.fetch = async () => new Response(structuredMarkdown, { headers: { "content-type": "text/plain" } });
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });
    const url = "https://example.com/find";
    const fetched = await service.fetch({ url, find: "mETHODS body" }, fetchContext);
    if (fetched.status !== "ok") throw new Error("fetch failed");
    expect(fetched.markdown).toContain('1 matching lines for "mETHODS body"');
    expect(fetched.markdown).toContain("8: Methods body.");
    expect(fetched.markdown).not.toContain("Appendix body.");
    const cached = await service.fetch({ url, find: "mETHODS body" }, fetchContext);
    const fixed = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, find: "mETHODS body" }, fetchContext);
    expect(cached).toMatchObject({ status: "ok", markdown: fetched.markdown, fromCache: true });
    expect(fixed).toMatchObject({ status: "ok", markdown: fetched.markdown, snapshot: fetched.snapshot, fromCache: true });
    const whole = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId }, fetchContext);
    expect(whole).toMatchObject({ status: "ok", markdown: structuredMarkdown, snapshot: fetched.snapshot });
    for (const source of [{ url }, { snapshotId: fetched.snapshot!.snapshotId }]) {
      for (const position of [{ kind: "lines" as const, startLine: 7, endLine: 14 }, { kind: "section" as const, title: "Methods" }]) {
        const selected = await service.fetch({ ...source, position, find: "Methods body" }, fetchContext);
        expect(selected).toMatchObject({ status: "ok", range: { startLine: 7, totalLines: 17 }, snapshot: fetched.snapshot });
        if (selected.status !== "ok") throw new Error("selection failed");
        expect(selected.markdown).toContain("Extracted page: 17 lines.");
        expect(selected.markdown).toContain("8: Methods body.");
        expect(selected.markdown).not.toContain("Intro body");
      }
    }
    const invalid = { position: { kind: "lines" as const, startLine: 3, endLine: 1 } };
    for (const source of [{ url }, { snapshotId: fetched.snapshot!.snapshotId }]) {
      expect(await service.fetch({ ...source, ...invalid }, fetchContext)).toMatchObject({ status: "failed", reason: "endLine must be greater than or equal to startLine" });
    }
  });

  it("applies a position slice on a URL fetch result", async () => {
    const service = openMaterialService();
    const sliced = await service.fetch({ url: "https://example.com/doc3", position: { kind: "lines", startLine: 4, endLine: 5 } }, fetchContext);
    expect(sliced.status).toBe("ok");
    if (sliced.status === "ok") {
      expect(sliced.markdown).toBe("Intro body line one.\nIntro body line two.");
      expect(sliced.range).toEqual({ startLine: 4, endLine: 5, totalLines: 17 });
    }
  });
});

describe("question-directed original reading", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const open = (body: string, options: Partial<import("./web-fetch.js").WebFetchDeps> = {}) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/markdown" } })));
    const fixture = createMaterialStoreFixture();
    return { ...fixture, service: createWebFetch({ ssrf: createMockSsrf(), materials: fixture.materials, ...options }) };
  };
  it("selects Chinese and technical passages with exact unchanged original ranges", async () => {
    const body = ["# 产品手册", "", "## 账户", "注册账户可以使用电子邮件。", "", "## 代理故障", "出现 ERR_CONNECTION_RESET 时，检查代理的 TLS 配置。", "仅当代理启用时，才需设置 HTTPS_PROXY；直连不要设置。", "", "```bash", "export HTTPS_PROXY=http://proxy.example:8080", "```", "", "## 价格", "基础套餐每月十元。"].join("\n");
    const { service, materials } = open(body);
    const result = await service.fetch({ url: "https://example.com/manual", question: "如何处理代理的 ERR_CONNECTION_RESET 错误？", maxLines: 8 }, fetchContext);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.markdown).toContain("检查代理的 TLS 配置");
    expect(result.markdown).toContain("仅当代理启用时");
    expect(result.markdown).not.toContain("基础套餐");
    expect(result.selection).toMatchObject({ method: "question", matched: true });
    expect(result.markdown).toBe(result.ranges!.map(range => body.split("\n").slice(range.startLine - 1, range.endLine).join("\n")).join("\n\n…\n\n"));
    const original = await materials.read("ws", result.snapshot!.snapshotId, fetchContext.authority);
    expect(original?.body.toString("utf8")).toBe(body);
    const reread = await service.fetch({ snapshotId: result.snapshot!.snapshotId, position: { kind: "section", title: "代理故障" } }, fetchContext);
    expect(reread.status === "ok" && reread.markdown).toContain("export HTTPS_PROXY");
    await service.dispose();
  });

  it("rejects invented helper ranges, uses deterministic fallback and never uses helper prose", async () => {
    const helper = vi.fn(async () => ({ ranges: [{ startLine: 300, endLine: 500 }], reason: "invalid source ranges" }));
    const { service } = open("# TLS\n\nTLS requires certificate verification.\n\n# Other\n\nUnrelated detail.", { selectPassages: helper });
    const result = await service.fetch({ url: "https://example.com/tls", question: "TLS certificate verification" }, fetchContext);
    expect(result).toMatchObject({ status: "ok", selection: { method: "question", detail: "invalid source ranges" } });
    expect(result.status === "ok" && result.markdown).toContain("TLS requires certificate verification.");
    expect(helper).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it("accepts only grounded helper locations and preserves fenced code and table structure", async () => {
    const body = "# Setup\n\n```sh\nset MODE=1\n\necho done\n```\n\n| Option | Default |\n| --- | --- |\n| MODE | 1 |\n\nOther material.";
    const { service } = open(body, { selectPassages: async () => ({ ranges: [{ startLine: 5, endLine: 5 }, { startLine: 11, endLine: 11 }], assistance: { status: "selected", purpose: "reading" } }) });
    const result = await service.fetch({ url: "https://example.com/setup", question: "How do I set the mode?" }, fetchContext);
    expect(result).toMatchObject({ status: "ok", selection: { method: "helper", assistance: { status: "selected" } } });
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.markdown).toContain("```sh\nset MODE=1\n\necho done\n```");
    expect(result.markdown).toContain("| Option | Default |\n| --- | --- |\n| MODE | 1 |");
    expect(result.markdown).not.toContain("Other material.");
    await service.dispose();
  });

  it("reports a searched range when no passage matches instead of inventing an answer", async () => {
    const { service } = open("# Apples\n\nApples grow on trees.");
    const result = await service.fetch({ url: "https://example.com/apple", question: "What is ERR_SSL_PROTOCOL_ERROR?" }, fetchContext);
    expect(result).toMatchObject({ status: "ok", ranges: [], selection: { method: "question", matched: false, searchedRange: { startLine: 1, endLine: 3 } }, nextRead: { position: { kind: "lines", startLine: 1 } } });
    expect(result.status === "ok" && result.markdown).toContain("No relevant passages");
    await service.dispose();
  });

  it("pages a long document from the same immutable snapshot even after the URL changes", async () => {
    const body = Array.from({ length: 375 }, (_, index) => `Original line ${index + 1}`).join("\n");
    const { service } = open(body);
    const first = await service.fetch({ url: "https://example.com/long" }, fetchContext);
    if (first.status !== "ok") throw new Error(first.status);
    expect(first.range).toEqual({ startLine: 1, endLine: 160, totalLines: 375 });
    expect(first.completeness).toMatchObject({ download: { status: "complete" }, extraction: { status: "complete" }, display: { status: "partial" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Changed live page")));
    const second = await service.fetch(first.nextRead!, fetchContext);
    if (second.status !== "ok") throw new Error(second.status);
    const last = await service.fetch(second.nextRead!, fetchContext);
    if (last.status !== "ok") throw new Error(last.status);
    expect([first.markdown, second.markdown, last.markdown].join("\n")).toBe(body);
    expect(last.nextRead).toBeUndefined();
    expect(second.snapshot!.snapshotId).toBe(first.snapshot!.snapshotId);
    expect(last.snapshot!.snapshotId).toBe(first.snapshot!.snapshotId);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("preserves HTML headings, code and real table cells instead of flattening them", async () => {
    const html = '<html><body><main><h1>Setup</h1><p>Only when enabled:</p><pre><code class="language-js">if (enabled) {\n  run();\n}</code></pre><table><tr><th>Option</th><th>Docs</th></tr><tr><td>TLS</td><td><a href="https://example.com/tls">Guide</a></td></tr></table></main></body></html>';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } })));
    const service = createWebFetch({ ssrf: createMockSsrf() });
    const result = await service.fetch("https://example.com/table", fetchContext);
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.markdown).toContain("# Setup");
    expect(result.markdown).toContain("```js\nif (enabled) {");
    expect(result.markdown).toContain("| Option | Docs |\n| --- | --- |\n| TLS | [Guide](https://example.com/tls) |");
    expect(result.structure!.tables).toHaveLength(1);
    expect(result.completeness!.extraction.status).toBe("unknown");
    await service.dispose();
  });

  it("counts bytes across streaming UTF-8 boundaries and records partial input on snapshots", async () => {
    const source = Buffer.from("开源代码与文档", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(source.subarray(0, 1));
      controller.enqueue(source.subarray(1, 4));
      controller.enqueue(source.subarray(4));
      controller.close();
    } }), { headers: { "content-type": "text/plain" } })));
    const { materials } = createMaterialStoreFixture();
    const service = createWebFetch({ ssrf: createMockSsrf(), maxBytes: 10, materials });
    const result = await service.fetch("https://example.com/utf8", fetchContext);
    if (result.status !== "ok") throw new Error(result.status);
    expect(result.markdown).toBe("开源代");
    expect(result.markdown).not.toContain("�");
    expect(result.bytes).toBe(10);
    expect(result.completeness).toMatchObject({ download: { status: "partial", receivedBytes: source.length, retainedBytes: 10, limitBytes: 10 }, extraction: { status: "partial" }, display: { status: "complete" } });
    const reread = await service.fetch({ snapshotId: result.snapshot!.snapshotId }, fetchContext);
    expect(reread.status === "ok" && reread.completeness!.download.status).toBe("partial");
    expect(reread.status === "ok" && reread.nextRead).toBeUndefined();
    await service.dispose();
  });

  it("fully decodes a multibyte stream exactly at the byte limit", async () => {
    const source = Buffer.from("你好🙂", "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of source) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { "content-type": "text/plain", "content-length": String(source.length) } })));
    const service = createWebFetch({ ssrf: createMockSsrf(), maxBytes: source.length });
    const result = await service.fetch("https://example.com/exact", fetchContext);
    expect(result).toMatchObject({ status: "ok", markdown: "你好🙂", bytes: source.length, completeness: { download: { status: "complete", receivedBytes: source.length } } });
    await service.dispose();
  });

  it("uses automatic rendering only when enabled with an actual Host renderer", async () => {
    const shell = '<html><body><div id="app"></div><script src="app.js"></script></body></html>';
    const renderer = vi.fn(async () => ({ html: '<html><body><p>Rendered result</p></body></html>', finalUrl: "https://example.com/shell", blockedRequests: 0 }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(shell, { headers: { "content-type": "text/html" } })));
    const service = createWebFetch({ ssrf: createMockSsrf(), renderer });
    expect(await service.fetch("https://example.com/shell", fetchContext)).toMatchObject({ status: "empty-shell" });
    expect(renderer).not.toHaveBeenCalled();
    const rendered = await service.fetch("https://example.com/shell", { ...fetchContext, allowRenderFallback: true });
    expect(rendered).toMatchObject({ status: "ok", rendered: true, markdown: "Rendered result", completeness: { download: { status: "complete" } } });
    expect(renderer).toHaveBeenCalledOnce();
    expect(await service.fetch({ url: "https://example.com/shell", render: false }, { ...fetchContext, allowRenderFallback: true })).toMatchObject({ status: "empty-shell" });
    const remote = createWebFetch({ ssrf: createMockSsrf() });
    expect(await remote.fetch("https://example.com/shell", { ...fetchContext, allowRenderFallback: true })).toMatchObject({ status: "empty-shell", hint: expect.stringContaining("no BrowserOwner") });
    await Promise.all([service.dispose(), remote.dispose()]);
  });

  it("routes Office originals through the existing reader and never text-decodes ZIP bytes", async () => {
    const source = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } })));
    const alternateDocumentReader = vi.fn<import("./document-material.js").AlternateDocumentReader>(async () => ({ status: "ok" as const, url: "https://example.com/a.docx", finalUrl: "https://example.com/a.docx", contentType: "text/markdown", markdown: "Office content", bytes: 14, fromCache: false, rendered: false }));
    const service = createWebFetch({ ssrf: createMockSsrf(), alternateDocumentReader });
    const result = await service.fetch("https://example.com/a.docx", fetchContext);
    expect(result).toMatchObject({ status: "ok", markdown: "Office content" });
    expect(alternateDocumentReader.mock.calls[0]?.[2]).toMatchObject({ source });
    await service.dispose();
  });

  it("expires unused cached bytes and drains pending stream cancellation before disposal", async () => {
    vi.useFakeTimers();
    const { service } = open("cache content", { cacheTtlMs: 50 });
    await service.fetch("https://example.com/cache", fetchContext);
    expect(service.cache.size).toBe(1);
    await vi.advanceTimersByTimeAsync(51);
    expect(service.cache.size).toBe(0);
    await service.dispose();
    vi.useRealTimers();
    let stopped!: () => void;
    const released = new Promise<void>(resolve => { stopped = resolve; });
    const cancel = vi.fn(() => released);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ pull() {}, cancel }), { headers: { "content-type": "text/plain" } })));
    const draining = createWebFetch({ ssrf: createMockSsrf() });
    const pending = draining.fetch("https://example.com/stream", fetchContext);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    let disposed = false;
    const closing = draining.dispose().then(() => { disposed = true; });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    stopped();
    await Promise.all([closing, rejected]);
    expect(draining.inflight.size).toBe(0);
    expect(draining.cache.size).toBe(0);
    expect(await draining.fetch("https://example.com/new", fetchContext)).toMatchObject({ status: "failed", reason: "Web fetch service is closed" });
  });
});

describe("rendering preserves original egress authority", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("checks every rendered subresource and final URL and does not transfer cached browser observations", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response('<html><script src="app.js"></script><body></body></html>', { headers: { "content-type": "text/html" } });
    }));
    const renderer = vi.fn<NonNullable<import("./web-fetch.js").WebFetchDeps["renderer"]>>(async request => {
      await expect(request.fetch({ url: "http://127.0.0.1/private", method: "GET", headers: {} }, request.signal!)).rejects.toThrow("private-network");
      await expect(request.fetch({ url: "https://denied.example/script.js", method: "GET", headers: {} }, request.signal!)).rejects.toThrow("domain policy");
      await request.fetch({ url: "https://example.com/app.js", method: "GET", headers: {} }, request.signal!);
      return { html: '<p>Original rendered source</p>', finalUrl: "https://example.com/final", blockedRequests: 2 };
    });
    const service = createWebFetch({ ssrf: createMockSsrf(), renderer, rendererId: "real-owner",
      domainPolicy: () => ({ block: ["denied.example"] }) });
    const ctx = { ...fetchContext, allowRenderFallback: true };
    const result = await service.fetch("https://example.com/start", ctx);
    expect(result).toMatchObject({ status: "ok", finalUrl: "https://example.com/final", completeness: { download: { status: "partial" }, extraction: { status: "partial" } } });
    expect(fetched).toEqual(["https://example.com/start", "https://example.com/app.js"]);
    await service.fetch("https://example.com/start", { ...ctx, authority: { ...ctx.authority, threadId: "another-thread" } });
    expect(renderer).toHaveBeenCalledTimes(2);
    await service.fetch("https://example.com/start", ctx);
    expect(renderer).toHaveBeenCalledTimes(3);
    await service.dispose();
  });
  it("refuses a renderer that reports a forbidden final navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<script src="app.js"></script>', { headers: { "content-type": "text/html" } })));
    const service = createWebFetch({ ssrf: createMockSsrf(), renderer: async () => ({ html: '<p>private</p>', finalUrl: 'http://127.0.0.1/private', blockedRequests: 0 }) });
    expect(await service.fetch("https://example.com/start", { ...fetchContext, allowRenderFallback: true })).toMatchObject({ status: "blocked", reason: "private-network" });
    expect(service.cache.size).toBe(0);
    await service.dispose();
  });
  it("bounds all concurrent rendered resources by one acquisition budget", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return url.endsWith("/start") ? new Response("<script></script>", { headers: { "content-type": "text/html" } })
        : new Response("12345678", { headers: { "content-type": "text/plain" } });
    }));
    const service = createWebFetch({ ssrf: createMockSsrf(), maxBytes: 20, renderer: async request => {
      const responses = await Promise.allSettled(["a", "b", "c"].map(path => request.fetch({ url: `https://example.com/${path}`, method: "GET", headers: {} }, request.signal!)));
      await expect(request.fetch({ url: "https://example.com/after-limit", method: "GET", headers: {} }, request.signal!)).rejects.toThrow("aggregate download budget");
      return { html: "<p>result</p>", finalUrl: request.url, blockedRequests: responses.filter(value => value.status === "rejected").length + 1 };
    } });
    const result = await service.fetch("https://example.com/start", { ...fetchContext, allowRenderFallback: true });
    expect(result).toMatchObject({ status: "ok", completeness: { download: { status: "partial", retainedBytes: 20, receivedBytes: 24, limitBytes: 20 }, extraction: { status: "partial" } } });
    expect(urls).not.toContain("https://example.com/after-limit");
    await service.dispose();
  });
  it("keeps the renderer deadline active and waits for its original stop", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    let rendererSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<script></script>", { headers: { "content-type": "text/html" } })));
    const service = createWebFetch({ ssrf: createMockSsrf(), renderer: async request => {
      rendererSignal = request.signal;
      await drained;
      return { html: "<p>late</p>", finalUrl: request.url, blockedRequests: 0 };
    } });
    let settled = false;
    try {
      const pending = service.fetch("https://example.com/slow-render", { ...fetchContext, allowRenderFallback: true }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(0);
      expect(rendererSignal).toBeDefined();
      await vi.advanceTimersByTimeAsync(20_001);
      expect(rendererSignal!.aborted).toBe(true);
      expect(settled).toBe(false);
      release();
      expect(await pending).toMatchObject({ status: "failed", errorClass: "timeout" });
      expect(service.cache.size).toBe(0);
      await service.dispose();
    } finally { release(); vi.useRealTimers(); }
  });

});

/**
 * Repeatable catalog-query measurement for the symbol graph.
 *
 * Not part of the default test suite. Run with:
 *
 *   bun run --cwd packages/web symbol-graph-query
 *
 * Prints one JSON object to stdout. Progress goes to stderr. Does not claim a
 * speedup. Uses `git ls-files` plus the same tree-sitter queries,
 * `replaceFileSymbols` path, associate gate and `CATALOG_SCAN_BATCH` write
 * burst as the collector, so the numbers describe the shape the product runs.
 * Gated association candidates are stored as compact file facts and resolved
 * from committed connects after the first pass; the old source re-collect pass
 * is deliberately not part of this measurement.
 *
 * Enumeration is still `git ls-files`; the resulting list is supplied through
 * the runtime's `searchFilesystemFiles` boundary so this script measures the
 * production scan path without depending on workspace-root plumbing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { languageIdForPath } from "../application-host/lib/harness/language-id.js";
import { openWorkspaceKnowledge } from "../application-host/lib/knowledge/store.js";
import { CATALOG_SCAN_BATCH, createSymbolGraphRuntime } from "../application-host/lib/knowledge/symbol-runtime.js";
import { CATALOG_SCAN_LANGUAGES } from "../application-host/lib/structure/languages.js";
import { createStructureSource } from "../application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../application-host/lib/structure/tree-sitter-provider.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const catalogFiles = (): string[] => {
  const listed = spawnSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr || listed.status}`);
  }
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && CATALOG_SCAN_LANGUAGES.has(languageIdForPath(line) ?? ""));
};

const main = async (): Promise<void> => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "varin-symbol-graph-query-"));
  const store = await openWorkspaceKnowledge({
    dataDir,
    hostId: "symbol-graph-query-host",
    workspaceId: "measurement",
    embedding: null,
  });
  const source = createStructureSource([createTreeSitterStructureProvider()]);
  const sourceCalls = { outline: 0, imports: 0, literalCalls: 0 };
  const instrumentedSource = {
    outline: (request: Parameters<typeof source.outline>[0]) => {
      sourceCalls.outline += 1;
      return source.outline(request);
    },
    classifyHits: (request: Parameters<typeof source.classifyHits>[0]) => source.classifyHits(request),
    imports: (request: Parameters<typeof source.imports>[0]) => {
      sourceCalls.imports += 1;
      return source.imports(request);
    },
    literalCalls: (request: Parameters<typeof source.literalCalls>[0]) => {
      sourceCalls.literalCalls += 1;
      return source.literalCalls(request);
    },
  };
  const files = catalogFiles();
  process.stderr.write(`catalog files (git ls-files ∩ CATALOG_SCAN_LANGUAGES): ${files.length}\n`);
  const fileItems = files.map((relativePath) => ({
    name: path.basename(relativePath),
    path: path.join(repoRoot, relativePath),
    relativePath,
  }));
  let readCount = 0;
  let readFailed = 0;
  let searchCount = 0;
  let runtimeErrors = 0;
  const runtimeErrorMessages = new Set<string>();
  const runtime = createSymbolGraphRuntime({
    getStore: async () => store,
    documents: {
      inspectWorkspace: async () => ({ root: repoRoot }),
      read: async ({ resourceId }: { resourceId: string }) => {
        readCount += 1;
        const absolute = path.join(repoRoot, resourceId);
        try {
          const content = await fs.readFile(absolute, "utf8");
          const revision = createHash("sha256").update(content).digest("hex").slice(0, 16);
          return {
            status: "ready",
            resource: { workspaceId: "measurement", resourceId },
            content,
            revision,
            encoding: "utf-8",
            bom: false,
            byteLength: Buffer.byteLength(content, "utf8"),
            epoch: 1,
          };
        } catch {
          readFailed += 1;
          return { status: "missing", resource: { workspaceId: "measurement", resourceId } };
        }
      },
    } as never,
    supervisor: {
      syncDocument: async () => ({ status: "synced", documentVersion: 1 }),
      documentSymbols: async () => ({ status: "failed", message: "catalog measurement must not start a language server" }),
    } as never,
    structureSource: instrumentedSource,
    searchFilesystemFiles: async () => {
      searchCount += 1;
      return fileItems;
    },
    onError: (error) => {
      runtimeErrors += 1;
      runtimeErrorMessages.add(error instanceof Error ? error.message : String(error));
    },
  });
  const scanStarted = performance.now();
  await runtime.scanWorkspace("measurement");
  const catalogBuildMs = performance.now() - scanStarted;
  const coldReadCount = readCount;
  const hotStarted = performance.now();
  await runtime.scanWorkspace("measurement");
  const hotRescanMs = performance.now() - hotStarted;
  const stats = await store.catalogStats();
  const searchStarted = performance.now();
  const symbols = await store.searchSymbols("explore", 20);
  const searchSymbolsMs = performance.now() - searchStarted;
  const linksStarted = performance.now();
  const links = await store.findLinks("explore.search");
  const findLinksMs = performance.now() - linksStarted;
  const explorePath = stats.paths.find((item) => item.endsWith("explore.ts") && item.includes("harness")) ?? stats.paths[0] ?? "";
  const importersStarted = performance.now();
  const importers = explorePath ? await store.findImporters(explorePath) : { resolved: [] };
  const findImportersMs = performance.now() - importersStarted;
  await runtime.dispose();
  process.stdout.write(`${JSON.stringify({
    catalogBuildMs: Number(catalogBuildMs.toFixed(1)),
    hotRescanMs: Number(hotRescanMs.toFixed(3)),
    searchSymbolsMs: Number(searchSymbolsMs.toFixed(3)),
    findLinksMs: Number(findLinksMs.toFixed(3)),
    findImportersMs: Number(findImportersMs.toFixed(3)),
    catalogFileCount: files.length,
    readCount,
    reads: { cold: coldReadCount, hot: readCount - coldReadCount },
    readFailed,
    searchCount,
    sourceCalls,
    runtimeErrors,
    runtimeErrorMessages: [...runtimeErrorMessages],
    symbolCount: stats.symbolCount,
    fileCount: stats.fileCount,
    linkCount: stats.linkCount,
    nodeCount: stats.nodeCount,
    languages: stats.languages,
    searchHitCount: symbols.length,
    searchMatchTiers: Object.fromEntries(
      ["exact", "name-contains", "path-contains"].map((tier) => [tier, symbols.filter((item) => item.match === tier).length]),
    ),
    linkHitCount: links.length,
    importerCount: importers.resolved.length,
    explorePath,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? null,
      totalmemMiB: Math.round(os.totalmem() / (1024 * 1024)),
      node: process.version,
    },
    method: `git ls-files of this repository ∩ CATALOG_SCAN_LANGUAGES, then createSymbolGraphRuntime.scanWorkspace with tree-sitter outline/imports/literalCalls, compact association facts, one relation-only resolution pass, and writes issued in bursts of CATALOG_SCAN_BATCH=${CATALOG_SCAN_BATCH} as the collector does. A second unchanged scan measures hotRescanMs while still rechecking document revisions; external file writes are picked up on that explicit rescan. Queries: one searchSymbols('explore', 20), one findLinks('explore.search'), one findImporters of harness explore.ts. Clock is process performance.now(). Not a speedup claim. Enumeration is git ls-files, supplied to the runtime's searchFilesystemFiles boundary.`,
  }, null, 2)}\n`);
  await store.close();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }).catch(() => undefined);
};

await main();

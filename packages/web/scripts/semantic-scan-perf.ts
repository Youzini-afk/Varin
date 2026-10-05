import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createDocumentAuthorityHarness } from "../application-host/lib/documents/contract-fixtures.js";
import { createStructureSource } from "../application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../application-host/lib/structure/tree-sitter-provider.js";
import {
  semanticGenerationDir,
  semanticSpaceDir,
  spaceIdOf,
  workspaceScope,
} from "../application-host/lib/knowledge/semantic/identity.js";
import { createLocalSemanticEmbedder } from "../application-host/lib/knowledge/semantic/local-embedder.js";
import { resolveInstalledModelPack } from "../application-host/lib/knowledge/semantic/model-store.js";
import { createSemanticIndexRuntime, isSemanticIndexPath } from "../application-host/lib/knowledge/semantic/runtime.js";

/**
 * Manual one-process performance diagnostic. Its output is evidence for local
 * investigations, not a stable CI benchmark or regression threshold.
 */
const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const target = (process.argv[2] ?? "packages/web/application-host/lib/knowledge/semantic").replaceAll("\\", "/");
const tracked = execFileSync("git", ["-C", repositoryRoot, "ls-files", "-z", "--", target], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .filter(isSemanticIndexPath);
if (tracked.length === 0) throw new Error(`No tracked semantic-scannable files under ${target}`);

const pack = resolveInstalledModelPack("");
if (!pack?.onnxPath) throw new Error("The local MiniLM model pack is not installed.");
const harness = await createDocumentAuthorityHarness();
const hostId = "semantic-scan-perf";
const files = tracked.map((resourceId) => {
  const source = join(repositoryRoot, resourceId);
  const destination = join(harness.workspaceRoot, resourceId);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
  return {
    name: basename(resourceId),
    path: destination,
    relativePath: resourceId,
    bytes: statSync(source).size,
  };
});
const largest = files.toSorted((left, right) => right.bytes - left.bytes)[0]!;
const embedder = createLocalSemanticEmbedder({ dataDir: harness.dataDir, pack });
const errors: string[] = [];
const runtime = createSemanticIndexRuntime({
  dataDir: harness.dataDir,
  hostId,
  documents: harness.authority,
  structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 30_000 })]),
  searchFilesystemFiles: async () => files,
  embedder,
  onError: (error) => errors.push(error instanceof Error ? error.stack ?? error.message : String(error)),
});
const scope = workspaceScope(harness.identity.workspaceId);
const spaceDir = semanticSpaceDir(harness.dataDir, hostId, scope, spaceIdOf(embedder.space));
const started = performance.now();
const progress: Array<{ processedFiles: number; publishedDocuments: number; elapsedMs: number }> = [];

try {
  await runtime.scanScope(scope, {
    onBatchComplete: (sample) => progress.push({
      processedFiles: sample.processedFiles,
      publishedDocuments: sample.publishedDocuments,
      elapsedMs: performance.now() - started,
    }),
  });
  const wallMs = performance.now() - started;
  const status = runtime.statusFor(scope);
  const checkpoint = JSON.parse(readFileSync(join(spaceDir, "current.json"), "utf8")) as {
    generation: string;
    publishedDocuments: number;
  };
  await runtime.dispose();
  const dbPath = join(semanticGenerationDir(
    harness.dataDir,
    hostId,
    scope,
    spaceIdOf(embedder.space),
    checkpoint.generation,
  ), "index.tdb");
  const db = new TriviumDB(dbPath, {
    dim: embedder.space.dim,
    accessMode: "readOnly",
    loadTextIndex: false,
    payloadCacheMb: 0,
  });
  let chunks: number;
  try {
    chunks = db.indexedLookup({ type: "block" }, Math.max(1, db.nodeCount())).length;
  } finally {
    db.close();
  }
  console.log(JSON.stringify({
    target: relative(repositoryRoot, resolve(repositoryRoot, target)).replaceAll("\\", "/"),
    files: files.length,
    chunks,
    publishedDocuments: checkpoint.publishedDocuments,
    firstBatchMs: progress[0] ? Math.round(progress[0].elapsedMs * 100) / 100 : null,
    wallMs: Math.round(wallMs * 100) / 100,
    progress: progress.map((sample) => ({
      processedFiles: sample.processedFiles,
      publishedDocuments: sample.publishedDocuments,
      elapsedMs: Math.round(sample.elapsedMs * 100) / 100,
    })),
    largestFile: { path: largest.relativePath, bytes: largest.bytes },
    status,
    errors,
  }));
} finally {
  await runtime.dispose();
  await harness.cleanup();
}

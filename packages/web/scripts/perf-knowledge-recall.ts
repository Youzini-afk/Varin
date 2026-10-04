/**
 * Manual knowledge-recall diagnostic using generated documents and the real
 * TriviumDB owner. No provider or user store is opened. Run with:
 *   bun x tsx scripts/perf-knowledge-recall.ts [documents] [blocks] [body-bytes] [engine|ipc]
 * Timings are local observations; request counts and serialized bytes are
 * deterministic workload evidence. The legacy path exists only in this probe.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { serialize } from "node:v8";
import { createSemanticStoreEngine } from "../application-host/lib/knowledge/semantic/store-engine.js";
import { createSemanticGenerationStore } from "../application-host/lib/knowledge/semantic/store.js";
import { createHashEmbedder } from "../application-host/lib/knowledge/semantic/embedder.js";
import { knowledgeStoreProcess } from "../application-host/lib/knowledge/store-process.js";
import type { SemanticChunk } from "../application-host/lib/knowledge/semantic/chunker.js";

const documents = Number(process.argv[2] ?? 1000);
const blocks = Number(process.argv[3] ?? 8);
const bodyBytes = Number(process.argv[4] ?? 2048);
const mode = process.argv[5] ?? "ipc";
if (![documents, blocks, bodyBytes].every(value => Number.isSafeInteger(value) && value > 0)
  || !["engine", "ipc"].includes(mode)) throw new Error("Expected positive fixture dimensions and engine|ipc");

const dataDir = mkdtempSync(join(tmpdir(), "varin-perf-knowledge-recall-"));
const space = { ...createHashEmbedder().space, dim: 2, modelRevision: "recall-performance" };
const scope = { scopeKind: "knowledge-workspace", scopeId: "fixture" };
const options = { dataDir, hostId: "perf", scope, space };
const expected = Array.from({ length: documents }, (_, index) => ({ documentId: String(index + 1), revision: "r1" }));
const fixture = expected.map(({ documentId, revision }) => ({
  documentId, revision,
  chunks: Array.from({ length: blocks }, (_, index): SemanticChunk => ({
    documentId, blockId: `${documentId}:${index}`, parentUnitId: documentId,
    parentName: "", parentKind: "knowledge", parentSignature: "",
    startLine: index + 1, endLine: index + 1, contentHash: `${documentId}:${index}`,
    body: "x".repeat(bodyBytes), embedText: "x".repeat(bodyBytes), fallback: true,
  })),
  vectors: Array.from({ length: blocks }, (_, index) => [1, index / blocks]),
}));
let engine: ReturnType<typeof createSemanticStoreEngine> | null = createSemanticStoreEngine(options);
let facade: ReturnType<typeof createSemanticGenerationStore> | null = null;
try {
  engine.markBuilding("building");
  await engine.publishDocuments(fixture);
  engine.markReady(true);
  if (mode === "ipc") {
    await engine.close();
    engine = null;
    facade = createSemanticGenerationStore({ ...options, embedder: { ...createHashEmbedder(), space } });
    await facade.ready();
  }
  const store = facade ?? engine!;
  const stats = { requests: 0, requestBytes: 0, responseBytes: 0 };
  const owner = mode === "ipc" ? knowledgeStoreProcess("semantic") : null;
  const originalRequest = owner?.request.bind(owner);
  if (owner && originalRequest) {
    owner.request = async (...args: Parameters<typeof owner.request>) => {
      stats.requests += 1;
      stats.requestBytes += serialize(args.slice(0, 3)).byteLength;
      const value = await originalRequest(...args);
      stats.responseBytes += serialize(value).byteLength;
      return value;
    };
  }

  const legacy = async () => {
    const publishedIds = await store.listDocumentIds();
    const validDocuments = new Set<string>();
    const byDocument = new Map(expected.map(item => [item.documentId, item.revision]));
    for (const documentId of publishedIds) {
      const revision = byDocument.get(documentId);
      const published = revision ? await store.publishedRevision(documentId) : null;
      if (revision && published?.revision === revision) validDocuments.add(documentId);
    }
    const maskPaths = publishedIds.filter(documentId => !validDocuments.has(documentId));
    const semanticHits = await store.search([1, 0], Number.MAX_SAFE_INTEGER, { maskPaths });
    const best = new Map<string, { documentId: string; revision: string; similarity: number }>();
    for (const hit of semanticHits) {
      if (!validDocuments.has(hit.documentId) || byDocument.get(hit.documentId) !== hit.revision) continue;
      if ((best.get(hit.documentId)?.similarity ?? -Infinity) < hit.similarity) {
        best.set(hit.documentId, { documentId: hit.documentId, revision: hit.revision, similarity: hit.similarity });
      }
    }
    return [...best.values()].sort((left, right) => right.similarity - left.similarity
      || Number(left.documentId) - Number(right.documentId));
  };
  const measure = async (path: string, operation: () => Promise<unknown>) => {
    stats.requests = stats.requestBytes = stats.responseBytes = 0;
    const start = performance.now();
    const cpuStart = process.cpuUsage();
    const result = await operation();
    const cpu = process.cpuUsage(cpuStart);
    const elapsedMs = performance.now() - start;
    const observation = { path, elapsedMs: Number(elapsedMs.toFixed(3)),
      ...(mode === "engine" ? { cpuMs: (cpu.user + cpu.system) / 1000 } : {}), ...stats,
      resultBytes: serialize(result).byteLength };
    return { result, observation };
  };
  const samples = [];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const before = await measure("legacy", legacy);
    const after = await measure("document-scores", async () => (
      (await store.searchDocumentScores([1, 0], expected, documents)).hits
    ));
    assert.deepEqual(after.result, before.result);
    samples.push({ iteration, before: before.observation, after: after.observation });
  }
  if (owner && originalRequest) owner.request = originalRequest;
  console.log(JSON.stringify({ mode, documents, blocksPerDocument: blocks, bodyBytes, samples }, null, 2));
} finally {
  await facade?.close();
  await engine?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

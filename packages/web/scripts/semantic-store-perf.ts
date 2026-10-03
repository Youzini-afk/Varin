import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createHashEmbedder } from "../application-host/lib/knowledge/semantic/embedder.js";
import { workspaceScope } from "../application-host/lib/knowledge/semantic/identity.js";
import {
  createSemanticGenerationStore,
  type SemanticDocumentPublication,
} from "../application-host/lib/knowledge/semantic/store.js";

/**
 * Manual one-process performance diagnostic. Its output is evidence for local
 * investigations, not a stable CI benchmark or regression threshold.
 */
const total = Number.parseInt(process.argv[2] ?? "1000", 10);
const interval = Number.parseInt(process.argv[3] ?? "100", 10);
const batchSize = Number.parseInt(process.argv[4] ?? "1", 10);
if (!(total > 0 && interval > 0 && batchSize > 0)) {
  throw new Error("Usage: semantic-store-perf.ts [documents>0] [report-interval>0] [batch-size>0]");
}

const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-store-perf-"));
const store = createSemanticGenerationStore({
  dataDir,
  hostId: "perf",
  scope: workspaceScope("workspace"),
  embedder: createHashEmbedder(),
});

try {
  await store.markBuilding("building");
  let windowStarted = performance.now();
  const started = windowStarted;
  for (let offset = 0; offset < total;) {
    const nextReport = Math.min(total, (Math.floor(offset / interval) + 1) * interval);
    const count = Math.min(batchSize, nextReport - offset);
    const publications: SemanticDocumentPublication[] = Array.from({ length: count }, (_, index) => ({
      documentId: `src/document-${offset + index}.ts`,
      revision: "r1",
      chunks: [],
    }));
    await store.publishDocuments(publications);
    offset += count;
    if (offset === nextReport) {
      const now = performance.now();
      console.log(JSON.stringify({
        documents: offset,
        batchSize,
        windowMs: Math.round((now - windowStarted) * 100) / 100,
        totalMs: Math.round((now - started) * 100) / 100,
      }));
      windowStarted = now;
    }
  }
} finally {
  await store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

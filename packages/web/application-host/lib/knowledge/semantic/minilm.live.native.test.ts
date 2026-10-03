/**
 * The one test that exercises the real MiniLM pack: tokenizer, ONNX session,
 * pooling, normalization, and a nearest neighbour whose query shares no word
 * with the target body. Skipped when the pack is absent, because weights are
 * fetched by `semantic:copy-model` rather than checked in (D-172).
 */

import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDocumentAuthorityHarness } from "../../documents/contract-fixtures.js";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/native-provider.test-helper.js";
import { createLocalMinilmEmbedder } from "./minilm.js";
import { resolveInstalledModelPack } from "./model-store.js";
import { LOCAL_MINILM_SPACE, workspaceScope } from "./identity.js";
import { createSemanticIndexRuntime } from "./runtime.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposes.splice(0).reverse()) await dispose();
});

const pack = resolveInstalledModelPack("");
const hasPack = Boolean(pack?.onnxPath);

const cosine = (left: readonly number[], right: readonly number[]): number => {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index]! * right[index]!;
  return dot;
};

describe.skipIf(!hasPack)("local MiniLM pack", () => {
  it("tokenizes, embeds at the space dimension, and ranks a lexical-gap body first", async () => {
    const embedder = createLocalMinilmEmbedder({ dataDir: "", pack });
    expect(embedder.status).toBe("ready");
    await embedder.prepare();

    expect(embedder.countTokens("export function reclaimLease(handle: string) {")).toBeGreaterThan(5);

    const query = "how does the runtime discard idle tokens";
    const target = "export function reclaimLease(handle: string) {\n  parkedHandles.delete(handle);\n}";
    const decoy = "export const CSS_RESET = \"margin:0;padding:0\";";

    const [queryVector, targetVector, decoyVector] = await embedder.embed([query, target, decoy]);
    expect(queryVector).toHaveLength(LOCAL_MINILM_SPACE.dim);
    expect(targetVector).toHaveLength(LOCAL_MINILM_SPACE.dim);

    // Normalized vectors, so cosine is the dot product and lives in [-1, 1].
    const norm = Math.sqrt(cosine(queryVector!, queryVector!));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);

    const targetScore = cosine(queryVector!, targetVector!);
    const decoyScore = cosine(queryVector!, decoyVector!);
    expect(targetScore).toBeGreaterThan(decoyScore);
  }, 120_000);

  it("indexes and answers a lexical-gap query through the real runtime", async () => {
    const documents = await createDocumentAuthorityHarness();
    disposes.push(() => documents.cleanup());
    const files = {
      "lease.ts": [
        "export function reclaimLease(handle: string) {",
        "  parkedHandles.delete(handle);",
        "  return handle;",
        "}",
      ].join("\n"),
      "style.ts": [
        "export const CSS_RESET = \"margin:0;padding:0\";",
        "export function applyReset(node: HTMLElement) {",
        "  node.setAttribute(\"style\", CSS_RESET);",
        "}",
      ].join("\n"),
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(documents.workspaceRoot, name), body, "utf8");
    }

    const runtime = createSemanticIndexRuntime({
      dataDir: documents.dataDir,
      hostId: "minilm-live",
      documents: documents.authority,
      structureSource: createStructureSource([createTreeSitterStructureProvider({ parseBudgetMs: 30_000 })]),
      searchFilesystemFiles: async () => Object.keys(files).map((name) => ({
        name,
        path: join(documents.workspaceRoot, name),
        relativePath: name,
      })),
      embedder: createLocalMinilmEmbedder({ dataDir: documents.dataDir, pack }),
    });
    disposes.push(() => runtime.dispose());

    const scope = workspaceScope(documents.identity.workspaceId);
    await runtime.scanScope(scope);
    // No word of the question appears in either body.
    const found = await runtime.search(scope, "how does the runtime discard idle tokens", 8);
    expect(found.status.lifecycle).toBe("ready");
    expect(found.status.coverage).toBe("complete");
    expect(found.hits[0]?.documentId).toBe("lease.ts");
  }, 180_000);
});

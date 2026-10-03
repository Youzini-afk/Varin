import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHashEmbedder } from "./embedder.js";
import { blockIdentity, semanticSpaceDir, spaceIdOf, workspaceScope } from "./identity.js";
import { createSemanticGenerationStore } from "./store.js";
import type { SemanticChunk } from "./chunker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const chunk = (documentId: string, body: string, startLine = 1, endLine = 3): SemanticChunk => ({
  blockId: blockIdentity(documentId, startLine, endLine),
  parentUnitId: `${encodeURIComponent(documentId)}#run#function`,
  documentId,
  parentName: "run",
  parentKind: "function",
  parentSignature: "function run()",
  startLine,
  endLine,
  contentHash: `hash-${body}`,
  body,
  embedText: body,
  fallback: false,
});

describe("semantic generation store", () => {
  it("keeps two scopeIds isolated and accepts a non-path documentId", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-scope-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const alpha = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("scope-alpha"),
      embedder,
    });
    const beta = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("scope-beta"),
      embedder,
    });
    try {
      await alpha.publishDocument({
        documentId: "mail:abc123",
        revision: "r1",
        chunks: [chunk("mail:abc123", "alpha unique pineapple token")],
      });
      await beta.publishDocument({
        documentId: "src/other.ts",
        revision: "r1",
        chunks: [chunk("src/other.ts", "beta unique coconut token")],
      });
      const alphaHits = await alpha.search((await embedder.embed(["alpha unique pineapple token"]))[0]!, 8);
      const betaHits = await beta.search((await embedder.embed(["alpha unique pineapple token"]))[0]!, 8);
      expect(alphaHits[0]?.documentId).toBe("mail:abc123");
      expect(alphaHits[0]?.blockId).toContain(encodeURIComponent("mail:abc123"));
      expect(alphaHits.some((hit) => hit.documentId === "src/other.ts")).toBe(false);
      expect(betaHits.some((hit) => hit.documentId === "mail:abc123")).toBe(false);
    } finally {
      await alpha.close();
      await beta.close();
    }
  });

  it("computes scoped vector Top-K before truncating global candidates", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-scoped-topk-"));
    dirs.push(dataDir);
    const space = {
      provider: "test",
      model: "scoped-topk",
      modelRevision: "r1",
      dim: 2,
      pooling: "mean" as const,
      normalize: true,
      maxTokens: 32,
    };
    const embedder = {
      status: "ready" as const,
      space,
      prepare: async () => undefined,
      countTokens: (text: string) => Math.max(1, text.length),
      embed: async (texts: readonly string[]) => texts.map((text) => (
        text.includes("outside") ? [1, 0] : [0.8, 0.6]
      )),
      embedBatch: async (request: { batchId: string; items: ReadonlyArray<{ id: string; text: string }> }) => {
        const vectors = request.items.map((item) => (
          item.text.includes("outside") ? [1, 0] : [0.8, 0.6]
        ));
        return {
          batchId: request.batchId,
          space,
          items: request.items.map((item, index) => ({
            id: item.id,
            index,
            vector: vectors[index]!,
          })),
        };
      },
    };
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-scoped-topk"),
      embedder,
    });
    try {
      await store.publishDocuments([
        ...Array.from({ length: 5 }, (_, index) => {
          const documentId = `outside/${index}.ts`;
          return { documentId, revision: "r1", chunks: [chunk(documentId, `outside result ${index}`)] };
        }),
        {
          documentId: "allowed/z-inside.ts",
          revision: "r1",
          chunks: [chunk("allowed/z-inside.ts", "inside result")],
        },
      ]);

      expect((await store.search([1, 0], 1))[0]?.documentId).toMatch(/^outside\//);
      expect((await store.search([1, 0], 1, ["allowed"])).map((hit) => hit.documentId)).toEqual(["allowed/z-inside.ts"]);
      expect((await store.search([1, 0], 1, ["."]))[0]?.documentId).toMatch(/^outside\//);
      await expect(store.search([1], 1)).rejects.toThrow("dimension 1; expected 2");

      await store.publishDocument({
        documentId: "allowed/z-inside.ts",
        revision: "r2",
        chunks: [chunk("allowed/z-inside.ts", "inside result updated")],
      });
      expect((await store.search([1, 0], 1, ["allowed"]))[0]?.revision).toBe("r2");
      await store.removeDocument("allowed/z-inside.ts");
      expect(await store.search([1, 0], 1, ["allowed"])).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("reports partial coverage and only returns published documents while a generation is half-built", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-partial-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-partial"),
      embedder,
    });
    try {
      await store.markBuilding("building");
      await store.publishDocument({
        documentId: "src/ready.ts",
        revision: "r1",
        chunks: [chunk("src/ready.ts", "published zebra token")],
      });
      expect(store.coverage).toBe("partial");
      expect(store.lifecycle).toBe("building");
      const hits = await store.search((await embedder.embed(["published zebra token"]))[0]!, 8);
      expect(hits.map((hit) => hit.documentId)).toEqual(["src/ready.ts"]);
      expect(hits[0]?.generation).toBe(store.generation);
    } finally {
      await store.close();
    }
  });

  it("skips publishing when the embedder is unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-unavail-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    embedder.status = "unavailable";
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-unavail"),
      embedder,
    });
    try {
      await store.publishDocument({
        documentId: "src/a.ts",
        revision: "r1",
        chunks: [chunk("src/a.ts", "should not be stored")],
      });
      expect(await store.search((await createHashEmbedder().embed(["should not be stored"]))[0]!, 4)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("maintains published document counts across batches, replacements, removals, and reopen", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-count-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    const scope = workspaceScope("ws-count");
    const open = () => createSemanticGenerationStore({ dataDir, hostId: "host", scope, embedder });
    const store = open();
    await store.markBuilding("building");
    await store.publishDocuments([
      { documentId: "src/a.ts", revision: "r1", chunks: [chunk("src/a.ts", "alpha")] },
      { documentId: "src/b.ts", revision: "r1", chunks: [chunk("src/b.ts", "beta")] },
    ]);
    expect(store.checkpoint()?.publishedDocuments).toBe(2);

    await store.publishDocument({
      documentId: "src/a.ts",
      revision: "r2",
      chunks: [chunk("src/a.ts", "alpha changed")],
    });
    expect(store.checkpoint()?.publishedDocuments).toBe(2);
    await store.removeDocument("src/b.ts");
    expect(store.checkpoint()?.publishedDocuments).toBe(1);
    await store.close();

    // Simulate a current.json left behind before its count caught up with the
    // database transaction. Opening the store reconciles the database once.
    const current = join(semanticSpaceDir(dataDir, "host", scope, spaceIdOf(embedder.space)), "current.json");
    const stale = JSON.parse(readFileSync(current, "utf8")) as Record<string, unknown>;
    writeFileSync(current, `${JSON.stringify({ ...stale, publishedDocuments: 99 })}\n`, "utf8");
    const reopened = open();
    try {
      await reopened.ready();
      expect(reopened.checkpoint()?.publishedDocuments).toBe(1);
      expect(reopened.coverage).toBe("partial");
      expect(await reopened.publishedRevision("src/a.ts")).toEqual({ revision: "r2", recipeId: reopened.recipeId });
      expect(await reopened.publishedRevision("src/b.ts")).toBeNull();
      const scoped = await reopened.search((await embedder.embed(["alpha changed"]))[0]!, 1, ["src"]);
      expect(scoped[0]?.documentId).toBe("src/a.ts");
    } finally {
      await reopened.close();
    }
  });

  it("rejects incomplete embedding batches without publishing zero vectors", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-vector-count-"));
    dirs.push(dataDir);
    const embedder = createHashEmbedder();
    embedder.embed = async () => [];
    const store = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-vector-count"),
      embedder,
    });
    try {
      await expect(store.publishDocument({
        documentId: "src/a.ts",
        revision: "r1",
        chunks: [chunk("src/a.ts", "alpha")],
      })).rejects.toThrow("returned 0 vectors for 1 chunks");
      expect(await store.publishedRevision("src/a.ts")).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("recovers and recounts a partial generation left by an exited writer", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-semantic-recovery-"));
    dirs.push(dataDir);
    const semanticDir = dirname(fileURLToPath(import.meta.url));
    const storeUrl = pathToFileURL(join(semanticDir, "store.ts")).href;
    const embedderUrl = pathToFileURL(join(semanticDir, "embedder.ts")).href;
    const identityUrl = pathToFileURL(join(semanticDir, "identity.ts")).href;
    const child = spawnSync("node", ["--import", "tsx", "--input-type=module", "-e", `
      const { createSemanticGenerationStore } = await import(${JSON.stringify(storeUrl)});
      const { createHashEmbedder } = await import(${JSON.stringify(embedderUrl)});
      const { blockIdentity, workspaceScope } = await import(${JSON.stringify(identityUrl)});
      const documentId = "src/crashed.ts";
      const store = createSemanticGenerationStore({
        dataDir: process.env.VARIN_TEST_DATA_DIR,
        hostId: "host",
        scope: workspaceScope("ws-recovery"),
        embedder: createHashEmbedder(),
      });
      await store.markBuilding("building");
      await store.publishDocument({
        documentId,
        revision: "r1",
        chunks: [{
          blockId: blockIdentity(documentId, 1, 1),
          parentUnitId: "unit",
          documentId,
          parentName: "run",
          parentKind: "function",
          parentSignature: "function run()",
          startLine: 1,
          endLine: 1,
          contentHash: "hash",
          body: "crash recovery token",
          embedText: "crash recovery token",
          fallback: false,
        }],
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      process.exit(0);
    `], {
      cwd: process.cwd(),
      env: { ...process.env, VARIN_TEST_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);

    const reopened = createSemanticGenerationStore({
      dataDir,
      hostId: "host",
      scope: workspaceScope("ws-recovery"),
      embedder: createHashEmbedder(),
    });
    try {
      await reopened.ready();
      expect(reopened.checkpoint()).toMatchObject({
        lifecycle: "building",
        coverage: "partial",
        publishedDocuments: 1,
      });
      expect(await reopened.publishedRevision("src/crashed.ts")).toEqual({ revision: "r1", recipeId: reopened.recipeId });
    } finally {
      await reopened.close();
    }
  });
});

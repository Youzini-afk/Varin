import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as createTar } from "tar";
import {
  createLocalSemanticComponentManager,
  LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
  LOCAL_SEMANTIC_WORKER_ENTRY,
} from "./local-component.js";
import { resolveInstalledModelPack } from "./model-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function makeArchive(options: { extra?: string; schemaVersion?: number; modelBytes?: string } = {}): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "varin-local-semantic-source-"));
  roots.push(source);
  const files: Record<string, Uint8Array> = {
    "model/recipe.json": new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      provider: "local",
      model: "all-MiniLM-L6-v2",
      modelRevision: "test",
      dim: 3,
      pooling: "mean",
      normalize: true,
      maxTokens: 512,
      onnxFile: "onnx/model_quantized.onnx",
      tokenizerFile: "tokenizer.json",
    })),
    "model/tokenizer.json": new TextEncoder().encode("{}"),
    "model/onnx/model_quantized.onnx": new TextEncoder().encode(options.modelBytes ?? "test-onnx"),
    [LOCAL_SEMANTIC_TRANSFORMERS_ENTRY]: new TextEncoder().encode("export default {};"),
    [LOCAL_SEMANTIC_WORKER_ENTRY]: new TextEncoder().encode("export default {};"),
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(source, ...name.split("/"));
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, bytes);
  }
  if (options.extra) {
    const extraFile = join(source, ...options.extra.split("/"));
    await mkdir(join(extraFile, ".."), { recursive: true });
    await writeFile(extraFile, "unexpected");
  }
  const manifest = {
    schemaVersion: options.schemaVersion ?? 3,
    workerProtocol: 1,
    id: "local-semantic",
    version: "test-version",
    platform: process.platform,
    arch: process.arch,
    modelPath: "model",
    transformersEntry: LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
    workerEntry: LOCAL_SEMANTIC_WORKER_ENTRY,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.byteLength }])),
  };
  await writeFile(join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const archive = join(source, "component.tar.gz");
  await createTar({ file: archive, cwd: source, gzip: true, portable: true }, ["manifest.json", ...Object.keys(files), ...(options.extra ? [options.extra] : [])]);
  return archive;
}

describe("local semantic component manager", () => {
  it("keeps the component unavailable without importing a runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test" });
    expect(manager.status()).toEqual({ status: "not-installed" });
    const embedderModule = await import("./local-embedder.js");
    expect(embedderModule.createLocalSemanticEmbedder({ dataDir }).status).toBe("unavailable");
    await manager.dispose();
  });

  it("reports a damaged active pointer as failed rather than not-installed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const pointer = join(dataDir, "optional-components/local-semantic/active.json");
    await mkdir(join(pointer, ".."), { recursive: true });
    await writeFile(pointer, "{not-json", "utf8");
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test" });
    expect(manager.status()).toEqual({ status: "failed", error: expect.any(String) });
    await manager.dispose();
  });

  it("rejects files outside the manifest without publishing an active pointer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const archive = await makeArchive({ extra: "unexpected.txt" });
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(archive);
    expect(manager.status().status).toBe("failed");
    expect(resolveInstalledModelPack(dataDir)).toBeNull();
    await expect(readFile(join(dataDir, "optional-components/local-semantic/active.json"))).rejects.toThrow();
    await manager.dispose();
  });

  it("verifies and enables a complete package atomically", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const archive = await makeArchive();
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(archive);
    expect(manager.status()).toMatchObject({ status: "ready", version: "test-version" });
    expect(resolveInstalledModelPack(dataDir)).toMatchObject({ source: "component", recipe: { dim: 3 } });
    await manager.dispose();
  });

  it("leaves the previously enabled package usable after a failed replacement", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "varin-local-semantic-data-"));
    roots.push(dataDir);
    const valid = await makeArchive();
    const invalid = await makeArchive({ extra: "unexpected.txt" });
    const manager = createLocalSemanticComponentManager({ dataDir, version: "test", validatePack: async () => undefined });
    await manager.importArchive(valid);
    const before = resolveInstalledModelPack(dataDir);
    expect(before?.source).toBe("component");
    await manager.importArchive(invalid);
    expect(manager.status()).toMatchObject({ status: "ready", error: expect.any(String) });
    expect(resolveInstalledModelPack(dataDir)?.root).toBe(before?.root);
    await manager.dispose();
  });
});

it('rejects obsolete component archives and active manifests while preserving their bytes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-local-semantic-old-')); roots.push(dataDir);
  const archive = await makeArchive({ schemaVersion: 2 });
  const manager = createLocalSemanticComponentManager({ dataDir, version: 'test', validatePack: async () => undefined });
  await manager.importArchive(archive);
  expect(manager.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('manifest format 3 and worker protocol 1') });
  expect((await readFile(archive)).length).toBeGreaterThan(0);
  const parent = join(dataDir, 'optional-components/local-semantic');
  await mkdir(join(parent, 'versions/old'), { recursive: true });
  const manifestPath = join(parent, 'versions/old/manifest.json');
  await writeFile(manifestPath, await readFile(join(archive, '../manifest.json')));
  await writeFile(join(parent, 'active.json'), JSON.stringify({ schemaVersion: 1, root: 'versions/old', version: 'old' }));
  expect(resolveInstalledModelPack(dataDir)).toBeNull();
  const reopened = createLocalSemanticComponentManager({ dataDir, version: 'test' });
  expect(reopened.status()).toMatchObject({ status: 'failed', error: expect.stringContaining('manifest format 3 and worker protocol 1') });
  await reopened.dispose();
  expect((await readFile(manifestPath, 'utf8'))).toContain('"schemaVersion":2');
  await manager.dispose();
});

it('separates identical model names and revisions when verified graph bytes change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-local-semantic-identity-')); roots.push(dataDir);
  const manager = createLocalSemanticComponentManager({ dataDir, version: 'test', validatePack: async () => undefined });
  await manager.importArchive(await makeArchive({ modelBytes: 'first graph' }));
  const before = resolveInstalledModelPack(dataDir)!;
  await manager.importArchive(await makeArchive({ modelBytes: 'second graph' }));
  const after = resolveInstalledModelPack(dataDir)!;
  expect(after.recipe.modelRevision).toBe(before.recipe.modelRevision);
  expect(after.recipe.onnxFile).toBe(before.recipe.onnxFile);
  expect(after.space.configurationId).not.toBe(before.space.configurationId);
  expect(after.component!.manifestDigest).not.toBe(before.component!.manifestDigest);
  await manager.dispose();
});

import { createHash } from "node:crypto";

export const LOCAL_SEMANTIC_COMPONENT_ID = "local-semantic";
export const LOCAL_SEMANTIC_TRANSFORMERS_ENTRY = "runtime/node_modules/@huggingface/transformers/dist/transformers.node.mjs";
export const LOCAL_SEMANTIC_WORKER_ENTRY = "runtime/local-embedding-worker.mjs";
const MANIFEST_NAME = "manifest.json";

export interface LocalSemanticComponentManifest {
  schemaVersion: 3;
  workerProtocol: 1;
  id: typeof LOCAL_SEMANTIC_COMPONENT_ID;
  version: string;
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64";
  modelPath: "model";
  transformersEntry: typeof LOCAL_SEMANTIC_TRANSFORMERS_ENTRY;
  workerEntry: typeof LOCAL_SEMANTIC_WORKER_ENTRY;
  files: Record<string, { sha256: string; bytes: number }>;
}

export const safeRelativePath = (value: string, allowEmpty = false): string => {
  const normalized = value.replace(/\\/g, "/");
  if ((!normalized && !allowEmpty) || normalized.startsWith("/") || /^[A-Za-z]:(?:\/|$)/u.test(normalized)) {
    throw new Error(`Archive path is unsafe: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) throw new Error(`Archive path escapes its root: ${value}`);
  const result = parts.filter((part) => part && part !== ".").join("/");
  if (!result && !allowEmpty) throw new Error(`Archive path is empty: ${value}`);
  return result;
};

export const parseManifest = (raw: unknown): LocalSemanticComponentManifest => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Local semantic manifest is malformed.");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 3 || value.workerProtocol !== 1 || value.id !== LOCAL_SEMANTIC_COMPONENT_ID
    || typeof value.version !== "string" || !value.version.trim()
    || (value.platform !== "win32" && value.platform !== "linux" && value.platform !== "darwin")
    || (value.arch !== "x64" && value.arch !== "arm64")
    || value.modelPath !== "model"
    || value.transformersEntry !== LOCAL_SEMANTIC_TRANSFORMERS_ENTRY
    || value.workerEntry !== LOCAL_SEMANTIC_WORKER_ENTRY
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error("Local semantic component requires manifest format 3 and worker protocol 1 with a valid component shape. Rebuild and import it with the current component builder.");
  }
  const files: LocalSemanticComponentManifest["files"] = {};
  for (const [name, descriptor] of Object.entries(value.files as Record<string, unknown>)) {
    const normalized = safeRelativePath(name);
    if (normalized === MANIFEST_NAME || !descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`Local semantic manifest file entry is malformed: ${name}`);
    }
    const row = descriptor as Record<string, unknown>;
    if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/iu.test(row.sha256)
      || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      throw new Error(`Local semantic manifest file entry is malformed: ${name}`);
    }
    files[normalized] = { sha256: row.sha256.toLowerCase(), bytes: row.bytes };
  }
  if (!files["model/recipe.json"] || !files["model/tokenizer.json"] || !files[LOCAL_SEMANTIC_TRANSFORMERS_ENTRY] || !files[LOCAL_SEMANTIC_WORKER_ENTRY]) {
    throw new Error("Local semantic manifest is missing the model recipe, tokenizer, or runtime entry.");
  }
  return {
    schemaVersion: 3,
    workerProtocol: 1,
    id: LOCAL_SEMANTIC_COMPONENT_ID,
    version: value.version.trim(),
    platform: value.platform,
    arch: value.arch,
    modelPath: "model",
    transformersEntry: LOCAL_SEMANTIC_TRANSFORMERS_ENTRY,
    workerEntry: LOCAL_SEMANTIC_WORKER_ENTRY,
    files,
  };
};

/** Identity of the already verified immutable package; no model-byte reread. */
export const componentManifestDigest = (manifest: LocalSemanticComponentManifest): string => createHash('sha256')
  .update(JSON.stringify({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }))
  .digest('hex');

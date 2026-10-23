/**
 * Resolution for the optional local semantic component.
 *
 * The component manager owns archive validation and the active pointer. This
 * module only turns an already enabled component into the pack shape consumed
 * by the local encoder, so normal Host startup never scans or imports the runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifest, componentManifestDigest, LOCAL_SEMANTIC_TOKENIZER_ENTRY, type LocalSemanticComponentManifest } from "./local-component-manifest.js";
import { type VectorSpaceIdentity } from "./identity.js";

export interface SemanticModelRecipe {
  schemaVersion: 1;
  provider: "local";
  model: string;
  modelRevision: string;
  dim: number;
  pooling: "mean" | "cls";
  normalize: boolean;
  maxTokens: number;
  onnxFile: string;
  tokenizerFile: string;
  /** Actual local inference grain. Every input is still encoded. */
  inferenceBatchSize?: number;
  batchByLength?: boolean;
  preferredCpuThreads?: number;
  /** Enable timing-based grains only for exports verified across batch sizes. */
  adaptiveBatching?: boolean;
}

export interface ResolvedModelPack {
  id: string;
  root: string;
  recipe: SemanticModelRecipe;
  space: VectorSpaceIdentity;
  onnxPath: string | null;
  tokenizerPath: string | null;
  source: "bundled" | "component";
  component?: { componentId: string; componentVersion: string; manifestDigest: string; workerProtocol: number };
  /** Absolute path to the component's transformers.node.mjs entry. */
  transformersEntry?: string;
  inferenceWorkerEntry?: string;
  tokenizerEntry?: string;
}

const RECIPE_NAME = "recipe.json";
const COMPONENT_ROOT = "optional-components/local-semantic";

const readRecipe = (file: string): SemanticModelRecipe | null => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SemanticModelRecipe>;
    if (raw.schemaVersion !== 1 || raw.provider !== "local"
      || typeof raw.model !== "string" || typeof raw.modelRevision !== "string"
      || typeof raw.dim !== "number" || typeof raw.pooling !== "string"
      || typeof raw.normalize !== "boolean" || typeof raw.maxTokens !== "number"
      || typeof raw.onnxFile !== "string" || typeof raw.tokenizerFile !== "string"
      || (raw.inferenceBatchSize !== undefined && (!Number.isSafeInteger(raw.inferenceBatchSize) || raw.inferenceBatchSize < 1))
      || (raw.preferredCpuThreads !== undefined && (!Number.isSafeInteger(raw.preferredCpuThreads) || raw.preferredCpuThreads < 1))
      || (raw.batchByLength !== undefined && typeof raw.batchByLength !== "boolean")
      || (raw.adaptiveBatching !== undefined && typeof raw.adaptiveBatching !== 'boolean')) return null;
    return raw as SemanticModelRecipe;
  } catch {
    return null;
  }
};

const spaceFromRecipe = (recipe: SemanticModelRecipe): VectorSpaceIdentity => ({
  provider: recipe.provider,
  model: recipe.model,
  modelRevision: recipe.modelRevision,
  dim: recipe.dim,
  pooling: recipe.pooling,
  normalize: recipe.normalize,
  maxTokens: recipe.maxTokens,
  // Different graphs (e.g. FP32 versus an INT8 export) at one upstream model
  // revision must not share persisted vectors. The manifest verifies bytes.
  configurationId: `local-onnx:${recipe.onnxFile}`,
});

const safeComponentPath = (root: string, relativePath: string): string | null => {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")) return null;
  const candidate = resolve(root, relativePath);
  const base = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`;
  return candidate === resolve(root) || candidate.startsWith(base) ? candidate : null;
};

/** Resolve one extracted component without loading its optional runtime. */
export const resolveModelPackAtComponentRoot = (
  componentRoot: string,
  manifest: LocalSemanticComponentManifest,
  pathExists: (candidate: string) => boolean = existsSync,
): ResolvedModelPack | null => {
  const manifestDigest = componentManifestDigest(manifest);
  const modelRoot = safeComponentPath(componentRoot, manifest.modelPath);
  const transformersEntry = safeComponentPath(componentRoot, manifest.transformersEntry);
  const inferenceWorkerEntry = safeComponentPath(componentRoot, manifest.workerEntry);
  const tokenizerEntry = safeComponentPath(componentRoot, LOCAL_SEMANTIC_TOKENIZER_ENTRY);
  if (!modelRoot || !transformersEntry || !inferenceWorkerEntry || !tokenizerEntry || !pathExists(transformersEntry) || !pathExists(inferenceWorkerEntry) || !pathExists(tokenizerEntry)) return null;
  const recipe = readRecipe(join(modelRoot, RECIPE_NAME));
  if (!recipe) return null;
  const onnxPath = safeComponentPath(modelRoot, recipe.onnxFile);
  const tokenizerPath = safeComponentPath(modelRoot, recipe.tokenizerFile);
  if (!onnxPath || !tokenizerPath) return null;
  return {
    id: recipe.model,
    root: modelRoot,
    recipe,
    space: { ...spaceFromRecipe(recipe), configurationId: `local-component:${manifestDigest}` },
    component: { componentId: manifest.id, componentVersion: manifest.version, manifestDigest, workerProtocol: manifest.workerProtocol },
    onnxPath: pathExists(onnxPath) ? onnxPath : null,
    tokenizerPath: pathExists(tokenizerPath) ? tokenizerPath : null,
    source: "component",
    transformersEntry,
    inferenceWorkerEntry,
    tokenizerEntry,
  };
};

const activeComponentRoot = (dataDir: string): { root: string; manifest: LocalSemanticComponentManifest } | null => {
  const parent = join(dataDir, COMPONENT_ROOT);
  let raw: { schemaVersion?: unknown; root?: unknown };
  try {
    raw = JSON.parse(readFileSync(join(parent, "active.json"), "utf8")) as { schemaVersion?: unknown; root?: unknown };
  } catch {
    return null;
  }
  if (raw.schemaVersion !== 1 || typeof raw.root !== "string" || !raw.root.trim() || raw.root.includes("\\")) return null;
  const relative = raw.root.replace(/\\/g, "/");
  if (relative.split("/").some((part) => part === ".." || !part)) return null;
  const root = safeComponentPath(parent, relative);
  if (!root) return null;
  try {
    const manifest = parseManifest(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")));
    return { root, manifest };
  } catch {
    return null;
  }
};

export function resolveInstalledModelPack(dataDir: string): ResolvedModelPack | null {
  const component = activeComponentRoot(dataDir);
  return component ? resolveModelPackAtComponentRoot(component.root, component.manifest) : null;
}

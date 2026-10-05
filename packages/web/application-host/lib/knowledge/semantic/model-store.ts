/**
 * Resolution for the optional local semantic component.
 *
 * The component manager owns archive validation and the active pointer. This
 * module only turns an already enabled component into the pack shape consumed
 * by MiniLM, so normal Host startup never scans or imports the runtime.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
}

export interface ResolvedModelPack {
  id: string;
  root: string;
  recipe: SemanticModelRecipe;
  space: VectorSpaceIdentity;
  onnxPath: string | null;
  tokenizerPath: string | null;
  source: "bundled" | "component";
  /** Absolute path to the component's transformers.node.mjs entry. */
  transformersEntry?: string;
  inferenceWorkerEntry?: string;
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
      || (raw.batchByLength !== undefined && typeof raw.batchByLength !== "boolean")) return null;
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
  manifest: { modelPath: string; transformersEntry: string; workerEntry: string },
  pathExists: (candidate: string) => boolean = existsSync,
): ResolvedModelPack | null => {
  const modelRoot = safeComponentPath(componentRoot, manifest.modelPath);
  const transformersEntry = safeComponentPath(componentRoot, manifest.transformersEntry);
  const inferenceWorkerEntry = safeComponentPath(componentRoot, manifest.workerEntry);
  if (!modelRoot || !transformersEntry || !inferenceWorkerEntry || !pathExists(transformersEntry) || !pathExists(inferenceWorkerEntry)) return null;
  const recipe = readRecipe(join(modelRoot, RECIPE_NAME));
  if (!recipe) return null;
  const onnxPath = safeComponentPath(modelRoot, recipe.onnxFile);
  const tokenizerPath = safeComponentPath(modelRoot, recipe.tokenizerFile);
  if (!onnxPath || !tokenizerPath) return null;
  return {
    id: recipe.model,
    root: modelRoot,
    recipe,
    space: spaceFromRecipe(recipe),
    onnxPath: pathExists(onnxPath) ? onnxPath : null,
    tokenizerPath: pathExists(tokenizerPath) ? tokenizerPath : null,
    source: "component",
    transformersEntry,
    inferenceWorkerEntry,
  };
};

const activeComponentRoot = (dataDir: string): { root: string; manifest: { modelPath: string; transformersEntry: string; workerEntry: string } } | null => {
  const parent = join(dataDir, COMPONENT_ROOT);
  let raw: { root?: unknown };
  try {
    raw = JSON.parse(readFileSync(join(parent, "active.json"), "utf8")) as { root?: unknown };
  } catch {
    return null;
  }
  if (typeof raw.root !== "string" || !raw.root.trim() || raw.root.includes("\\")) return null;
  const relative = raw.root.replace(/\\/g, "/");
  if (relative.split("/").some((part) => part === ".." || !part)) return null;
  const root = safeComponentPath(parent, relative);
  if (!root) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      modelPath?: unknown;
      transformersEntry?: unknown;
      workerEntry?: unknown;
    };
    if (typeof manifest.modelPath !== "string" || typeof manifest.transformersEntry !== "string" || typeof manifest.workerEntry !== "string") return null;
    return { root, manifest: { modelPath: manifest.modelPath, transformersEntry: manifest.transformersEntry, workerEntry: manifest.workerEntry } };
  } catch {
    return null;
  }
};

export function resolveInstalledModelPack(dataDir: string): ResolvedModelPack | null {
  const component = activeComponentRoot(dataDir);
  return component ? resolveModelPackAtComponentRoot(component.root, component.manifest) : null;
}

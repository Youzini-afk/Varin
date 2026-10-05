/**
 * Host-local MiniLM via the optional local semantic component. The runtime is
 * loaded from the component's absolute entry only after a package is enabled;
 * missing weights are `unavailable`, not an empty ready index.
 */

import os from "node:os";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { intraOpThreads, LOCAL_MINILM_SPACE, type VectorSpaceIdentity } from "./identity.js";
import type { SemanticEmbedder, SemanticEmbedderStatus } from "./embedder.js";
import { resolveInstalledModelPack, type ResolvedModelPack } from "./model-store.js";

type Encoded = { length: number } | ArrayLike<number>;

type TransformersModule = {
  env: {
    allowRemoteModels?: boolean;
    localModelPath?: string;
    backends?: {
      onnx?: {
        wasm?: { numThreads?: number };
      };
    };
  };
  AutoTokenizer: {
    from_pretrained: (source: string, options?: { local_files_only?: boolean }) => Promise<{
      encode: (text: string) => Encoded | Promise<Encoded>;
    }>;
  };
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: {
      local_files_only?: boolean;
      dtype?: string;
      session_options?: {
        intraOpNumThreads?: number;
        interOpNumThreads?: number;
        intra_op_num_threads?: number;
        inter_op_num_threads?: number;
      };
    },
  ) => Promise<(
    texts: string | string[],
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<{ tolist: () => number[] | number[][] } | number[][]>>;
};

const encodedLength = (value: Encoded): number => (
  typeof (value as { length: number }).length === "number" ? (value as { length: number }).length : 0
);

/**
 * Kept out of the bundler's static graph so a desktop build does not inline the
 * runtime, but a real dynamic import so it actually loads and is testable — the
 * previous `new Function("return import(...)")` form threw "A dynamic import
 * callback was not specified" under the test runner, which is why this path had
 * never run (D-172).
 */
const TRANSFORMERS_MODULE_ID = "@huggingface/transformers";
// 32 is the measured CPU batch size for near-window inputs. It is only an
// inference grain: embed() always walks every input and preserves its order.
const INFERENCE_BATCH_SIZE = 32;

const loadTransformers = async (entry?: string): Promise<TransformersModule> => (
  await import(/* @vite-ignore */ (entry ? pathToFileURL(entry).href : TRANSFORMERS_MODULE_ID)) as TransformersModule
);

export function createLocalMinilmEmbedder(options: {
  dataDir: string;
  pack?: ResolvedModelPack | null;
  parallelism?: number;
}): SemanticEmbedder {
  // A query keeps one model identity for its entire lifetime. The workspace
  // owner replaces this instance when a new component is enabled.
  const packSnapshot = options.pack !== undefined ? options.pack : resolveInstalledModelPack(options.dataDir);
  const currentPack = (): ResolvedModelPack | null => packSnapshot;
  let encode: ((text: string) => number) | null = null;
  let prepared = false;
  let preparedRoot: string | null = null;
  let preparePromise: Promise<void> | null = null;
  let extractor: ((texts: readonly string[], signal?: AbortSignal) => Promise<number[][]>) | null = null;

  const threadCount = (): number => intraOpThreads(options.parallelism ?? os.availableParallelism());

  const configureThreads = (mod: TransformersModule): number => {
    const threads = threadCount();
    if (mod.env.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = threads;
    return threads;
  };

  const embedder: SemanticEmbedder = {
    inferenceBatchSize: INFERENCE_BATCH_SIZE,
    get status(): SemanticEmbedderStatus {
      return currentPack()?.onnxPath ? "ready" : "unavailable";
    },
    get space(): VectorSpaceIdentity {
      return currentPack()?.space ?? LOCAL_MINILM_SPACE;
    },
    prepare: async () => {
      const current = currentPack();
      if (prepared && preparedRoot === (current?.root ?? null)) return;
      if (preparePromise) return preparePromise;
      prepared = false;
      preparedRoot = null;
      encode = null;
      extractor = null;
      preparePromise = (async () => {
        const pack = currentPack();
        if (!pack?.root) {
          prepared = true;
          preparedRoot = null;
          encode = null;
          extractor = null;
          return;
        }
        const mod = await loadTransformers(pack.transformersEntry);
        const threads = configureThreads(mod);
        // transformers.js resolves a local pack as `${env.localModelPath}/${id}`
        // and looks for `onnx/<file>` inside it. A file:// URL as the id makes it
        // read `tokenizer_config.json` off the wrong base (D-172).
        mod.env.allowRemoteModels = false;
        mod.env.localModelPath = dirname(pack.root);
        const source = basename(pack.root);
        if (pack.tokenizerPath) {
          const tokenizer = await mod.AutoTokenizer.from_pretrained(source, { local_files_only: true });
          encode = (text) => {
            const ids = tokenizer.encode(text);
            return encodedLength(ids as Encoded);
          };
        }
        if (pack.onnxPath) {
          // `dtype` picks the weight filename: q8 resolves `onnx/model_quantized.onnx`,
          // which is the file the pack recipe names (D-172).
          const pipe = await mod.pipeline("feature-extraction", source, {
            local_files_only: true,
            dtype: "q8",
            session_options: {
              intraOpNumThreads: threads,
              interOpNumThreads: 1,
              intra_op_num_threads: threads,
              inter_op_num_threads: 1,
            },
          });
          extractor = async (texts, signal) => {
            const vectors: number[][] = [];
            for (let offset = 0; offset < texts.length; offset += INFERENCE_BATCH_SIZE) {
              signal?.throwIfAborted();
              const batch = texts.slice(offset, offset + INFERENCE_BATCH_SIZE);
              const output = await pipe(batch, { pooling: pack.space.pooling, normalize: pack.space.normalize });
              signal?.throwIfAborted();
              const listed = typeof (output as { tolist?: () => number[] | number[][] }).tolist === "function"
                ? (output as { tolist: () => number[] | number[][] }).tolist()
                : output as number[][];
              const rows = Array.isArray(listed[0]) ? listed as number[][] : [listed as number[]];
              if (rows.length !== batch.length || rows.some((row) => row.length !== pack.space.dim)) {
                throw new Error(`MiniLM returned ${rows.length} vectors for ${batch.length} inputs in ${pack.space.dim} dimensions.`);
              }
              vectors.push(...rows);
            }
            return vectors;
          };
        }
        prepared = true;
        preparedRoot = pack.root;
      })();
      const pending = preparePromise;
      try { await pending; }
      finally {
        if (preparePromise === pending) preparePromise = null;
      }
    },
    countTokens: (text) => {
      if (encode) return encode(text);
      throw new Error("MiniLM tokenizer is not prepared.");
    },
    embed: async (texts, request) => {
      const pack = currentPack();
      if (!pack?.onnxPath || !extractor || preparedRoot !== pack.root) {
        throw new Error("MiniLM model pack is unavailable.");
      }
      return extractor(texts, request?.signal);
    },
    embedBatch: async (request) => {
      request.signal?.throwIfAborted();
      const vectors = await embedder.embed(request.items.map((item) => item.text), {
        purpose: request.purpose, ...(request.signal ? { signal: request.signal } : {}),
      });
      request.signal?.throwIfAborted();
      const space = embedder.space;
      if (vectors.length !== request.items.length || vectors.some((vector) => vector.length !== space.dim)) {
        throw new Error(`MiniLM returned ${vectors.length} vectors for ${request.items.length} inputs in ${space.dim} dimensions.`);
      }
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
  return embedder;
}

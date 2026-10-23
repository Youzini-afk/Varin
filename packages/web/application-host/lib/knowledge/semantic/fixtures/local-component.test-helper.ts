/** Controlled model bytes inside the real component and Node Worker path. No ONNX quality claim. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOCAL_SEMANTIC_TRANSFORMERS_ENTRY, LOCAL_SEMANTIC_WORKER_ENTRY, LOCAL_SEMANTIC_TOKENIZER_ENTRY, parseManifest } from '../local-component-manifest.js';
import { resolveModelPackAtComponentRoot } from '../model-store.js';

export async function localComponentFixture(root: string, options: { revision?: string; dim?: number; batchSize?: number } = {}) {
  const dim = options.dim ?? 2;
  const model = join(root, 'model');
  await mkdir(model, { recursive: true });
  const files: Record<string, string> = {
    'model/recipe.json': JSON.stringify({ schemaVersion: 1, provider: 'local', model: 'controlled-bekko-contract', modelRevision: options.revision ?? 'fixture',
      dim, pooling: 'mean', normalize: true, maxTokens: 512, onnxFile: 'onnx/model.onnx', tokenizerFile: 'tokenizer.json',
      inferenceBatchSize: options.batchSize ?? 2, adaptiveBatching: false }),
    'model/tokenizer.json': '{}', 'model/tokenizer_config.json': '{}', 'model/onnx/model.onnx': 'controlled model bytes, never loaded as ONNX',
    [LOCAL_SEMANTIC_TOKENIZER_ENTRY]: `export class Tokenizer { encode(text) { return { ids: Array.from({length: text.split(/\\s+/u).filter(Boolean).length + 2}, (_, i) => i) }; } }`,
    [LOCAL_SEMANTIC_TRANSFORMERS_ENTRY]: `
      import { appendFile, writeFile, access } from 'node:fs/promises';
      import { join } from 'node:path';
      export const env = {};
      const tokenizer = { encode: text => Array.from({length: text.split(/\\s+/u).filter(Boolean).length + 2}, (_, i) => i) };
      export const AutoTokenizer = { from_pretrained: async () => tokenizer };
      export async function pipeline(_purpose, source) {
        const root = join(env.localModelPath, source);
        const extract = async texts => {
          await appendFile(join(root, 'calls.jsonl'), JSON.stringify(texts) + '\\n');
          if (texts.some(text => text.includes('HOLD_FORWARD'))) {
            await writeFile(join(root, 'started'), 'yes');
            while (true) {
              try { await access(join(root, 'release')); break; } catch {}
              await new Promise(resolve => setTimeout(resolve, 5));
            }
          }
          if (texts.some(text => text.includes('EXIT_FORWARD'))) process.exit(7);
          if (texts.some(text => text.includes('FAIL_FORWARD'))) throw new Error('Controlled encoder failure');
          return { tolist: () => texts.map(text => ${dim} === 2
            ? (text.includes('MAGENTA') || text === 'nebula docking' ? [1, 0] : [0, 1])
            : Array.from({ length: ${dim} }, (_, i) => i === 0 ? 1 : 0)) };
        };
        extract.tokenizer = tokenizer;
        extract.dispose = async () => {};
        return extract;
      }
    `,
  };
  for (const [name, value] of Object.entries(files)) {
    const target = join(root, name); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value);
  }
  await mkdir(join(root, 'runtime'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../../../../../../../scripts/local-embedding-worker.mjs', import.meta.url)), join(root, LOCAL_SEMANTIC_WORKER_ENTRY));
  const names = [...Object.keys(files), LOCAL_SEMANTIC_WORKER_ENTRY];
  const descriptors = await Promise.all(names.map(async name => {
    const bytes = await readFile(join(root, name)); return [name, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }];
  }));
  const manifest = parseManifest({ schemaVersion: 4, workerProtocol: 1, id: 'local-semantic', version: 'fixture', platform: process.platform, arch: process.arch,
    modelPath: 'model', transformersEntry: LOCAL_SEMANTIC_TRANSFORMERS_ENTRY, workerEntry: LOCAL_SEMANTIC_WORKER_ENTRY, files: Object.fromEntries(descriptors) });
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  return { pack: resolveModelPackAtComponentRoot(root, manifest)!, manifest, model,
    calls: async (): Promise<string[][]> => { try { return (await readFile(join(model, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]); } catch { return []; } },
    release: () => writeFile(join(model, 'release'), 'yes') };
}

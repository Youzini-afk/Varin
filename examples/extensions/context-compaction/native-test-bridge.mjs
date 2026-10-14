/** Cross-language test adapter. The native test owns both paths and the original Catalog job. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseVarinContextCompactionInput, parseVarinContextCompactionPlan } from '../../../packages/extension-contract/dist/index.js';
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: native-test-bridge.mjs preview.json plan.json');
const preview = parseVarinContextCompactionInput(JSON.parse(await readFile(inputPath, 'utf8')));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(new URL('./varin.extension.json', import.meta.url), 'utf8'));
let handlers;
await require(`./${manifest.entrypoints.host.file}`).default.activate({ services: { provide: (_descriptor, implementation) => { handlers = implementation; } } });
const plan = parseVarinContextCompactionPlan(await handlers.prepare([preview], { signal: new AbortController().signal }), preview);
await writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ sources: preview.sources.length, media: preview.sources.filter(source => source.item.content.kind === 'media').length,
  kind: plan.kind, nodes: plan.kind === 'model_plan' ? plan.nodes.length : 0, sourceCutHash: plan.sourceCutHash }));

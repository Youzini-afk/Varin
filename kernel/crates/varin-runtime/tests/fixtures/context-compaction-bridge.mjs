// Cross-language fixture: native preview -> actual Host v1 boundary -> SDK -> native plan validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
const root = path.resolve(import.meta.dirname, '../../../../..');
const { contextCompactionServiceInput } = await tsImport(path.join(root, 'packages/web/application-host/lib/kernel/context-compaction.ts'), import.meta.url);
const { provideContextCompaction } = await tsImport(path.join(root, 'packages/extension-sdk/src/context-compaction.ts'), import.meta.url);
const { parseVarinContextCompactionInput } = await tsImport(path.join(root, 'packages/extension-contract/src/context-compaction.ts'), import.meta.url);
const native = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.throws(() => parseVarinContextCompactionInput(native), /Invalid context compaction source/);
const input = contextCompactionServiceInput(native);
assert.deepEqual(parseVarinContextCompactionInput(input), input);
if (!native.sources.some(source => source.material)) throw new Error('Expected actual readable native materials');
if (input.sources.some(source => Object.hasOwn(source, 'material'))) throw new Error('Private source mapping reached v1');
let handler;
provideContextCompaction({ services: { provide(_descriptor, implementation) { handler = implementation; } } }, {
  identity: { name: 'v1-native-bridge', version: '1' }, configuration: null,
  prepare(value) {
    return { kind: 'model_plan', sourceCutHash: value.sourceCutHash, finalNodeId: 'source', nodes: [
      { id: 'source', instructions: null, inputs: value.sources.map(source => ({ kind: 'source', sourceId: source.sourceId,
        range: source.item.content.kind === 'text' && source.item.content.text.length
          ? { start: 0, end: Buffer.byteLength(source.item.content.text) } : null })) },
    ] };
  },
});
const plan = await handler.prepare([input], { signal: new AbortController().signal, callId: 'bridge',
  capabilities: { call() { throw new Error('Algorithm capabilities are unavailable'); } } });
fs.writeFileSync(process.argv[3], JSON.stringify(plan));
console.log('Native readable UTF-8 sources accepted by the unchanged v1 SDK after the actual Host boundary.');

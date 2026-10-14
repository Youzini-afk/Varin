import { defineHostExtension, provideContextCompaction } from '@varin/extension-sdk';
import type { VarinContextCompactionNode, VarinContextCompactionNodeInput } from '@varin/extension-contract';
import metadata from './package.json' with { type: 'json' };

// Algorithm choices belonging to this example, not limits imposed on other providers.
const configuration = {
  sourceChunkBytes: 4096,
  extractiveBytes: 512,
  leafInstructions: 'Summarize only this independently quoted source. Preserve original source IDs, decisions, evidence, unfinished work and uncertainty. Do not infer results from other sources.',
  mergeInstructions: 'Merge these independent summaries. Preserve original source IDs, disagreements, chronology, concrete evidence and unfinished work. Deduplicate only equivalent facts. Return one continuation summary.',
};
export default defineHostExtension({
  activate(context) {
    provideContextCompaction(context, {
      identity: { name: 'independent-source-merge-tree', version: metadata.version }, configuration,
      prepare(input, signal, declaredConfiguration) {
        const config = declaredConfiguration as typeof configuration;
        const encoder = new TextEncoder();
        signal.throwIfAborted();
        const extract = input.sources.every(source => source.item.content.kind === 'text')
          ? input.sources.map(source => `[${source.sourceId}]\n${source.item.content.kind === 'text' ? source.item.content.text : ''}`).join('\n\n')
          : null;
        if (extract?.trim() && encoder.encode(extract).length <= config.extractiveBytes) {
          return { kind: 'text', sourceCutHash: input.sourceCutHash, text: extract };
        }
        const nodes: VarinContextCompactionNode[] = [];
        let level: string[] = [];
        const leaf = (reference: VarinContextCompactionNodeInput) => {
          const id = `leaf-${nodes.length}`;
          nodes.push({ id, instructions: config.leafInstructions, inputs: [reference] }); level.push(id);
        };
        const maxBytes = input.modelBudget.sourceBudgetTokens === null ? config.sourceChunkBytes
          : Math.min(config.sourceChunkBytes, input.modelBudget.sourceBudgetTokens * 4);
        // This is a preparation heuristic, not a claim about measured tokens. Core checks real
        // requests and publication capacity. Inline media stays whole and has unknown token cost.
        for (const source of input.sources) {
          signal.throwIfAborted();
          if (source.item.content.kind === 'media') { leaf({ kind: 'source', sourceId: source.sourceId, range: null }); continue; }
          const bytes = encoder.encode(source.item.content.text);
          if (bytes.length <= maxBytes) { leaf({ kind: 'source', sourceId: source.sourceId, range: null }); continue; }
          let start = 0;
          while (start < bytes.length) {
            signal.throwIfAborted();
            let end = Math.min(bytes.length, start + maxBytes);
            while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
            if (end <= start) throw new Error('Selected summary source budget cannot represent a UTF-8 source character');
            leaf({ kind: 'source', sourceId: source.sourceId, range: { start, end } }); start = end;
          }
        }
        // Leaves never depend on earlier leaves. Each subsequent level merges disjoint subtrees.
        // The core executes topologically in serial; the graph promises no parallel model dispatch.
        while (level.length > 1) {
          signal.throwIfAborted();
          const next: string[] = [];
          for (let index = 0; index < level.length; index += 2) {
            const pair = level.slice(index, index + 2);
            if (pair.length === 1) { next.push(pair[0]!); continue; }
            const id = `merge-${nodes.length}`;
            nodes.push({ id, instructions: config.mergeInstructions, inputs: pair.map(nodeId => ({ kind: 'node_output', nodeId })) }); next.push(id);
          }
          level = next;
        }
        return { kind: 'model_plan', sourceCutHash: input.sourceCutHash, nodes, finalNodeId: level[0]! };
      },
    });
  },
});

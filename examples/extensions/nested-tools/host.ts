import { defineHostExtension, provideTool, type NestedToolReceipt } from '@varin/extension-sdk';
import { parseVarinToolJson } from '@varin/extension-contract';
import manifest from './varin.extension.json' with { type: 'json' };

export type MemoryThenReadInput = {
  memory: {
    action: 'read' | 'search' | 'save' | 'delete';
    scope?: 'global' | 'project' | 'currentThread';
    id?: number;
    content?: string;
    query?: string;
    revision?: number;
  };
  read?: { path: string; offset?: number; length?: number };
};

export type MemoryThenReadResult = {
  memory: NestedToolReceipt;
  read:
    | { status: 'not_requested' }
    | { status: 'skipped'; reason: 'memory_not_succeeded' }
    | { status: 'invoked'; receipt: NestedToolReceipt };
};

export default defineHostExtension({
  activate(context) {
    provideTool<MemoryThenReadInput>(context, manifest.provides.services[0], async (input, call) => {
      // These stable local IDs are bound by core to this original parent invocation.
      const memory = await call.tools.invoke({ callId: 'memory', name: 'memory', arguments: input.memory });
      let read: MemoryThenReadResult['read'] = { status: 'not_requested' };
      if (input.read !== undefined) {
        if (memory.completion.kind === 'result' && memory.completion.outcome === 'succeeded') {
          call.signal.throwIfAborted();
          read = { status: 'invoked', receipt: await call.tools.invoke({
            callId: 'read', name: 'file_read', arguments: input.read,
          }) };
        } else {
          read = { status: 'skipped', reason: 'memory_not_succeeded' };
        }
      }
      // Preserve the original completions and domain content; this is not a new effect receipt.
      const result: MemoryThenReadResult = { memory, read };
      return parseVarinToolJson(result);
    });
  },
});

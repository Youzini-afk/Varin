/** Real MemoryBridge -> MemoryOwner -> AgentPersonalization. Only Kernel Storage primitives
 * are a controlled in-memory fixture. This executable reads/writes original private frames
 * over test stdin/stdout; it does not implement or replace product Kernel transport. */
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { KernelClient, KernelScopedClient } from './kernel-client.js';
import { MemoryBridge, type PrivateMemoryResponse } from './memory-bridge.js';
import { createMemoryOwner } from './memory-owner.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import type { ContextPreparer } from './thread-context.js';
import type { ContextCheckpoint } from '@varin/application-client';

export function createNestedMemoryHostFixture() {
  type RecordValue = Awaited<ReturnType<KernelScopedClient['putRecord']>>;
  const records = new Map<string, RecordValue>();
  const operations = new Map<string, { kind: string; state: string; result: RecordValue }>();
  let writes = 0;
  const scoped = {
    getRecord: async (workspace: string, record: string) => structuredClone(records.get(`${workspace}:${record}`) ?? null),
    getOperation: async (id: string) => structuredClone(operations.get(id) ?? null),
    putRecord: async (input: Parameters<KernelScopedClient['putRecord']>[0]) => {
      const key = `${input.workspaceId}:${input.recordId}`, current = records.get(key);
      if (input.expectedRecordRevision !== undefined && input.expectedRecordRevision !== current?.recordRevision) throw new Error('record revision conflict');
      const result = { ...input, recordRevision: (current?.recordRevision ?? 0) + 1, createdAt: current?.createdAt ?? 1, updatedAt: 1 };
      records.set(key, structuredClone(result));
      operations.set(input.operationId, { kind: 'storage.record.put', state: 'committed', result: structuredClone(result) });
      writes++; return structuredClone(result);
    },
  };
  const storage = { issueGrant: async () => ({}), scoped: () => scoped } as unknown as KernelClient;
  const personalization = createAgentPersonalization({ client: storage, context: async () => ({ bot: false, threadRole: 'main' }) });
  const prepareContext = Object.assign(async () => { throw new Error('This fixture requires the original checkpoint for context synchronization'); },
    { main: async () => { throw new Error('No fixture main context'); },
      // This context fixture preserves the admitted system/profile snapshot. The real
      // MemoryOwner still fetches fresh runtimeState for ordinary tail-memory projection.
      refresh: async (checkpoint: ContextCheckpoint) => {
        if (!checkpoint.personalization) throw new Error('original personalization required');
        return structuredClone({ effectiveSystemPrompt: checkpoint.proposal.effective_system_prompt,
          instructionSources: checkpoint.proposal.instruction_sources, memoryCheckpoint: checkpoint.proposal.memory_checkpoint,
          personalization: checkpoint.personalization, ...(checkpoint.resources ? { resources: checkpoint.resources } : {}) });
      },
    }) as ContextPreparer;
  const owner = createMemoryOwner({ personalization, prepareContext });
  const pairs: Array<{ request: unknown; response: PrivateMemoryResponse }> = [];
  const pending = new Map<string, { request: unknown; resolve(value: PrivateMemoryResponse): void }>();
  let epoch = 'nested-memory-review';
  const bridge = new MemoryBridge(() => epoch, async response => {
    const waiting = pending.get(response.id); if (!waiting) throw new Error('unexpected fixture memory response');
    pending.delete(response.id); pairs.push({ request: waiting.request, response: structuredClone(response) }); waiting.resolve(response);
  }, () => { throw new Error('fixture memory transport failed'); });
  bridge.setOwner(owner);
  const dispatch = (frame: Record<string, unknown>): Promise<PrivateMemoryResponse> => {
    if (frame.kind !== 'memory-request' || typeof frame.id !== 'string' || typeof frame.kernelEpoch !== 'string' || pending.has(frame.id)) throw new Error('one original memory request identity is required');
    epoch = frame.kernelEpoch;
    return new Promise(resolve => { pending.set(frame.id as string, { request: structuredClone(frame), resolve }); if (!bridge.consume(frame)) throw new Error('memory frame rejected'); });
  };
  return { dispatch, pairs, personalization, owner, writes: () => writes, close: () => bridge.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = createNestedMemoryHostFixture();
  const evidencePath = process.argv[2];
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line) as Record<string, unknown>;
      const response = await fixture.dispatch(request);
      if (evidencePath) await appendFile(evidencePath, `${JSON.stringify({ request, response })}\n`);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } finally { fixture.close(); }
}

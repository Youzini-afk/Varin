import { expect, it, vi } from 'vitest';
import type { ContextCheckpoint } from '@varin/application-client';
import { waitWithSignal } from '../cancellation.js';
import { ContextService } from './context-service.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { InitialContext } from './protocol.generated.js';

it('keeps shared compaction preparation alive for a cancelled query but cancels it with its actual owner', async () => {
  const checkpoint: ContextCheckpoint = { id: 'accepted', revision: 1, resource_activations: [],
    proposal: { key: 'accepted', branch_id: 'branch', through_id: null, expected_revision: 0, summary: '',
      effective_system_prompt: 'Original', instruction_sources: [], memory_checkpoint: null } };
  const createContextJob = vi.fn(async () => { throw new Error('Cancelled preparation must not admit a summary'); });
  const runtime = { run: async () => ({ id: 'run', branch_id: 'branch', state: 'running', cancel_requested: false, configuration: {} }),
    launch: async () => null, context: async () => checkpoint, contextJobs: async () => [], createContextJob };
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let finish!: (value: InitialContext) => void;
  const body = new Promise<InitialContext>(resolve => { finish = resolve; });
  let preparationSignal: AbortSignal | undefined;
  const prepare = Object.assign(async () => { throw new Error('Unrequested initial context'); }, {
    main: async () => { throw new Error('Unrequested main context'); },
    compact: async (_checkpoint: ContextCheckpoint, signal?: AbortSignal) => {
      preparationSignal = signal; enter(); return waitWithSignal(body, signal);
    },
  }) satisfies ContextPreparer;
  const service = new ContextService(runtime as unknown as AgentRuntimeClient, prepare,
    async () => { throw new Error('Unrequested policy'); }, async () => { throw new Error('Unrequested Run'); }, null);
  const query = new AbortController();
  const pending = service.query({ action: 'compact', requestId: 'request', runId: 'run', expectedRevision: 1, throughId: 'input', nativeBlock: false, summaryRecipe: { strategy: { kind: 'builtin', name: 'capacity', version: '1' }, mode: 'background', configurationIdentity: 'fixture', additionalInstructions: null } }, query.signal);
  const rejection = expect(pending).rejects.toThrow();
  try {
    await entered;
    expect(preparationSignal).toBeInstanceOf(AbortSignal);
    query.abort(new Error('One waiting query ended'));
    await rejection;
    expect(preparationSignal!.aborted).toBe(false);
    service.close();
    expect(preparationSignal!.aborted).toBe(true);
  } finally {
    query.abort(); service.close();
    finish({ effectiveSystemPrompt: 'Late pure result', instructionSources: [], memoryCheckpoint: null });
    await rejection;
  }
  expect(createContextJob).not.toHaveBeenCalled();
});

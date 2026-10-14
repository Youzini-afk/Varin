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
  const pending = service.query({ action: 'compact', requestId: 'request', runId: 'run', expectedRevision: 1, throughId: 'input', block: false, summaryRecipe: { strategy: { kind: 'builtin', name: 'capacity', version: '1' }, mode: 'background', configurationIdentity: 'fixture', additionalInstructions: null } }, query.signal);
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

it.each(['main', 'child'])('stages a %s candidate, measures only new work, and reuses its original job across Runs', async role => {
  let now = 0;
  let summaryState = 'running';
  const listeners = new Set<(event: { stream: string }) => void>();
  const parent = { id: 'parent', thread_id: `thread:${role}`, branch_id: `branch:${role}`, state: 'running', cancel_requested: false, configuration: { model: 'same-model' } };
  const successor = { ...parent, id: 'next' };
  const checkpoint = { id: 'original', revision: 1, proposal: { memory_checkpoint: 'original-memory', effective_system_prompt: '', instruction_sources: [] } };
  const recipe = { strategy: { kind: 'builtin', name: 'capacity', version: '1' }, mode: 'background', configurationIdentity: 'settings', additionalInstructions: null } as const;
  const jobs: import('@varin/application-client').ContextJob[] = [];
  const publishContextJob = vi.fn(async () => checkpoint);
  const runtime = {
    run: async (id: string) => id === 'parent' ? parent : id === 'next' ? successor : { ...parent, id: 'summary', state: summaryState },
    launch: async () => null, context: async () => checkpoint, contextJobs: async () => jobs,
    createContextJob: vi.fn(async (input: { key: string }) => {
      const job = { compaction: { producer: { kind: 'builtin', name: 'fold', version: '1' }, kind: 'model_plan', sourceCutHash: 'cut', planHash: 'plan' }, request: { key: input.key, owner_run_id: 'parent', branch_id: parent.branch_id, through_id: 'prefix', expected_revision: 1, summary_recipe: recipe }, receipt: { run_id: 'summary' } };
      jobs.push(job as never); return job;
    }),
    publishContextJob,
    onEvent: (listener: (event: { stream: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    resumeContextJob: vi.fn(async () => null),
  };
  const prepare = Object.assign(async () => { throw new Error('No initial context'); }, { main: async () => { throw new Error('No main context'); } });
  const service = new ContextService(runtime as unknown as AgentRuntimeClient, prepare as ContextPreparer,
    async () => ({ policy: { configurationIdentity: 'settings', enabled: true, reserveTokens: 100, keepRecentTokens: 20000,
      explicitKeepRecentTokens: null, backgroundPreparation: true, preparationWaterline: 0.75 }, scope: { sessionId: parent.thread_id } }),
    async () => { throw new Error('A sendable parent must not restart'); }, null, () => now);
  const signal = new AbortController().signal;
  const observe = (requestId: string, tokens: number, runId = 'parent') => service.query({ action: 'prepare', runId, requestId,
    expectedRevision: 1, observation: { identity: 'binding', estimatedTokens: tokens } }, signal);
  try {
    expect(await observe('a', 400)).toMatchObject({ timing: { durationMs: null, tokensPerMs: null } });
    now = 1000;
    expect(await observe('b', 600)).toMatchObject({ timing: { durationMs: null, tokensPerMs: 0.2, pendingTokens: 200 } });
    const query = { action: 'compact', requestId: 'b', runId: 'parent', throughId: 'prefix', expectedRevision: 1, block: false, summaryRecipe: recipe } as const;
    expect(await service.query(query, signal)).toMatchObject({ published: false, accepted: { block: false } });
    now = 3500; summaryState = 'completed';
    for (const notify of listeners) notify({ stream: 'durable' });
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(publishContextJob).not.toHaveBeenCalled();
    expect(checkpoint.proposal.memory_checkpoint).toBe('original-memory');
    parent.state = 'completed'; now = 4000;
    expect(await observe('c', 800, 'next')).toMatchObject({ timing: { durationMs: 2500 } });
    const accepted = await service.query({ ...query, runId: 'next', requestId: 'c', block: true }, signal);
    expect(accepted).toMatchObject({ published: false, jobRunId: 'summary', accepted: { throughId: 'prefix', block: true } });
    expect(runtime.createContextJob).toHaveBeenCalledTimes(1);
    expect(publishContextJob).not.toHaveBeenCalled();
    // A fresh Host can recover the result, but cannot infer the old generation's elapsed time.
    service.close();
    const reopened = new ContextService(runtime as unknown as AgentRuntimeClient, prepare as ContextPreparer,
      async () => ({ policy: { configurationIdentity: 'settings', enabled: true, reserveTokens: 100, keepRecentTokens: 20000,
        explicitKeepRecentTokens: null, backgroundPreparation: true, preparationWaterline: 0.75 }, scope: { sessionId: parent.thread_id } }), async () => {}, null, () => now);
    try {
      const cold = await reopened.query({ action: 'prepare', runId: 'next', requestId: 'd', expectedRevision: 1,
        observation: { identity: 'binding', estimatedTokens: 900 } }, signal);
      expect(cold).toMatchObject({ timing: { durationMs: null, tokensPerMs: null } });
    } finally { reopened.close(); }
  } finally { service.close(); }
});

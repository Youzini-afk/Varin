import { expect, it, vi } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter } from './thread-adapter.js';

function fixture() {
  const identity = { runtime: 'agent' as const, threadId: 'thread:test', branchId: 'main' };
  const run = { id: 'run', thread_id: 'thread:test', branch_id: 'main', state: 'running' };
  const view = { identity, eventCursor: 12, thread: { principal_id: null, branches: [{ branch_id: 'main', latest_run: run }] },
    history: [{ id: 'original', content: { text: 'Original 中文 body' } }], historyPage: { head: 'original', previous: null },
    operations: [{ id: 'receipt', result: { text: 'Full retained tool result' } }], context: { checkpoint: null, jobs: [] },
    activeRun: run, policySelection: { desired: null, active: null, pending: null } } as unknown as ThreadSnapshot;
  const runtime = { threadView: vi.fn(async () => structuredClone(view)), policyPreparation: vi.fn(() => ({ phase: 'preparing' })) };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, { resolveModel: vi.fn(), rebindModel: vi.fn() }, vi.fn(), vi.fn());
  return { identity, view, runtime, adapter };
}
it('composes one Catalog view with only Host-owned policy, preparation, defaults and recovery', async () => {
  const { identity, view, runtime, adapter } = fixture();
  const policy = { thresholdTokens: 9000 } as unknown as NonNullable<ThreadSnapshot['context']['policy']>;
  const defaults = { workspaceId: 'workspace' } as unknown as NonNullable<ThreadSnapshot['creationDefaults']>;
  const recovery = { status: 'available' } as unknown as NonNullable<ThreadSnapshot['recovery']>;
  adapter.bindContextPolicy(vi.fn(async () => policy));
  adapter.bindCreationDefaults(vi.fn(async () => defaults));
  adapter.bindRecoveryReader(vi.fn(async () => recovery));
  const result = await adapter.snapshot(identity, undefined, { afterHeadId: 'previous' });
  expect(runtime.threadView).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread:test', branchId: 'main', historyLimit: 20, afterHeadId: 'previous' }, undefined);
  expect(result.history).toEqual(view.history); expect(result.operations).toEqual(view.operations);
  expect(result.context.policy).toBe(policy); expect(result.creationDefaults).toBe(defaults); expect(result.recovery).toBe(recovery);
  expect(result.policySelection?.preparation).toEqual({ phase: 'preparing' });
});
it('retains policy failure visibility and abort fences without publishing a partially completed snapshot', async () => {
  const { identity, adapter } = fixture();
  adapter.bindContextPolicy(async () => { throw new Error('Policy source unavailable'); });
  expect((await adapter.snapshot(identity)).context.policyError).toBe('Policy source unavailable');
  const controller = new AbortController();
  adapter.bindRecoveryReader(async () => { controller.abort(); return {} as NonNullable<ThreadSnapshot['recovery']>; });
  await expect(adapter.snapshot(identity, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

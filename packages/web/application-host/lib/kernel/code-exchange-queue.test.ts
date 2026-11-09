import { expect, it, vi } from 'vitest';
import { createCodeExchangeQueue } from './code-exchange-queue.js';
import type { CodeExchangeOwners, CodeParticipant } from './code-exchange.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { Operation, HostJobBinding } from './protocol.generated.js';
import type { WorkingResult } from '../harness/working-state/types.js';
import { exchangeExternalCode } from '../external-agents/code-exchange.js';
import { openFixedCodeSource } from './code-exchange.js';
vi.mock('./code-exchange.js', () => ({ codeIntegration: vi.fn(), openExchangeScope: vi.fn(), openFixedCodeSource: vi.fn() }));
vi.mock('./managed-code-exchange.js', () => ({ exchangeManagedCode: vi.fn(), releaseManagedCodeResult: vi.fn() }));
vi.mock('../external-agents/code-exchange.js', () => ({ exchangeExternalCode: vi.fn() }));

function fixture() {
  const events = new Set<() => void>();
  const errors: unknown[] = [];
  const invocation = { runId: 'parent-run', threadId: 'parent', operationId: 'original-exchange', executorOwner: { kind: 'external', identity: 'host', epoch: 'epoch' },
    source: { workspace_id: 'workspace', execution_workspace_id: 'execution', resource_owner: { kind: 'local' } } } as ToolInvocationAuthority;
  const self = { runId: 'parent-run', branchId: 'parent-branch', member: { threadId: 'parent', name: 'Parent' }, source: invocation.source, launch: {} } as CodeParticipant;
  const op = { id: invocation.operationId, run_id: invocation.runId, revision: 1, phase: 'running', cancel_requested: false } as Operation;
  let payload: unknown, recipientActive = true;
  const emit = () => { for (const event of events) event(); };
  const rpc = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === 'runtime.host_job.begin') { op.host_job = { binding: input.binding as HostJobBinding, acceptanceRef: null, mcpHolderReleased: true }; return {}; }
    if (method === 'runtime.host_job.code_exchange.queue') {
      op.host_job = { binding: input.binding as HostJobBinding, acceptanceRef: null, mcpHolderReleased: true };
      payload = structuredClone(input.payload);
      op.host_job!.codeExchange = { requestRef: {}, targetThreadId: 'parent', targetBranchId: 'parent-branch', afterRunId: 'parent-run', externalOperationId: null, started: false };
      op.revision++; return structuredClone(op);
    }
    if (method === 'runtime.host_job.code_exchange.request') return { kind: 'result', content: { data: structuredClone(payload), parts: [] } };
    if (method === 'runtime.host_job.accept') { op.host_job!.acceptanceRef = { original: 'public-acceptance' }; op.revision++; emit(); return {}; }
    if (method === 'runtime.host_job.code_exchange.pending') return op.host_job && !(op.phase === 'terminal' && op.external_receipt?.executor_stopped)
      ? [{ binding: op.host_job.binding, runId: op.run_id, accepted: op.host_job.acceptanceRef !== null }] : [];
    if (method === 'runtime.host_job.code_exchange.control') {
      expect(input.expectedRevision).toBe(op.revision);
      const queue = op.host_job!.codeExchange!;
      if (input.action === 'claim' && !op.cancel_requested && (!queue.afterRunId || !recipientActive)) queue.started = true;
      if (input.action === 'send_now') queue.afterRunId = null;
      if (input.action === 'cancel') op.cancel_requested = true;
      op.revision++; return structuredClone(op);
    }
    if (method === 'runtime.host_job.terminal') {
      op.phase = 'terminal'; op.external_receipt = { executor_stopped: input.executorStopped } as Operation['external_receipt']; emit(); return {};
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const owners = { kernel: { agentRuntimeRequest: rpc }, runtime: {
    operation: async () => structuredClone(op), launch: async () => ({}), onReady: () => () => {},
    onEvent: (listener: (event: unknown) => void) => { const event = () => listener({ stream: 'durable', kind: 'runtime-event', cursor: 2 }); events.add(event); return () => events.delete(event); },
    reconcileHostTool: vi.fn(),
  }, onCleanupError: (_id: string, error: unknown) => errors.push(error) } as unknown as CodeExchangeOwners;
  const result = { branchId: 'code-exchange:original-exchange', resultRevision: 1, root: 'frozen-root', changedPaths: ['a.ts'], pathStates: {}, baseStates: {} } as WorkingResult;
  const delivery = { kind: 'external' as const, self, child: { name: 'External Agent', conversation_id: 'external', parent_thread_id: 'parent', parent_branch_id: 'parent-branch' } as import('./protocol.generated.js').ExternalChild,
    direction: 'receive' as const, result };
  const apply = vi.mocked(exchangeExternalCode).mockResolvedValue({ executor_stopped: true,
    completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: { status: 'applied' }, parts: [] } } });
  apply.mockClear();
  return { owners, invocation, delivery, rpc, apply, errors, emit, op: () => op, finish: () => { recipientActive = false; emit(); } };
}
it('resumes a queued immutable version on a durable Run-end notification after the owner restarts', async () => {
  const f = fixture();
  const first = createCodeExchangeQueue(f.owners);
  const acceptance = await first.owner.enqueue(f.invocation, 'parent-branch', f.delivery);
  expect(acceptance.completion.kind).toBe('job_accepted');
  expect(JSON.stringify(acceptance)).not.toContain('frozen-root');
  await first.dispose();
  f.delivery.result.root = 'newer-root-on-disk';
  const reopened = createCodeExchangeQueue(f.owners); reopened.start();
  await vi.waitFor(() => expect(f.rpc.mock.calls.some(([method]) => method.endsWith('.control'))).toBe(true));
  expect(f.apply).not.toHaveBeenCalled();
  f.finish();
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
  expect(f.apply.mock.calls[0]![7]!.frozen?.root).toBe('frozen-root');
  await vi.waitFor(() => expect(f.op().phase).toBe('terminal'));
  f.emit(); await reopened.dispose();
  expect(f.apply).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
});
it('send-now applies the retained version while the recipient Run is still active', async () => {
  const f = fixture(), queue = createCodeExchangeQueue(f.owners);
  await queue.owner.enqueue(f.invocation, 'parent-branch', f.delivery);
  queue.start(); queue.owner.release(f.invocation.operationId);
  await vi.waitFor(() => expect(f.rpc.mock.calls.some(([method]) => method.endsWith('.control'))).toBe(true));
  await queue.control({ runtime: 'agent', threadId: 'parent', branchId: 'parent-branch' }, { operationId: f.invocation.operationId, expectedRevision: f.op().revision, action: 'send_now' });
  await vi.waitFor(() => expect(f.apply).toHaveBeenCalledOnce());
  await queue.dispose(); expect(f.errors).toEqual([]);
});
it('withdrawal releases the frozen result and settles the original Job without applying files', async () => {
  const f = fixture(), queue = createCodeExchangeQueue(f.owners);
  const deleteResults = vi.fn(), deleteBranch = vi.fn(), release = vi.fn();
  vi.mocked(openFixedCodeSource).mockResolvedValue({ store: { deleteResults, deleteBranch }, release } as unknown as Awaited<ReturnType<typeof openFixedCodeSource>>);
  await queue.owner.enqueue(f.invocation, 'parent-branch', f.delivery);
  queue.start(); queue.owner.release(f.invocation.operationId);
  await queue.control({ runtime: 'agent', threadId: 'parent', branchId: 'parent-branch' }, { operationId: f.invocation.operationId, expectedRevision: f.op().revision, action: 'cancel' });
  await vi.waitFor(() => expect(f.op().phase).toBe('terminal'));
  expect(f.apply).not.toHaveBeenCalled();
  expect(deleteResults).toHaveBeenCalledExactlyOnceWith(f.delivery.result.branchId, [1]);
  expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(f.delivery.result.branchId); expect(release).toHaveBeenCalledOnce();
  expect(f.rpc.mock.calls.find(([method]) => method.endsWith('.terminal'))?.[1]).toMatchObject({ binding: { operationId: f.invocation.operationId }, outcome: 'cancelled', effect: 'none', executorStopped: true });
  await queue.dispose(); expect(f.errors).toEqual([]);
});

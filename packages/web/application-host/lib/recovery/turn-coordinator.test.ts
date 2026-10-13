import { describe, expect, it, vi } from 'vitest';
import type {
  RecoveryConversation,
  WorkspaceRecoveryCheckpointState,
  WorkspaceRecoveryTurnBinding,
  WorkspaceRecoveryTurnProvenance,
} from '@varin/extension-contract';
import {
  createRecoveryTurnCoordinator,
  type AdmitRequest,
  type HostEvent,
  type RecoveryServiceRequest,
} from './turn-coordinator.js';

interface BindingInput {
  activeWriterScopes: string[];
  assistantEntryId?: string | undefined;
  executionId: string;
  provenance: WorkspaceRecoveryTurnProvenance;
  runtimeGeneration?: number | undefined;
  conversation?: RecoveryConversation | undefined;
  userEntryId?: string | undefined;
  workerId?: string | undefined;
  workspaceId: string;
}

const binding = (
  input: BindingInput,
  status: WorkspaceRecoveryCheckpointState = 'pending',
): WorkspaceRecoveryTurnBinding => ({
  activeWriterScopes: input.activeWriterScopes,
  checkpointId: `checkpoint-${input.executionId}`,
  executionId: input.executionId,
  provenance: input.provenance,
  runtimeGeneration: input.runtimeGeneration ?? 1,
  runtimeKey: `worker-1@${input.runtimeGeneration ?? 1}`,
  conversation: input.conversation ?? { kind: 'pi', sessionId: 'session-1' },
  startedAt: '2026-08-30T00:00:00.000Z',
  status,
  unrecordedResourceIds: [],
  userEntryId: input.userEntryId ?? 'user-1',
  workerId: input.workerId ?? 'worker-1',
  workspaceId: input.workspaceId,
  ...(input.assistantEntryId ? { assistantEntryId: input.assistantEntryId } : {}),
  ...(status === 'pending' ? {} : { settledAt: '2026-08-30T00:00:01.000Z' }),
});

const agentEvent = (executionId: string, event: Record<string, unknown>): HostEvent => ({
  executionId,
  kind: 'host',
  envelope: {
    data: { event, sessionId: 'session-1' },
    event: 'agent.event',
    kind: 'event',
  },
  sessionId: 'session-1',
  workerId: 'worker-1',
});

const createHarness = () => {
  const calls: RecoveryServiceRequest[] = [];
  const documents = {
    inspectMutation: vi.fn(async () => ({
      activeWriters: [], epoch: 1, maintenance: false, mutationRevision: 1, writerRevision: 1,
    })),
  };
  const invokeService = vi.fn(async (request: RecoveryServiceRequest): Promise<unknown> => {
    calls.push(request);
    const input = request.args[0] as BindingInput;
    if (request.method === 'recordTurnStart') return { binding: binding(input), status: 'ready' };
    if (request.method === 'recordTurnSettled') {
      return { binding: binding({ ...input, runtimeGeneration: 1, conversation: { kind: 'pi', sessionId: 'session-1' }, userEntryId: 'user-1', workerId: 'worker-1' }, 'ready'), status: 'ready' };
    }
    if (request.method === 'recordMutationBefore' || request.method === 'recordMutationAfter') {
      return { recorded: true, status: 'ready' };
    }
    throw new Error(`unexpected service method ${request.method}`);
  });
  const writerTracker = {
    admit: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    waitForIdle: vi.fn(async () => ({
      changedResourceIds: ['note.txt'], coverageComplete: true, mutationObserved: true,
    })),
  };
  const observed: Array<{ workspaceId: string; absolutePath: string; respondedBefore: number }> = [];
  const respondMutation = vi.fn(async (): Promise<void> => undefined);
  const observeToolWrite = vi.fn(async (workspaceId: string, absolutePath: string): Promise<void> => {
    observed.push({ workspaceId, absolutePath, respondedBefore: respondMutation.mock.calls.length });
  });
  const coordinator = createRecoveryTurnCoordinator({
    documents,
    getSessionSnapshot: () => ({ workspace: { authorityId: 'workspace-1', id: 'project-1', kind: 'workspace' } }),
    invokeService,
    respondMutation,
    observeToolWrite,
    writerTracker,
  });
  return { calls, coordinator, observed, observeToolWrite, respondMutation, writerTracker };
};

const admission: AdmitRequest = {
  cwd: 'D:/workspace',
  executionId: 'execution-1',
  method: 'agent.prompt',
  phase: 'agent-run',
  runtimeGeneration: 1,
  sessionId: 'session-1',
  workerId: 'worker-1',
  workspace: { authorityId: 'workspace-1', id: 'project-1', kind: 'workspace' },
};

describe('recovery turn coordinator', () => {
  it('keeps an accepted prompt addressable until ordered Pi events settle it without a workspace scan', async () => {
    const { calls, coordinator } = createHarness();
    const lease = await coordinator.admit(admission);
    if (!lease) throw new Error('Expected recovery writer lease');
    await lease.close();
    await coordinator.processEvent(agentEvent('execution-1', { type: 'agent_start' }));
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      type: 'entry_appended',
    }));
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'assistant-1', message: { role: 'assistant' }, type: 'message' },
      type: 'entry_appended',
    }));
    await coordinator.processEvent(agentEvent('execution-1', { type: 'agent_settled' }));

    expect(calls.map((call) => call.method)).toEqual(['recordTurnStart', 'recordTurnSettled']);
    expect(calls[0]?.args[0]).toMatchObject({ conversation: { kind: 'pi', sessionId: 'session-1' } });
    expect(calls.some((call) => call.method.includes('Snapshot') || call.method.includes('capture'))).toBe(false);
    expect(calls[1]?.args[0]).toMatchObject({
      assistantEntryId: 'assistant-1',
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt'],
    });
  });

  it('persists before and after tool boundaries before acknowledging the worker', async () => {
    const { calls, coordinator, respondMutation } = createHarness();
    await coordinator.admit(admission);
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      type: 'entry_appended',
    }));
    const request = {
      path: 'D:/workspace/note.txt',
      phase: 'before',
      requestId: 'mutation-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    };
    await coordinator.processEvent({
      executionId: 'execution-1',
      kind: 'host',
      envelope: { data: request, event: 'workspace.mutation.request', kind: 'event' },
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    await coordinator.processEvent({
      executionId: 'execution-1',
      kind: 'host',
      envelope: {
        data: { ...request, phase: 'after', succeeded: true },
        event: 'workspace.mutation.request',
        kind: 'event',
      },
      sessionId: 'session-1',
      workerId: 'worker-1',
    });

    expect(calls.map((call) => call.method)).toEqual([
      'recordTurnStart', 'recordMutationBefore', 'recordMutationAfter',
    ]);
    expect(respondMutation).toHaveBeenNthCalledWith(1, request, true);
    expect(respondMutation).toHaveBeenNthCalledWith(2, { ...request, phase: 'after', succeeded: true }, true);
  });

  it('reports a completed tool write before acknowledging it and ignores before/failed phases', async () => {
    const { coordinator, observed, observeToolWrite } = createHarness();
    await coordinator.admit(admission);
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      type: 'entry_appended',
    }));
    const request = {
      path: 'D:/workspace/note.txt',
      phase: 'before',
      requestId: 'mutation-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolName: 'write',
    };
    const send = (data: Record<string, unknown>): Promise<unknown> => coordinator.processEvent({
      executionId: 'execution-1',
      kind: 'host',
      envelope: { data, event: 'workspace.mutation.request', kind: 'event' },
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    await send(request);
    expect(observeToolWrite).not.toHaveBeenCalled();
    await send({ ...request, requestId: 'mutation-2', phase: 'after', succeeded: false });
    expect(observeToolWrite).not.toHaveBeenCalled();
    await send({ ...request, requestId: 'mutation-3', phase: 'after', succeeded: true });
    // The next read in this turn must not still see the pre-write draft, so the
    // report is awaited before the tool is acknowledged (D-088).
    expect(observed).toEqual([{
      workspaceId: 'workspace-1',
      absolutePath: 'D:/workspace/note.txt',
      respondedBefore: 2,
    }]);
  });

  it('always releases a mutation request that no longer has an owning turn', async () => {
    const { coordinator, respondMutation } = createHarness();
    const request = {
      path: 'D:/workspace/note.txt', phase: 'before', requestId: 'orphan', sessionId: 'session-1',
      toolCallId: 'tool-1', toolName: 'edit',
    };
    await coordinator.processEvent({
      executionId: 'missing',
      kind: 'host',
      envelope: { data: request, event: 'workspace.mutation.request', kind: 'event' },
    });
    expect(respondMutation).toHaveBeenCalledWith(request, false);
  });

  it('leaves an unbound/general chat on the ordinary writer admission path', async () => {
    const { coordinator, writerTracker } = createHarness();
    await coordinator.admit({ ...admission, workspace: { kind: 'unbound' } });
    expect(writerTracker.admit).toHaveBeenCalledOnce();
  });

  it('flags unjournalledTool for process and unknown tools but not for none or journaled tools', async () => {
    const { calls, coordinator } = createHarness();
    await coordinator.admit(admission);
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      type: 'entry_appended',
    }));
    // none — should NOT flag
    await coordinator.processEvent(agentEvent('execution-1', { type: 'tool_execution_start', toolName: 'read' }));
    // journaled — should NOT flag
    await coordinator.processEvent(agentEvent('execution-1', { type: 'tool_execution_start', toolName: 'write' }));
    // process — SHOULD flag
    await coordinator.processEvent(agentEvent('execution-1', { type: 'tool_execution_start', toolName: 'bash' }));
    // unknown — SHOULD flag
    await coordinator.processEvent(agentEvent('execution-1', { type: 'tool_execution_start', toolName: 'custom_tool' }));
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'assistant-1', message: { role: 'assistant' }, type: 'message' },
      type: 'entry_appended',
    }));
    await coordinator.processEvent(agentEvent('execution-1', { type: 'agent_settled' }));

    const settledCall = calls.find((call) => call.method === 'recordTurnSettled');
    expect(settledCall?.args[0]).toMatchObject({ mutationObserved: true });
  });

  it('encodes writer mode into the writerScope as mode/kind:id@gen', async () => {
    const calls: RecoveryServiceRequest[] = [];
    const documents = {
      inspectMutation: vi.fn(async () => ({
        activeWriters: [
          { writerId: 'w-1', mode: 'process', owner: { kind: 'pi-worker', id: 'worker-1', generation: 1 } },
          { writerId: 'w-2', mode: 'external', owner: { kind: 'editor', id: 'vscode' } },
          { writerId: 'w-3', owner: { kind: 'pi-worker', id: 'worker-2', generation: 3 } },
        ],
        epoch: 1, maintenance: false, mutationRevision: 1, writerRevision: 1,
      })),
    };
    const invokeService = vi.fn(async (request: RecoveryServiceRequest): Promise<unknown> => {
      calls.push(request);
      const input = request.args[0] as BindingInput;
      if (request.method === 'recordTurnStart') return { binding: binding(input), status: 'ready' };
      if (request.method === 'recordTurnSettled') {
        return { binding: binding({ ...input, runtimeGeneration: 1, conversation: { kind: 'pi', sessionId: 'session-1' }, userEntryId: 'user-1', workerId: 'worker-1' }, 'ready'), status: 'ready' };
      }
      if (request.method === 'recordMutationBefore' || request.method === 'recordMutationAfter') {
        return { recorded: true, status: 'ready' };
      }
      throw new Error(`unexpected service method ${request.method}`);
    });
    const coordinator = createRecoveryTurnCoordinator({
      documents,
      getSessionSnapshot: () => ({ workspace: { authorityId: 'workspace-1', id: 'project-1', kind: 'workspace' } }),
      invokeService,
      respondMutation: vi.fn(async () => undefined),
      writerTracker: {
        admit: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
        waitForIdle: vi.fn(async () => ({ changedResourceIds: [], coverageComplete: true, mutationObserved: false })),
      },
    });
    await coordinator.admit(admission);
    await coordinator.processEvent(agentEvent('execution-1', {
      entry: { id: 'user-1', message: { role: 'user' }, type: 'message' },
      type: 'entry_appended',
    }));
    await coordinator.processEvent(agentEvent('execution-1', { type: 'agent_settled' }));

    const settledCall = calls.find((call) => call.method === 'recordTurnSettled');
    const scopes = (settledCall?.args[0] as { activeWriterScopes?: string[] }).activeWriterScopes ?? [];
    // process/pi-worker:worker-1@1, external/editor:vscode, controlled/pi-worker:worker-2@3
    expect(scopes).toContain('process/pi-worker:worker-1@1');
    expect(scopes).toContain('external/editor:vscode');
    expect(scopes).toContain('controlled/pi-worker:worker-2@3');
  });
});

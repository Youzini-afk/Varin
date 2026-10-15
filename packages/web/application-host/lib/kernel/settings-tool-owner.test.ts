import { describe, expect, it, vi } from 'vitest';
import { createSettingsToolOwner } from './settings-tool-owner.js';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import type { SettingsService } from '../harness/settings-service.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const owner = { extensionId: 'varin.builtin.runtime-contracts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'settings', generation: 1 };
const authority = (args: unknown): ToolInvocationAuthority => ({ invocationId: 'settings-call', threadId: 'thread', runId: 'run',
  operationId: 'settings:node:node', callId: 'node', executorOwner: { kind: 'kernel' },
  origin: { kind: 'policy_action', action_id: 'settings', node_id: 'node' }, source: null,
  toolName: 'settings_update', operation: 'effect', completion: 'result', arguments: args });

describe('native settings invocation owner', () => {
  it('retains original Thread/branch and actual completion through observer cancellation without replay', async () => {
    const args = { id: 'sessions.default-model', set: { defaultModel: 'native' } };
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const update = vi.fn(async (_caller: import('../harness/settings-service.js').SettingsServiceCaller, _input: unknown) => { entered(); await gate; return { status: 'applied' }; });
    const handler = createSettingsToolOwner({ service: { update } as unknown as SettingsService,
      runtime: { run: async () => ({ thread_id: 'thread', branch_id: 'original-branch' }) } as unknown as AgentRuntimeClient });
    const controller = new AbortController(); let receipt: ToolExecutionReceipt | undefined;
    const work = withToolInvocation({ authority: authority(args), owner, signal: controller.signal, onEffectReceipt: value => { receipt = value; } }, async invocation => {
      const context = { owner, signal: controller.signal, invocation };
      const first = handler('update', args, context), second = handler('update', args, context);
      return Promise.all([first, second]);
    });
    await started; controller.abort();
    expect(receipt).toBeUndefined(); expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toMatchObject({ threadId: 'thread', branchId: 'original-branch', runId: 'run', operationId: 'settings:node:node', workspaceId: null });
    finish(); await work;
    expect(receipt).toMatchObject({ executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed' } });
  });
  it('rejects renderer/model supplied authority before calling any owner', () => {
    const handler = createSettingsToolOwner({ service: {} as SettingsService, runtime: {} as AgentRuntimeClient });
    expect(() => handler('update', { id: 'harness.shell', threadId: 'forged' }, {} as never)).toThrow(/caller authority/);
  });
});

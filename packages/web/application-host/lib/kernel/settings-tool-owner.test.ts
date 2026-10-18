import { describe, expect, it, vi } from 'vitest';
import { createSettingsToolOwner } from './settings-tool-owner.js';
import { withToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';
import { createSettingsService, settingsDocumentRevision, type SettingsService, type SettingsServiceDeps } from '../harness/settings-service.js';
import type { VarinSettingsDocument } from '@varin/settings-store';
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
    const update = vi.fn(async (caller: import('../harness/settings-service.js').SettingsServiceCaller, _input: unknown) => {
      caller.onMutationState?.('started');entered();await gate;caller.onMutationState?.('applied');return { status:'applied' };
    });
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
  it('uses actual writer facts for validation, CAS rebasing and lost write replies', async () => {
    let document:VarinSettingsDocument={};
    let loseReply=false;
    const persist=vi.fn<SettingsServiceDeps['persistAppSettings']>(async changes=>{
      if (persist.mock.calls.length===1) {
        document={...document,uiFont:'concurrent UI change'};
        return {conflict:true,revision:settingsDocumentRevision(document),document};
      }
      document={...document,...changes};
      if (loseReply) throw new Error('write reply lost');
      return {conflict:false,revision:settingsDocumentRevision(document),document};
    });
    const service=createSettingsService({readAppSettings:async()=>document,persistAppSettings:persist,
      agentSettings:()=>{throw new Error('unexpected Agent settings');},resolveWorkspaceRoot:async()=>null});
    const handler=createSettingsToolOwner({service,runtime:{run:async()=>({thread_id:'thread',branch_id:'branch'})} as unknown as AgentRuntimeClient});
    const invoke=async(args:Record<string,unknown>)=>{
      const signal=new AbortController().signal;let receipt:ToolExecutionReceipt|undefined;
      await withToolInvocation({authority:authority(args),owner,signal,onEffectReceipt:value=>{receipt=value;}},
        async invocation=>handler('update',args as never,{owner,signal,invocation}));
      return receipt;
    };
    expect(await invoke({id:'appearance.time-format',set:{timeFormatPreference:'invalid'}}))
      .toMatchObject({completion:{outcome:'failed',effect:'none'}});
    expect(await invoke({id:'appearance.time-format',set:{timeFormatPreference:'24h'},expectedRevision:'stale'}))
      .toMatchObject({completion:{outcome:'failed',effect:'none'}});
    expect(persist).not.toHaveBeenCalled();
    expect(await invoke({id:'appearance.time-format',set:{timeFormatPreference:'24h'}}))
      .toMatchObject({completion:{outcome:'succeeded',effect:'confirmed'}});
    expect(persist).toHaveBeenCalledTimes(2);
    expect(document).toMatchObject({uiFont:'concurrent UI change',timeFormatPreference:'24h'});
    loseReply=true;
    expect(await invoke({id:'appearance.time-format',set:{timeFormatPreference:'12h'}}))
      .toMatchObject({completion:{outcome:'indeterminate',effect:'unknown'}});
    expect(persist).toHaveBeenCalledTimes(3);
  });
});

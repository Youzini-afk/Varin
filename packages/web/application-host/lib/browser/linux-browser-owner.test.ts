import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { ComputerBrowserParams, ComputerBrowserResult } from '@varin/protocol';
import type { ComputerAdmission } from '../computer/computer-automation.js';
import type { ComputerService } from '../computer/computer-service.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { LinuxBrowserOwner, createLinuxBrowserResources } from './linux-browser-owner.js';

function fixture() {
  let instanceId = 'actual-instance';
  const context = new AsyncLocalStorage<ComputerAdmission>();
  const browser = vi.fn(async (params: ComputerBrowserParams) => {
    let result: ComputerBrowserResult;
    if (params.op === 'status') result = { ok: true, status: { running: true, instanceId, wsUrl: 'ws://secret-endpoint' } };
    else if (params.expectedInstanceId && params.expectedInstanceId !== instanceId) result = { ok: false, error: 'original instance ended' };
    else if (params.op === 'tabs') result = { ok: true, instanceId, tabs: [{ id: 'real-target', title: 'Visible page', url: 'https://example.test/' }] };
    else if (params.op === 'snapshot') result = { ok: true, instanceId, tab: 'real-target', lines: ['button OK'], observation: {
      documentId: 'frame-loader', viewport: { width: 800, height: 600, scale: 1 }, frames: [{ frameId: 'frame-1', url: 'https://example.test/', available: true }], elements: [{ role: 'button', name: 'OK' }],
    } };
    else result = { ok: true, instanceId, tab: 'real-target', result: 'evaluated' };
    return { ...result, inputWriterStopped: true, receipt: { effect: result.ok ? 'dispatched' as const : 'none' as const } };
  });
  const authorize = vi.fn(async (_work, _access, _desktop, run) => context.run({ signal: new AbortController().signal } as ComputerAdmission, run));
  const computers = { browser, automation: { authorize, context }, list: vi.fn(async () => ({ machines: [
    { id: 'linux', name: 'Linux device', platform: 'linux' }, { id: 'mac', name: 'Mac', platform: 'macos' },
  ], desktops: [
    { id: 'local', machineId: 'linux', label: 'Desktop', capabilities: { applicationTools: { browser: true } } },
    { id: 'unsupported', machineId: 'mac', label: 'Desktop', capabilities: { applicationTools: { browser: false } } },
  ] })) } as unknown as ComputerService;
  const run = vi.fn(async () => ({ thread_id: 'thread-1', branch_id: 'branch-1' }));
  const runtime = { run } as unknown as Pick<AgentRuntimeClient, 'run'>;
  const owner = new LinuxBrowserOwner({ computers, runtime }, 'local');
  const binding = { browserId: owner.browserId, instanceId, pageId: 'real-target' };
  const scoped = () => owner.forScope({ threadId: 'thread-1', runId: 'run-1', operationId: 'op-1' }, binding);
  return { owner, scoped, binding, browser, authorize, run, computers, runtime, restart() { instanceId = 'replacement-instance'; } };
}

describe('original Linux browser resource adapter', () => {
  it('discovers only verified Linux providers and never leaks a CDP endpoint or invents file capabilities', async () => {
    const f = fixture();
    const discovery = createLinuxBrowserResources(f);
    const found = await discovery.discover();
    expect(found).toHaveLength(1);
    expect(found[0]!.owner).toBe((await discovery.discover())[0]!.owner);
    const status = await f.owner.resource();
    expect(status.instanceId).toBe('actual-instance');
    expect(JSON.stringify(status)).not.toContain('ws://');
    expect(status.capabilities).not.toContain('upload');
    expect(status.operations).toContain('act:click:point');
  });
  it('keeps native Thread/branch/Run authority and uses original driver route for all input', async () => {
    const f = fixture();
    const owner = f.scoped();
    const observed = await owner.read({ pageId: 'real-target' });
    expect(observed.elements![0]).not.toHaveProperty('ref');
    await owner.act('real-target', { action: 'click', point: { x: 20, y: 30 }, observationId: observed.observationId });
    expect(f.authorize).toHaveBeenCalledWith({ runtime: 'agent', threadId: 'thread-1', branchId: 'branch-1' }, 'control', 'local', expect.any(Function), {
      work: { runtime: 'agent', threadId: 'thread-1', branchId: 'branch-1' }, runId: 'run-1',
    });
    expect(f.browser).toHaveBeenCalledWith(expect.objectContaining({ desktopId: 'local', expectedInstanceId: 'actual-instance',
      expectedDocumentId: 'frame-loader', act: { kind: 'click', x: 20, y: 30 } }));
    await expect(owner.act('real-target', { action: 'click', point: { x: 20, y: 30 }, observationId: observed.observationId })).rejects.toMatchObject({ effect: 'none' });
  });
  it('fails closed for no Run, mismatched Thread, stale instance, and unsupported methods before input', async () => {
    const f = fixture();
    await expect(f.owner.act('real-target', { action: 'type', text: 'no' })).rejects.toMatchObject({ effect: 'none' });
    await expect(f.owner.forScope({ threadId: 'managed-peer-alias' }, f.binding).read({ pageId: 'real-target' })).resolves.toHaveProperty('observationId');
    await expect(f.owner.forScope({ threadId: 'managed-peer-alias' }, f.binding).act('real-target', { action: 'type', text: 'no' })).rejects.toMatchObject({ effect: 'none' });
    f.run.mockResolvedValueOnce({ thread_id: 'other-thread', branch_id: 'branch-1' });
    await expect(f.scoped().act('real-target', { action: 'evaluate', script: '1' })).rejects.toMatchObject({ effect: 'none' });
    await expect(f.scoped().act('real-target', { action: 'type', ref: 'invented', text: 'no' })).rejects.toMatchObject({ effect: 'none' });
    f.restart();
    await expect(f.scoped().act('real-target', { action: 'type', text: 'no' })).rejects.toMatchObject({ effect: 'none' });
    expect(f.browser.mock.calls.some(([params]) => params.op === 'act')).toBe(false);
  });
  it('preserves an unknown receipt and never retries the effect', async () => {
    const f = fixture();
    const original = f.browser.getMockImplementation()!;
    f.browser.mockImplementation(async params => params.op === 'act' ? { ok: false, outcome: 'unknown', error: 'lost acknowledgement',
      inputWriterStopped: false, receipt: { effect: 'unknown' as never } } : original(params));
    await expect(f.scoped().act('real-target', { action: 'type', text: 'only once' })).rejects.toMatchObject({ effect: 'unknown', executorStopped: false });
    expect(f.browser.mock.calls.filter(([params]) => params.op === 'act')).toHaveLength(1);
  });
});

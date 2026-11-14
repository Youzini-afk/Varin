import { describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { BrowserExecutionError, type BrowserOwner, type BrowserResourceBinding } from '@varin/protocol';
import { createBrowserRuntime } from './browser-runtime.js';
import { withToolInvocation } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

const extension = { extensionId: 'varin.builtin.browser', extensionVersion: '1', entrypointId: 'host', instanceKey: 'browser-runtime-test', generation: 1 };
const binding: BrowserResourceBinding = { browserId: 'office-browser', instanceId: 'original-instance' };
const page = { browserId: 'owner-local-browser', pageId: 'original-tab', title: 'Original page', url: 'https://example.test/', loading: false, canGoBack: false, canGoForward: false, retained: true };
const target = { ...binding, pageId: page.pageId };
const settings = async () => ({ global: {}, project: {}, globalRevision: '1', projectRevision: '1', projectTrusted: false });

// A controlled resource and file-owner port isolates the real tool adapter.
// Registry admission, owner connection lifetime and native writes have their own tests.
function fixture() {
  const owner = {
    browserId: 'owner-local-browser', list: vi.fn(async () => [page]), open: vi.fn(async () => page),
    retainForThread: vi.fn(), read: vi.fn(async () => ({ page, observationId: 'original-observation', viewport: { width: 800, height: 600, scale: 1 }, frames: [],
      image: { mimeType: 'image/png', base64: 'YWJj', width: 800, height: 600 } })),
    act: vi.fn(async () => ({ page, action: 'click' })), downloads: vi.fn(async () => [{ downloadId: 'download', pageId: page.pageId, state: 'completed' }]),
    readDownload: vi.fn(async () => ({ name: 'remote.pdf', bytes: Buffer.from('browser-device bytes') })),
    releaseDownload: vi.fn(async () => {}), upload: vi.fn(async () => ({ page, action: 'upload' })),
  };
  const resources = {
    list: vi.fn(async () => [{ ...binding, label: 'Chrome', deviceName: 'Office computer', state: 'connected', capabilities: { screenshot: true } }]),
    use: vi.fn(async (_target: unknown, _scope: unknown, work: (browser: BrowserOwner, original: BrowserResourceBinding) => Promise<ToolExecutionReceipt>, _options: unknown) => work(owner as unknown as BrowserOwner, binding)),
    hasProviders: () => true, releaseThread: vi.fn(),
  };
  const readRef = vi.fn(async () => ({ title: 'source.pdf', source: Buffer.from('pinned-source bytes') }));
  const readPath = vi.fn(async () => { throw new Error('must not reopen a source reference as a path'); });
  const write = vi.fn(async () => ({ status: 'applied', executorStopped: true, path: 'received.pdf', attachment: { ref: 'attachment:download', filename: 'received.pdf', mimeType: 'application/pdf', byteLength: 20 } }));
  const materials = { read: vi.fn(async () => ({ ref: { title: 'attachment.pdf' }, source: { bytes: Buffer.from('retained-original bytes') } })) };
  const runtime = { run: async () => ({ thread_id: 'thread', principal_id: 'original-principal' }), familyList: async () => ({ rootThreadId: 'thread' }), principalCanUseHostResources: vi.fn(async (_principal: string) => true) };
  const browser = createBrowserRuntime({ resources, settings, runtime,
    sources: { tool: () => ({ readRef, readPath }) }, files: { write }, materials,
  } as unknown as Parameters<typeof createBrowserRuntime>[0]);
  async function invoke(method: string, args: Record<string, unknown>) {
    const declaration = BROWSER_TOOL_DECLARATIONS.find(item => item.id === `varin.browser.${method}`)!;
    const signal = new AbortController().signal;
    let receipt: ToolExecutionReceipt | undefined;
    await withToolInvocation({ owner: extension, signal, onEffectReceipt: value => { receipt = value; }, authority: {
      invocationId: 'invocation', runId: 'run', threadId: 'thread', callId: 'call', operationId: 'request:tool:call',
      origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'kernel' }, source: null,
      toolName: declaration.tool!.name, operation: declaration.tool!.operation, completion: 'result', configurationIdentity: JSON.stringify({ version: 1, disabled: [] }), arguments: args,
    } }, async invocation => browser.capability(method, args as never, { owner: extension, signal, invocation }));
    return receipt!;
  }
  return { owner, resources, invoke, browser, readRef, readPath, write, materials, runtime };
}

describe('browser resource tool routing', () => {
  it('discovers actual resource metadata without acquiring a desktop or page', async () => {
    const f = fixture();
    expect(await f.invoke('resources', {})).toMatchObject({ completion: { outcome: 'succeeded', effect: 'none', content: { data: { resources: [{ ...binding, deviceName: 'Office computer' }] } } } });
    expect(f.resources.use).not.toHaveBeenCalled(); expect(f.owner.list).not.toHaveBeenCalled();
  });
  it('checks the original Run principal before revealing resources or entering the owner', async () => {
    const f = fixture(); f.runtime.principalCanUseHostResources.mockResolvedValue(false);
    for (const [method, args] of [['resources', {}], ['act', { ...target, action: 'reload' }]] as const) {
      expect(await f.invoke(method, args)).toMatchObject({ completion: { outcome: 'failed', effect: 'none', content: { data: { message: 'Host browser resources require the Host owner' } } } });
    }
    expect(f.runtime.principalCanUseHostResources).toHaveBeenCalledWith('original-principal');
    expect(f.resources.list).not.toHaveBeenCalled(); expect(f.resources.use).not.toHaveBeenCalled();
  });
  it('keeps tabs and opened pages on the original resource/instance and strips routing fields before owner dispatch', async () => {
    const f = fixture();
    const tabs = await f.invoke('tabs', { ...binding });
    expect(tabs).toMatchObject({ completion: { content: { data: { binding, pages: [page] } } } });
    const opened = await f.invoke('open', { ...binding, url: 'https://example.test/new' });
    expect(opened).toMatchObject({ completion: { effect: 'confirmed', content: { data: { binding: target, page } } } });
    expect(f.owner.open).toHaveBeenCalledWith({ url: 'https://example.test/new' }, { threadId: 'thread', signal: expect.any(AbortSignal) });
    expect(f.resources.use).toHaveBeenLastCalledWith(binding, { threadId: 'thread', runId: 'run', operationId: 'request:tool:call', signal: expect.any(AbortSignal) }, expect.any(Function), { writes: true, observes: false });
  });
  it('requires the original instance for raw page IDs and rejects legacy desktop targeting before owner input', async () => {
    const f = fixture();
    for (const incomplete of [{ pageId: page.pageId }, { browserId: binding.browserId, pageId: page.pageId }]) {
      expect(await f.invoke('act', { ...incomplete, action: 'reload' })).toMatchObject({ completion: { outcome: 'failed', effect: 'none', content: { data: { message: expect.stringContaining('instanceId') } } } });
    }
    await expect(f.invoke('act', { ...target, desktopId: 'wrong-machine', action: 'reload' })).rejects.toThrow('Browser arguments');
    expect(f.resources.use).not.toHaveBeenCalled(); expect(f.owner.act).not.toHaveBeenCalled();
  });
  it('emits screenshot bytes through media output and preserves original binding for the reference owner', async () => {
    const f = fixture();
    const result = await f.invoke('read', { ...target, view: 'screenshot' });
    expect(result).toMatchObject({ completion: { effect: 'none', content: { data: { binding: target, observationId: 'original-observation' }, parts: [{ kind: 'media', media: { media_type: 'image/png', data_base64: 'YWJj' } }] } } });
    if (result.completion.kind !== 'result') throw new Error('Expected result');
    expect(JSON.stringify(result.completion.content.data)).not.toContain('YWJj');
    expect(f.owner.read).toHaveBeenCalledWith({ pageId: page.pageId, view: 'screenshot' }, expect.any(AbortSignal));
    expect(f.resources.use.mock.calls[0]![3]).toEqual({ writes: false, observes: true });
  });
  it('reports disconnected, unsupported and stale-instance admission as no effect without fallback', async () => {
    for (const message of ['browser_disconnected', 'browser_capability_unavailable', 'browser_instance_changed']) {
      const f = fixture(); f.resources.use.mockRejectedValueOnce(new Error(message));
      expect(await f.invoke('act', { ...target, action: 'reload' })).toMatchObject({ completion: { outcome: 'failed', effect: 'none', content: { data: { message } } } });
      expect(f.owner.act).not.toHaveBeenCalled();
    }
  });
  it('keeps an action with a lost response unknown and never retries it', async () => {
    const f = fixture(); f.owner.act.mockRejectedValueOnce(new BrowserExecutionError(new Error('connection lost after dispatch'), 'unknown'));
    expect(await f.invoke('act', { ...target, action: 'click', ref: 'element:1' })).toMatchObject({ completion: { outcome: 'indeterminate', effect: 'unknown', content: { data: { next: expect.stringContaining('before repeating') } } } });
    expect(f.owner.act).toHaveBeenCalledOnce(); expect(f.resources.use).toHaveBeenCalledOnce();
  });
  it('passes generic post-dispatch uncertainty through the registry so the original page can be fenced', async () => {
    const f = fixture(); f.owner.act.mockRejectedValueOnce(new Error('response unavailable'));
    let ownerError: unknown;
    f.resources.use.mockImplementationOnce(async (_target, _scope, work) => {
      try { return await work(f.owner as unknown as BrowserOwner, binding); }
      catch (error) { ownerError = error; throw error; }
    });
    expect(await f.invoke('act', { ...target, action: 'reload' })).toMatchObject({ completion: { outcome: 'indeterminate', effect: 'unknown' } });
    expect(ownerError).toBeInstanceOf(BrowserExecutionError);
    expect(ownerError).toMatchObject({ effect: 'unknown' });
  });
  it('waits for the original executor completion before reporting an unknown effect', async () => {
    const f = fixture();
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    f.owner.act.mockImplementationOnce(async () => { started(); throw new BrowserExecutionError('response unavailable', 'unknown', false, completion); });
    let finished = false;
    const pending = f.invoke('act', { ...target, action: 'reload' }).then(result => { finished = true; return result; });
    await dispatched;
    try { expect(f.owner.act).toHaveBeenCalledOnce(); expect(finished).toBe(false); } finally { finish(); }
    expect(await pending).toMatchObject({ executor_stopped: true, completion: { outcome: 'indeterminate', effect: 'unknown' } });
  });
  it('does not classify an interrupted read-only wait as an unknown write', async () => {
    const f = fixture(); f.owner.act.mockRejectedValueOnce(new Error('connection lost during wait'));
    expect(await f.invoke('act', { ...target, action: 'wait', condition: 'loaded' })).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
    expect(f.resources.use.mock.calls[0]![3]).toEqual({ writes: false, observes: false });
  });
  it('transfers uploads through source and retained-material owners, never a browser-device path', async () => {
    const f = fixture();
    const result = await f.invoke('files', { ...target, action: 'upload', ref: 'element:2', files: [{ path: 'file:17' }, { snapshotId: 'snapshot' }] });
    expect(result).toMatchObject({ completion: { outcome: 'succeeded', effect: 'confirmed' } });
    expect(f.readRef).toHaveBeenCalledWith('file:17', expect.any(AbortSignal)); expect(f.readPath).not.toHaveBeenCalled();
    expect(f.owner.upload).toHaveBeenCalledWith(page.pageId, 'element:2', [{ name: 'source.pdf', bytes: Buffer.from('pinned-source bytes') }, { name: 'attachment.pdf', bytes: Buffer.from('retained-original bytes') }], expect.any(AbortSignal));
  });
  it('saves bytes from the selected browser owner through the actual file-source writer and retains its attachment receipt', async () => {
    const f = fixture();
    const result = await f.invoke('files', { ...target, action: 'save', downloadId: 'download', path: 'received.pdf', expectedRevision: 'observed-revision' });
    expect(f.owner.readDownload).toHaveBeenCalledWith(page.pageId, 'download', expect.any(AbortSignal));
    expect(f.write).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', operationId: 'request:tool:call' }), { path: 'received.pdf', expectedRevision: 'observed-revision', bytes: Buffer.from('browser-device bytes') }, expect.any(AbortSignal));
    expect(result).toMatchObject({ completion: { effect: 'confirmed', content: { parts: [{ kind: 'attachment', attachment: { ref: 'attachment:download' } }] } } });
    expect(f.owner.releaseDownload).toHaveBeenCalledWith(page.pageId, 'download');
  });
});

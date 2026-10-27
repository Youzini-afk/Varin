import { describe, expect, it, vi } from 'vitest';
import { CaptureInventoryChangedError, createCaptureInventory } from '../../documents/capture-inventory.js';
import { captureStableDirectoryBaseline, captureStableSourceBaseline, type SourceCaptureDocuments } from './source-preparation.js';
import type { BaselineInventory } from './workspace-baseline.js';
import type { RecoveryState, WorkingStateRootStore } from './types.js';

function fixture(initial: Record<string, RecoveryState> = { 'file.txt': { kind: 'regular-file', objectHash: 'saved', byteLength: 5, mode: 0o644 } }) {
  const disk = structuredClone(initial);
  let pass = 0;
  const hooks: { capture?: (pass: number) => void; settle?: () => void } = {};
  const release = vi.fn(async () => undefined);
  const create = vi.fn(async (_workspace: string, branchId: string, states: Record<string, RecoveryState>) => ({
    workspaceId: 'workspace', branchId, baseRoot: 'fixed', root: 'fixed', headRevision: 0, writeRevision: 0,
    draftBasePaths: [], captureScopes: [], createdAt: 1, updatedAt: 1, states,
  }));
  const store = {
    readSourcePreparation: vi.fn(async () => null),
    listWorkspaceBaselinePaths: vi.fn(async () => Object.keys(disk).sort()),
    listCaptureScopePaths: vi.fn(async (_directory: string, scopes: readonly string[]) => Object.keys(disk).filter(file => scopes.some(scope => file === scope || file.startsWith(`${scope}/`))).sort()),
    captureDirectory: vi.fn(async (_directory: string, paths?: string[], options?: Parameters<WorkingStateRootStore['captureDirectory']>[2]) => {
      hooks.capture?.(++pass);
      options?.onProgress?.(1, (paths ?? Object.keys(disk)).length);
      return Object.fromEntries((paths ?? Object.keys(disk)).map(file => [file, structuredClone(file === '.' ? {kind:'directory',mode:0o755} : disk[file] ?? { kind: 'missing' })]));
    }),
    releaseCapturedStates: release,
    createBranch: create,
  } as unknown as WorkingStateRootStore;
  const complete = vi.fn(async () => ({ stable: true, reasons: [] as string[] }));
  const barrier = { settle: vi.fn(async () => { hooks.settle?.(); }), release: vi.fn(async () => undefined) };
  const documents = {
    inspectWorkspace: vi.fn(async () => ({ root: '/source', workspaceId: 'workspace' })),
    beginDirtyStateBarrier: vi.fn(async () => barrier),
    beginCapture: vi.fn(async () => ({ captureId: 'capture', workspaceId: 'workspace' })),
    completeCapture: complete,
    discardCapture: vi.fn(),
    captureInventory: (_capture: unknown, scan: () => Promise<string[]>) => {
      let paths: string[];
      return { read: async () => paths = await scan(), verify: async () => {
        if (JSON.stringify(await scan()) !== JSON.stringify(paths)) throw new CaptureInventoryChangedError();
      } };
    },
    inspectMutation: vi.fn(async () => ({ activeWriters: [] })),
    inspectDirtyBuffers: vi.fn(async () => []),
  } as unknown as SourceCaptureDocuments;
  const inspectInventory = vi.fn(async (): Promise<BaselineInventory> => ({ kind: 'directory' }));
  const input = { store, workspaceId: 'workspace', captureWorkspaceId: 'workspace', branchId: 'captured', directory: '/source', captureScopes: [], content: { mode: 'saved-files' as const } };
  return { disk, hooks, store, documents, complete, barrier, release, create, inspectInventory, input };
}

describe('shared stable source capture', () => {
  it('passes original cancellation through branch publication and drains captured owners', async () => {
    const f = fixture();
    const controller = new AbortController();
    let publishing!: () => void;
    const entered = new Promise<void>(resolve => { publishing = resolve; });
    vi.spyOn(f.store, 'createBranch').mockImplementation(async (_workspace, _branch, _states, _base, _drafts, _scopes, options) => {
      expect(options?.signal).toBe(controller.signal);
      publishing();
      await new Promise<void>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const pending = captureStableSourceBaseline({ ...f.input, signal: controller.signal }, f);
    await entered;
    controller.abort(new Error('cancel original import'));
    await expect(pending).rejects.toThrow('cancel original import');
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.barrier.release).toHaveBeenCalledOnce();
  });

  it('stops verification on an invalidated namespace and releases the captured snapshot', async () => {
    const f = fixture();
    const inventory = createCaptureInventory();
    const position = { epoch: 1, sourceId: 'source', generation: 1, complete: true };
    const candidate = await inventory.prepare({ ...position, scan: async () => ['file.txt'] });
    f.hooks.capture = pass => { if (pass === 2) inventory.invalidate('new-file.txt'); };
    const verify = vi.fn(async () => undefined);
    await expect(captureStableDirectoryBaseline({ ...f.input, inspectInventory: f.inspectInventory,
      directoryInventory: { read: async () => candidate.paths, assertCurrent: () => inventory.assertCurrent(candidate), verify },
    })).rejects.toThrow('new-file.txt');
    expect(verify).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
  });

  it('keeps saved bytes for dirty paths and exposes omitted overlays separately', async () => {
    const f = fixture();
    vi.mocked(f.documents.inspectDirtyBuffers).mockResolvedValue([{ ownerId: 'editor', generation: 1, registrationId: 'registration', workspaceId: 'workspace', updatedAt: 'now',
      resources: [{ resource: { workspaceId: 'workspace', resourceId: 'file.txt' }, baseRevision: 'saved', localEditRevision: 2 }] }]);
    const result = await captureStableSourceBaseline(f.input, f);
    expect(f.create.mock.calls[0]?.[2]['file.txt']).toEqual(f.disk['file.txt']);
    expect(result.provenance).toMatchObject({ contentMode: 'saved-files', omittedDraftPaths: ['file.txt'], consistency: 'stable-capture' });
    expect(f.barrier.settle).toHaveBeenCalled();
    expect(f.barrier.release).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledWith('workspace', 'captured', expect.any(Object), 'zero-commit', [], [], { sourceProvenance: result.provenance });
  });

  it('recovers the fixed source and provenance before observing newer Documents or disk state', async () => {
    const f = fixture();
    const prepared = await captureStableSourceBaseline(f.input, f);
    vi.mocked(f.store.readSourcePreparation).mockResolvedValue(prepared);
    vi.mocked(f.documents.inspectWorkspace).mockRejectedValue(new Error('new workspace unavailable'));
    f.disk['file.txt'] = { kind: 'missing' };
    const recovered = await captureStableSourceBaseline(f.input, f);
    expect(recovered).toEqual(prepared);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.documents.inspectWorkspace).toHaveBeenCalledOnce();
  });

  it('checks inventory after the full content verification, including an insertion in its last read', async () => {
    const f = fixture();
    f.hooks.capture = pass => { if (pass === 2) f.disk['late.txt'] = { kind: 'directory', mode: 0o755 }; };
    await expect(captureStableSourceBaseline(f.input, f)).rejects.toThrow('directory paths');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['delete', { kind: 'missing' }],
    ['bytes', { kind: 'regular-file', objectHash: 'new', byteLength: 3, mode: 0o644 }],
    ['mode', { kind: 'regular-file', objectHash: 'saved', byteLength: 5, mode: 0o755 }],
    ['symlink', { kind: 'symlink', symlinkTarget: 'elsewhere', mode: 0o777 }],
  ] as const)('rejects %s drift instead of publishing mixed states', async (_name, changed) => {
    const f = fixture();
    f.hooks.capture = pass => { if (pass === 2) f.disk['file.txt'] = changed; };
    await expect(captureStableSourceBaseline(f.input, f)).rejects.toThrow('content or metadata');
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects the original Documents capture generation when a writer changed', async () => {
    const f = fixture();
    f.complete.mockResolvedValue({ stable: false, reasons: ['writer-activity'] });
    await expect(captureStableSourceBaseline(f.input, f)).rejects.toThrow('writer-activity');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.barrier.release).toHaveBeenCalledOnce();
  });

  it('does not publish after cancellation during the last Documents barrier', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.hooks.settle = () => controller.abort();
    await expect(captureStableSourceBaseline({ ...f.input, signal: controller.signal }, f)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.barrier.release).toHaveBeenCalledOnce();
  });

  it('rechecks frozen Git inventory and captureScopes using the same capture algorithm', async () => {
    const f = fixture({ 'file.txt': { kind: 'directory', mode: 0o755 }, 'ignored.txt': { kind: 'regular-file', objectHash: 'ignored', byteLength: 7 } });
    const git: BaselineInventory = { kind: 'git', baseRef: 'commit', unborn: false, paths: ['file.txt'], gitlinks: [] };
    f.inspectInventory.mockResolvedValue(git);
    const result = await captureStableDirectoryBaseline({ ...f.input, captureScopes: ['ignored.txt'], inspectInventory: f.inspectInventory });
    expect(result.states['ignored.txt']).toEqual(f.disk['ignored.txt']);
    expect(result.consistency).toBe('git-base-with-overlay');
    expect(f.store.captureDirectory).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.store.captureDirectory).mock.calls[1]?.[1]).toContain('ignored.txt');
    f.inspectInventory.mockResolvedValueOnce(git).mockResolvedValueOnce({ ...git, paths: ['file.txt', 'new.txt'] });
    await expect(captureStableDirectoryBaseline({ ...f.input, inspectInventory: f.inspectInventory })).rejects.toThrow('Git inventory');
  });

  it('includes explicit scopes outside the default directory inventory in the shared body pass', async () => {
    const f = fixture({ 'file.txt': { kind: 'directory', mode: 0o755 }, '.config/settings': { kind: 'regular-file', objectHash: 'settings', byteLength: 8 } });
    vi.mocked(f.store.listWorkspaceBaselinePaths).mockResolvedValue(['file.txt']);
    const input = { ...f.input, captureScopes: ['.config'], inspectInventory: f.inspectInventory };
    const result = await captureStableDirectoryBaseline(input);
    expect(result.states['.config/settings']).toEqual(f.disk['.config/settings']);
    expect(f.store.captureDirectory).toHaveBeenCalledTimes(2);
    f.hooks.capture = pass => { if (pass === 2) f.disk['.config/settings'] = { kind: 'missing' }; };
    await expect(captureStableDirectoryBaseline(input)).rejects.toThrow('content or metadata');
  });
});

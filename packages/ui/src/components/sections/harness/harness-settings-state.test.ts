import type { AgentSettingsSnapshot } from '@varin/application-client';
import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@varin/protocol';
import { HarnessSettingsController } from './harness-settings-state';

const snapshot = (harness: JsonValue, revision: string): AgentSettingsSnapshot => ({
  global: { harness }, globalRevision: revision, project: {}, projectRevision: 'project', projectTrusted: false,
});
const writtenSnapshot = (global: Record<string, JsonValue>, revision: string): AgentSettingsSnapshot => ({ ...snapshot({}, revision), global });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('Harness automatic saving', () => {
  it('reports invalid settings without rejecting the load and recovers after the document is corrected', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot({ models: { unknownRole: { providerId: 'one', modelId: 'model' } } }, 'invalid'))
      .mockResolvedValueOnce(snapshot({ models: { worker: { providerId: 'one', modelId: 'model' } } }, 'corrected'));
    const write = vi.fn();
    const controller = new HarnessSettingsController({ read, write });
    await expect(controller.load()).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({
      harness: null, status: 'error', error: 'Invalid model role: unknownRole',
    });
    await controller.retry();
    expect(controller.getSnapshot()).toMatchObject({
      harness: { models: { worker: { providerId: 'one', modelId: 'model' } } }, status: 'idle', error: null,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps rapid edits visible and sends them after the acknowledged revision without overwriting other settings', async () => {
    const first = deferred<AgentSettingsSnapshot>();
    const second = deferred<AgentSettingsSnapshot>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const controller = new HarnessSettingsController({ read: async () => snapshot({ tools: { grep: true }, future: { keep: true } }, 'a'), write });
    await controller.load();
    controller.update({ tools: { bash: false } });
    controller.update({ tools: { grep: false } });
    controller.update({ output: { visibleBytes: 64000 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().harness!.tools).toEqual({ bash: false, grep: false });
    first.resolve(writtenSnapshot(write.mock.calls[0]![0], 'b'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]).toEqual([{ harness: { tools: { grep: false, bash: false }, future: { keep: true }, output: { visibleBytes: 64000 } } }, 'b']);
    second.resolve(writtenSnapshot(write.mock.calls[1]![0], 'c'));
    await controller.load();
    expect(controller.getSnapshot().status).toBe('saved');
  });

  it('retains failed edits, and explicit retry merges them with a fresh snapshot', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot({ tools: { grep: true } }, 'a'))
      .mockResolvedValueOnce(snapshot({ tools: { grep: true }, context: { backgroundPreparation: false } }, 'outside'));
    const write = vi.fn().mockRejectedValueOnce(new Error('revision conflict'))
      .mockImplementationOnce(async (settings: Record<string, JsonValue>) => writtenSnapshot(settings, 'new'));
    const controller = new HarnessSettingsController({ read, write });
    await controller.load();
    controller.update({ tools: { bash: false } });
    await controller.load();
    expect(controller.getSnapshot().error).toBe('revision conflict');
    controller.update({ tools: { grep: false } });
    expect(write).toHaveBeenCalledTimes(1);
    await controller.retry();
    expect(write.mock.calls[1]).toEqual([{ harness: { tools: { grep: false, bash: false }, context: { backgroundPreparation: false } } }, 'outside']);
    expect(controller.getSnapshot().error).toBeNull();
  });

  it('removes only the chosen override and preserves empty domain restrictions and explicit false', async () => {
    const write = vi.fn(async (settings: Record<string, JsonValue>) => writtenSnapshot(settings, 'b'));
    const controller = new HarnessSettingsController({ read: async () => snapshot({
      models: { worker: { providerId: 'one', modelId: 'model' }, explore: { providerId: 'two', modelId: 'other' } },
      web: { domains: { block: ['blocked.test'] } }, nextStep: { enabled: true },
    }, 'a'), write });
    await controller.load();
    controller.update({ models: { worker: undefined }, web: { domains: { allow: [] } }, nextStep: { enabled: false } });
    await controller.load();
    expect(write.mock.calls[0]![0]).toEqual({ harness: { models: { explore: { providerId: 'two', modelId: 'other' } }, web: { domains: { block: ['blocked.test'], allow: [] } }, nextStep: { enabled: false } } });
  });

  it('restores a document parser default by removing only that user override', async () => {
    const write = vi.fn(async (settings: Record<string, JsonValue>) => writtenSnapshot(settings, 'b'));
    const controller = new HarnessSettingsController({
      read: async () => snapshot({ documentReading: {
        doclingCommand: 'custom-docling', tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
      } }, 'a'),
      write,
    });
    await controller.load();
    controller.update({ documentReading: { doclingCommand: undefined } });
    await controller.load();
    expect(write.mock.calls[0]![0]).toEqual({ harness: { documentReading: {
      tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
    } } });
    expect(controller.getSnapshot().harness?.documentReading).toEqual({
      doclingCommand: 'docling', tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
    });
  });

  it('saves the reserve ratio alongside harness edits while preserving other compaction settings', async () => {
    const initial = writtenSnapshot({ harness: { shell: 'auto' }, defaultModel: 'selected',
      compaction: { keepRecentTokens: 1000, modelOverrides: { 'p/m': { reserveRatio: 0.15 } } } }, 'a');
    const first = deferred<AgentSettingsSnapshot>();
    const write = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async (settings: Record<string, JsonValue>) => writtenSnapshot({ ...initial.global, ...settings }, 'c'));
    const controller = new HarnessSettingsController({ read: async () => initial, write });
    await controller.load();
    expect(controller.getSnapshot().reserveRatio).toBe(0.1);
    controller.update({ context: { backgroundPreparation: false } });
    controller.updateReserveRatio(0.2);
    expect(controller.getSnapshot().reserveRatio).toBe(0.2);
    first.resolve(writtenSnapshot({ ...initial.global, ...write.mock.calls[0]![0] }, 'b'));
    await controller.load();
    expect(write.mock.calls[1]).toEqual([{ compaction: { reserveRatio: 0.2, keepRecentTokens: 1000, modelOverrides: { 'p/m': { reserveRatio: 0.15 } } } }, 'b']);
    expect(controller.getSnapshot().status).toBe('saved');
  });

  it('refreshes an externally changed settings snapshot while preserving local state', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot({ shell: 'auto' }, 'a'))
      .mockResolvedValueOnce(snapshot({ shell: 'wsl' }, 'b'));
    const controller = new HarnessSettingsController({ read, write: vi.fn() });
    await controller.load();
    await controller.refresh();
    expect(controller.getSnapshot().harness?.shell).toBe('wsl');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not lose an external refresh that arrives while a save is in flight', async () => {
    const pendingWrite = deferred<AgentSettingsSnapshot>();
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot({ shell: 'auto' }, 'a'))
      .mockResolvedValueOnce(snapshot({ shell: 'wsl', nextStep: { enabled: true } }, 'c'));
    const controller = new HarnessSettingsController({ read, write: vi.fn(() => pendingWrite.promise) });
    await controller.load();
    controller.update({ tools: { grep: false } });
    const refreshed = controller.refresh();
    pendingWrite.resolve(snapshot({ shell: 'auto', tools: { grep: false } }, 'b'));
    await refreshed;
    expect(read).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().harness).toMatchObject({ shell: 'wsl', nextStep: { enabled: true } });
  });
});
describe('Harness explicit draft saving', () => {
  it('keeps a failed rule draft out of later automatic writes', async () => {
    const read = vi.fn(async () => snapshot({ permissions: { rules: [] } }, 'a'));
    const write = vi.fn().mockRejectedValueOnce(new Error('write failed'))
      .mockImplementation(async (global: Record<string, JsonValue>) => writtenSnapshot(global, 'b'));
    const controller = new HarnessSettingsController({ read, write });
    await controller.load();
    expect(await controller.commit({ permissions: { rules: [{ tool: 'file_write', decision: 'ask' }] } })).toBe(false);
    expect(controller.getSnapshot().harness?.permissions?.rules).toEqual([]);
    controller.update({ context: { backgroundPreparation: false } });
    await controller.retry();
    expect(write.mock.calls[1]![0].harness.permissions.rules).toEqual([]);
    expect(write.mock.calls[1]![0].harness.context.backgroundPreparation).toBe(false);
  });
  it('serializes rules behind automatic edits and retains edits made during the save', async () => {
    const first = deferred<AgentSettingsSnapshot>(), second = deferred<AgentSettingsSnapshot>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
      .mockImplementation(async (global: Record<string, JsonValue>) => writtenSnapshot(global, 'd'));
    const controller = new HarnessSettingsController({ read: async () => snapshot({}, 'a'), write });
    await controller.load();
    controller.update({ permissions: { mode: 'accept-edits' } });
    const saved = controller.commit({ permissions: { rules: [{ tool: 'file_write', decision: 'ask' }] } });
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(writtenSnapshot(write.mock.calls[0]![0], 'b'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    controller.update({ context: { backgroundPreparation: false } });
    expect(write.mock.calls[1]![1]).toBe('b');
    second.resolve(writtenSnapshot(write.mock.calls[1]![0], 'c'));
    expect(await saved).toBe(true);
    await controller.load();
    expect(write.mock.calls[2]![1]).toBe('c');
    expect(controller.getSnapshot().harness).toMatchObject({ permissions: { mode: 'accept-edits', rules: [{ tool: 'file_write', decision: 'ask' }] }, context: { backgroundPreparation: false } });
  });
});

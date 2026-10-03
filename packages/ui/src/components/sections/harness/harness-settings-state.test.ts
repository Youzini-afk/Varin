import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PiSettingsSnapshot } from '@varin/protocol';
import { HarnessSettingsController } from './harness-settings-state';

const snapshot = (harness: JsonValue, revision: string): PiSettingsSnapshot => ({
  global: { harness }, globalRevision: revision, project: {}, projectRevision: 'project', projectTrusted: false,
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('Harness automatic saving', () => {
  it('reports invalid settings without rejecting the load and recovers after the document is corrected', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot({ models: { unknownRole: { providerId: 'one', modelId: 'model' } } }, 'invalid'))
      .mockResolvedValueOnce(snapshot({ models: { review: { providerId: 'one', modelId: 'model' } } }, 'corrected'));
    const write = vi.fn();
    const controller = new HarnessSettingsController({ read, write });
    await expect(controller.load()).resolves.toBeUndefined();
    expect(controller.getSnapshot()).toEqual({
      harness: null, status: 'error', error: 'Invalid model role: unknownRole',
    });
    await controller.retry();
    expect(controller.getSnapshot()).toMatchObject({
      harness: { models: { review: { providerId: 'one', modelId: 'model' } } }, status: 'idle', error: null,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps rapid edits visible and sends them after the acknowledged revision without overwriting other settings', async () => {
    const first = deferred<PiSettingsSnapshot>();
    const second = deferred<PiSettingsSnapshot>();
    const write = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const controller = new HarnessSettingsController({ read: async () => snapshot({ tools: { grep: true }, future: { keep: true } }, 'a'), write });
    await controller.load();
    controller.update({ tools: { bash: false } });
    controller.update({ tools: { grep: false } });
    controller.update({ output: { visibleBytes: 64000 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().harness!.tools).toEqual({ bash: false, grep: false });
    first.resolve(snapshot(write.mock.calls[0]![0], 'b'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]).toEqual([{ tools: { grep: false, bash: false }, future: { keep: true }, output: { visibleBytes: 64000 } }, 'b']);
    second.resolve(snapshot(write.mock.calls[1]![0], 'c'));
    await controller.load();
    expect(controller.getSnapshot().status).toBe('saved');
  });

  it('retains failed edits, and explicit retry merges them with a fresh snapshot', async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot({ tools: { grep: true } }, 'a'))
      .mockResolvedValueOnce(snapshot({ tools: { grep: true }, context: { backgroundPreparation: false } }, 'outside'));
    const write = vi.fn().mockRejectedValueOnce(new Error('revision conflict'))
      .mockImplementationOnce(async (harness: JsonValue) => snapshot(harness, 'new'));
    const controller = new HarnessSettingsController({ read, write });
    await controller.load();
    controller.update({ tools: { bash: false } });
    await controller.load();
    expect(controller.getSnapshot().error).toBe('revision conflict');
    controller.update({ tools: { grep: false } });
    expect(write).toHaveBeenCalledTimes(1);
    await controller.retry();
    expect(write.mock.calls[1]).toEqual([{ tools: { grep: false, bash: false }, context: { backgroundPreparation: false } }, 'outside']);
    expect(controller.getSnapshot().error).toBeNull();
  });

  it('removes only the chosen override and preserves empty domain restrictions and explicit false', async () => {
    const write = vi.fn(async (harness: JsonValue) => snapshot(harness, 'b'));
    const controller = new HarnessSettingsController({ read: async () => snapshot({
      models: { review: { providerId: 'one', modelId: 'model' }, explore: { providerId: 'two', modelId: 'other' } },
      web: { domains: { block: ['blocked.test'] } }, review: { enabled: true },
    }, 'a'), write });
    await controller.load();
    controller.update({ models: { review: undefined }, web: { domains: { allow: [] } }, review: { enabled: false } });
    await controller.load();
    expect(write.mock.calls[0]![0]).toEqual({ models: { explore: { providerId: 'two', modelId: 'other' } }, web: { domains: { block: ['blocked.test'], allow: [] } }, review: { enabled: false } });
  });

  it('restores a document parser default by removing only that user override', async () => {
    const write = vi.fn(async (harness: JsonValue) => snapshot(harness, 'b'));
    const controller = new HarnessSettingsController({
      read: async () => snapshot({ documentReading: {
        doclingCommand: 'custom-docling', tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
      } }, 'a'),
      write,
    });
    await controller.load();
    controller.update({ documentReading: { doclingCommand: undefined } });
    await controller.load();
    expect(write.mock.calls[0]![0]).toEqual({ documentReading: {
      tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
    } });
    expect(controller.getSnapshot().harness?.documentReading).toEqual({
      doclingCommand: 'docling', tesseractCommand: 'custom-tesseract', ocrLanguage: 'fra',
    });
  });

  it('refreshes an externally changed Pi settings snapshot while preserving local state', async () => {
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
    const pendingWrite = deferred<PiSettingsSnapshot>();
    const read = vi.fn()
      .mockResolvedValueOnce(snapshot({ shell: 'auto' }, 'a'))
      .mockResolvedValueOnce(snapshot({ shell: 'wsl', review: { enabled: true } }, 'c'));
    const controller = new HarnessSettingsController({ read, write: vi.fn(() => pendingWrite.promise) });
    await controller.load();
    controller.update({ tools: { grep: false } });
    const refreshed = controller.refresh();
    pendingWrite.resolve(snapshot({ shell: 'auto', tools: { grep: false } }, 'b'));
    await refreshed;
    expect(read).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().harness).toMatchObject({ shell: 'wsl', review: { enabled: true } });
  });
});

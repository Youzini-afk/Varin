import { expect, it, vi } from 'vitest';
import { createTerminalCommandObserveAdapter, createTerminalCommandProjector } from './terminal-projection.js';
import type { TerminalCommandRecord } from '../terminal/session-api.js';
const record = (overrides: Partial<TerminalCommandRecord> = {}): TerminalCommandRecord => ({ command: 'echo hi', commandId: 'terminal:generation:1',
  cwd: '/workspace', endedAt: 10, exitCode: 0, integration: 'osc-633', owner: 'user', terminalId: 'terminal', ...overrides });
it('submits one workspace capture without reading or draining any Thread source queue', async () => {
  const observeTerminalCommand = vi.fn(async () => ({ captureId: 'original', state: 'pending' as const }));
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: async () => 'ws', observe: createTerminalCommandObserveAdapter({ observeTerminalCommand }) });
  expect(await projector.project(record())).toEqual({ captureId: 'original', state: 'pending' });
  expect(observeTerminalCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: 'ws', commandId: 'terminal:generation:1', endedAt: 10 }));
});
it('ignores harness commands and unresolved workspaces', async () => {
  const observe = vi.fn(() => ({ captureId: 'unused', state: 'pending' as const }));
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: async () => null, observe });
  expect(await projector.project(record({ owner: 'harness' }))).toBeNull(); expect(await projector.project(record())).toBeNull();
  expect(observe).not.toHaveBeenCalled();
});
it('bounds commands retained during a held root lookup and reports the exact gap', async () => {
  let release!: (workspace: string) => void;
  const lookup = new Promise<string>(resolve => { release = resolve; }), error = vi.fn();
  const observe = vi.fn(() => ({ captureId: 'original', state: 'pending' as const }));
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: () => lookup, observe, onError: error, budgets: { bytes: 100, commands: 1 } });
  const first = projector.project(record());
  expect(await projector.project(record({ commandId: 'second' }))).toMatchObject({ state: 'gap', reason: 'queue_budget', captureId: 'terminal:terminal:second' });
  expect(error).toHaveBeenCalledOnce(); release('ws'); await first; expect(observe).toHaveBeenCalledOnce();
});

it('closes intake but waits for an already owned root resolution to hand off its capture', async () => {
  let release!: (workspace: string) => void;
  const lookup = new Promise<string>(resolve => { release = resolve; });
  const observe = vi.fn(() => ({ captureId: 'original', state: 'pending' as const }));
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: () => lookup, observe });
  const original = projector.project(record()); let closed = false;
  const closing = projector.close().then(result => { closed = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false); expect(observe).not.toHaveBeenCalled();
  expect(await projector.project(record({ commandId: 'late' }))).toMatchObject({ state: 'gap', reason: 'closed' });
  release('ws'); expect(await original).toEqual({ captureId: 'original', state: 'pending' });
  expect(await closing).toMatchObject({ gap: { count: 1 }, failed: 0 }); expect(observe).toHaveBeenCalledOnce();
});

it('keeps a failed owned root resolution visible to shutdown without manufacturing a capture receipt', async () => {
  let reject!: (error: Error) => void;
  const lookup = new Promise<string>((_resolve, fail) => { reject = fail; }), observe = vi.fn(() => null);
  const projector = createTerminalCommandProjector({ resolveWorkspaceId: () => lookup, observe });
  const original = projector.project(record()); const rejected = expect(original).rejects.toThrow('root unavailable');
  const closing = projector.close(); reject(new Error('root unavailable')); await rejected;
  expect(await closing).toEqual({ gap: null, failed: 1 }); expect(observe).not.toHaveBeenCalled();
});

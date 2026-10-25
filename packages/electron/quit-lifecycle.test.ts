import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createQuitLifecycle } from './quit-lifecycle.js';

const fixture = () => {
  const events = new EventEmitter();
  const state = { quitRequested: false, quitConfirmed: false, quitInProgress: false,
    quitConfirmationPending: false, installingUpdate: false };
  const before: Array<{ preventDefault: ReturnType<typeof vi.fn> }> = [];
  const app = {
    on: events.on.bind(events),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }; before.push(event);
      events.emit('before-quit', event);
    }),
    exit: vi.fn(),
  };
  let finish!: () => void;
  const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const confirmation = vi.fn(), reportError = vi.fn();
  const lifecycle = createQuitLifecycle({ app, state, prepare, requestConfirmation: confirmation, reportError });
  const willQuit = () => {
    const event = { preventDefault: vi.fn() };
    events.emit('will-quit', event); return event;
  };
  return { app, state, lifecycle, before, prepare, confirmation, reportError, willQuit, finish: () => finish() };
};

it('keeps the Host available through window closing and drains once at will-quit before exit', async () => {
  const f = fixture();
  // The tray asks Electron to quit; the first pass obtains user confirmation.
  f.app.quit();
  expect(f.before[0]!.preventDefault).toHaveBeenCalledOnce();
  expect(f.confirmation).toHaveBeenCalledOnce();
  expect(f.prepare).not.toHaveBeenCalled();
  f.lifecycle.confirm();
  expect(f.app.quit).toHaveBeenCalledTimes(2);
  expect(f.before[1]!.preventDefault).not.toHaveBeenCalled();
  expect(f.state.quitRequested).toBe(true);
  // Renderers are still flushing/closing here. No native owner is stopped.
  expect(f.prepare).not.toHaveBeenCalled();
  const event = f.willQuit();
  f.willQuit();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.app.exit).not.toHaveBeenCalled();
  f.finish();
  await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0));
});

it('cancels a blocked window unload without stopping services and allows a later quit attempt', () => {
  const f = fixture();
  f.lifecycle.confirm();
  f.lifecycle.cancel();
  expect(f.state.quitRequested).toBe(false);
  expect(f.state.quitInProgress).toBe(false);
  expect(f.state.quitConfirmed).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
  f.app.quit();
  expect(f.before.at(-1)!.preventDefault).toHaveBeenCalledOnce();
  expect(f.confirmation).toHaveBeenCalledOnce();
  f.lifecycle.confirm();
  expect(f.before.at(-1)!.preventDefault).not.toHaveBeenCalled();
});

it('does not start overlapping native quit attempts', () => {
  const f = fixture();
  f.lifecycle.confirm(); f.lifecycle.confirm();
  expect(f.app.quit).toHaveBeenCalledOnce();
  expect(f.prepare).not.toHaveBeenCalled();
});

it('leaves update installation under the updater-owned quit handshake', () => {
  const f = fixture();
  f.state.installingUpdate = true;
  f.app.quit();
  expect(f.before[0]!.preventDefault).not.toHaveBeenCalled();
  expect(f.willQuit().preventDefault).not.toHaveBeenCalled();
  expect(f.confirmation).not.toHaveBeenCalled();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.app.exit).not.toHaveBeenCalled();
});

it('reports a failed shutdown and completes native exit after the windows have already closed', async () => {
  const f = fixture(), error = new Error('Owner drain failed');
  f.prepare.mockRejectedValueOnce(error);
  f.lifecycle.confirm(); f.willQuit();
  await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0));
  expect(f.reportError).toHaveBeenCalledExactlyOnceWith(error);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTauriDesktopBridge, DesktopBridgeError, type DesktopNativeTransport } from '../src/bridge.js';
import { installTauriDesktop, initializeTauriDesktop, type DesktopBootstrapTarget, type TauriDesktopBootstrap } from '../src/bootstrap.js';

class NativePort implements DesktopNativeTransport {
  calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
  listener: ((payload: unknown) => void) | undefined;
  subscriptions = 0;
  unsubscriptions = 0;
  constructor(readonly respond: (command: string, args?: Record<string, unknown>) => unknown = () => null) {}
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    return await this.respond(command, args) as T;
  }
  async listen(handler: (payload: unknown) => void): Promise<() => void> {
    this.subscriptions++;
    this.listener = handler;
    return () => { this.unsubscriptions++; this.listener = undefined; };
  }
  emit(event: string, detail?: unknown) { this.listener?.({ event, detail }); }
}

const bootstrap = (overrides: Partial<TauriDesktopBootstrap> = {}): TauriDesktopBootstrap => ({
  version: 1,
  runtime: 'tauri',
  localPage: true,
  platform: 'linux',
  arch: 'x64',
  windowRole: 'main',
  localOrigin: 'http://127.0.0.1:19001',
  apiBaseUrl: 'https://selected-host.example',
  clientToken: 'remote-window-token',
  requestHeaders: { 'X-Varin-Client': 'client-one' },
  homeDirectory: '/home/example',
  relayHostId: 'host-one',
  locale: 'zh-CN',
  macosMajor: 0,
  macVibrancy: false,
  trayEnabled: true,
  bootOutcome: { target: 'remote', status: 'ok', hostId: 'host-one', url: 'https://selected-host.example' },
  ...overrides,
});

const makeWindow = (): DesktopBootstrapTarget => Object.assign(new EventTarget(), {
  document: { documentElement: { toggleAttribute: () => {} } },
}) as unknown as DesktopBootstrapTarget;

test('the shared bridge preserves command results and all special entry points', async () => {
  const selected = { path: '/chosen/report.pdf', outsideFileGrant: 'grant-one', expiresAt: 123 };
  const port = new NativePort((command, args) => {
    if (command === 'varin_dialog_open' || command === 'varin_file_grant_existing') return selected;
    if (args?.command === 'desktop_get_current_window_state') return { maximized: true };
    return null;
  });
  const { bridge, dispose } = await createTauriDesktopBridge(port);
  assert.deepEqual(await bridge.invoke('desktop_get_current_window_state'), { maximized: true });
  assert.deepEqual(await bridge.openDialog({ returnGrant: true }), selected);
  assert.deepEqual(await bridge.grantFileAccess('/chosen/report.pdf'), selected);
  assert.equal(await bridge.openExternal('https://example.com'), null);
  assert.deepEqual(port.calls, [
    { command: 'varin_invoke', args: { command: 'desktop_get_current_window_state', args: {} } },
    { command: 'varin_dialog_open', args: { options: { returnGrant: true } } },
    { command: 'varin_file_grant_existing', args: { filePath: '/chosen/report.pdf' } },
    { command: 'varin_invoke', args: { command: 'desktop_open_external_url', args: { url: 'https://example.com' } } },
  ]);
  dispose();
});

test('unavailable and uncertain native effects remain failures and are never retried', async () => {
  const port = new NativePort(() => { throw { code: 'unavailable', message: 'Native browser presentation is unavailable' }; });
  const { bridge, dispose } = await createTauriDesktopBridge(port);
  await assert.rejects(bridge.invoke('desktop_web_render', { url: 'https://example.com' }), (error: unknown) =>
    error instanceof DesktopBridgeError && error.code === 'unavailable' && error.message.includes('unavailable'));
  assert.equal(port.calls.length, 1);
  dispose();
});

test('unknown methods and events never reach native IPC', async () => {
  const port = new NativePort();
  const { bridge, dispose } = await createTauriDesktopBridge(port);
  await assert.rejects(Reflect.apply(bridge.invoke, bridge, ['__proto__']), /Unknown desktop command/);
  await assert.rejects(Reflect.apply(bridge.listen, bridge, ['varin:arbitrary', () => {}]), /Unknown desktop event/);
  assert.deepEqual(port.calls, []);
  dispose();
});

test('events preserve typed payloads, isolate callbacks, unsubscribe and dispose once', async () => {
  const port = new NativePort();
  const domEvents: unknown[] = [];
  const { bridge, dispose } = await createTauriDesktopBridge(port, (event, detail) => domEvents.push({ event, detail }));
  const received: unknown[] = [];
  await bridge.listen('varin:window-maximized-changed', () => { throw new Error('consumer failed'); });
  const unsubscribe = await bridge.listen('varin:window-maximized-changed', event => received.push(event.payload));
  port.emit('varin:window-maximized-changed', { maximized: true });
  port.emit('varin:not-supported', { secret: 'ignored' });
  assert.deepEqual(received, [{ maximized: true }]);
  assert.deepEqual(domEvents, [{ event: 'varin:window-maximized-changed', detail: { maximized: true } }]);
  unsubscribe();
  unsubscribe();
  port.emit('varin:window-maximized-changed', { maximized: false });
  assert.equal(received.length, 1);
  dispose();
  dispose();
  assert.equal(port.unsubscriptions, 1);
  await assert.rejects(bridge.invoke('desktop_close_current_window'), /disposed/);
  await assert.rejects(bridge.listen('varin:window-resized', () => {}), /disposed/);
  assert.deepEqual(port.calls, []);
});

test('main and Mini Chat bootstrap retain separate selected Host credentials and events', async () => {
  const main = makeWindow();
  const mini = makeWindow();
  const mainPort = new NativePort(() => bootstrap());
  const miniPort = new NativePort(() => bootstrap({
    windowRole: 'mini-chat', apiBaseUrl: 'https://second-host.example',
    clientToken: 'second-window-token', relayHostId: 'host-two',
    requestHeaders: { 'X-Varin-Client': 'client-two' },
    bootOutcome: { target: 'remote', status: 'ok', hostId: 'host-two', url: 'https://second-host.example' },
  }));
  const disposeMain = await installTauriDesktop(main, mainPort);
  const disposeMini = await installTauriDesktop(mini, miniPort);
  assert.equal(main.__VARIN_CLIENT_TOKEN__, 'remote-window-token');
  assert.equal(mini.__VARIN_CLIENT_TOKEN__, 'second-window-token');
  assert.equal(mini.__VARIN_API_BASE_URL__, 'https://second-host.example');
  assert.deepEqual(mini.__VARIN_RUNTIME_HEADERS__, { 'X-Varin-Client': 'client-two' });
  assert.equal(mini.__VARIN_RELAY_HOST_ID__, 'host-two');
  assert.equal(mini.__VARIN_DESKTOP_RUNTIME__?.runtime, 'tauri');
  assert.equal('__VARIN_ELECTRON__' in mini, false);
  const received: unknown[] = [];
  mini.addEventListener('varin:open-thread', event => received.push((event as CustomEvent).detail));
  mainPort.emit('varin:open-thread', { threadId: 'main-only' });
  assert.deepEqual(received, []);
  miniPort.emit('varin:open-thread', { threadId: 'mini-only' });
  assert.deepEqual(received, [{ threadId: 'mini-only' }]);
  mini.dispatchEvent(new Event('pagehide'));
  assert.equal(miniPort.unsubscriptions, 1);
  assert.equal(mainPort.unsubscriptions, 0);
  disposeMain?.();
  disposeMini?.();
});

test('unknown remote documents receive no bridge, subscription, home or credentials', async () => {
  const target = makeWindow();
  const port = new NativePort(() => ({ ...bootstrap(), localPage: false }));
  assert.equal(await installTauriDesktop(target, port), null);
  assert.equal(target.__VARIN_DESKTOP__, undefined);
  assert.equal(target.__VARIN_CLIENT_TOKEN__, undefined);
  assert.equal(target.__VARIN_RUNTIME_HEADERS__, undefined);
  assert.equal(target.__VARIN_HOME__, undefined);
  assert.equal(target.__VARIN_DESKTOP_RUNTIME__, undefined);
  assert.equal(port.subscriptions, 0);
});

test('decorative companion surfaces never gain the Host or desktop bridge', async () => {
  for (const windowRole of ['companion-scene', 'companion-stool'] as const) {
    const target = makeWindow();
    const port = new NativePort(() => bootstrap({ windowRole }));
    assert.equal(await installTauriDesktop(target, port), null);
    assert.equal(target.__VARIN_DESKTOP__, undefined);
    assert.equal(target.__VARIN_CLIENT_TOKEN__, undefined);
    assert.equal(port.subscriptions, 0);
  }
});

test('malformed or future bootstrap fails before publishing partial global state', async () => {
  for (const invalid of [{ ...bootstrap(), version: 2 }, { ...bootstrap(), requestHeaders: { bearer: 42 } },
    { ...bootstrap(), bootOutcome: { target: 'remote', status: 'ok' } }]) {
    const target = makeWindow();
    const port = new NativePort(() => invalid);
    await assert.rejects(installTauriDesktop(target, port), /missing or incompatible/);
    assert.equal(target.__VARIN_DESKTOP__, undefined);
    assert.equal(target.__VARIN_CLIENT_TOKEN__, undefined);
    assert.equal(port.subscriptions, 0);
  }
});

test('Web and embedded documents do not load native APIs or install a bridge', async () => {
  const browser = makeWindow();
  await initializeTauriDesktop(browser as unknown as Window);
  assert.equal(browser.__VARIN_DESKTOP__, undefined);
  const embedded = Object.assign(makeWindow(), { __TAURI_INTERNALS__: {}, top: {} });
  await initializeTauriDesktop(embedded as unknown as Window);
  assert.equal(embedded.__VARIN_DESKTOP__, undefined);
});

test('navigation readiness waits for the exact document runtime ledger before native actions can flush', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'document-one' }) : command === 'varin_runtime_changed' ? write : null);
  const dispose = await installTauriDesktop(target, port);
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap']);
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap', 'varin_runtime_changed']);
  assert.deepEqual(port.calls[1]?.args, { documentNonce: 'document-one', config: {
    apiBaseUrl: 'https://selected-host.example', clientToken: 'remote-window-token',
    requestHeaders: { 'X-Varin-Client': 'client-one' }, relayHostId: 'host-one',
  } });
  settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(port.calls[2], { command: 'varin_renderer_ready', args: { documentNonce: 'document-one' } });
  dispose?.();
});

test('each runtime change snapshots its own credentials in order and disposal fences queued writes', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'document-two' }) : command === 'varin_runtime_changed' ? write : null);
  const dispose = await installTauriDesktop(target, port);
  target.__VARIN_API_BASE_URL__ = 'https://first.example';
  target.__VARIN_CLIENT_TOKEN__ = 'first-token';
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  await new Promise(resolve => setImmediate(resolve));
  target.__VARIN_API_BASE_URL__ = 'https://second.example';
  target.__VARIN_CLIENT_TOKEN__ = 'second-token';
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  assert.equal((port.calls[1]?.args?.config as Record<string, unknown>).clientToken, 'first-token');
  dispose?.();
  settle();
  await new Promise(resolve => setImmediate(resolve));
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap', 'varin_runtime_changed']);
});

test('failed native runtime authority never becomes a successful document-ready receipt or hidden retry', async () => {
  const target = makeWindow();
  const port = new NativePort(command => {
    if (command === 'varin_bootstrap') return bootstrap({ documentNonce: 'replaced-document' });
    if (command === 'varin_runtime_changed') throw new Error('The original application document was replaced');
    return null;
  });
  const dispose = await installTauriDesktop(target, port);
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap', 'varin_runtime_changed']);
  dispose?.();
});

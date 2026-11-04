import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { exportDesktopFrontendEntries, FRONTEND_MIGRATION_MARKER_KEY } from '@varin/application-client/desktop';
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
  emit(event: string, detail?: unknown, delivery?: { runtimeEpoch: string; documentNonce: string }) { this.listener?.({ event, detail, ...delivery }); }
}

const bootstrap = (overrides: Partial<TauriDesktopBootstrap> = {}): TauriDesktopBootstrap => ({
  version: 1,
  runtime: 'tauri',
  localPage: true,
  platform: 'linux',
  arch: 'x64',
  windowRole: 'main',
  frontendMigrationOwner: true,
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

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('only the native migration owner imports before installing any workbench bridge', async () => {
  const storage = new MemoryStorage();
  const payload = exportDesktopFrontendEntries([['lastDirectory', '/preserved-project']]);
  const stage = { schema: 1, id: 'original-preferences', sourceOrigin: 'varin-ui://app', sourceVersion: '1',
    stage: 'staged', payload, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  for (const label of ['main', 'workbench-1', 'workbench-2', 'mini-chat-1']) {
    const target = Object.assign(makeWindow(), { localStorage: storage, crypto: webcrypto as unknown as Crypto });
    const owner = label === 'main';
    const port = new NativePort((command, args) => {
      if (command === 'varin_bootstrap') return bootstrap({
        windowRole: label.startsWith('mini-chat') ? 'mini-chat' : 'main', frontendMigrationOwner: owner,
      });
      if (command === 'varin_frontend_migration') {
        // Exercise the real native authorization boundary with the DOM services
        // available in production, instead of silently skipping the import.
        assert.equal(label, 'main', 'secondary workbenches cannot call the migration owner');
        assert.equal(target.__VARIN_DESKTOP__, undefined, 'consumers must wait for the original import');
        return args?.action === 'read' ? JSON.stringify(stage) : null;
      }
      return null;
    });
    const dispose = await installTauriDesktop(target, port);
    assert.ok(target.__VARIN_DESKTOP__, `${label} installs its own bridge`);
    assert.equal(storage.getItem('lastDirectory'), '/preserved-project');
    assert.ok(storage.getItem(FRONTEND_MIGRATION_MARKER_KEY));
    assert.equal(port.calls.filter(call => call.command === 'varin_frontend_migration').length, owner ? 2 : 0);
    dispose?.();
  }
});

test('failed owner import leaves the original preferences unacknowledged and no partial bridge', async () => {
  const target = Object.assign(makeWindow(), { localStorage: new MemoryStorage(), crypto: webcrypto as unknown as Crypto });
  const port = new NativePort(command => {
    if (command === 'varin_bootstrap') return bootstrap();
    throw new Error('Preference export is unavailable');
  });
  await assert.rejects(installTauriDesktop(target, port), /Preference export is unavailable/);
  assert.equal(target.__VARIN_DESKTOP__, undefined);
  assert.equal(target.__VARIN_CLIENT_TOKEN__, undefined);
  assert.equal(target.localStorage.length, 0);
  assert.equal(port.subscriptions, 0);
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap', 'varin_frontend_migration']);
});

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
  const mainPort = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'main-document' })
    : command === 'varin_runtime_changed' ? { runtimeEpoch: 'main-epoch', documentNonce: 'main-document' } : null);
  const miniPort = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({
    documentNonce: 'mini-document',
    windowRole: 'mini-chat', apiBaseUrl: 'https://second-host.example',
    clientToken: 'second-window-token', relayHostId: 'host-two',
    requestHeaders: { 'X-Varin-Client': 'client-two' },
    bootOutcome: { target: 'remote', status: 'ok', hostId: 'host-two', url: 'https://second-host.example' },
  }) : command === 'varin_runtime_changed' ? { runtimeEpoch: 'mini-epoch', documentNonce: 'mini-document' } : null);
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
  main.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  mini.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  mainPort.emit('varin:open-thread', { threadId: 'main-only' }, { runtimeEpoch: 'main-epoch', documentNonce: 'main-document' });
  assert.deepEqual(received, []);
  miniPort.emit('varin:open-thread', { threadId: 'mini-only' }, { runtimeEpoch: 'mini-epoch', documentNonce: 'mini-document' });
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
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'document-one' })
    : command === 'varin_runtime_changed' ? write.then(() => ({ runtimeEpoch: 'runtime-one', documentNonce: 'document-one' })) : null);
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
  assert.deepEqual(port.calls[2], { command: 'varin_renderer_ready', args: { documentNonce: 'document-one', runtimeEpoch: 'runtime-one' } });
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

test('draft transfer waits for native acceptance and dispatches its targeted receiver payload without retry', async () => {
  let accept!: (value: { accepted: true }) => void;
  const transfer = { schemaVersion: 1 as const, sourceDraftKey: 'draft', snapshotId: 'snapshot', sourceHostGeneration: 5,
    directory: '/project', projectId: 'project', draft: { text: 'Retain these bytes', images: [], materials: [], preparedSource: null } };
  const port = new NativePort((_command, args) => args?.command === 'desktop_transfer_draft'
    ? new Promise(resolve => { accept = resolve; }) : null);
  const events: unknown[] = [];
  const { bridge, dispose } = await createTauriDesktopBridge(port, (name, detail) => events.push({ name, detail }));
  let accepted = false;
  const pending = bridge.invoke('desktop_transfer_draft', { transfer }).then(result => { accepted = result.accepted; });
  await Promise.resolve();
  assert.equal(accepted, false);
  const detail = { transferId: 'native-id', apiBaseUrl: 'https://host.example', relayHostId: '', transfer };
  port.emit('varin:transfer-draft', detail);
  assert.deepEqual(events, [{ name: 'varin:transfer-draft', detail }]);
  await bridge.invoke('desktop_complete_draft_transfer', { transferId: 'native-id', accepted: true });
  assert.equal(accepted, false, 'sending the receiver command alone is not a source receipt');
  accept({ accepted: true }); await pending;
  assert.equal(accepted, true);
  assert.equal(port.calls.filter(call => call.args?.command === 'desktop_transfer_draft').length, 1);
  dispose();
});

const draftTransfer = () => ({ schemaVersion: 1 as const, sourceDraftKey: 'source-draft', snapshotId: 'original-snapshot', sourceHostGeneration: 2,
  directory: '/project', projectId: '', draft: { text: 'Keep the original Host', images: [], materials: [], preparedSource: null } });

test('Host-scoped commands wait for the actual native runtime receipt without blocking window controls', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  let nativeEndpoint = 'https://selected-host.example';
  const observed: string[] = [];
  const port = new NativePort(async (command, args) => {
    if (command === 'varin_bootstrap') return bootstrap({ documentNonce: 'original-document' });
    if (command === 'varin_runtime_changed') {
      await write;
      nativeEndpoint = (args?.config as { apiBaseUrl: string }).apiBaseUrl;
      return { runtimeEpoch: 'runtime-new', documentNonce: 'original-document' };
    }
    if (command === 'varin_invoke' && args?.command !== 'desktop_minimize_current_window') observed.push(nativeEndpoint);
    return args?.command === 'desktop_transfer_draft' ? { accepted: true } : null;
  });
  const dispose = await installTauriDesktop(target, port);
  const bridge = target.__VARIN_DESKTOP__!;
  target.__VARIN_API_BASE_URL__ = 'https://new-host.example';
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  const transfer = draftTransfer();
  const pending = [
    bridge.invoke('desktop_transfer_draft', { transfer }),
    bridge.invoke('desktop_complete_draft_transfer', { transferId: 'receipt', accepted: true }),
    bridge.invoke('desktop_focus_main_window', { mode: 'draft' }),
    bridge.invoke('desktop_new_window'),
    bridge.invoke('desktop_new_window_at_url', { url: 'https://explicit-host.example' }),
    bridge.invoke('desktop_new_window_for_host', { hostId: 'saved-host' }),
    bridge.invoke('desktop_open_draft_mini_chat_window', { directory: '/project' }),
    bridge.invoke('desktop_open_thread_mini_chat_window', { threadId: 'thread', branchId: 'branch' }),
    bridge.invoke('desktop_notify', { title: 'Host notification' }),
    bridge.invoke('desktop_tray_update', { dockBadgeCount: 1 }),
    bridge.invoke('desktop_browser_device', { action: 'status' }),
    bridge.invoke('desktop_browser_control', { pageId: 'original-page', paused: true }),
    bridge.invoke('desktop_web_render', { url: 'https://example.com' }),
  ];
  await bridge.invoke('desktop_minimize_current_window');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [], 'none of the scoped commands may use the old native Host');
  assert.equal(port.calls.filter(call => call.command === 'varin_runtime_changed').length, 1);
  settle();
  assert.deepEqual((await Promise.all(pending))[0], { accepted: true });
  assert.equal(observed.length, pending.length);
  assert.ok(observed.every(endpoint => endpoint === 'https://new-host.example'));
  assert.deepEqual(port.calls.find(call => call.args?.command === 'desktop_transfer_draft')?.args?.args, { transfer });
  dispose?.();
});

test('a failed runtime write rejects scoped commands and remains failed without a hidden retry', async () => {
  const target = makeWindow();
  let rejectWrite!: (error: Error) => void;
  const write = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'original-document' })
    : command === 'varin_runtime_changed' ? write : null);
  const dispose = await installTauriDesktop(target, port);
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  const rejected = assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_transfer_draft', { transfer: draftTransfer() }), /Native authority rejected/);
  rejectWrite(new Error('Native authority rejected'));
  await rejected;
  await assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_focus_main_window', {}), /Native authority rejected/);
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(port.calls.map(call => call.command), ['varin_bootstrap', 'varin_runtime_changed']);
  await target.__VARIN_DESKTOP__!.invoke('desktop_close_current_window');
  assert.equal(port.calls.at(-1)?.args?.command, 'desktop_close_current_window');
  dispose?.();
});

test('a later Host revision promptly rejects an earlier command and never replays it on the new Host', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  let writes = 0;
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'original-document' })
    : command === 'varin_runtime_changed' ? (++writes === 1 ? write : Promise.resolve()).then(() => ({ runtimeEpoch: `runtime-${writes}`, documentNonce: 'original-document' })) : null);
  const dispose = await installTauriDesktop(target, port);
  target.__VARIN_API_BASE_URL__ = 'https://first.example';
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  const rejected = assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_transfer_draft', { transfer: draftTransfer() }), /original desktop document or Application Host changed/);
  await new Promise(resolve => setImmediate(resolve));
  target.__VARIN_API_BASE_URL__ = 'https://second.example';
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  await rejected; // No need for the old native write to finish to reject its dependent request.
  const next = target.__VARIN_DESKTOP__!.invoke('desktop_focus_main_window', {});
  settle();
  await next;
  assert.deepEqual(port.calls.filter(call => call.command === 'varin_invoke').map(call => call.args?.command), ['desktop_focus_main_window']);
  assert.deepEqual(port.calls.filter(call => call.command === 'varin_runtime_changed').map(call => (call.args?.config as { apiBaseUrl: string }).apiBaseUrl), ['https://first.example', 'https://second.example']);
  dispose?.();
});

test('a revision change after ledger completion is still checked immediately before IPC dispatch', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'original-document' })
    : command === 'varin_runtime_changed' ? write : null);
  const dispose = await installTauriDesktop(target, port);
  const rejected = assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_open_draft_mini_chat_window', {}), /original desktop document or Application Host changed/);
  await new Promise(resolve => setImmediate(resolve));
  settle();
  queueMicrotask(() => target.dispatchEvent(new Event('varin:runtime-endpoint-changed')));
  await rejected;
  assert.equal(port.calls.some(call => call.command === 'varin_invoke'), false);
  dispose?.();
});

test('document disposal rejects a waiting transfer before a stalled native write can finish', async () => {
  const target = makeWindow();
  let settle!: () => void;
  const write = new Promise<void>(resolve => { settle = resolve; });
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'original-document' })
    : command === 'varin_runtime_changed' ? write : null);
  const dispose = await installTauriDesktop(target, port);
  const rejected = assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_transfer_draft', { transfer: draftTransfer() }), /original desktop document or Application Host changed/);
  await new Promise(resolve => setImmediate(resolve));
  target.dispatchEvent(new Event('pagehide'));
  await rejected;
  settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(port.calls.some(call => call.command === 'varin_invoke'), false);
  dispose?.();
});

test('targeted navigation is delivered only to the synchronized document and epoch, never replayed after same-URL credential changes', async () => {
  const target = makeWindow();
  const first = { runtimeEpoch: 'first-epoch', documentNonce: 'receiver-document' };
  const second = { runtimeEpoch: 'second-epoch', documentNonce: 'receiver-document' };
  let settle!: (value: typeof second) => void;
  const write = new Promise<typeof second>(resolve => { settle = resolve; });
  let writes = 0;
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: first.documentNonce })
    : command === 'varin_runtime_changed' ? (++writes === 1 ? first : write) : null);
  const dispose = await installTauriDesktop(target, port);
  const names = ['varin:transfer-draft', 'varin:open-thread', 'varin:open-draft-thread'] as const;
  const dom: unknown[] = [], bridge: unknown[] = [];
  for (const name of names) {
    target.addEventListener(name, event => dom.push((event as CustomEvent).detail));
    await target.__VARIN_DESKTOP__!.listen(name, event => bridge.push(event.payload));
  }
  const detail = { transferId: 'original-transfer', transfer: draftTransfer(), threadId: 'thread', branchId: 'branch', directory: '/project', apiBaseUrl: target.__VARIN_API_BASE_URL__, relayHostId: target.__VARIN_RELAY_HOST_ID__ };
  for (const name of names) port.emit(name, detail, first);
  assert.deepEqual(dom, [], 'native metadata alone is not a successful renderer synchronization receipt');
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  for (const name of names) port.emit(name, detail, first);
  assert.deepEqual(dom, names.map(() => detail));
  assert.deepEqual(bridge, dom);

  // Neither URL nor relay changes. Only the connection's authority changes.
  target.__VARIN_CLIENT_TOKEN__ = 'second-test-token';
  target.__VARIN_RUNTIME_HEADERS__ = { 'X-Varin-Client': 'second-client' };
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  for (const name of names) {
    port.emit(name, detail, first);
    port.emit(name, detail, second);
  }
  let updates = 0;
  target.addEventListener('varin:check-for-updates', () => { updates++; });
  port.emit('varin:check-for-updates');
  assert.equal(updates, 1, 'global update navigation does not inherit a Host');
  assert.equal(dom.length, names.length);
  settle(second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.length, names.length, 'dropped events must not be replayed against a new receipt');
  assert.deepEqual(port.calls.filter(call => call.command === 'varin_renderer_ready').map(call => call.args), [first, second]);
  for (const name of names) {
    port.emit(name, detail, first);
    port.emit(name, detail, { ...second, documentNonce: 'replaced-document' });
    port.emit(name, detail);
  }
  assert.equal(dom.length, names.length);
  assert.deepEqual(bridge, dom, 'bridge listeners cannot bypass the delivery fence');
  for (const name of names) port.emit(name, detail, second);
  assert.equal(dom.length, names.length * 2);
  assert.deepEqual(bridge, dom);
  dispose?.();
});

test('failed or superseded native receipts cannot authorize delayed drafts and disposed documents cannot receive them', async () => {
  const target = makeWindow();
  const first = { runtimeEpoch: 'first', documentNonce: 'receiver-document' };
  const stale = { runtimeEpoch: 'stale', documentNonce: first.documentNonce };
  const current = { runtimeEpoch: 'current', documentNonce: first.documentNonce };
  let settleStale!: (value: typeof stale) => void;
  const staleWrite = new Promise<typeof stale>(resolve => { settleStale = resolve; });
  let writes = 0;
  const port = new NativePort(command => {
    if (command === 'varin_bootstrap') return bootstrap({ documentNonce: first.documentNonce });
    if (command !== 'varin_runtime_changed') return null;
    if (++writes === 1) return first;
    if (writes === 2) throw new Error('Native runtime rejected');
    return writes === 3 ? staleWrite : current;
  });
  const dispose = await installTauriDesktop(target, port);
  const received: unknown[] = [];
  target.addEventListener('varin:transfer-draft', event => received.push((event as CustomEvent).detail));
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  await new Promise(resolve => setImmediate(resolve));
  const detail = { transferId: 'original-transfer', transfer: draftTransfer() };
  port.emit('varin:transfer-draft', detail, first);
  assert.deepEqual(received, []);
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  await new Promise(resolve => setImmediate(resolve));
  target.dispatchEvent(new Event('varin:runtime-endpoint-changed'));
  settleStale(stale);
  port.emit('varin:transfer-draft', detail, stale);
  await new Promise(resolve => setImmediate(resolve));
  port.emit('varin:transfer-draft', detail, stale);
  assert.deepEqual(received, [], 'an obsolete successful response must never publish its epoch');
  assert.deepEqual(port.calls.filter(call => call.command === 'varin_renderer_ready').map(call => call.args), [first, current]);
  port.emit('varin:transfer-draft', detail, current);
  assert.deepEqual(received, [detail]);
  const queuedNativeDelivery = port.listener!;
  target.dispatchEvent(new Event('pagehide'));
  queuedNativeDelivery({ event: 'varin:transfer-draft', detail, ...current });
  assert.deepEqual(received, [detail]);
  dispose?.();
});

test('missing or wrong-document runtime receipts never authorize commands or targeted events', async () => {
  for (const receipt of [null, {}, { runtimeEpoch: '', documentNonce: 'receiver-document' }, { runtimeEpoch: 'epoch', documentNonce: 'other-document' }]) {
    const target = makeWindow();
    const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: 'receiver-document' }) : receipt);
    const dispose = await installTauriDesktop(target, port);
    let delivered = false;
    target.addEventListener('varin:transfer-draft', () => { delivered = true; });
    await assert.rejects(target.__VARIN_DESKTOP__!.invoke('desktop_focus_main_window', {}), /native desktop runtime receipt/);
    port.emit('varin:transfer-draft', { transfer: draftTransfer() }, { runtimeEpoch: 'epoch', documentNonce: 'receiver-document' });
    assert.equal(delivered, false);
    assert.equal(port.calls.some(call => call.command === 'varin_invoke'), false);
    dispose?.();
  }
});

test('a listener that changes Host cannot expose the same stale event to subsequent consumers', async () => {
  const target = makeWindow();
  const delivery = { runtimeEpoch: 'epoch', documentNonce: 'receiver-document' };
  const port = new NativePort(command => command === 'varin_bootstrap' ? bootstrap({ documentNonce: delivery.documentNonce }) : delivery);
  const dispose = await installTauriDesktop(target, port);
  target.dispatchEvent(new Event('varin:desktop-navigation-ready'));
  await new Promise(resolve => setImmediate(resolve));
  await target.__VARIN_DESKTOP__!.listen('varin:transfer-draft', () => target.dispatchEvent(new Event('varin:runtime-endpoint-changed')));
  let delivered = false;
  await target.__VARIN_DESKTOP__!.listen('varin:transfer-draft', () => { delivered = true; });
  target.addEventListener('varin:transfer-draft', () => { delivered = true; });
  port.emit('varin:transfer-draft', { transfer: draftTransfer() }, delivery);
  assert.equal(delivered, false);
  dispose?.();
});

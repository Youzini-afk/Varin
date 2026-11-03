import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { getRuntimeApiBaseUrl, getRuntimeKey, registerRuntimeEndpointSwitchBlocker, switchRuntimeEndpoint, switchRuntimeEndpointSafely, getLocalRuntimeUrlAuthTokenSync, getRuntimeUrlAuthTokenSync, refreshLocalRuntimeUrlAuthToken, setLocalRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@varin/application-client';
import { installTauriDesktop, type DesktopBootstrapTarget, type TauriDesktopBootstrap } from '../src/bootstrap.js';
import type { DesktopNativeTransport } from '../src/bridge.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const releases: Array<() => void> = [];
let originalWindow: PropertyDescriptor | undefined, originalFetch: typeof fetch;
beforeEach(() => { originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'); originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(null, { status: 404 }); });
afterEach(() => {
  releases.splice(0).forEach(release => release()); globalThis.fetch = originalFetch; if (originalWindow)
    Object.defineProperty(globalThis, 'window', originalWindow);
  else
    Reflect.deleteProperty(globalThis, 'window');
});
async function setup() {
  const target = Object.assign(new EventTarget(), { document: { documentElement: { toggleAttribute() { } } }, location: { href: 'http://tauri.localhost/', origin: 'http://tauri.localhost' } }) as unknown as DesktopBootstrapTarget;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  let value: TauriDesktopBootstrap = { version: 1, runtime: 'tauri', localPage: true, platform: 'linux', arch: 'x64', windowRole: 'main', localOrigin: 'http://127.0.0.1:19001', apiBaseUrl: 'http://127.0.0.1:19001', clientToken: 'old-token', requestHeaders: {}, homeDirectory: '/home/example', relayHostId: '', macosMajor: 0, macVibrancy: false, trayEnabled: true, bootOutcome: { target: 'local', status: 'ok' } };
  let listener!: (payload: unknown) => void;
  const calls: string[] = [];
  const transport: DesktopNativeTransport = { async invoke<T>(command: string, args?: Record<string, unknown>) { calls.push(command); if (command === 'varin_invoke' && args?.command === 'desktop_local_client_token_get') return 'old-token' as T; return value as T; }, async listen(handler) { listener = handler; return () => { listener = () => { }; }; } };
  const dispose = await installTauriDesktop(target, transport);
  releases.push(dispose!);
  switchRuntimeEndpoint({ apiBaseUrl: value.apiBaseUrl, clientToken: value.clientToken, runtimeKey: 'local' });
  return { target, calls, restart(sameOrigin = false) { if (!sameOrigin) value = { ...value, apiBaseUrl: 'http://127.0.0.1:19002', localOrigin: 'http://127.0.0.1:19002', clientToken: 'replacement-token' }; listener({ event: 'varin:local-host-restarted', detail: { previousOrigin: 'http://127.0.0.1:19001' } }); } };
}
test('local Host restart uses the shared guarded switch without reloading or exposing its private event', async () => {
  const f = await setup();
  let saved = false, cleaned = false;
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { saved = true; }, { phase: 'guard' }));
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { assert.equal(saved, true); cleaned = true; }));
  let exposed = false;
  f.target.addEventListener('varin:local-host-restarted', () => { exposed = true; });
  await assert.rejects(Reflect.apply(f.target.__VARIN_DESKTOP__!.listen, f.target.__VARIN_DESKTOP__, ['varin:local-host-restarted', () => { }]), /Unknown/);
  f.restart();
  await tick();
  await tick();
  assert.equal(cleaned, true);
  assert.equal(exposed, false);
  assert.equal(getRuntimeKey(), 'local');
  assert.equal(getRuntimeApiBaseUrl(), 'http://127.0.0.1:19002');
  assert.equal(f.target.__VARIN_CLIENT_TOKEN__, 'replacement-token');
  assert.equal(f.target.__VARIN_LOCAL_ORIGIN__, 'http://127.0.0.1:19002');
  assert.equal(f.calls.filter(c => c === 'varin_bootstrap').length, 2);
});
test('restart never overwrites an already selected remote endpoint or credentials', async () => {
  const f = await setup();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'remote-token', runtimeKey: 'host:remote' });
  let cleaned = false;
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { cleaned = true; }));
  f.restart();
  await tick();
  await tick();
  assert.equal(getRuntimeApiBaseUrl(), 'https://remote.example');
  assert.equal(f.target.__VARIN_CLIENT_TOKEN__, 'remote-token');
  assert.equal(f.target.__VARIN_LOCAL_ORIGIN__, 'http://127.0.0.1:19002');
  assert.equal(cleaned, false);
});
test('a remote switch already queued wins without cleaning that new runtime', async () => {
  const f = await setup();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  releases.push(registerRuntimeEndpointSwitchBlocker(() => pending, { phase: 'guard' }));
  const remote = switchRuntimeEndpointSafely({ apiBaseUrl: 'https://remote.example', clientToken: 'remote-token', runtimeKey: 'host:remote' });
  let cleanups = 0;
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { cleanups++; }));
  f.restart();
  await tick();
  release();
  await remote;
  await tick();
  await tick();
  assert.equal(getRuntimeKey(), 'host:remote');
  assert.equal(f.target.__VARIN_CLIENT_TOKEN__, 'remote-token');
  assert.equal(cleanups, 1);
});


test('remote-selected same-port restart clears cached local grants without changing remote auth', async () => {
  const f = await setup();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'remote-token', runtimeKey: 'host:remote' });
  await tick(); // Settle the selected remote's independent background mint.
  const local = f.target.__VARIN_LOCAL_ORIGIN__!;
  setRuntimeUrlAuthToken('remote-url-grant', Date.now() + 60_000);
  setLocalRuntimeUrlAuthToken('old-local-url-grant', Date.now() + 60_000, local);
  assert.equal(getLocalRuntimeUrlAuthTokenSync(local), 'old-local-url-grant');
  f.restart(true);
  await tick(); await tick();
  assert.equal(getLocalRuntimeUrlAuthTokenSync(local), '');
  assert.equal(getRuntimeUrlAuthTokenSync(), 'remote-url-grant');
  assert.equal(getRuntimeKey(), 'host:remote');
  assert.equal(f.target.__VARIN_CLIENT_TOKEN__, 'remote-token');
});

test('remote-selected same-port restart fences the in-flight local mint even when the private bearer is unchanged', async () => {
  const f = await setup();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', clientToken: 'remote-token', runtimeKey: 'host:remote' });
  await tick(); // Settle the selected remote's independent background mint.
  const local = f.target.__VARIN_LOCAL_ORIGIN__!;
  let release!: (response: Response) => void;
  let dispatched!: () => void;
  const ready = new Promise<void>(yes => { dispatched = yes; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${local}/auth/url-token`);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer old-token');
    return new Promise<Response>(yes => { release = yes; dispatched(); });
  };
  const mint = refreshLocalRuntimeUrlAuthToken(local);
  const rejection = assert.rejects(mint, /stale/);
  await ready;
  f.restart(true);
  await tick(); await tick();
  globalThis.fetch = async () => new Response(null, { status: 404 });
  release(Response.json({ token: 'old-local-url-grant', expiresAt: Date.now() + 60_000 }));
  await rejection;
  assert.equal(getLocalRuntimeUrlAuthTokenSync(local), '');
  assert.equal(getRuntimeKey(), 'host:remote');
  assert.equal(f.target.__VARIN_CLIENT_TOKEN__, 'remote-token');
});

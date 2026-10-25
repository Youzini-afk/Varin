import "./network-fixture.js";
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import {
  getRuntimeApiBaseUrl, getRuntimeEndpointGeneration, getRuntimeKey, registerRuntimeEndpointSwitchBlocker,
  switchRuntimeEndpoint, switchRuntimeEndpointSafely, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange,
} from '../src/transport/runtime-switch.js';

const releases: Array<() => void> = [];
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://old.example', runtimeKey: 'old' });
});
afterEach(() => { releases.splice(0).forEach(release => release()); globalThis.fetch = originalFetch; });
const switchHost = () => switchRuntimeEndpointSafely({ apiBaseUrl: 'https://new.example', runtimeKey: 'new' });
const tick = () => new Promise(resolve => setImmediate(resolve));

it('keeps old views writable through an asynchronous guard, regardless of registration order', async () => {
  let viewOpen = true, allow!: () => void;
  const calls: string[] = [];
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { viewOpen = false; calls.push('close'); }));
  releases.push(registerRuntimeEndpointSwitchBlocker(async () => {
    await new Promise<void>(resolve => { allow = resolve; });
    assert.equal(viewOpen, true);
    assert.equal(getRuntimeKey(), 'old');
    calls.push('save');
  }, { phase: 'guard' }));
  const generation = getRuntimeEndpointGeneration();
  const switching = switchHost();
  await tick();
  assert.equal(getRuntimeEndpointGeneration(), generation);
  assert.equal(viewOpen, true); assert.deepEqual(calls, []);
  allow(); await switching;
  assert.deepEqual(calls, ['save', 'close']); assert.equal(getRuntimeKey(), 'new');
  assert.equal(getRuntimeEndpointGeneration(), generation + 1);
});

it('a rejected guard performs zero cleanup and leaves the endpoint and generation unchanged', async () => {
  let closed = false;
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { closed = true; }));
  releases.push(registerRuntimeEndpointSwitchBlocker(() => { throw new Error('Keep editing'); }, { phase: 'guard' }));
  const generation = getRuntimeEndpointGeneration();
  await assert.rejects(switchHost(), /Keep editing/);
  assert.equal(closed, false); assert.equal(getRuntimeKey(), 'old');
  assert.equal(getRuntimeEndpointGeneration(), generation);
});

it('cleans up resources current after the guard and never commits after a cleanup failure', async () => {
  const calls: string[] = [];
  const oldCleanup = registerRuntimeEndpointSwitchBlocker(() => { calls.push('obsolete'); });
  releases.push(oldCleanup);
  releases.push(registerRuntimeEndpointSwitchBlocker(() => {
    oldCleanup();
    releases.push(registerRuntimeEndpointSwitchBlocker(() => { calls.push('current'); throw new Error('Close failed'); }));
  }, { phase: 'guard' }));
  const generation = getRuntimeEndpointGeneration();
  await assert.rejects(switchHost(), /Close failed/);
  assert.deepEqual(calls, ['current']); assert.equal(getRuntimeKey(), 'old');
  assert.equal(getRuntimeEndpointGeneration(), generation);
});

it('notifies old and new identities at the commit boundary even with read-only Electron preload globals', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const runtimeWindow = new EventTarget();
  for (const [name, value] of Object.entries({
    __VARIN_API_BASE_URL__: 'http://127.0.0.1:3000', __VARIN_CLIENT_TOKEN__: '', __VARIN_RUNTIME_HEADERS__: {},
  })) Object.defineProperty(runtimeWindow, name, { value, writable: false });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
  try {
    const events: Array<[string, string, string]> = [];
    releases.push(subscribeRuntimeEndpointWillChange(detail => events.push(['before', getRuntimeKey(), detail.previousRuntimeKey])));
    releases.push(subscribeRuntimeEndpointChanged(detail => events.push(['after', getRuntimeKey(), detail.runtimeKey])));
    await switchHost();
    assert.deepEqual(events, [['before', 'old', 'old'], ['after', 'new', 'new']]);
    assert.equal(getRuntimeKey(), 'new');
    assert.equal(getRuntimeApiBaseUrl(), 'https://new.example');
  } finally {
    // Unsubscribe against the same window that owned the listeners.
    releases.splice(0).forEach(release => release());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

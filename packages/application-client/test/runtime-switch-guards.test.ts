import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import {
  getRuntimeEndpointGeneration, getRuntimeKey, registerRuntimeEndpointSwitchBlocker,
  switchRuntimeEndpoint, switchRuntimeEndpointSafely,
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
  const switching = switchHost();
  await tick();
  assert.equal(viewOpen, true); assert.deepEqual(calls, []);
  allow(); await switching;
  assert.deepEqual(calls, ['save', 'close']); assert.equal(getRuntimeKey(), 'new');
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

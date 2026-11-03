import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNodeRuntime } from '../src/node/runtime.js';

test('packaged Node overrides a desktop executable and strips inherited private IPC', () => {
  const env = { VARIN_NODE_PATH: '/release/node', ELECTRON_RUN_AS_NODE: '1', NODE_CHANNEL_FD: '9', PATH: '/user/bin' };
  const result = resolveNodeRuntime({ env, execPath: '/app/Varin', versions: { electron: '42' }, platform: 'linux' });
  assert.equal(result.executable, '/release/node');
  assert.deepEqual(result.env, { VARIN_NODE_PATH: '/release/node', PATH: '/user/bin' });
  assert.equal(env.NODE_CHANNEL_FD, '9');
});

test('transitional Electron and ordinary Node have distinct environment contracts', () => {
  assert.equal(resolveNodeRuntime({ env: {}, execPath: '/app/Varin', versions: { electron: '42' } }).env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(resolveNodeRuntime({ env: { ELECTRON_RUN_AS_NODE: '0' }, execPath: '/bin/node', versions: { node: '24' } }).env.ELECTRON_RUN_AS_NODE, undefined);
});

test('a malformed explicit runtime never silently falls back', () => {
  assert.throws(() => resolveNodeRuntime({ env: { VARIN_NODE_PATH: 'node' } }), /absolute Node/);
  assert.throws(() => resolveNodeRuntime({ env: { VARIN_NODE_PATH: '/node\0extra' } }), /absolute Node/);
  assert.equal(resolveNodeRuntime({ env: { VARIN_NODE_PATH: 'C:\\Varin\\node.exe' }, platform: 'win32' }).executable, 'C:\\Varin\\node.exe');
});

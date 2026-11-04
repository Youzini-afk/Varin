import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const bootstrap = readFileSync(new URL('../src-tauri/src/preview.html', import.meta.url), 'utf8');
const script = bootstrap.match(/<script>([\s\S]*)<\/script>/)![1];

test('preview bootstrap accepts only its embedding parent and generation, once, after load', () => {
  const listeners = new Map<string, (event: unknown) => void>(), messages: unknown[] = [], writes: string[] = [];
  const parent = { postMessage: (data: unknown) => messages.push(data) };
  const sandbox = { parent, window: {}, location: { hash: '#generation' },
    addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
    document: { open: () => writes.push('open'), write: (html: string) => writes.push(html), close: () => writes.push('close') } };
  vm.runInNewContext(script, sandbox);
  assert.equal(messages.length, 0);
  listeners.get('load')!({});
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'varin-preview:ready', id: 'generation' }]);
  const data = { type: 'varin-preview:install', id: 'generation', html: '<h1>rendered</h1>' };
  listeners.get('message')!({ source: {}, data });
  listeners.get('message')!({ source: parent, data: { ...data, id: 'stale' } });
  listeners.get('message')!({ source: parent, data: { ...data, html: 123 } });
  assert.equal(writes.length, 0);
  listeners.get('message')!({ source: parent, data });
  assert.deepEqual(writes, ['open', '<h1>rendered</h1>', 'close']);
  assert.equal(listeners.has('message'), false);
});

test('preview bootstrap is inert outside an identified child frame', () => {
  for (const topLevel of [true, false]) {
    const parent = {}, events: string[] = [];
    vm.runInNewContext(script, { parent, window: topLevel ? parent : {}, location: { hash: topLevel ? '#generation' : '' },
      addEventListener: (event: string) => events.push(event) });
    assert.deepEqual(events, []);
  }
});

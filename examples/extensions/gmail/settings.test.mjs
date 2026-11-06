import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseHTML } from 'linkedom';
import { createSettingsExtension } from './settings.mjs';

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  throw new Error('UI state did not update');
}

test('settings page connects, cancels, checks and disconnects using its Host service', async () => {
  const { document, window } = parseHTML('<html><body><main></main></body></html>');
  const main = document.querySelector('main'), abort = new AbortController();
  let phase = 'disconnected', connectCount = 0, receivedClient;
  const service = {
    async status() { return { phase, message: null, authorizationUrl: phase === 'authorizing' ? 'https://accounts.google.com/example' : null }; },
    async start(json) { receivedClient = json; phase = ++connectCount === 1 ? 'authorizing' : 'connected'; },
    async cancel() { phase = 'disconnected'; },
    async check() { return { emailAddress: 'fixture@example.com' }; },
    async disconnect() { phase = 'disconnected'; },
  };
  let implementation, descriptor;
  await createSettingsExtension().activate({
    styles: { async use(path) { assert.equal(path, 'package/settings.css'); } },
    useService(id, version) { assert.equal(id, 'example.gmail.connection'); assert.equal(version, 1); return service; },
    contribute(value, impl) { descriptor = value; implementation = impl; },
  });
  assert.equal(descriptor.kind, 'settings-page');
  const dispose = implementation.mount(main, { signal: abort.signal, props: { region: 'content' } });
  await until(() => main.querySelector('.varin-gmail-status').textContent.includes('Not connected'));
  const file = main.querySelector('input[type="file"]');
  Object.defineProperty(file, 'files', { configurable: true, value: [{ size: 30, async text() { return '{"installed":{"client_id":"x"}}'; } }] });
  file.dispatchEvent(new window.Event('change'));
  const button = name => [...main.querySelectorAll('button')].find(node => node.textContent === name);
  assert.equal(button('Connect Gmail').disabled, false);
  button('Connect Gmail').click();
  await until(() => main.querySelector('.varin-gmail-status').textContent.includes('Waiting'));
  assert.equal(receivedClient, '{"installed":{"client_id":"x"}}');
  assert.equal(main.querySelector('a[href="https://accounts.google.com/example"]').hidden, false);
  button('Cancel sign-in').click();
  await until(() => main.querySelector('.varin-gmail-status').textContent.includes('Not connected'));
  file.dispatchEvent(new window.Event('change'));
  button('Connect Gmail').click();
  await until(() => main.querySelector('.varin-gmail-status').textContent.includes('Connected'));
  button('Verify connection').click();
  await until(() => main.textContent.includes('fixture@example.com'));
  button('Disconnect').click();
  await until(() => main.querySelector('.varin-gmail-status').textContent.includes('Not connected'));
  assert.equal(main.textContent.includes('fixture@example.com'), false);
  dispose();
  assert.equal(main.querySelector('.varin-gmail'), null);
});

test('publisher-provided OAuth configuration enables one-click login without a client file', async () => {
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const main = document.querySelector('main'), abort = new AbortController();
  let starts = 0, argumentCount = -1, implementation;
  const service = {
    async status() { return { phase: 'disconnected', publisherConfigured: true }; },
    async start(...args) { starts++; argumentCount = args.length; },
  };
  await createSettingsExtension().activate({ styles: { async use() {} }, useService() { return service; },
    contribute(_value, impl) { implementation = impl; } });
  const dispose = implementation.mount(main, { signal: abort.signal, props: { region: 'content' } });
  const button = [...main.querySelectorAll('button')].find(node => node.textContent === 'Connect Gmail');
  await until(() => button.disabled === false);
  assert.match(main.textContent, /authorize your own Google account/u);
  button.click();
  await until(() => starts === 1);
  assert.equal(argumentCount, 0);
  dispose();
});

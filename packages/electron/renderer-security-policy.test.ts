import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  createPreloadBootstrapPayload,
  isTrustedLocalRendererUrl,
  normalizeExternalHttpUrl,
  REMOTE_SAFE_DESKTOP_COMMANDS,
} from './renderer-security-policy.js';

const trustOptions = {
  uiProtocol: 'varin-ui',
  developmentUiOrigin: 'http://127.0.0.1:5173',
  localOrigins: ['http://127.0.0.1:57123'],
};

test('opens only HTTP and HTTPS URLs through the operating system', () => {
  assert.equal(normalizeExternalHttpUrl('https://varin.dev/docs'), 'https://varin.dev/docs');
  assert.equal(normalizeExternalHttpUrl('http://127.0.0.1:57123/path'), 'http://127.0.0.1:57123/path');
  for (const value of ['file:///C:/Windows/System32', 'javascript:alert(1)', 'mailto:user@example.com', 'not a url']) {
    assert.equal(normalizeExternalHttpUrl(value), null);
  }
});

test('recognizes only packaged, exact development, and exact local renderer origins', () => {
  assert.equal(isTrustedLocalRendererUrl('varin-ui://app/index.html', trustOptions), true);
  assert.equal(isTrustedLocalRendererUrl('varin-ui://other/index.html', trustOptions), false);
  assert.equal(isTrustedLocalRendererUrl('http://127.0.0.1:5173/index.html', trustOptions), true);
  assert.equal(isTrustedLocalRendererUrl('http://127.0.0.1:57123/chat', trustOptions), true);
  assert.equal(isTrustedLocalRendererUrl('http://127.0.0.1:57124/chat', trustOptions), false);
  assert.equal(isTrustedLocalRendererUrl('https://remote.example.test', trustOptions), false);
});

test('remote renderers cannot enumerate credentials, probe hosts, or discover the LAN address', () => {
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_hosts_get'), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_host_probe'), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_get_lan_address'), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_new_window'), true);
});

test('preload bootstrap discloses runtime credentials only to a trusted local renderer', () => {
  const common = {
    ...trustOptions,
    localOrigin: 'http://127.0.0.1:57123',
    apiBaseUrl: 'https://remote.example.test',
    clientToken: 'secret-token',
    requestHeaders: { 'CF-Access-Client-Secret': 'secret-header' },
    homeDirectory: 'C:\\Users\\Example',
    relayHostId: 'relay-host',
    macosMajor: 15,
    macVibrancy: true,
    trayEnabled: true,
  };
  const remote = createPreloadBootstrapPayload({ ...common, senderUrl: 'https://remote.example.test/app' });
  assert.equal(remote.localPage, false);
  assert.equal(remote.apiBaseUrl, 'https://remote.example.test');
  for (const key of ['clientToken', 'requestHeaders', 'homeDirectory', 'relayHostId']) {
    assert.equal(Object.hasOwn(remote, key), false);
  }

  const local = createPreloadBootstrapPayload({ ...common, senderUrl: 'varin-ui://app/index.html' });
  assert.equal(local.localPage, true);
  assert.equal(local.clientToken, 'secret-token');
  assert.deepEqual(local.requestHeaders, { 'CF-Access-Client-Secret': 'secret-header' });
  assert.equal(local.homeDirectory, 'C:\\Users\\Example');
  assert.equal(local.relayHostId, 'relay-host');
});

test('frontend-only recovery keeps native startup and restart privileged to the bundled shell', () => {
  const withoutLocalHost = { uiProtocol: 'varin-ui', localOrigins: [] };
  assert.equal(isTrustedLocalRendererUrl('varin-ui://app/index.html', withoutLocalHost), true);
  assert.equal(isTrustedLocalRendererUrl('https://remote.example.test/app', withoutLocalHost), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_get_local_host_mode'), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_set_local_host_mode'), false);
  assert.equal(REMOTE_SAFE_DESKTOP_COMMANDS.has('desktop_restart_without_update'), false);
});

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { normalizeConnectionHost } from '../web/application-host/lib/connections/hosts.js';
import { rendererRelayStartup, resolveStartupUrlProbePlan, shouldIgnoreLoopbackConnectionLimit } from './startup-url-selection.js';

test('bundled development never probes HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: true,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('HMR development probes both API and UI endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: true,
    probeHmrUi: true,
  });
});

test('serverless HMR development skips only the local API probe', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: true,
  }), {
    probeHmrApi: false,
    probeHmrUi: true,
  });
});

test('production does not probe HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: false,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('keeps Chromium connection limits for the Vite HMR module graph', () => {
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: false }), false);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: true }), true);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: false, packagedUi: false }), true);
});

test('a saved relay-only Host boots the trusted chooser/renderer without probing relay:// or passing tokens to a default HTTP base', () => {
  const relay = { relayUrl: 'wss://relay.example', serverId: 'pinned', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'example' } };
  const saved = normalizeConnectionHost({ id: 'cloud', relay, clientToken: 'private', requestHeaders: { 'X-Client': 'private' } });
  assert.equal(saved.url, 'relay://pinned'); assert.equal(saved.apiUrl, undefined);
  const expected = { initialUrl: 'varin-ui://app/index.html', relayHostId: 'cloud', apiBaseUrl: '', clientToken: '', requestHeaders: {},
    bootOutcome: { target: 'remote', status: 'relay-pending', hostId: 'cloud', url: 'relay://pinned', localAvailable: false } };
  assert.deepEqual(rendererRelayStartup(saved, expected.initialUrl, false), expected);
  assert.deepEqual(rendererRelayStartup({ ...saved, apiUrl: 'https://old-direct.example' }, expected.initialUrl, false), expected);
  assert.equal(rendererRelayStartup({ id: 'direct', url: 'https://direct.example' }, expected.initialUrl, false), null);
});

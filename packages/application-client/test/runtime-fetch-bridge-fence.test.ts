import assert from 'node:assert/strict';
import { it } from 'node:test';
import { installRuntimeFetchBridge } from '../src/transport/runtime-fetch.js';
import { clearRuntimeAuthCredentialProvider, setRuntimeAuthCredentialProvider } from '../src/transport/runtime-auth.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';
import { registerRelayTunnelProvider } from '../src/transport/relay-provider.js';

it('fences installed browser fetch and relay dispatch while the selected Host changes during authentication', async () => {
  const original = { window: globalThis.window, fetch: globalThis.fetch };
  const dispatches: string[] = [];
  const nativeFetch: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/auth/url-token')) dispatches.push(url);
    return Response.json({ token: 'synthetic-url-token', expiresAt: Date.now() + 120_000 });
  };
  const runtimeWindow = Object.assign(new EventTarget(), {
    location: { origin: 'https://app.test', href: 'https://app.test/' }, fetch: nativeFetch,
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
  globalThis.fetch = nativeFetch;
  installRuntimeFetchBridge();
  globalThis.fetch = window.fetch;
  try {
    for (const kind of ['relative', 'absolute', 'url', 'request', 'relay'] as const) {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://first.test/team', clientToken: 'first-fixture' });
      await new Promise(resolve => setImmediate(resolve));
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      setRuntimeAuthCredentialProvider(async () => { entered(); await held; return { type: 'bearer', token: 'first-fixture' }; });
      if (kind === 'relay') registerRelayTunnelProvider(() => ({ fetch: async (input) => {
        if (!String(input).includes('/auth/url-token')) dispatches.push(`relay:${String(input)}`);
        return Response.json({ token: 'synthetic-relay-token', expiresAt: Date.now() + 120_000 });
      } }));
      const absolute = 'https://first.test/team/api/models/credentials/store';
      const input = kind === 'absolute' ? absolute : kind === 'url' ? new URL(absolute)
        : kind === 'request' ? new Request(absolute, { method: 'POST', body: '{}' }) : '/api/models/credentials/store';
      const pending = window.fetch(input, { method: 'POST', body: '{}' });
      const rejected = assert.rejects(pending, /Host changed/);
      await started;
      switchRuntimeEndpoint({ apiBaseUrl: 'https://second.test/team', clientToken: 'second-fixture' });
      release();
      try { await rejected; } finally { registerRelayTunnelProvider(() => null); }
      assert.deepEqual(dispatches, [], kind);
    }
  } finally {
    registerRelayTunnelProvider(() => null);
    clearRuntimeAuthCredentialProvider();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: original.window });
    globalThis.fetch = original.fetch;
  }
});

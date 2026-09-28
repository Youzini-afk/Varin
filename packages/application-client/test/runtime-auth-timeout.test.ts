import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  clearRuntimeAuthCredentialProvider,
  getLocalRuntimeUrlAuthTokenSync,
  getRuntimeUrlAuthTokenSync,
  refreshLocalRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
} from '../src/transport/runtime-auth.js';

it('expires shared auth mints, retries without restart, and rejects late token publication', { timeout: 20_000 }, async () => {
  const originalFetch = globalThis.fetch;
  clearRuntimeAuthCredentialProvider();
  const signals: AbortSignal[] = [];
  const calls: string[] = [];
  let releaseBody!: (body: unknown) => void;
  let releaseLocal!: (response: Response) => void;
  const oldBody = new Promise<unknown>((resolve) => { releaseBody = resolve; });
  const oldLocal = new Promise<Response>((resolve) => { releaseLocal = resolve; });
  const response = (token: string) => Response.json({ token, expiresAt: Date.now() + 60_000 });
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    assert.ok(init?.signal); signals.push(init.signal);
    if (url.startsWith('http://remote.test')) {
      // Headers arrived, but an auth response body that ignores cancellation stalls.
      return { ok: true, json: () => oldBody } as Response;
    }
    return oldLocal;
  };
  try {
    const primary = refreshRuntimeUrlAuthToken('http://remote.test');
    const samePrimary = refreshRuntimeUrlAuthToken('http://remote.test');
    const local = refreshLocalRuntimeUrlAuthToken('http://local.test');
    const sameLocal = refreshLocalRuntimeUrlAuthToken('http://local.test');
    await Promise.all([primary, samePrimary, local, sameLocal].map((promise) =>
      assert.rejects(promise, /authentication timed out/)));
    assert.equal(calls.length, 2, 'callers share one bounded operation per authority');
    assert.ok(signals.every((signal) => signal.aborted));

    globalThis.fetch = async (input) => response(String(input).startsWith('http://remote.test') ? 'new-primary' : 'new-local');
    assert.equal(await refreshRuntimeUrlAuthToken('http://remote.test'), 'new-primary');
    assert.equal(await refreshLocalRuntimeUrlAuthToken('http://local.test'), 'new-local');
    // These must not overwrite the replacements even when a transport ignores abort.
    releaseBody({ token: 'old-primary', expiresAt: Date.now() + 60_000 });
    releaseLocal(response('old-local'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getRuntimeUrlAuthTokenSync(), 'new-primary');
    assert.equal(getLocalRuntimeUrlAuthTokenSync('http://local.test'), 'new-local');
  } finally {
    releaseBody({ token: 'unused', expiresAt: 0 });
    releaseLocal(response('unused'));
    await new Promise((resolve) => setImmediate(resolve));
    clearRuntimeAuthCredentialProvider();
    globalThis.fetch = originalFetch;
  }
});

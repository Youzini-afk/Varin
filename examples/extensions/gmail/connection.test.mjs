import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createConnectionController } from './runtime/connection.mjs';
import { loadCredentials, saveCredentials } from './runtime/credentials.mjs';
import { GMAIL_SCOPES } from './runtime/oauth.mjs';

const client = { client_id: 'test-desktop-client', client_secret: 'test-client-secret' };
const json = (value, options) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'varin-gmail-connection-'));
  try { await fn(join(root, 'config')); } finally { await rm(root, { recursive: true, force: true }); }
}
async function waitForPhase(controller, expected) {
  for (let n = 0; n < 100; n++) {
    const state = await controller.status();
    if (state.phase === expected) return state;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test('settings connection completes loopback OAuth, checks the Gmail profile and revokes access', async () => fixture(async directory => {
  let opened, revokeCount = 0;
  const controller = createConnectionController({ directory, openBrowser(url) { opened = url; }, async fetchImpl(url, options) {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return options.body.get('grant_type') === 'authorization_code'
        ? json({ access_token: 'initial-secret', refresh_token: 'refresh-secret', scope: GMAIL_SCOPES.join(' ') })
        : json({ access_token: 'access-secret' });
    }
    if (String(url) === 'https://oauth2.googleapis.com/revoke') {
      assert.equal(options.body.get('token'), 'refresh-secret'); revokeCount++; return new Response(null, { status: 200 });
    }
    assert.match(String(url), /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/u);
    assert.equal(options.headers.authorization, 'Bearer access-secret');
    return json({ emailAddress: 'fixture@example.com' });
  } });
  assert.equal((await controller.status()).phase, 'disconnected');
  const started = await controller.start(JSON.stringify({ installed: client }));
  assert.equal(started.phase, 'authorizing'); assert.equal(opened, started.authorizationUrl);
  assert.equal((await controller.status()).phase, 'authorizing');
  await assert.rejects(controller.start(JSON.stringify({ installed: client })), /already in progress/u);
  const authorization = new URL(started.authorizationUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
  assert.equal((await fetch(callback)).status, 200);
  await waitForPhase(controller, 'connected');
  const profile = await controller.check();
  assert.deepEqual(profile, { emailAddress: 'fixture@example.com' });
  assert.equal(JSON.stringify({ started, profile, status: await controller.status() }).includes('refresh-secret'), false);
  assert.equal((await controller.disconnect()).phase, 'disconnected');
  assert.equal(revokeCount, 1); assert.equal(await loadCredentials(directory), null);
  await controller.dispose();
}));

test('cancel closes the local listener and never saves a token', async () => fixture(async directory => {
  const controller = createConnectionController({ directory, openBrowser() {}, async fetchImpl() { throw new Error('No token request expected'); } });
  const { authorizationUrl } = await controller.start(JSON.stringify({ installed: client }));
  const callback = new URL(new URL(authorizationUrl).searchParams.get('redirect_uri'));
  assert.equal((await controller.cancel()).phase, 'disconnected');
  assert.equal(await loadCredentials(directory), null);
  await assert.rejects(fetch(callback));
  await controller.dispose();
}));

test('a failed revoke retains credentials and a malformed client cannot start authorization', async () => fixture(async directory => {
  const controller = createConnectionController({ directory, openBrowser() {}, async fetchImpl() { return json({}, { status: 503 }); } });
  await assert.rejects(controller.start('{"web":{}}'), /Desktop OAuth client/u);
  await saveCredentials(directory, { ...client, refresh_token: 'refresh-secret' });
  await assert.rejects(controller.start(JSON.stringify({ installed: client })), /Disconnect/u);
  await assert.rejects(controller.disconnect(), /revoke access/u);
  assert.equal((await controller.status()).phase, 'connected');
  assert.equal((await loadCredentials(directory)).refresh_token, 'refresh-secret');
  await controller.dispose();
}));

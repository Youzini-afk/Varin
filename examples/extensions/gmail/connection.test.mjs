import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createConnectionController } from './runtime/connection.mjs';
import { loadCredentials, saveCredentials } from './runtime/credentials.mjs';
import { GMAIL_SCOPES } from './runtime/oauth.mjs';
import { publisherClient } from './runtime/publisher-client.mjs';

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

test('publisher configuration enables login without importing a client file or storing the publisher secret', async () => fixture(async directory => {
  const configured = { kind: 'publisher', client_id: 'fixture.apps.googleusercontent.com', client_secret: 'publisher-secret' };
  const controller = createConnectionController({ directory, getPublisherClient: () => configured, openBrowser() {}, async fetchImpl(url, options) {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.body.get('client_secret'), configured.client_secret);
      return options.body.get('grant_type') === 'authorization_code'
        ? json({ refresh_token: 'user-refresh', scope: GMAIL_SCOPES.join(' ') })
        : json({ access_token: 'user-access' });
    }
    assert.equal(options.headers.authorization, 'Bearer user-access');
    return json({ emailAddress: 'fixture@example.com' });
  } });
  assert.equal((await controller.status()).publisherConfigured, true);
  const started = await controller.start();
  assert.equal(JSON.stringify(started).includes(configured.client_secret), false);
  const auth = new URL(started.authorizationUrl), callback = new URL(auth.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
  assert.equal((await fetch(callback)).status, 200);
  await waitForPhase(controller, 'connected');
  assert.deepEqual(await controller.check(), { emailAddress: 'fixture@example.com' });
  const stored = await readFile(join(directory, 'credentials.json'), 'utf8');
  assert.equal(stored.includes(configured.client_secret), false);
  assert.equal(JSON.stringify(await controller.status()).includes('user-refresh'), false);
  assert.deepEqual(await loadCredentials(directory), { kind: 'publisher', client_id: configured.client_id, refresh_token: 'user-refresh' });
  await controller.dispose();
}));

test('publisher client is deployment-owned and a changed client cannot use a previous user token', async () => fixture(async directory => {
  assert.equal(publisherClient({}), null);
  assert.throws(() => publisherClient({ VARIN_GMAIL_PUBLISHER_CLIENT_ID: 'fixture.apps.googleusercontent.com' }), /isolated single-user Host/u);
  assert.throws(() => publisherClient({ VARIN_GMAIL_ISOLATED_HOST: '1', VARIN_GMAIL_PUBLISHER_CLIENT_ID: 'fixture.apps.googleusercontent.com' }), /not configured/u);
  const configured = publisherClient({ VARIN_GMAIL_ISOLATED_HOST: '1', VARIN_GMAIL_PUBLISHER_CLIENT_ID: 'fixture.apps.googleusercontent.com', VARIN_GMAIL_PUBLISHER_CLIENT_SECRET: 'private-secret' });
  assert.equal(publisherClient({ VARIN_GMAIL_ISOLATED_HOST: '1', VARIN_GMAIL_PUBLISHER_CLIENT_SECRET: 'private-secret' }, { client_id: 'fixture.apps.googleusercontent.com' }).client_id, configured.client_id);
  assert.throws(() => publisherClient({}, { client_id: null, client_secret: 'should-not-be-public' }), /public client configuration/u);
  await saveCredentials(directory, { ...configured, refresh_token: 'user-refresh' });
  let networkCalls = 0;
  const controller = createConnectionController({ directory, getPublisherClient: () => ({ ...configured, client_id: 'other.apps.googleusercontent.com' }),
    async fetchImpl() { networkCalls++; throw new Error('unexpected'); } });
  await assert.rejects(controller.check(), /changed or is unavailable/u);
  assert.equal(networkCalls, 0);
  await controller.dispose();
}));

test('separately provisioned Host directories retain separate user credentials', async () => fixture(async directory => {
  const config = { kind: 'publisher', client_id: 'fixture.apps.googleusercontent.com', client_secret: 'publisher-secret' };
  const one = join(directory, 'host-one'), two = join(directory, 'host-two');
  await saveCredentials(one, { ...config, refresh_token: 'first-user' });
  await saveCredentials(two, { ...config, refresh_token: 'second-user' });
  assert.equal((await loadCredentials(one)).refresh_token, 'first-user');
  assert.equal((await loadCredentials(two)).refresh_token, 'second-user');
  // Separate directories on the same OS account are not a security boundary; deployments need
  // distinct OS users/Hosts until Varin supplies a trusted per-user identity to the extension.
}));

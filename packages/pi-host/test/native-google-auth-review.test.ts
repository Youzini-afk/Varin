import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeGoogleCredentialOwner } from '../src/native-google-auth.js';
import { HostCredentialAuthority } from '../src/credential-authority.js';

test('locked Google auth client refreshes temporary ADC at a loopback token endpoint without copying tokens into Host storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-google-auth-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: string[] = [];
  let reject = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push(Buffer.concat(chunks).toString());
      response.writeHead(reject ? 400 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reject ? { error: 'invalid_grant', error_description: 'fake-private-response' }
        : { access_token: `fake-adc-token-${requests.length}`, token_type: 'Bearer', expires_in: 0 }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const filename = join(directory, 'adc.json');
  const adc = JSON.stringify({ type: 'external_account_authorized_user', audience: 'fake-fixture-audience', client_id: 'fake-client-id', client_secret: 'fake-client-secret', refresh_token: 'fake-refresh-token', token_url: `http://127.0.0.1:${address.port}/token` });
  await writeFile(filename, adc);
  const env = { GOOGLE_APPLICATION_CREDENTIALS: filename, GOOGLE_CLOUD_PROJECT: 'fixture-project', GOOGLE_CLOUD_LOCATION: 'us-central1' };
  const sourceOwner = new NativeGoogleCredentialOwner();
  const source = await sourceOwner.source(env);
  const first = await sourceOwner.headers(source);
  assert.equal(first.authorization, 'Bearer fake-adc-token-1');
  assert.equal(requests[0], 'grant_type=refresh_token&refresh_token=fake-refresh-token');
  assert.deepEqual(await sourceOwner.source(env), source);
  assert.equal((await sourceOwner.headers(source)).authorization, 'Bearer fake-adc-token-2');
  const authority = HostCredentialAuthority.open(join(directory, 'host'));
  await authority.modifyWithIntent('google-vertex', 'replace', async () => ({ type: 'api_key', env }));
  assert.equal(await authority.vertexAuthentication('google-vertex'), 'adc');
  const before = await authority.currentScope('google-vertex');
  const firstAuth = await authority.getAuth('google-vertex');
  assert.equal(firstAuth?.auth.headers?.authorization, 'Bearer fake-adc-token-3');
  assert.equal((await authority.getAuth('google-vertex'))?.auth.headers?.authorization, 'Bearer fake-adc-token-4');
  assert.deepEqual(await authority.currentScope('google-vertex'), before);
  assert.equal(await readFile(filename, 'utf8'), adc);
  assert.equal((await readFile(join(directory, 'host', 'auth.json'), 'utf8')).includes('fake-adc-token'), false);
  reject = true;
  await assert.rejects(authority.getAuth('google-vertex'), { code: 'google-credential-resolution-failed', message: 'google-credential-resolution-failed' });
  assert.deepEqual(await authority.currentScope('google-vertex'), before);
  await assert.rejects(sourceOwner.source({ GOOGLE_APPLICATION_CREDENTIALS: join(directory, 'missing.json') }), { code: 'google-credential-source-unavailable' });
});

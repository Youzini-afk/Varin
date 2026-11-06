import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeDesktop, GMAIL_SCOPES } from './runtime/oauth.mjs';
import { loadCredentials, saveCredentials } from './runtime/credentials.mjs';
import { createGmailClient, createRawMessage } from './runtime/gmail.mjs';
import { createExtension } from './host.mjs';
import manifest from './varin.extension.json' with { type: 'json' };

const client = { client_id: 'desktop-client', client_secret: 'private-client-secret' };
const credentials = { ...client, refresh_token: 'private-refresh-token' };
const json = (body, init) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'varin-gmail-test-'));
  try { await callback(join(root, 'config')); } finally { await rm(root, { recursive: true, force: true }); }
}

test('Google desktop OAuth uses loopback, state, PKCE and stores only local private credentials', async () => fixture(async directory => {
  let authUrl, tokenForm, exchangeCount = 0;
  await authorizeDesktop(client, directory, {
    async onAuthorizationUrl(url) {
      authUrl = new URL(url);
      const callback = new URL(authUrl.searchParams.get('redirect_uri'));
      const wrong = new URL(callback);
      wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'fake-code');
      assert.equal((await fetch(wrong)).status, 400);
      assert.equal(await loadCredentials(directory), null);
      callback.searchParams.set('state', authUrl.searchParams.get('state')); callback.searchParams.set('code', 'valid-code');
      assert.equal((await fetch(callback)).status, 200);
    },
    async fetchImpl(url, options) {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.redirect, 'error');
      tokenForm = options.body; exchangeCount++;
      return json({ access_token: 'temporary', refresh_token: credentials.refresh_token, scope: GMAIL_SCOPES.join(' ') });
    },
  });
  assert.equal(exchangeCount, 1);
  assert.equal(authUrl.origin, 'https://accounts.google.com');
  assert.equal(new URL(authUrl.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('code_challenge'), createHash('sha256').update(tokenForm.get('code_verifier')).digest('base64url'));
  assert.deepEqual(authUrl.searchParams.get('scope').split(' '), GMAIL_SCOPES);
  assert.equal(tokenForm.get('code'), 'valid-code');
  assert.deepEqual(await loadCredentials(directory), credentials);
  const file = await readFile(join(directory, 'credentials.json'), 'utf8');
  assert.equal(file.includes('temporary'), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
    await chmod(join(directory, 'credentials.json'), 0o644);
    await assert.rejects(loadCredentials(directory), /permissions|connect again/u);
  }
}));

test('OAuth does not save a partially granted or refresh-token-free authorization', async () => fixture(async directory => {
  for (const result of [{ access_token: 'a' }, { access_token: 'a', refresh_token: 'r', scope: GMAIL_SCOPES[1] }, { access_token: 'a', refresh_token: 'r' }]) {
    await assert.rejects(authorizeDesktop(client, directory, {
      async onAuthorizationUrl(url) {
        const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri'));
        callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'code');
        await fetch(callback);
      },
      async fetchImpl() { return json(result); },
    }), /refresh token|both requested/u);
    assert.equal(await loadCredentials(directory), null);
  }
}));

test('a denied authorization is reported and does not write credentials', async () => fixture(async directory => {
  await assert.rejects(authorizeDesktop(client, directory, {
    async onAuthorizationUrl(url) {
      const auth = new URL(url), callback = new URL(auth.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
      assert.equal((await fetch(callback)).status, 400);
    },
    async fetchImpl() { throw new Error('The token endpoint must not be called'); },
  }), /not completed/u);
  assert.equal(await loadCredentials(directory), null);
}));

test('search, read and send use Gmail API; tokens stay out of results and MIME round-trips Unicode', async () => fixture(async directory => {
  await saveCredentials(directory, credentials);
  const requests = [];
  const api = createGmailClient({ directory, async fetchImpl(url, options) {
    requests.push({ url: String(url), options });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.body.get('refresh_token'), credentials.refresh_token);
      return json({ access_token: 'ephemeral-access-token' });
    }
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ephemeral-access-token');
    if (String(url).includes('/messages/send')) return json({ id: 'sent123', threadId: 't1' });
    if (String(url).includes('/messages/msg123')) return json({ id: 'msg123', threadId: 't1', snippet: 'hello', payload: {
      headers: [{ name: 'Subject', value: 'A subject' }, { name: 'From', value: 'sender@example.com' }],
      parts: [{ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=gbk' }],
        body: { data: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]).toString('base64url') } },
        { filename: 'test.txt', mimeType: 'text/plain', body: { attachmentId: 'a1', size: 7 } }],
    } });
    return json({ messages: [{ id: 'msg123', threadId: 't1' }], nextPageToken: 'next' });
  } });
  assert.equal((await api.status()).configured, true);
  const found = await api.search({ query: 'is:unread from:me', maxResults: 5 });
  assert.deepEqual(found, { messages: [{ id: 'msg123', threadId: 't1' }], nextPageToken: 'next' });
  const message = await api.read({ id: 'msg123' });
  assert.equal(message.body, '你好'); assert.equal(message.headers.subject, 'A subject');
  assert.deepEqual(message.attachments, [{ filename: 'test.txt', mimeType: 'text/plain', size: 7 }]);
  const sent = await api.send({ to: ['person@example.com'], cc: ['copy@example.com'], subject: '你好 subject', body: '正文\nHello' });
  assert.deepEqual(sent, { status: 'sent', id: 'sent123', threadId: 't1' });
  const query = new URL(requests.find(request => request.url.includes('/messages?')).url);
  assert.equal(query.searchParams.get('q'), 'is:unread from:me');
  const send = requests.find(request => request.url.includes('/messages/send'));
  const mime = Buffer.from(JSON.parse(send.options.body).raw, 'base64url').toString('utf8');
  assert.match(mime, /To: person@example\.com\r\nCc: copy@example\.com/u);
  assert.ok(mime.includes(Buffer.from('你好 subject').toString('base64')));
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/gu, ''), 'base64').toString('utf8'), '正文\nHello');
  assert.equal(JSON.stringify({ found, message, sent }).includes('token'), false);
}));

test('email headers reject injection before any network request', async () => fixture(async directory => {
  let calls = 0;
  const api = createGmailClient({ directory, async fetchImpl() { calls++; throw new Error('unexpected'); } });
  await assert.rejects(api.send({ to: ['safe@example.com\r\nBcc: attacker@example.com'], subject: 'test', body: 'x' }), /Recipients/u);
  await assert.rejects(api.send({ to: ['safe@example.com'], subject: 'test\r\nBcc: attacker@example.com', body: 'x' }), /control/u);
  assert.equal(calls, 0);
  assert.throws(() => createRawMessage({ to: ['display <test@example.com>'], subject: 'a', body: 'x' }), /Recipients/u);
}));

test('uncertain or rejected sends never retry and are not reported as successful Varin effects', async () => fixture(async directory => {
  await saveCredentials(directory, credentials);
  for (const type of ['transport', 'server', 'client', 'missing-id']) {
    let sends = 0;
    const api = createGmailClient({ directory, async fetchImpl(url) {
      if (String(url).includes('oauth2.googleapis.com')) return json({ access_token: 'a' });
      sends++;
      if (type === 'transport') throw new Error('network failure after dispatch');
      if (type === 'server') return json({}, { status: 503 });
      if (type === 'client') return json({}, { status: 403 });
      return json({});
    } });
    const result = await api.send({ to: ['person@example.com'], subject: 'test', body: 'test' });
    assert.equal(result.status, type === 'client' ? 'rejected' : 'unknown');
    assert.equal(sends, 1);
    const handlers = new Map();
    createExtension(api).activate({ effect() {}, services: { provide(descriptor, handler) { if (descriptor.tool) handlers.set(descriptor.tool.name, handler); } } });
    const send = handlers.get('gmail_send');
    const invocation = { callId: 'fixture', signal: new AbortController().signal, capabilities: { async call() { throw new Error('unexpected'); } } };
    await assert.rejects(send.execute([{ to: ['person@example.com'], subject: 'test', body: 'test' }], invocation));
    assert.equal(sends, 2); // one dispatch per explicit invocation; the SDK handler did not retry
  }
  assert.equal(manifest.provides.services.find(service => service.tool.name === 'gmail_send').tool.operation, 'effect');
}));

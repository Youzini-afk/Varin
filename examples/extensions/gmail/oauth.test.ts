import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { authenticate, configuration, scopes } from './oauth.js';
const config = { clientId: 'public-client', redirectUri: 'http://127.0.0.1:8085/callback' };
test('public native OAuth uses PKCE and rejects wrong state or callback before token exchange', async () => {
  const begin = await authenticate({ kind: 'begin', provider: 'gmail', connectionId: 'one' }, config);
  assert.equal(begin.kind, 'pending'); if (begin.kind !== 'pending') return;
  const url = new URL(begin.authorizationUrl), state = begin.state as { verifier: string; nonce: string };
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(state.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  let requests = 0;
  const fetcher = (async () => { requests++; throw new Error('unexpected network'); }) as typeof fetch;
  for (const redirect of [`${config.redirectUri}?state=wrong&code=code`, `https://evil.test/callback?state=${state.nonce}&code=code`, `${config.redirectUri}?state=${state.nonce}&code=a&code=b`]) {
    await assert.rejects(authenticate({ kind: 'complete', provider: 'gmail', connectionId: 'one', state: begin.state, redirect }, config, fetcher), /callback or state/);
  }
  assert.equal(requests, 0);
});
test('token exchange and refresh verify account and preserve refresh token without a public client secret', async () => {
  const begin = await authenticate({ kind: 'begin', provider: 'gmail', connectionId: 'one' }, config);
  if (begin.kind !== 'pending') throw new Error('expected pending');
  const params: URLSearchParams[] = [];
  const fetcher = (async (url, init) => {
    if (String(url).endsWith('/token')) {
      params.push(init!.body as URLSearchParams);
      return Response.json({ access_token: 'access', refresh_token: params.length === 1 ? 'refresh' : undefined, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') });
    }
    return Response.json({ emailAddress: 'me@example.test' });
  }) as typeof fetch;
  const result = await authenticate({ kind: 'complete', provider: 'gmail', connectionId: 'one', state: begin.state, redirect: `${config.redirectUri}?state=${(begin.state as { nonce: string }).nonce}&code=code` }, config, fetcher);
  if (result.kind !== 'token') throw new Error('expected token');
  assert.equal(params[0]!.has('client_secret'), false);
  assert.equal(params[0]!.get('code_verifier'), (begin.state as { verifier: string }).verifier);
  const refreshed = await authenticate({ kind: 'refresh', provider: 'gmail', connectionId: 'one', token: result.token }, config, fetcher);
  assert.equal(refreshed.kind === 'token' && refreshed.token.refreshToken, 'refresh');
  assert.equal(params[1]!.get('grant_type'), 'refresh_token');
  await assert.rejects(authenticate({ kind: 'refresh', provider: 'gmail', connectionId: 'one', token: { ...result.token, accountId: 'someone@example.test' } }, config, fetcher), /identity changed/);
});
test('remote callback and deployment prerequisites are explicit', () => {
  assert.throws(() => configuration({}), /Configure VARIN_GMAIL/);
  assert.throws(() => configuration({ VARIN_GMAIL_CLIENT_ID: 'id', VARIN_GMAIL_REDIRECT_URI: 'http://remote.test/callback' }), /HTTPS/);
  assert.equal(configuration({ VARIN_GMAIL_CLIENT_ID: 'id', VARIN_GMAIL_REDIRECT_URI: 'https://remote.test/callback' }).clientSecret, undefined);
});

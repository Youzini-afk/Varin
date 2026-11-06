import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { saveCredentials } from './credentials.mjs';
import { publisherClient } from './publisher-client.mjs';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function tokenRequest(parameters, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters), redirect: 'error', signal,
    });
  } catch { throw new Error('Google OAuth request failed; check the network and try connecting again'); }
  if (!response.ok) throw new Error(`Google OAuth rejected the request (HTTP ${response.status}); connect again`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Google OAuth returned an invalid response'); }
  return payload;
}

export async function refreshAccessToken(credentials, { fetchImpl = fetch, signal, getPublisherClient = publisherClient } = {}) {
  const configured = credentials.kind === 'publisher' ? getPublisherClient() : null;
  if (credentials.kind === 'publisher' && (!configured || configured.client_id !== credentials.client_id)) {
    throw new Error('The Gmail publisher OAuth client changed or is unavailable; reconnect the account');
  }
  const result = await tokenRequest({
    client_id: credentials.client_id, client_secret: configured?.client_secret || credentials.client_secret,
    refresh_token: credentials.refresh_token, grant_type: 'refresh_token',
  }, fetchImpl, signal);
  if (typeof result?.access_token !== 'string' || !result.access_token) throw new Error('Google OAuth did not return an access token');
  return result.access_token;
}

const equalState = (actual, expected) => {
  const a = Buffer.from(actual || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Test dependencies are passed explicitly; production endpoints cannot be changed by an environment variable.
export async function authorizeDesktop(client, directory, { fetchImpl = fetch, onAuthorizationUrl, timeoutMs = 300000, signal } = {}) {
  signal?.throwIfAborted();
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');
  let resolveCode, rejectCode, timer, consumed = false;
  const pending = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const abort = () => rejectCode(new Error('Google authorization cancelled'));
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback') { response.writeHead(404).end('Not found'); return; }
    if (!equalState(url.searchParams.get('state'), state)) { response.writeHead(400).end('Invalid state'); return; }
    if (consumed) { response.writeHead(400).end('Authorization callback already received'); return; }
    consumed = true;
    const code = url.searchParams.get('code');
    if (!code || url.searchParams.has('error')) {
      response.writeHead(400).end('Authorization was not completed. You may close this window.');
      rejectCode(new Error('Google authorization was not completed'));
      return;
    }
    response.writeHead(200).end('Authorization received. Return to your application to finish connecting Gmail.');
    resolveCode(code);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
    code_challenge: challenge, code_challenge_method: 'S256', state,
  }).toString();
  try {
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    timer = setTimeout(() => rejectCode(new Error('Google authorization timed out')), timeoutMs);
    const [, code] = await Promise.all([Promise.resolve().then(() => onAuthorizationUrl(url.toString())), pending]);
    signal?.throwIfAborted();
    const result = await tokenRequest({ code, client_id: client.client_id, client_secret: client.client_secret,
      code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }, fetchImpl, signal);
    if (typeof result?.refresh_token !== 'string' || !result.refresh_token) {
      throw new Error('Google did not return a refresh token; revoke the app in Google and connect again');
    }
    if (typeof result.scope !== 'string' || !GMAIL_SCOPES.every(scope => result.scope.split(' ').includes(scope))) {
      throw new Error('Google did not grant both requested Gmail scopes; connect again');
    }
    signal?.throwIfAborted();
    await saveCredentials(directory, { ...client, refresh_token: result.refresh_token }, { signal });
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
    await new Promise(resolve => server.close(resolve));
  }
}

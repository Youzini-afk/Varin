import { spawn } from 'node:child_process';
import { credentialDirectory, loadCredentials, parseDesktopClient, removeCredentials } from './credentials.mjs';
import { authorizeDesktop } from './oauth.mjs';
import { createGmailClient } from './gmail.mjs';
import { publisherClient } from './publisher-client.mjs';

function openSystemBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
  if (!command) return; // The settings page also exposes the generated URL as a fallback.
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// A single Host-owned account and at most one pending authorization per extension generation.
// The Surface receives only a short-lived authorization URL, account status and sanitized errors.
export function createConnectionController({ directory = credentialDirectory(), fetchImpl = fetch,
  openBrowser = openSystemBrowser, authorize = authorizeDesktop, getPublisherClient = publisherClient } = {}) {
  let active = null;
  let failure = null;
  const gmail = createGmailClient({ directory, fetchImpl, getPublisherClient });
  async function status() {
    let publisherConfigured = false, publisherConfigError = false;
    try { publisherConfigured = Boolean(getPublisherClient()); } catch { publisherConfigError = true; }
    if (active) return { phase: 'authorizing', authorizationUrl: active.url || null, publisherConfigured, publisherConfigError };
    const configured = Boolean(await loadCredentials(directory));
    return { phase: configured ? 'connected' : failure ? 'error' : 'disconnected',
      message: failure, authorizationUrl: null, publisherConfigured, publisherConfigError };
  }
  async function start(json) {
    if (active) throw new Error('A Gmail connection is already in progress');
    const client = typeof json === 'string' && json.trim() ? parseDesktopClient(json) : getPublisherClient();
    if (!client) throw new Error('The publisher has not configured Gmail login; import a Desktop OAuth client or contact the publisher');
    const attempt = { controller: new AbortController(), url: null, task: null };
    active = attempt; failure = null;
    try {
      if (await loadCredentials(directory)) throw new Error('Disconnect the existing account before connecting another');
      attempt.controller.signal.throwIfAborted();
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      attempt.task = authorize(client, directory, { fetchImpl, signal: attempt.controller.signal, onAuthorizationUrl(url) {
        attempt.url = url;
        resolveReady();
        try { openBrowser(url); } catch { /* A fallback link remains available in the settings page. */ }
      } }).then(() => { failure = null; }, error => {
        failure = attempt.controller.signal.aborted ? null : (error instanceof Error ? error.message : 'Gmail authorization failed');
        rejectReady(new Error(failure || 'Google authorization cancelled'));
      }).finally(() => { if (active === attempt) active = null; });
      await ready;
      return { phase: 'authorizing', authorizationUrl: attempt.url };
    } catch (error) {
      if (active === attempt && !attempt.task) active = null;
      throw error;
    }
  }
  async function cancel() {
    const attempt = active;
    if (attempt) { attempt.controller.abort(); await attempt.task; }
    failure = null;
    return status();
  }
  async function check(signal) {
    if (active) throw new Error('Finish or cancel the pending Gmail authorization first');
    return gmail.profile(signal);
  }
  async function disconnect(signal) {
    if (active) throw new Error('Finish or cancel the pending Gmail authorization first');
    const credentials = await loadCredentials(directory);
    if (!credentials) return { phase: 'disconnected' };
    let response;
    try {
      response = await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: credentials.refresh_token }), redirect: 'error', signal });
    } catch { throw new Error('Could not revoke Google access. Check your network and try again.'); }
    if (!response.ok) throw new Error(`Google could not revoke access (HTTP ${response.status}).`);
    await removeCredentials(directory);
    failure = null;
    return { phase: 'disconnected' };
  }
  return { status, start, cancel, check, disconnect, dispose: cancel };
}

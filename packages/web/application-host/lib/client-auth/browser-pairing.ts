import crypto from 'node:crypto';

export const BROWSER_PAIRING_PATH = '/pair';
export const BROWSER_PAIRING_REDEEM_PATH = '/api/client-auth/pairing/browser/redeem';
// Browsers cap persistent cookies. This is storage retention, never an extension
// of the server-side device expiration (which remains authoritative).
const COOKIE_RETENTION_SECONDS = 400 * 24 * 60 * 60;

export const browserClientCookieName = (serverId: string): string => {
  if (!serverId.trim()) throw new Error('Browser pairing requires a stable Host identity');
  return `__Host-varin_client_${crypto.createHash('sha256').update(serverId).digest('hex').slice(0, 24)}`;
};

export function browserClientCookie(name: string, token: string, expiresAt: string | null): string {
  const remaining = expiresAt === null ? COOKIE_RETENTION_SECONDS : Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  if (!Number.isFinite(remaining)) throw new Error('Invalid browser client expiration');
  const maxAge = token ? Math.min(remaining, COOKIE_RETENTION_SECONDS) : 0;
  return `${name}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(maxAge ? Date.now() + maxAge * 1000 : 0).toUTCString()}`;
}

export function buildBrowserPairingUrl(origin: string, pairing: { id: string; secret: string; expiresAt: string; fingerprint: string }): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Object.assign(new Error('Browser pairing requires an HTTPS origin'), { statusCode: 400 });
  }
  const payload = { v: 2, pairingId: pairing.id, secret: pairing.secret, expiresAt: pairing.expiresAt,
    fingerprint: pairing.fingerprint, candidates: [{ type: 'tunnel', url: url.origin, priority: 10 }] };
  url.pathname = BROWSER_PAIRING_PATH;
  url.hash = `pairing=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return url.toString();
}

// No URL secret is rendered into HTML, logged by the server, or fetched by a
// preview GET. Clear the fragment immediately, then require an explicit click.
const script = `(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  const button = document.getElementById('connect');
  let payload;
  try {
    const encoded = fragment.get('pairing');
    if (!encoded || encoded.length > 16384) throw new Error();
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (payload.v !== 2 || typeof payload.pairingId !== 'string' || typeof payload.secret !== 'string') throw new Error();
    status.textContent = 'Connect this browser to ' + location.host + '? Only continue if you requested this device link.';
    button.hidden = false;
  } catch { status.textContent = 'Open a new device pairing link from your Varin Host.'; return; }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Connecting…';
    try {
      const response = await fetch('${BROWSER_PAIRING_REDEEM_PATH}', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingId: payload.pairingId, secret: payload.secret,
          deviceName: navigator.userAgent, devicePlatform: navigator.platform })
      });
      payload = null;
      if (!response.ok) throw new Error();
      location.replace('/');
    } catch {
      payload = null;
      status.textContent = 'Could not confirm pairing. Reopen your link or create a new one. This request will not be retried automatically.';
    }
  });
})();`;

export const browserPairingPage = {
  contentSecurityPolicy: `default-src 'none'; script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect this browser · Varin</title><body><main><h1>Connect this browser</h1><p id="status">Preparing device pairing…</p><button id="connect" hidden>Connect browser</button><noscript>JavaScript is required to pair this browser.</noscript></main><script>${script}</script></body></html>`,
};

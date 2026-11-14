import { connectorEndpoint } from './transport.mjs';
import { message } from './i18n.mjs';

function connectionEndpoint(url) {
  try { return connectorEndpoint(url); }
  catch { throw new Error(message('invalidLink')); }
}

/** Consumes the same device links as the desktop/mobile clients. No new credential issuer. */
export function parseConnectionLink(value) {
  let link;
  try { link = new URL(value.trim()); }
  catch { throw new Error(message('invalidLink')); }
  if (link.protocol !== 'varin:' || link.hostname !== 'connect') throw new Error(message('invalidLink'));
  if (link.searchParams.get('v') === '1') {
    const hostUrl = link.searchParams.get('server'), clientToken = link.searchParams.get('token');
    connectionEndpoint(hostUrl);
    if (!clientToken?.startsWith('varin_client_')) throw new Error(message('invalidLink'));
    return { candidates: [{ url: hostUrl }], clientToken, label: link.searchParams.get('label') || 'Varin' };
  }
  if (link.searchParams.get('v') !== '2') throw new Error(message('invalidLink'));
  const encoded = link.searchParams.get('p') || '';
  let payload;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='));
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  } catch { throw new Error(message('invalidLink')); }
  if (payload?.v !== 2 || typeof payload.pairingId !== 'string' || !payload.pairingId || typeof payload.secret !== 'string' || !payload.secret || !Array.isArray(payload.candidates)) throw new Error(message('invalidLink'));
  const candidates = payload.candidates.filter(item => item.type === 'lan' || item.type === 'tunnel');
  if (!candidates.length) throw new Error(message('relayOnly'));
  candidates.forEach(item => connectionEndpoint(item.url));
  return { ...payload, candidates };
}
export async function redeemConnection(link, hostUrl, fetch = globalThis.fetch) {
  if (!link.candidates.some(item => item.url === hostUrl)) throw new Error(message('invalidLink'));
  if (link.clientToken) return { hostUrl, clientToken: link.clientToken, label: link.label || 'Varin' };
  const endpoint = new URL(connectionEndpoint(hostUrl));
  endpoint.pathname = endpoint.pathname.replace(/browser-resources\/connector\/exchange$/, 'client-auth/pairing/redeem');
  const response = await fetch(endpoint.href, { method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingId: link.pairingId, secret: link.secret,
      clientKind: 'desktop', clientLabel: 'Browser', deviceName: 'Browser Connector', devicePlatform: 'browser' }) });
  if (!response.ok) throw new Error(message('pairRejected'));
  const result = await response.json();
  if (typeof result.clientToken !== 'string' || !result.clientToken.startsWith('varin_client_')) throw new Error(message('missingToken'));
  return { hostUrl, clientToken: result.clientToken, label: result.server?.label || link.label || 'Varin',
    ...(result.client?.label ? { browserLabel: result.client.label } : {}) };
}

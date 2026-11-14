import { connectorEndpoint } from './transport.mjs';

/** Consumes the same device links as the desktop/mobile clients. No new credential issuer. */
export function parseConnectionLink(value) {
  const link = new URL(value.trim());
  if (link.protocol !== 'varin:' || link.hostname !== 'connect') throw new Error('Paste a Varin device pairing link');
  if (link.searchParams.get('v') === '1') {
    const hostUrl = link.searchParams.get('server'), clientToken = link.searchParams.get('token');
    connectorEndpoint(hostUrl);
    if (!clientToken?.startsWith('varin_client_')) throw new Error('The connection link has no device credential');
    return { candidates: [{ url: hostUrl }], clientToken, label: link.searchParams.get('label') || 'Varin' };
  }
  if (link.searchParams.get('v') !== '2') throw new Error('Unsupported device link version');
  const encoded = link.searchParams.get('p') || '';
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='));
  const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
  if (payload.v !== 2 || typeof payload.pairingId !== 'string' || !payload.pairingId || typeof payload.secret !== 'string' || !payload.secret || !Array.isArray(payload.candidates)) throw new Error('Invalid Varin pairing link');
  const candidates = payload.candidates.filter(item => item.type === 'lan' || item.type === 'tunnel');
  if (!candidates.length) throw new Error('This link only offers a relay. Create a browser pairing link with a reachable service address.');
  candidates.forEach(item => connectorEndpoint(item.url));
  return { ...payload, candidates };
}
export async function redeemConnection(link, hostUrl, fetch = globalThis.fetch) {
  if (!link.candidates.some(item => item.url === hostUrl)) throw new Error('Choose an address from the device link');
  if (link.clientToken) return { hostUrl, clientToken: link.clientToken, label: link.label || 'Varin' };
  const endpoint = new URL(connectorEndpoint(hostUrl));
  endpoint.pathname = endpoint.pathname.replace(/browser-resources\/connector\/exchange$/, 'client-auth/pairing/redeem');
  const response = await fetch(endpoint.href, { method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingId: link.pairingId, secret: link.secret,
      clientKind: 'desktop', clientLabel: 'Browser', deviceName: 'Browser Connector', devicePlatform: 'browser' }) });
  if (!response.ok) throw new Error('The pairing link was rejected or expired. Create another link in Varin.');
  const result = await response.json();
  if (typeof result.clientToken !== 'string' || !result.clientToken.startsWith('varin_client_')) throw new Error('The service did not return a device credential');
  return { hostUrl, clientToken: result.clientToken, label: result.server?.label || link.label || 'Varin',
    ...(result.client?.label ? { browserLabel: result.client.label } : {}) };
}

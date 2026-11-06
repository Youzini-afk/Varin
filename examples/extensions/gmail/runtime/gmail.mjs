import { credentialDirectory, loadCredentials } from './credentials.mjs';
import { refreshAccessToken } from './oauth.mjs';
import { publisherClient } from './publisher-client.mjs';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const addressPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;
const idPattern = /^[A-Za-z0-9_-]+$/u;
const maxBodyChars = 200000;

function addresses(value, required) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0) || value.length > 100 || value.some(address =>
    typeof address !== 'string' || address.length > 254 || !addressPattern.test(address))) {
    throw new Error('Recipients must be a list of valid email addresses without display names');
  }
  return value;
}

function encodedSubject(subject) {
  const words = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

export function createRawMessage(input) {
  const to = addresses(input.to, true), cc = addresses(input.cc, false), bcc = addresses(input.bcc, false);
  if (typeof input.subject !== 'string' || /[\x00-\x1f\x7f]/u.test(input.subject) ||
      typeof input.body !== 'string') throw new Error('Subject and body must be text; subject cannot contain control characters');
  const headers = [
    `To: ${to.join(',\r\n ')}`,
    ...(cc.length ? [`Cc: ${cc.join(',\r\n ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(',\r\n ')}`] : []),
    `Subject: ${encodedSubject(input.subject)}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  const data = Buffer.from(input.body, 'utf8').toString('base64').match(/.{1,76}/gu)?.join('\r\n') || '';
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${data}\r\n`, 'utf8').toString('base64url');
}

function extractMessage(message) {
  const headers = {};
  for (const header of message?.payload?.headers || []) {
    const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
    if (['from', 'to', 'cc', 'subject', 'date'].includes(name) && typeof header.value === 'string') headers[name] = header.value;
  }
  const bodies = { 'text/plain': [], 'text/html': [] }, attachments = [];
  function visit(part) {
    if (!part || typeof part !== 'object') return;
    if (part.filename || part.body?.attachmentId) {
      attachments.push({ filename: String(part.filename || ''), mimeType: String(part.mimeType || ''), size: Number(part.body?.size || 0) });
    } else if (Object.hasOwn(bodies, part.mimeType) && typeof part.body?.data === 'string') {
      const contentType = (part.headers || []).find(header => header?.name?.toLowerCase() === 'content-type')?.value || '';
      const charset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1] || 'utf-8';
      let decoder;
      try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
      bodies[part.mimeType].push(decoder.decode(Buffer.from(part.body.data, 'base64url')));
    }
    for (const child of Array.isArray(part.parts) ? part.parts : []) visit(child);
  }
  visit(message?.payload);
  const mimeType = bodies['text/plain'].length ? 'text/plain' : 'text/html';
  const body = bodies[mimeType].join('\n');
  return { id: String(message.id || ''), threadId: String(message.threadId || ''), headers,
    snippet: String(message.snippet || ''), mimeType, body: body.slice(0, maxBodyChars),
    bodyTruncated: body.length > maxBodyChars, attachments };
}

export function createGmailClient({ directory = credentialDirectory(), fetchImpl = fetch, getPublisherClient = publisherClient } = {}) {
  async function auth(signal) {
    const credentials = await loadCredentials(directory);
    if (!credentials) throw new Error('Gmail is not connected. Run the local authorization command described in the extension README.');
    return refreshAccessToken(credentials, { fetchImpl, signal, getPublisherClient });
  }
  async function get(path, parameters, signal) {
    const token = await auth(signal);
    signal?.throwIfAborted();
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try { response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal }); }
    catch { throw new Error('Gmail request failed; check your connection'); }
    if (!response.ok) throw new Error(`Gmail rejected the request (HTTP ${response.status})`);
    try { return await response.json(); } catch { throw new Error('Gmail returned an invalid response'); }
  }
  return {
    async status() { return { configured: Boolean(await loadCredentials(directory)), note: 'Local credentials found does not prove Google authorization is still valid.' }; },
    async profile(signal) {
      const data = await get('/profile', {}, signal);
      if (typeof data.emailAddress !== 'string' || !data.emailAddress) throw new Error('Gmail returned an invalid account profile');
      return { emailAddress: data.emailAddress };
    },
    async search(input, signal) {
      if (input.query !== undefined && typeof input.query !== 'string') throw new Error('Gmail search query must be text');
      if (input.pageToken !== undefined && typeof input.pageToken !== 'string') throw new Error('Page token must be text');
      const max = input.maxResults ?? 25;
      if (!Number.isInteger(max) || max < 1 || max > 500) throw new Error('maxResults must be between 1 and 500');
      const data = await get('/messages', { q: input.query, maxResults: max, pageToken: input.pageToken }, signal);
      return { messages: (Array.isArray(data.messages) ? data.messages : []).map(item => ({ id: String(item.id), threadId: String(item.threadId) })),
        nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : null };
    },
    async read(input, signal) {
      if (typeof input.id !== 'string' || !idPattern.test(input.id)) throw new Error('Invalid Gmail message ID');
      const data = await get(`/messages/${input.id}`, { format: 'full' }, signal);
      return extractMessage(data);
    },
    async send(input, signal) {
      const raw = createRawMessage(input);
      const token = await auth(signal);
      signal?.throwIfAborted();
      let response;
      // There is deliberately no retry after dispatch. A transport failure or server error can
      // leave delivery unknown, even if cancellation was requested after the POST started.
      try {
        response = await fetchImpl(`${BASE}/messages/send`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ raw }), redirect: 'error', signal });
      } catch { return { status: 'unknown', message: 'Delivery is unknown. Check Gmail Sent before any retry.' }; }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          return { status: 'rejected', message: `Gmail rejected the message (HTTP ${response.status}).` };
        }
        return { status: 'unknown', message: 'Delivery is unknown. Check Gmail Sent before any retry.' };
      }
      try {
        const sent = await response.json();
        if (typeof sent.id === 'string' && sent.id) return { status: 'sent', id: sent.id, threadId: typeof sent.threadId === 'string' ? sent.threadId : '' };
      } catch { /* a successful HTTP status with no receipt is still ambiguous */ }
      return { status: 'unknown', message: 'Gmail returned no message ID. Check Gmail Sent before any retry.' };
    },
  };
}
